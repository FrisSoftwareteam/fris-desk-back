import mongoose, { mongo, type Types } from 'mongoose';
import { HttpError } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { AttachmentModel } from '../../models/Attachment.js';
import { NotificationModel } from '../../models/Notification.js';
import { PendingReplyModel } from '../../models/PendingReply.js';
import { audit, AuditLogModel } from '../../models/AuditLog.js';
import { DraftModel } from '../../models/Draft.js';
import { MessageModel } from '../../models/Message.js';
import { getSettings } from '../../models/Settings.js';
import { TicketModel, type TicketDoc } from '../../models/Ticket.js';
import { applySla } from '../automation/sla.js';
import { notifyTicketChanged } from '../realtime/changes.js';
import { DAY } from './retentionRules.js';

// Deletion and retention (BUILD_SPEC §10). Deleting moves an enquiry to "Deleted items", where it
// can be restored. Only the scheduled purge (or an admin, from Deleted items) removes it for good.
// Registrar Desk never deletes anything from the shared mailbox itself: purging removes only this
// app's copy (enquiry, messages, drafts, attachment copies, bell notifications and its activity history).

/** Per scheduled run, so one run can't hold the database for long; the rest go next time. */
const BATCH = 500;

export async function softDeleteTicket(ticket: TicketDoc, actorId: Types.ObjectId | null, reason: string) {
  if (ticket.deletedAt) return;
  ticket.deletedAt = new Date();
  ticket.deletedById = actorId;
  await ticket.save();
  await audit({ actorId, action: 'ticket.deleted', ticketId: ticket._id, meta: { reason } });
}

export async function restoreTicket(ticket: TicketDoc, actorId: Types.ObjectId | null, reason: string) {
  if (!ticket.deletedAt) return;
  ticket.deletedAt = null;
  ticket.deletedById = null;
  // Picks up any SLA policy changes made while it was deleted.
  await applySla(ticket);
  await ticket.save();
  await audit({ actorId, action: 'ticket.restored', ticketId: ticket._id, meta: { reason } });
}

/**
 * Permanently removes a deleted enquiry and everything stored for it. The audit log keeps one
 * entry saying which reference was purged, when and why, with no shareholder details.
 */
export async function purgeTicket(ticketId: Types.ObjectId, actorId: Types.ObjectId | null, reason: string) {
  const ticket = await TicketModel.findById(ticketId);
  if (!ticket) throw new HttpError(404, 'Enquiry not found');
  if (!ticket.deletedAt) throw new HttpError(400, 'Only enquiries in Deleted items can be permanently deleted');

  const messageAttachmentIds = await MessageModel.distinct('attachmentIds', { ticketId });
  const attachments = await AttachmentModel.find(
    { $or: [{ ticketId }, { _id: { $in: messageAttachmentIds } }] },
    { _id: 1, blobId: 1 },
  ).lean();
  const bucket = new mongo.GridFSBucket(mongoose.connection.db!, { bucketName: 'attachments' });
  for (const a of attachments) {
    if (a.blobId) await bucket.delete(a.blobId).catch(() => undefined);
  }

  // The enquiry goes last, so if anything fails part-way the next run finds it and tries again.
  const [messages] = await Promise.all([
    MessageModel.deleteMany({ ticketId }),
    AttachmentModel.deleteMany({ _id: { $in: attachments.map((a) => a._id) } }),
    DraftModel.deleteMany({ ticketId }),
    AuditLogModel.deleteMany({ ticketId }),
    NotificationModel.deleteMany({ ticketId }),
    PendingReplyModel.deleteMany({ ticketId }),
  ]);
  // Only while still deleted: if the shareholder wrote meanwhile, ingest restored the enquiry, and
  // it stays (with the new message) rather than vanishing.
  const removed = await TicketModel.deleteOne({ _id: ticketId, deletedAt: { $ne: null } });
  notifyTicketChanged(ticketId.toString());
  if (!removed.deletedCount) {
    logger.warn({ reference: ticket.reference }, 'Enquiry was restored during its purge; kept it');
  }

  await audit({
    actorId,
    action: 'ticket.purged',
    meta: {
      reference: ticket.reference,
      reason,
      deletedAt: ticket.deletedAt,
      messages: messages.deletedCount,
      attachments: attachments.length,
    },
  });
}

/**
 * Scheduled job (daily): moves long-untouched resolved enquiries to Deleted items, and purges
 * enquiries that have been in Deleted items past the retention period. Both are off by default.
 */
export async function runRetention(
  now = new Date(),
  retention: { purgeDeletedAfterDays?: number | null; deleteResolvedAfterDays?: number | null } | null = null,
): Promise<{ moved: number; purged: number }> {
  retention ??= (await getSettings()).retention ?? null;
  let moved = 0;
  let purged = 0;

  if (retention?.deleteResolvedAfterDays) {
    const cutoff = new Date(now.getTime() - retention.deleteResolvedAfterDays * DAY);
    const old = await TicketModel.find({
      deletedAt: null,
      status: 'resolved',
      resolvedAt: { $lt: cutoff },
      lastMessageAt: { $lt: cutoff },
    }).limit(BATCH);
    for (const t of old) {
      await softDeleteTicket(
        t,
        null,
        `retention: resolved and untouched for ${retention.deleteResolvedAfterDays} days`,
      );
      moved += 1;
    }
  }

  if (retention?.purgeDeletedAfterDays) {
    const cutoff = new Date(now.getTime() - retention.purgeDeletedAfterDays * DAY);
    const due = await TicketModel.find({ deletedAt: { $ne: null, $lt: cutoff } }, { _id: 1 })
      .limit(BATCH)
      .lean();
    for (const t of due) {
      try {
        await purgeTicket(t._id, null, `retention: in Deleted items for ${retention.purgeDeletedAfterDays} days`);
        purged += 1;
      } catch (err) {
        logger.error({ err, ticketId: t._id }, 'Retention purge failed for an enquiry; will retry next run');
      }
    }
  }

  if (moved || purged) logger.info({ moved, purged }, 'Retention schedule ran');
  return { moved, purged };
}
