import { Types } from 'mongoose';
import type { NotificationDto, NotificationType } from '../../shared.js';
import { logger } from '../../lib/logger.js';
import { NotificationModel, type Notification } from '../../models/Notification.js';
import { TicketModel } from '../../models/Ticket.js';
import { UserModel } from '../../models/User.js';

export interface NewNotification {
  userId: Types.ObjectId;
  type: NotificationType;
  ticketId: Types.ObjectId;
  messageId?: Types.ObjectId | null;
  actorId: Types.ObjectId | null;
  snippet?: string;
}

type Row = Notification & { _id: Types.ObjectId; createdAt: Date };

// Like changes.ts: the Socket.IO server registers where live notifications go; until then (and in
// scripts) they are only stored, and the bell picks them up on its next fetch.
let sink: ((userId: string, n: NotificationDto) => void) | null = null;

export function setNotificationSink(fn: (userId: string, n: NotificationDto) => void): void {
  sink = fn;
}

/** Bell entries with the enquiry's reference/subject and the actor's name filled in. */
export async function toNotificationDtos(rows: Row[]): Promise<NotificationDto[]> {
  const ticketIds = [...new Set(rows.map((r) => r.ticketId.toString()))];
  const actorIds = [...new Set(rows.flatMap((r) => (r.actorId ? [r.actorId.toString()] : [])))];
  const [tickets, actors] = await Promise.all([
    TicketModel.find({ _id: { $in: ticketIds } }, { reference: 1, subject: 1 }).lean(),
    UserModel.find({ _id: { $in: actorIds } }, { displayName: 1 }).lean(),
  ]);
  const ticketById = new Map(tickets.map((t) => [t._id.toString(), t]));
  const actorById = new Map(actors.map((a) => [a._id.toString(), a.displayName]));
  return rows.map((r) => {
    const t = ticketById.get(r.ticketId.toString());
    return {
      id: r._id.toString(),
      type: r.type as NotificationType,
      ticketId: r.ticketId.toString(),
      ticketReference: t?.reference ?? '',
      ticketSubject: t?.subject ?? '',
      actorName: r.actorId ? (actorById.get(r.actorId.toString()) ?? null) : null,
      snippet: r.snippet ?? '',
      createdAt: r.createdAt.toISOString(),
      readAt: r.readAt ? r.readAt.toISOString() : null,
    };
  });
}

/** Stores notifications and pushes each one live to its officer. Never throws: a failed bell
 * entry must not undo the note or reply that caused it. */
export async function notifyUsers(entries: NewNotification[]): Promise<void> {
  if (entries.length === 0) return;
  try {
    const docs = await NotificationModel.insertMany(
      entries.map((e) => ({ ...e, messageId: e.messageId ?? null, snippet: (e.snippet ?? '').slice(0, 200) })),
    );
    const dtos = await toNotificationDtos(docs.map((d) => d.toObject() as Row));
    dtos.forEach((dto, i) => sink?.(entries[i]!.userId.toString(), dto));
  } catch (err) {
    logger.error({ err }, 'Could not record notifications');
  }
}
