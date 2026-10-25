import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { NOTIFICATION_TYPES } from '../shared.js';

// `notifications` — the in-app bell: one row per officer per event (e.g. an @mention in a note).
const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    ticketId: { type: Schema.Types.ObjectId, ref: 'Ticket', required: true, index: true },
    messageId: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    snippet: { type: String, default: '' },
    readAt: { type: Date, default: null },
  },
  { timestamps: true },
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, type: 1, readAt: 1 });

export type Notification = InferSchemaType<typeof notificationSchema>;
export type NotificationDoc = HydratedDocument<Notification>;
export const NotificationModel = model('Notification', notificationSchema, 'notifications');
