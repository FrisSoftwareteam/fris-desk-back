import { Router } from 'express';
import multer from 'multer';
import { Types } from 'mongoose';
import { z } from 'zod';
import type { TemplateDto } from '../shared.js';
import { HttpError, parseBody, parsePatch } from '../lib/http.js';
import { audit } from '../models/AuditLog.js';
import { TemplateModel, type Template } from '../models/Template.js';
import { currentUser, requireAuth, requireRole } from '../middleware/auth.js';
import { sanitizeEmailHtml } from '../services/mail/sanitize.js';
import { storeTemplateFiles, templateFiles } from '../services/templates/files.js';
import { AttachmentModel } from '../models/Attachment.js';
import { attachmentStore } from '../services/attachments/AttachmentStore.js';

// Canned responses. Everyone can use them; supervisors and admins manage them (Admin screen: Phase 7).
export const templatesRouter = Router();

const objectId = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');
const TemplateBody = z.object({
  name: z.string().trim().min(1).max(120),
  subject: z.string().max(400).default(''),
  bodyHtml: z.string().min(1).max(200_000),
  folderId: objectId.nullable().default(null),
  attachmentIds: z.array(objectId).max(10).default([]),
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

async function toDto(t: Template & { _id: Types.ObjectId }): Promise<TemplateDto> {
  return {
    id: t._id.toString(),
    name: t.name,
    subject: t.subject,
    bodyHtml: t.bodyHtml,
    folderId: t.folderId ? t.folderId.toString() : null,
    attachments: await templateFiles(t.attachmentIds ?? []),
  };
}

/** Only files uploaded through POST /templates/files (no enquiry) may be attached to a template. */
async function checkFiles(ids: string[] | undefined) {
  if (!ids?.length) return ids?.map((id) => new Types.ObjectId(id));
  const objectIds = ids.map((id) => new Types.ObjectId(id));
  const found = await AttachmentModel.countDocuments({ _id: { $in: objectIds }, ticketId: null, storage: 'database' });
  if (found !== new Set(ids).size) throw new HttpError(400, 'A form file could not be found. Upload it again.');
  return objectIds;
}

/** Deletes form files a template no longer uses, unless another template still lists them. */
async function dropUnusedFiles(ids: Types.ObjectId[]) {
  if (ids.length === 0) return;
  const stillUsed = new Set(
    (await TemplateModel.distinct('attachmentIds', { attachmentIds: { $in: ids } })).map(String),
  );
  await attachmentStore.remove(ids.filter((id) => !stillUsed.has(id.toString())));
}

// GET /templates?folderId= — templates for every folder, plus those scoped to the given folder.
templatesRouter.get('/templates', requireAuth, async (req, res) => {
  const folderId = objectId.optional().parse(req.query.folderId || undefined);
  const filter = folderId ? { folderId: { $in: [null, new Types.ObjectId(folderId)] } } : {};
  const templates = await TemplateModel.find(filter).sort({ name: 1 }).lean();
  res.json(await Promise.all(templates.map(toDto)));
});

// POST /templates/files — upload form files for a template (multipart field "files").
templatesRouter.post(
  '/templates/files',
  requireAuth,
  requireRole('supervisor', 'admin'),
  upload.array('files', 10),
  async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) throw new HttpError(400, 'Choose at least one file');
    res.status(201).json(await storeTemplateFiles(files));
  },
);

templatesRouter.post('/templates', requireAuth, requireRole('supervisor', 'admin'), async (req, res) => {
  const body = parseBody(TemplateBody, req);
  const attachmentIds = await checkFiles(body.attachmentIds);
  const t = await TemplateModel.create({ ...body, attachmentIds, bodyHtml: sanitizeEmailHtml(body.bodyHtml) });
  await audit({ actorId: currentUser(req)._id, action: 'template.created', meta: { templateId: t._id, name: t.name } });
  res.status(201).json(await toDto(t.toObject()));
});

templatesRouter.patch('/templates/:id', requireAuth, requireRole('supervisor', 'admin'), async (req, res) => {
  const body = parsePatch(TemplateBody.partial().strict(), req);
  const attachmentIds = await checkFiles(body.attachmentIds);
  const update = {
    ...body,
    ...(attachmentIds && { attachmentIds }),
    ...(body.bodyHtml !== undefined && { bodyHtml: sanitizeEmailHtml(body.bodyHtml) }),
  };
  const before = await TemplateModel.findByIdAndUpdate(objectId.parse(req.params.id), update).lean();
  if (!before) throw new HttpError(404, 'Template not found');
  const t = (await TemplateModel.findById(before._id).lean())!;
  const kept = new Set(t.attachmentIds.map(String));
  await dropUnusedFiles(before.attachmentIds.filter((id) => !kept.has(id.toString())));
  await audit({
    actorId: currentUser(req)._id,
    action: 'template.updated',
    meta: { templateId: t._id, fields: Object.keys(body) },
  });
  res.json(await toDto(t));
});

templatesRouter.delete('/templates/:id', requireAuth, requireRole('supervisor', 'admin'), async (req, res) => {
  const t = await TemplateModel.findByIdAndDelete(objectId.parse(req.params.id)).lean();
  if (!t) throw new HttpError(404, 'Template not found');
  await dropUnusedFiles(t.attachmentIds);
  await audit({ actorId: currentUser(req)._id, action: 'template.deleted', meta: { templateId: t._id, name: t.name } });
  res.status(204).end();
});
