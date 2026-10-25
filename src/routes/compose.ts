import { Router } from 'express';
import multer from 'multer';
import { Types } from 'mongoose';
import { z } from 'zod';
import { DRAFT_KINDS, type AttachmentDto, type DraftDto, type SendResultDto } from '../shared.js';
import { HttpError, parseBody } from '../lib/http.js';
import { DraftModel, type DraftDoc } from '../models/Draft.js';
import { TicketModel } from '../models/Ticket.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { attachmentStore } from '../services/attachments/AttachmentStore.js';
import { sendTicketMessage } from '../services/mail/send.js';
import { sanitizeEmailHtml, sanitizeNoteHtml } from '../services/mail/sanitize.js';
import { toTicketDetail } from '../services/tickets/dto.js';
import { MessageModel } from '../models/Message.js';
import { TemplateModel } from '../models/Template.js';
import { copyTemplateFiles, safeFilename } from '../services/templates/files.js';

export const composeRouter = Router();

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 10 } });

const objectId = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');
const Address = z.object({ name: z.string().trim().max(200).default(''), email: z.email().max(320) });
const Compose = z.object({
  kind: z.enum(DRAFT_KINDS),
  to: z.array(Address).max(50).default([]),
  cc: z.array(Address).max(50).default([]),
  subject: z.string().max(400).default(''),
  bodyHtml: z.string().max(1_000_000).default(''),
  attachmentIds: z.array(objectId).max(20).default([]),
  templateIds: z.array(objectId).max(20).default([]),
});

/** Writes need a live enquiry; reading a saved draft also works in Deleted items (read-only there). */
async function loadTicket(id: string, opts: { includeDeleted?: boolean } = {}) {
  const ticket = await TicketModel.findOne({
    _id: objectId.parse(id),
    ...(!opts.includeDeleted && { deletedAt: null }),
  });
  if (!ticket) throw new HttpError(404, 'Enquiry not found');
  return ticket;
}

async function toDraftDto(d: DraftDoc): Promise<DraftDto> {
  const attachments = await attachmentStore.getMeta(d.attachmentIds);
  return {
    kind: d.kind,
    to: d.to.map((a) => ({ name: a.name ?? '', email: a.email })),
    cc: d.cc.map((a) => ({ name: a.name ?? '', email: a.email })),
    subject: d.subject,
    bodyHtml: d.bodyHtml,
    attachments: attachments.map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, size: a.size })),
    templateIds: (d.templateIds ?? []).map(String),
    updatedAt: d.updatedAt.toISOString(),
  };
}

// POST /tickets/:id/messages — send a reply / reply-all / forward, or add an internal note.
composeRouter.post('/tickets/:id/messages', requireAuth, async (req, res) => {
  const ticket = await loadTicket(String(req.params.id));
  const body = parseBody(Compose, req);
  const outcome = await sendTicketMessage(ticket, currentUser(req), body);
  const messages = await MessageModel.find({ ticketId: ticket._id }).sort({ sentAt: -1 });
  const result: SendResultDto = {
    ...(await toTicketDetail(ticket, messages)),
    heldForApproval: outcome.held?.reason ?? null,
  };
  res.status(201).json(result);
});

// POST /tickets/:id/attachments — stage files for a reply (multipart field "files").
composeRouter.post('/tickets/:id/attachments', requireAuth, upload.array('files', 10), async (req, res) => {
  const ticket = await loadTicket(String(req.params.id));
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) throw new HttpError(400, 'Choose at least one file');

  const saved: AttachmentDto[] = [];
  for (const f of files) {
    // Officer uploads aren't in the mailbox yet, so they're always kept in the database.
    const meta = await attachmentStore.save(
      {
        filename: safeFilename(f.originalname),
        contentType: f.mimetype || 'application/octet-stream',
        size: f.size,
        ticketId: ticket._id,
      },
      async () => f.buffer,
    );
    saved.push({ id: meta.id, filename: meta.filename, contentType: meta.contentType, size: meta.size });
  }
  res.status(201).json(saved);
});

// POST /tickets/:id/attachments/from-template/:templateId — stage copies of a template's form files.
composeRouter.post('/tickets/:id/attachments/from-template/:templateId', requireAuth, async (req, res) => {
  const ticket = await loadTicket(String(req.params.id));
  const template = await TemplateModel.findById(objectId.parse(req.params.templateId), { attachmentIds: 1 }).lean();
  if (!template) throw new HttpError(404, 'Template not found');
  res.status(201).json(await copyTemplateFiles(template.attachmentIds, ticket._id));
});

// GET /tickets/:id/draft — the signed-in officer's most recent unsent draft on this ticket, if any.
composeRouter.get('/tickets/:id/draft', requireAuth, async (req, res) => {
  const ticket = await loadTicket(String(req.params.id), { includeDeleted: true });
  const draft = await DraftModel.findOne({ ticketId: ticket._id, authorId: currentUser(req)._id }).sort({
    updatedAt: -1,
  });
  res.json(draft ? await toDraftDto(draft) : null);
});

// PUT /tickets/:id/draft — autosave (one draft per ticket, officer and kind).
composeRouter.put('/tickets/:id/draft', requireAuth, async (req, res) => {
  const ticket = await loadTicket(String(req.params.id));
  const body = parseBody(Compose, req);
  const draft = await DraftModel.findOneAndUpdate(
    { ticketId: ticket._id, authorId: currentUser(req)._id, kind: body.kind },
    {
      $set: {
        to: body.to,
        cc: body.cc,
        subject: body.subject,
        bodyHtml: body.kind === 'note' ? sanitizeNoteHtml(body.bodyHtml) : sanitizeEmailHtml(body.bodyHtml),
        attachmentIds: body.attachmentIds.map((id) => new Types.ObjectId(id)),
        templateIds: body.templateIds.map((id) => new Types.ObjectId(id)),
      },
    },
    { upsert: true, returnDocument: 'after' },
  );
  res.json(await toDraftDto(draft));
});

// DELETE /tickets/:id/draft?kind=reply — discard a draft.
composeRouter.delete('/tickets/:id/draft', requireAuth, async (req, res) => {
  const ticket = await loadTicket(String(req.params.id));
  const kind = z.enum(DRAFT_KINDS).optional().parse(req.query.kind);
  await DraftModel.deleteMany({ ticketId: ticket._id, authorId: currentUser(req)._id, ...(kind ? { kind } : {}) });
  res.status(204).end();
});
