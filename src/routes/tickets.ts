import { Router } from 'express';
import { Types, type QueryFilter } from 'mongoose';
import { z } from 'zod';
import {
  SYSTEM_VIEWS,
  TICKET_PRIORITIES,
  type BulkResultDto,
  type SystemView,
  type TicketCountsDto,
  type TicketListResponse,
} from '../shared.js';
import { HttpError, parseBody } from '../lib/http.js';
import { audit } from '../models/AuditLog.js';
import { CategoryModel } from '../models/Category.js';
import { DraftModel } from '../models/Draft.js';
import { FolderModel } from '../models/Folder.js';
import { MessageModel } from '../models/Message.js';
import { NotificationModel } from '../models/Notification.js';
import { PendingReplyModel } from '../models/PendingReply.js';
import { TicketModel, type Ticket, type TicketDoc } from '../models/Ticket.js';
import { currentUser, requireAuth, requireRole } from '../middleware/auth.js';
import { namesForTickets, toTicketDetail, toTicketSummary } from '../services/tickets/dto.js';
import { BulkBody, BulkIdsBody, PatchBody, nextCategoryIds } from '../services/tickets/patchSchema.js';
import { applyTicketPatch, checkPatch } from '../services/tickets/update.js';
import { snoozedHiddenFilter } from '../services/tickets/followUpRules.js';
import { makeSnippet } from '../services/mail/sanitize.js';
import { applySla } from '../services/automation/sla.js';
import { autoAcknowledge } from '../services/automation/autoAck.js';
import { nextTicketReference } from '../models/Counter.js';
import { currentViewers } from '../services/realtime/io.js';
import { getSettings } from '../models/Settings.js';
import { purgeTicket, restoreTicket, softDeleteTicket } from '../services/tickets/retention.js';
import { enquiryCsv, sendCsv } from '../services/reports/exports.js';
import { EXPORT_ROW_LIMIT } from '../services/reports/reports.js';

export const ticketsRouter = Router();
ticketsRouter.use('/tickets', requireAuth);

const PAGE_SIZE = 50;
const objectId = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');

const ListQuery = z.object({
  view: z.string().default('inbox'),
  tab: z.enum(['open', 'resolved']).default('open'),
  q: z.string().trim().max(200).optional(),
  cursor: z.string().optional(),
});

/**
 * MongoDB text search matches ANY of the words by default, so "REG-2026-000630" would match every
 * email mentioning 2026. A single plain word keeps word-form matching ("dividends" finds
 * "dividend"); anything else requires every word (quoted terms are ANDed and matched as typed).
 */
export function textSearchExpression(q: string): string {
  const terms = q.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 1 && /^[\p{L}]+$/u.test(terms[0]!)) return terms[0]!;
  return terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' ');
}

/**
 * Matches the reference, subject or shareholder's name/email/phone (partial text), or any word in
 * the messages themselves (full-text index, so "dividends" also finds "dividend").
 */
async function searchFilter(q: string): Promise<QueryFilter<Ticket>> {
  const re = new RegExp(escapeRegex(q), 'i');
  const inMessages = await MessageModel.find({ $text: { $search: textSearchExpression(q) } }, { ticketId: 1 })
    .limit(2000)
    .lean();
  return {
    $or: [
      { reference: re },
      { subject: re },
      { 'contact.name': re },
      { 'contact.email': re },
      { 'contact.phone': re },
      { _id: { $in: [...new Set(inMessages.map((m) => m.ticketId.toString()))].map((id) => new Types.ObjectId(id)) } },
    ],
  };
}

/** Tickets where this officer has an unsent draft (drives the Drafts view and the [Draft] marker). */
async function myDraftTicketIds(userId: Types.ObjectId): Promise<Types.ObjectId[]> {
  return DraftModel.distinct('ticketId', { authorId: userId });
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function encodeCursor(t: { lastMessageAt: Date; _id: Types.ObjectId }) {
  return Buffer.from(`${t.lastMessageAt.toISOString()}|${t._id.toString()}`).toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; id: Types.ObjectId } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const date = new Date(at ?? '');
  if (!id || !Types.ObjectId.isValid(id) || Number.isNaN(date.getTime())) throw new HttpError(400, 'Invalid cursor');
  return { at: date, id: new Types.ObjectId(id) };
}

/** Mongo filter for a system view or `folder:<id>`. */
/** Enquiries where a colleague has @mentioned this officer in a note (read or not). */
async function mentionedTicketIds(userId: Types.ObjectId): Promise<Types.ObjectId[]> {
  return NotificationModel.distinct('ticketId', { userId, type: 'mention' });
}

/**
 * Enquiries with a reply waiting for approval: all of them for supervisors and admins (who
 * approve), only the officer's own for agents.
 */
async function awaitingApprovalTicketIds(user: { _id: Types.ObjectId; role: string }): Promise<Types.ObjectId[]> {
  return PendingReplyModel.distinct('ticketId', {
    status: { $in: ['pending', 'sending'] },
    ...(user.role === 'agent' && { authorId: user._id }),
  });
}

/** The ids a view lists when it's defined by other collections (Mentioned me, Awaiting approval). */
async function viewTicketIds(view: string, user: { _id: Types.ObjectId; role: string }) {
  if (view === 'mentions') return mentionedTicketIds(user._id);
  if (view === 'approvals') return awaitingApprovalTicketIds(user);
  return [];
}

function viewFilter(
  view: string,
  userId: Types.ObjectId,
  draftTicketIds: Types.ObjectId[],
  /** For views listing a fixed set of enquiries (see viewTicketIds). */
  viewIds: Types.ObjectId[] = [],
): QueryFilter<Ticket> {
  if (view.startsWith('folder:')) {
    const id = view.slice('folder:'.length);
    if (!Types.ObjectId.isValid(id)) throw new HttpError(400, 'Unknown folder');
    return { folderId: new Types.ObjectId(id) };
  }
  switch (view as SystemView) {
    case 'inbox':
      return {};
    case 'mine':
      return { assigneeId: userId };
    case 'mentions':
    case 'approvals':
      return { _id: { $in: viewIds } };
    case 'unassigned':
      return { assigneeId: null, status: { $ne: 'resolved' } };
    case 'overdue':
      return { isOverdue: true, status: { $ne: 'resolved' } };
    case 'followups':
      // Every enquiry with a follow-up set, snoozed or not (G-04.3).
      return { followUp: { $ne: null } };
    case 'drafts':
      // Enquiries where the signed-in officer has an unsent reply, forward or note.
      return { _id: { $in: draftTicketIds } };
    case 'deleted':
      // Handled by the list route itself (it's the one view that shows deleted enquiries).
      return {};
    default:
      throw new HttpError(400, 'Unknown view');
  }
}

type ListQueryInput = z.infer<typeof ListQuery>;

/**
 * The Mongo filter for what the message list shows: a view and Open/Resolved tab, a search across
 * everything, or Deleted items (supervisors and admins only). The cursor is the caller's concern.
 */
async function listFilter(
  query: ListQueryInput,
  user: { _id: Types.ObjectId; role: string },
  draftTicketIds: Types.ObjectId[],
): Promise<{ filter: QueryFilter<Ticket>; and: QueryFilter<Ticket>[]; deletedView: boolean }> {
  // Deleted items: supervisors and admins only, every status, newest first. Search stays out of it.
  const deletedView = query.view === 'deleted' && !query.q;
  if (deletedView && !canManageDeleted(user.role)) {
    throw new HttpError(403, 'Only supervisors and admins can see deleted enquiries');
  }

  // Searching looks across every enquiry (all views, folders, open and resolved), as Outlook does.
  const searching = Boolean(query.q);
  const filter: QueryFilter<Ticket> = deletedView
    ? { deletedAt: { $ne: null } }
    : {
        deletedAt: null,
        ...(searching ? {} : viewFilter(query.view, user._id, draftTicketIds, await viewTicketIds(query.view, user))),
      };
  const and: QueryFilter<Ticket>[] = searching
    ? [await searchFilter(query.q!)]
    : deletedView
      ? []
      : [query.tab === 'resolved' ? { status: 'resolved' } : { status: { $ne: 'resolved' } }];
  // Snoozed enquiries stay out of sight until due, except in Follow-ups and search.
  if (!searching && !deletedView && query.view !== 'followups') and.push(snoozedHiddenFilter(new Date()));
  return { filter, and, deletedView };
}

// GET /tickets/export.csv?view=&tab=&q= — everything the message list shows (not just the loaded
// page) as CSV. It carries shareholder details, so supervisors and admins only (GAP_ANALYSIS G-06.2).
ticketsRouter.get('/tickets/export.csv', requireRole('supervisor', 'admin'), async (req, res) => {
  const query = ListQuery.parse(req.query);
  const user = currentUser(req);
  const { filter, and } = await listFilter(query, user, await myDraftTicketIds(user._id));
  const docs = await TicketModel.find({ ...filter, ...(and.length && { $and: and }) })
    .sort({ lastMessageAt: -1, _id: -1 })
    .limit(EXPORT_ROW_LIMIT)
    .lean();
  await sendCsv(req, res, await enquiryCsv(docs), {
    kind: 'list',
    view: query.view,
    tab: query.tab,
    q: query.q ?? null,
  });
});

// GET /tickets?view=inbox|mine|…|folder:<id>&tab=open|resolved&q=&cursor=
ticketsRouter.get('/tickets', async (req, res) => {
  const query = ListQuery.parse(req.query);
  const user = currentUser(req);
  const draftTicketIds = await myDraftTicketIds(user._id);
  const { filter, and, deletedView } = await listFilter(query, user, draftTicketIds);
  if (query.cursor) {
    const c = decodeCursor(query.cursor);
    and.push({ $or: [{ lastMessageAt: { $lt: c.at } }, { lastMessageAt: c.at, _id: { $lt: c.id } }] });
  }

  const docs = await TicketModel.find({ ...filter, ...(and.length && { $and: and }) })
    .sort({ lastMessageAt: -1, _id: -1 })
    .limit(PAGE_SIZE + 1);
  const page = docs.slice(0, PAGE_SIZE);
  const names = await namesForTickets(page);
  const purgeDays = deletedView ? ((await getSettings()).retention?.purgeDeletedAfterDays ?? null) : null;

  const body: TicketListResponse = {
    items: page.map((t) => toTicketSummary(t, names, new Set(draftTicketIds.map(String)), purgeDays)),
    nextCursor: docs.length > PAGE_SIZE ? encodeCursor(page[page.length - 1]!) : null,
  };
  res.json(body);
});

// GET /tickets/counts — unread counts for the folder pane.
ticketsRouter.get('/tickets/counts', async (req, res) => {
  const user = currentUser(req);
  const now = new Date();
  const base = { deletedAt: null, status: { $ne: 'resolved' as const } };
  // Matches the lists: snoozed enquiries aren't counted until they're due.
  const unread = { ...base, isUnread: true, ...snoozedHiddenFilter(now) };

  const [inbox, mine, unassigned, overdue, followups, byFolder, drafts, deleted, mentions, approvals] =
    await Promise.all([
      TicketModel.countDocuments(unread),
      TicketModel.countDocuments({ ...unread, assigneeId: user._id }),
      TicketModel.countDocuments({ ...unread, assigneeId: null }),
      TicketModel.countDocuments({ ...base, isOverdue: true, ...snoozedHiddenFilter(now) }),
      TicketModel.countDocuments({ ...base, 'followUp.at': { $lte: now } }),
      TicketModel.aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { ...unread, folderId: { $ne: null } } },
        { $group: { _id: '$folderId', n: { $sum: 1 } } },
      ]),
      myDraftTicketIds(user._id).then((ids) => TicketModel.countDocuments({ _id: { $in: ids }, deletedAt: null })),
      canManageDeleted(user.role) ? TicketModel.countDocuments({ deletedAt: { $ne: null } }) : 0,
      // Enquiries with a mention of me I haven't seen yet.
      NotificationModel.distinct('ticketId', { userId: user._id, type: 'mention', readAt: null }).then((ids) =>
        TicketModel.countDocuments({ _id: { $in: ids }, deletedAt: null }),
      ),
      awaitingApprovalTicketIds(user).then((ids) => TicketModel.countDocuments({ _id: { $in: ids }, deletedAt: null })),
    ]);

  const body: TicketCountsDto = {
    views: { inbox, mine, mentions, approvals, unassigned, overdue, followups, drafts, deleted } satisfies Record<
      (typeof SYSTEM_VIEWS)[number],
      number
    >,
    folders: Object.fromEntries(byFolder.map((f) => [f._id.toString(), f.n])),
  };
  res.json(body);
});

// GET /tickets/:id/presence — who has this enquiry open (the browser normally gets this over the socket).
ticketsRouter.get('/tickets/:id/presence', (req, res) => {
  res.json(currentViewers(objectId.parse(req.params.id)));
});

ticketsRouter.get('/tickets/:id', async (req, res) => {
  const id = objectId.parse(req.params.id);
  // Fetch the ticket and its messages (newest first, as in the reading pane) in parallel.
  const [ticket, messages] = await Promise.all([
    TicketModel.findById(id),
    MessageModel.find({ ticketId: id }).sort({ sentAt: -1 }),
  ]);
  // A deleted enquiry can still be opened (read-only) from Deleted items, by those who manage it.
  if (!ticket || (ticket.deletedAt && !canManageDeleted(currentUser(req).role))) {
    throw new HttpError(404, 'Enquiry not found');
  }
  const detail = await toTicketDetail(ticket, messages);
  detail.hasDraft = Boolean(await DraftModel.exists({ ticketId: ticket._id, authorId: currentUser(req)._id }));
  res.json(detail);
});

ticketsRouter.patch('/tickets/:id', async (req, res) => {
  const id = objectId.parse(req.params.id);
  const patch = parseBody(PatchBody, req);
  const user = currentUser(req);

  const ticket = await TicketModel.findOne({ _id: id, deletedAt: null });
  if (!ticket) throw new HttpError(404, 'Enquiry not found');
  await applyTicketPatch(ticket, patch, user, await checkPatch(patch));
  res.json(toTicketSummary(ticket, await namesForTickets([ticket])));
});

// ── Bulk actions (GAP_ANALYSIS G-04.2) ─────────────────────────────────────────

/** How many enquiries are changed at once; enough to be quick without flooding the database. */
const BULK_CONCURRENCY = 8;

/** Runs `fn` on each enquiry, a few at a time, collecting refusals instead of stopping at the first. */
async function forEachTicket(
  ids: string[],
  tickets: TicketDoc[],
  fn: (t: TicketDoc) => Promise<void>,
): Promise<BulkResultDto> {
  const result: BulkResultDto = { updated: [], failed: [] };
  const byId = new Map(tickets.map((t) => [t._id.toString(), t]));
  for (const id of new Set(ids)) {
    if (!byId.has(id)) result.failed.push({ id, reference: null, error: 'Enquiry not found' });
  }
  for (let i = 0; i < tickets.length; i += BULK_CONCURRENCY) {
    await Promise.all(
      tickets.slice(i, i + BULK_CONCURRENCY).map(async (t) => {
        try {
          await fn(t);
          result.updated.push(t._id.toString());
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          result.failed.push({ id: t._id.toString(), reference: t.reference, error: err.message });
        }
      }),
    );
  }
  return result;
}

// POST /tickets/bulk — one change applied to several enquiries. Each is checked and audited as if
// changed on its own; anything refused (e.g. an agent assigning someone else's) is reported back.
ticketsRouter.post('/tickets/bulk', async (req, res) => {
  const { ids, patch } = parseBody(BulkBody, req);
  const user = currentUser(req);
  const reason = await checkPatch(patch);
  const tickets = await TicketModel.find({ _id: { $in: ids }, deletedAt: null });

  const { addCategoryIds, removeCategoryIds, ...rest } = patch;
  const result = await forEachTicket(ids, tickets, async (t) => {
    const categoryIds =
      addCategoryIds || removeCategoryIds
        ? nextCategoryIds(t.categoryIds.map(String), addCategoryIds, removeCategoryIds)
        : undefined;
    await applyTicketPatch(t, { ...rest, ...(categoryIds && { categoryIds }) }, user, reason);
  });
  await audit({
    actorId: user._id,
    action: 'ticket.bulk_updated',
    meta: { fields: Object.keys(patch), updated: result.updated.length, failed: result.failed.length },
  });
  res.json(result);
});

const CreateEnquiry = z
  .object({
    origin: z.enum(['phone', 'walk_in']),
    contact: z.object({
      name: z.string().trim().min(1, 'Enter the shareholder’s name').max(200),
      email: z.union([z.email(), z.literal('')]).optional(),
      phone: z.string().trim().max(40).optional(),
    }),
    subject: z.string().trim().min(1, 'Enter a subject').max(300),
    details: z.string().trim().min(1, 'Describe the enquiry').max(20_000),
    folderId: objectId.nullable().default(null),
    categoryIds: z.array(objectId).max(20).default([]),
    priority: z.enum(TICKET_PRIORITIES).default('normal'),
    assignToMe: z.boolean().default(true),
  })
  .strict();

// POST /tickets — log a phone call or walk-in as an enquiry (BUILD_SPEC §6 "New Enquiry").
ticketsRouter.post('/tickets', async (req, res) => {
  const body = parseBody(CreateEnquiry, req);
  const user = currentUser(req);

  if (body.folderId && !(await FolderModel.exists({ _id: body.folderId }))) throw new HttpError(400, 'Unknown folder');
  const categoryIds = [...new Set(body.categoryIds)];
  if ((await CategoryModel.countDocuments({ _id: { $in: categoryIds } })) !== categoryIds.length) {
    throw new HttpError(400, 'Unknown category');
  }

  const now = new Date();
  const contact = {
    name: body.contact.name,
    email: body.contact.email?.toLowerCase() ?? '',
    phone: body.contact.phone ?? '',
  };
  const details = body.details;
  const bodyHtml = details
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`).replace(/\n/g, '<br>')}</p>`)
    .join('');

  const ticket = await TicketModel.create({
    reference: await nextTicketReference(now),
    subject: body.subject,
    status: body.assignToMe ? 'assigned' : 'new',
    origin: body.origin,
    contact,
    folderId: body.folderId,
    categoryIds,
    priority: body.priority,
    assigneeId: body.assignToMe ? user._id : null,
    assignedAt: body.assignToMe ? now : null,
    lastMessageAt: now,
    slaStartAt: now,
    // Logged by the officer, so it's already been seen.
    isUnread: false,
    snippet: makeSnippet(details),
    messageCount: 1,
  });
  await applySla(ticket);
  await ticket.save();
  // What the shareholder asked, recorded as their message and marked as logged by this officer.
  await MessageModel.create({
    ticketId: ticket._id,
    direction: 'inbound',
    from: { name: contact.name, email: contact.email },
    bodyHtml,
    bodyText: details,
    authorId: user._id,
    sentAt: now,
  });
  await audit({
    actorId: user._id,
    action: 'ticket.created',
    ticketId: ticket._id,
    meta: { origin: body.origin, reference: ticket.reference, assignedToSelf: body.assignToMe },
  });
  // With an email address and auto-acknowledgement on, they get the acknowledgement too (new email).
  if (contact.email) {
    await autoAcknowledge(ticket, { receivedAt: now, graphMessageId: null }).catch((err: unknown) =>
      req.log.warn({ err }, 'Auto-acknowledgement failed'),
    );
  }

  res.status(201).json(toTicketSummary(ticket, await namesForTickets([ticket])));
});

// ── Delete, restore, permanently delete (BUILD_SPEC §10) ──────────────────────

/** Supervisors and admins delete and restore; agents can't, to prevent accidental deletion. */
function canManageDeleted(role: string) {
  return role === 'supervisor' || role === 'admin';
}

// POST /tickets/bulk/delete and /bulk/restore — the same, for several enquiries at once.
ticketsRouter.post('/tickets/bulk/delete', requireRole('supervisor', 'admin'), async (req, res) => {
  const { ids } = parseBody(BulkIdsBody, req);
  const user = currentUser(req);
  const tickets = await TicketModel.find({ _id: { $in: ids }, deletedAt: null });
  res.json(await forEachTicket(ids, tickets, (t) => softDeleteTicket(t, user._id, 'deleted by an officer')));
});

ticketsRouter.post('/tickets/bulk/restore', requireRole('supervisor', 'admin'), async (req, res) => {
  const { ids } = parseBody(BulkIdsBody, req);
  const user = currentUser(req);
  const tickets = await TicketModel.find({ _id: { $in: ids }, deletedAt: { $ne: null } });
  res.json(await forEachTicket(ids, tickets, (t) => restoreTicket(t, user._id, 'restored by an officer')));
});

// DELETE /tickets/:id — move to Deleted items (restorable until the retention purge).
ticketsRouter.delete('/tickets/:id', requireRole('supervisor', 'admin'), async (req, res) => {
  const ticket = await TicketModel.findOne({ _id: objectId.parse(req.params.id), deletedAt: null });
  if (!ticket) throw new HttpError(404, 'Enquiry not found');
  await softDeleteTicket(ticket, currentUser(req)._id, 'deleted by an officer');
  res.status(204).end();
});

// POST /tickets/:id/restore — back out of Deleted items, as it was.
ticketsRouter.post('/tickets/:id/restore', requireRole('supervisor', 'admin'), async (req, res) => {
  const ticket = await TicketModel.findOne({ _id: objectId.parse(req.params.id), deletedAt: { $ne: null } });
  if (!ticket) throw new HttpError(404, 'Enquiry not found in Deleted items');
  await restoreTicket(ticket, currentUser(req)._id, 'restored by an officer');
  res.json(toTicketSummary(ticket, await namesForTickets([ticket])));
});

// DELETE /tickets/:id/permanent — remove a deleted enquiry for good now (admins only).
ticketsRouter.delete('/tickets/:id/permanent', requireRole('admin'), async (req, res) => {
  await purgeTicket(
    new Types.ObjectId(objectId.parse(req.params.id)),
    currentUser(req)._id,
    'deleted permanently by an admin',
  );
  res.status(204).end();
});
