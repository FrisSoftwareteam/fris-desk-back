import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { CATEGORY_TYPES, TICKET_STATUSES } from '../shared.js';
import { HttpError, parseBody, parsePatch } from '../lib/http.js';
import { audit } from '../models/AuditLog.js';
import { TicketModel } from '../models/Ticket.js';
import type { CategoryDto, FolderDto, MailboxStatusDto, StaffDto } from '../shared.js';
import { env, graphConfigured } from '../config/env.js';
import { CategoryModel } from '../models/Category.js';
import { FolderModel } from '../models/Folder.js';
import { MailboxModel } from '../models/Mailbox.js';
import { UserModel } from '../models/User.js';
import { currentUser, requireAuth, requireRole } from '../middleware/auth.js';
import { currentSyncProblem } from '../services/mail/sync.js';
import { StatusReasonModel } from '../models/StatusReason.js';
import { invalidateStatusReasons, listStatusReasons } from '../services/tickets/statusReasons.js';
import { notifyTicketChanged } from '../services/realtime/changes.js';

// Read-only reference data for the mail screen. Admin CRUD for these arrives in Phases 4 and 7.
export const lookupsRouter = Router();

lookupsRouter.get('/folders', requireAuth, async (_req, res) => {
  const folders = await FolderModel.find().sort({ order: 1, name: 1 }).lean();
  const body: FolderDto[] = folders.map((f) => ({
    id: f._id.toString(),
    name: f.name,
    order: f.order,
    parentId: f.parentId ? f.parentId.toString() : null,
    // Unread counts come from GET /tickets/counts.
    unreadCount: 0,
  }));
  res.json(body);
});

lookupsRouter.get('/categories', requireAuth, async (_req, res) => {
  const categories = await CategoryModel.find().sort({ type: 1, name: 1 }).lean();
  const body: CategoryDto[] = categories.map((c) => ({
    id: c._id.toString(),
    name: c.name,
    type: c.type,
    color: c.color,
  }));
  res.json(body);
});

// Active staff, for assignee pickers.
lookupsRouter.get('/users', requireAuth, async (_req, res) => {
  const users = await UserModel.find({ isActive: true }).sort({ displayName: 1 }).lean();
  const body: StaffDto[] = users.map((u) => ({
    id: u._id.toString(),
    displayName: u.displayName,
    email: u.email,
    role: u.role,
  }));
  res.json(body);
});

lookupsRouter.get('/mailbox', requireAuth, async (_req, res) => {
  const address = env.GRAPH_SHARED_MAILBOX?.toLowerCase() ?? null;
  const mailbox = address ? await MailboxModel.findOne({ address }).lean() : null;
  const body: MailboxStatusDto = {
    address,
    displayName: mailbox?.displayName ?? 'Shareholder Enquiries',
    syncEnabled: graphConfigured && env.GRAPH_SYNC_ENABLED,
    pushEnabled: Boolean(
      mailbox?.graphSubscriptionId && mailbox.subscriptionExpiresAt && mailbox.subscriptionExpiresAt > new Date(),
    ),
    pollIntervalSeconds: env.GRAPH_POLL_INTERVAL_SECONDS,
    lastSyncAt: mailbox?.lastSyncAt ? mailbox.lastSyncAt.toISOString() : null,
    lastSyncError: currentSyncProblem() ?? mailbox?.lastSyncError ?? null,
    sendAllowlist: env.MAIL_SEND_ALLOWLIST.length > 0 ? env.MAIL_SEND_ALLOWLIST : null,
  };
  res.json(body);
});

// ── Admin: folders and categories (screens arrive in Phase 7) ─────────────────

const objectId = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');
const FolderBody = z.object({
  name: z.string().trim().min(1).max(80),
  order: z.number().int().min(0).max(10_000).default(0),
  parentId: objectId.nullable().default(null),
});
const CategoryBody = z.object({
  name: z.string().trim().min(1).max(60),
  type: z.enum(CATEGORY_TYPES),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a hex value like #0f6cbd'),
});

lookupsRouter.post('/folders', requireAuth, requireRole('admin'), async (req, res) => {
  const body = parseBody(FolderBody, req);
  const folder = await FolderModel.create(body);
  await audit({
    actorId: currentUser(req)._id,
    action: 'folder.created',
    meta: { folderId: folder._id, name: folder.name },
  });
  res.status(201).json({
    id: folder._id.toString(),
    name: folder.name,
    order: folder.order,
    parentId: body.parentId,
    unreadCount: 0,
  });
});

lookupsRouter.patch('/folders/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const body = parsePatch(FolderBody.partial().strict(), req);
  const folder = await FolderModel.findByIdAndUpdate(objectId.parse(req.params.id), body, { returnDocument: 'after' });
  if (!folder) throw new HttpError(404, 'Folder not found');
  await audit({
    actorId: currentUser(req)._id,
    action: 'folder.updated',
    meta: { folderId: folder._id, changes: body },
  });
  res.json({
    id: folder._id.toString(),
    name: folder.name,
    order: folder.order,
    parentId: folder.parentId?.toString() ?? null,
    unreadCount: 0,
  });
});

// Deleting a folder never deletes enquiries: they return to "All enquiries" (no folder).
lookupsRouter.delete('/folders/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const id = new Types.ObjectId(objectId.parse(req.params.id));
  const folder = await FolderModel.findByIdAndDelete(id);
  if (!folder) throw new HttpError(404, 'Folder not found');
  const moved = await TicketModel.updateMany({ folderId: id }, { $set: { folderId: null } });
  await FolderModel.updateMany({ parentId: id }, { $set: { parentId: null } });
  await audit({
    actorId: currentUser(req)._id,
    action: 'folder.deleted',
    meta: { folderId: id, name: folder.name, ticketsUnfiled: moved.modifiedCount },
  });
  res.status(204).end();
});

lookupsRouter.post('/categories', requireAuth, requireRole('admin'), async (req, res) => {
  const body = parseBody(CategoryBody, req);
  const c = await CategoryModel.create({ ...body, color: body.color.toLowerCase() });
  await audit({ actorId: currentUser(req)._id, action: 'category.created', meta: { categoryId: c._id, name: c.name } });
  res.status(201).json({ id: c._id.toString(), name: c.name, type: c.type, color: c.color });
});

lookupsRouter.patch('/categories/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const body = parsePatch(CategoryBody.partial().strict(), req);
  const c = await CategoryModel.findByIdAndUpdate(
    objectId.parse(req.params.id),
    { ...body, ...(body.color && { color: body.color.toLowerCase() }) },
    { returnDocument: 'after' },
  );
  if (!c) throw new HttpError(404, 'Category not found');
  await audit({
    actorId: currentUser(req)._id,
    action: 'category.updated',
    meta: { categoryId: c._id, changes: body },
  });
  res.json({ id: c._id.toString(), name: c.name, type: c.type, color: c.color });
});

// Deleting a category removes it from every enquiry that had it.
lookupsRouter.delete('/categories/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const id = new Types.ObjectId(objectId.parse(req.params.id));
  const c = await CategoryModel.findByIdAndDelete(id);
  if (!c) throw new HttpError(404, 'Category not found');
  const cleared = await TicketModel.updateMany({ categoryIds: id }, { $pull: { categoryIds: id } });
  await audit({
    actorId: currentUser(req)._id,
    action: 'category.deleted',
    meta: { categoryId: id, name: c.name, ticketsUpdated: cleared.modifiedCount },
  });
  res.status(204).end();
});

// ── Stages within a status (Admin → Statuses, GAP_ANALYSIS G-04.7) ────────────

const StatusReasonBody = z.object({
  name: z.string().trim().min(1).max(60),
  baseStatus: z.enum(TICKET_STATUSES),
  order: z.number().int().min(0).max(10_000).default(0),
  isActive: z.boolean().default(true),
});

// Everyone needs the list (it names the stage on each enquiry), including retired stages.
lookupsRouter.get('/status-reasons', requireAuth, async (_req, res) => {
  res.json(await listStatusReasons());
});

lookupsRouter.post('/status-reasons', requireAuth, requireRole('admin'), async (req, res) => {
  const body = parseBody(StatusReasonBody, req);
  const r = await StatusReasonModel.create(body);
  invalidateStatusReasons();
  await audit({ actorId: currentUser(req)._id, action: 'status_reason.created', meta: { id: r._id, ...body } });
  res.status(201).json((await listStatusReasons()).find((x) => x.id === r._id.toString()));
});

// The parent status can't change: enquiries at this stage would then sit under the wrong status.
lookupsRouter.patch('/status-reasons/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const body = parsePatch(StatusReasonBody.omit({ baseStatus: true }).partial().strict(), req);
  const r = await StatusReasonModel.findByIdAndUpdate(objectId.parse(req.params.id), body, { returnDocument: 'after' });
  if (!r) throw new HttpError(404, 'Stage not found');
  invalidateStatusReasons();
  await audit({ actorId: currentUser(req)._id, action: 'status_reason.updated', meta: { id: r._id, changes: body } });
  res.json((await listStatusReasons()).find((x) => x.id === r._id.toString()));
});

// Deleting a stage takes it off every enquiry at that stage; their status stays as it is.
lookupsRouter.delete('/status-reasons/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const id = new Types.ObjectId(objectId.parse(req.params.id));
  const r = await StatusReasonModel.findByIdAndDelete(id);
  if (!r) throw new HttpError(404, 'Stage not found');
  const affected = await TicketModel.find({ statusReasonId: id }, { _id: 1 }).lean();
  await TicketModel.updateMany({ statusReasonId: id }, { $set: { statusReasonId: null } });
  affected.forEach((t) => notifyTicketChanged(t._id.toString()));
  invalidateStatusReasons();
  await audit({
    actorId: currentUser(req)._id,
    action: 'status_reason.deleted',
    meta: { id, name: r.name, ticketsUpdated: affected.length },
  });
  res.status(204).end();
});
