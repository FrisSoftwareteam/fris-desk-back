import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { MESSAGE_DIRECTIONS } from '../shared.js';

const addressSchema = new Schema(
  { name: { type: String, default: '' }, email: { type: String, default: '' } },
  { _id: false },
);

// `messages` — each email (or internal note) in a ticket thread (BUILD_SPEC §5).
const messageSchema = new Schema(
  {
    ticketId: { type: Schema.Types.ObjectId, ref: 'Ticket', required: true, index: true },
    direction: { type: String, enum: MESSAGE_DIRECTIONS, required: true },
    from: { type: addressSchema, required: true },
    to: { type: [addressSchema], default: [] },
    cc: { type: [addressSchema], default: [] },
    // Always stored sanitised; the browser additionally renders it in a sandboxed iframe.
    bodyHtml: { type: String, default: '' },
    bodyText: { type: String, default: '' },
    graphMessageId: { type: String, default: null },
    internetMessageId: { type: String, default: null },
    attachmentIds: { type: [Schema.Types.ObjectId], default: [] },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    // The supervisor who approved this reply before it went out (supervisor approval).
    approvedById: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    sentAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// The same Graph message must never be imported twice.
messageSchema.index(
  { graphMessageId: 1 },
  { unique: true, partialFilterExpression: { graphMessageId: { $type: 'string' } } },
);
messageSchema.index({ ticketId: 1, sentAt: -1 });
// Reports: replies sent per officer in a date range.
messageSchema.index({ direction: 1, sentAt: 1 });
// Full-text search across what was written (BUILD_SPEC §11: search by content).
messageSchema.index({ bodyText: 'text' }, { default_language: 'english' });

export type Message = InferSchemaType<typeof messageSchema>;
export type MessageDoc = HydratedDocument<Message>;
export const MessageModel = model('Message', messageSchema, 'messages');
