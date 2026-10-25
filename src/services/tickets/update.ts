import { Types } from 'mongoose';
import type { StatusReasonDto } from '../../shared.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../models/AuditLog.js';
import { CategoryModel } from '../../models/Category.js';
import { FolderModel } from '../../models/Folder.js';
import type { TicketDoc } from '../../models/Ticket.js';
import { UserModel, type UserDoc } from '../../models/User.js';
import { applySla } from '../automation/sla.js';
import { getStatusReasons } from './statusReasons.js';
import type { BulkPatch, TicketPatch } from './patchSchema.js';

// Officer changes to an enquiry: status, stage, assignee, folder, categories, priority, read state
// and follow-up. Shared by PATCH /tickets/:id and the bulk route, so both apply the same rules.

/**
 * Checks everything a patch refers to (once, however many enquiries it's for) and returns the
 * chosen stage, if any.
 */
export async function checkPatch(patch: TicketPatch | BulkPatch, now = new Date()): Promise<StatusReasonDto | null> {
  const categoryIds = [
    ...new Set([
      ...(('categoryIds' in patch && patch.categoryIds) || []),
      ...(('addCategoryIds' in patch && patch.addCategoryIds) || []),
    ]),
  ];
  if (
    categoryIds.length &&
    (await CategoryModel.countDocuments({ _id: { $in: categoryIds } })) !== categoryIds.length
  ) {
    throw new HttpError(400, 'Unknown category');
  }
  if (patch.folderId && !(await FolderModel.exists({ _id: patch.folderId })))
    throw new HttpError(400, 'Unknown folder');
  if (patch.assigneeId && !(await UserModel.exists({ _id: patch.assigneeId, isActive: true }))) {
    throw new HttpError(400, 'That officer does not exist or is inactive');
  }
  if (patch.followUp && new Date(patch.followUp.at).getTime() <= now.getTime()) {
    throw new HttpError(400, 'Choose a follow-up time in the future');
  }

  if (!patch.statusReasonId) return null;
  const reason = (await getStatusReasons()).get(patch.statusReasonId);
  if (!reason?.isActive) throw new HttpError(400, 'That stage does not exist or has been retired');
  if (patch.status && patch.status !== reason.baseStatus) {
    throw new HttpError(400, 'That stage belongs to a different status');
  }
  return reason;
}

type Change = { before: unknown; after: unknown; note?: string };

/**
 * Applies a checked patch to one enquiry, saves it (which announces the change to open browsers)
 * and records it in the audit log. Returns what changed. Throws 403 when an agent tries to assign
 * someone else's enquiry.
 */
export async function applyTicketPatch(
  ticket: TicketDoc,
  patch: TicketPatch,
  user: UserDoc,
  reason: StatusReasonDto | null,
): Promise<Record<string, Change>> {
  const changes: Record<string, Change> = {};
  const track = (field: string, before: unknown, after: unknown) => {
    if (String(before) !== String(after)) changes[field] = { before, after };
  };
  // Choosing a stage chooses its status too.
  const status = reason ? reason.baseStatus : patch.status;

  if (patch.assigneeId !== undefined) {
    const current = ticket.assigneeId?.toString() ?? null;
    if (patch.assigneeId !== current) {
      // Agents can take a ticket or let go of their own; assigning other people is for supervisors.
      const isSelfService = patch.assigneeId === user.id || (patch.assigneeId === null && current === user.id);
      if (!isSelfService && user.role === 'agent') {
        throw new HttpError(403, 'Only supervisors and admins can assign enquiries to other officers');
      }
      track('assigneeId', current, patch.assigneeId);
      ticket.assigneeId = patch.assigneeId ? new Types.ObjectId(patch.assigneeId) : null;
      ticket.assignedAt = patch.assigneeId ? new Date() : null;
      if (patch.assigneeId && ticket.status === 'new' && !status) {
        track('status', ticket.status, 'assigned');
        ticket.status = 'assigned';
      }
    }
  }

  if (status && status !== ticket.status) {
    track('status', ticket.status, status);
    ticket.status = status;
    ticket.resolvedAt = status === 'resolved' ? new Date() : null;
    if (status === 'resolved') ticket.isOverdue = false;
  }

  if (patch.statusReasonId !== undefined) {
    track('statusReasonId', ticket.statusReasonId?.toString() ?? null, patch.statusReasonId);
    ticket.statusReasonId = patch.statusReasonId ? new Types.ObjectId(patch.statusReasonId) : null;
  }

  if (patch.categoryIds) {
    const unique = [...new Set(patch.categoryIds)];
    track('categoryIds', ticket.categoryIds.map(String).join(','), unique.join(','));
    ticket.categoryIds = unique.map((c) => new Types.ObjectId(c));
  }

  if (patch.folderId !== undefined) {
    track('folderId', ticket.folderId?.toString() ?? null, patch.folderId);
    ticket.folderId = patch.folderId ? new Types.ObjectId(patch.folderId) : null;
  }

  if (patch.priority && patch.priority !== ticket.priority) {
    track('priority', ticket.priority, patch.priority);
    ticket.priority = patch.priority;
  }

  if (patch.followUp !== undefined) {
    const before = ticket.followUp?.at.toISOString() ?? null;
    if (patch.followUp === null) {
      track('followUp', before, null);
      ticket.followUp = null;
    } else {
      const at = new Date(patch.followUp.at);
      changes.followUp = { before, after: at.toISOString(), ...(patch.followUp.note && { note: patch.followUp.note }) };
      ticket.followUp = { at, note: patch.followUp.note, hide: patch.followUp.hide, setById: user._id, dueAt: null };
    }
  }

  // Read state is a view preference, not a change to the enquiry, so it isn't audited.
  if (patch.isUnread !== undefined) ticket.isUnread = patch.isUnread;

  // Folder, categories and priority choose the SLA policy; status pauses or resumes the clock.
  if (changes.folderId || changes.categoryIds || changes.priority || changes.status) await applySla(ticket);
  await ticket.save();
  if (Object.keys(changes).length > 0) {
    await audit({ actorId: user._id, action: 'ticket.updated', ticketId: ticket._id, meta: changes });
  }
  return changes;
}
