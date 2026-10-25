import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { DRAFT_KINDS, PENDING_REPLY_STATUSES } from '../shared.js';

const addressSchema = new Schema(
  { name: { type: String, default: '' }, email: { type: String, required: true } },
  { _id: false },
);

// `pendingReplies` — replies held for a supervisor's approval (Admin → Approvals). Approving sends
// it as the officer who wrote it; returning puts it back in their drafts with the reviewer's comment.
const pendingReplySchema = new Schema(
  {
    ticketId: { type: Schema.Types.ObjectId, ref: 'Ticket', required: true, index: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: DRAFT_KINDS, required: true },
    to: { type: [addressSchema], default: [] },
    cc: { type: [addressSchema], default: [] },
    subject: { type: String, default: '' },
    // Sanitised, with merge fields already filled in for the author.
    bodyHtml: { type: String, default: '' },
    attachmentIds: { type: [Schema.Types.ObjectId], default: [] },
    templateIds: { type: [Schema.Types.ObjectId], default: [] },
    reason: { type: String, default: '' },
    status: { type: String, enum: PENDING_REPLY_STATUSES, default: 'pending', index: true },
    reviewerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewComment: { type: String, default: '' },
    decidedAt: { type: Date, default: null },
    messageId: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
  },
  { timestamps: true },
);

export type PendingReply = InferSchemaType<typeof pendingReplySchema>;
export type PendingReplyDoc = HydratedDocument<PendingReply>;
export const PendingReplyModel = model('PendingReply', pendingReplySchema, 'pendingReplies');
