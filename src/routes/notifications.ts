import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import type { NotificationListDto } from '../shared.js';
import { parseBody } from '../lib/http.js';
import { NotificationModel } from '../models/Notification.js';
import { TicketModel } from '../models/Ticket.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { toNotificationDtos } from '../services/notifications/notify.js';

// The bell: each officer's own notifications (e.g. colleagues @mentioning them in notes).
export const notificationsRouter = Router();

const objectId = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');
const LIST_LIMIT = 50;

/** Enquiries in Deleted items don't show in the bell. */
async function deletedTicketIds(ticketIds: Types.ObjectId[]): Promise<Types.ObjectId[]> {
  return (await TicketModel.distinct('_id', { _id: { $in: ticketIds }, deletedAt: { $ne: null } })) as Types.ObjectId[];
}

// GET /notifications — the latest notifications and how many are unread.
notificationsRouter.get('/notifications', requireAuth, async (req, res) => {
  const userId = currentUser(req)._id;
  const rows = await NotificationModel.find({ userId }).sort({ createdAt: -1 }).limit(LIST_LIMIT).lean();
  const unreadTicketIds = await NotificationModel.distinct('ticketId', { userId, readAt: null });
  const hidden = await deletedTicketIds([...rows.map((r) => r.ticketId), ...unreadTicketIds]);
  const unread = await NotificationModel.countDocuments({ userId, readAt: null, ticketId: { $nin: hidden } });
  const hiddenSet = new Set(hidden.map(String));
  const body: NotificationListDto = {
    items: await toNotificationDtos(rows.filter((r) => !hiddenSet.has(r.ticketId.toString()))),
    unread,
  };
  res.json(body);
});

const ReadBody = z.union([
  z.object({ ids: z.array(objectId).min(1).max(LIST_LIMIT) }),
  z.object({ ticketId: objectId }),
  z.object({ all: z.literal(true) }),
]);

// POST /notifications/read — { ids } | { ticketId } (opening that enquiry) | { all: true }.
notificationsRouter.post('/notifications/read', requireAuth, async (req, res) => {
  const body = parseBody(ReadBody, req);
  const userId = currentUser(req)._id;
  const which =
    'ids' in body
      ? { _id: { $in: body.ids.map((id) => new Types.ObjectId(id)) } }
      : 'ticketId' in body
        ? { ticketId: new Types.ObjectId(body.ticketId) }
        : {};
  const result = await NotificationModel.updateMany(
    { userId, readAt: null, ...which },
    { $set: { readAt: new Date() } },
  );
  res.json({ updated: result.modifiedCount });
});
