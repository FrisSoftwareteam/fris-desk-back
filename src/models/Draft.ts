import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { DRAFT_KINDS } from '../shared.js';

const addressSchema = new Schema(
  { name: { type: String, default: '' }, email: { type: String, required: true } },
  { _id: false },
);

// `drafts` — an officer's unsent reply/forward/note on a ticket, saved Outlook-style (BUILD_SPEC §5).
const draftSchema = new Schema(
  {
    ticketId: { type: Schema.Types.ObjectId, ref: 'Ticket', required: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: DRAFT_KINDS, required: true },
    to: { type: [addressSchema], default: [] },
    cc: { type: [addressSchema], default: [] },
    subject: { type: String, default: '' },
    bodyHtml: { type: String, default: '' },
    // Files uploaded in the composer but not yet sent.
    attachmentIds: { type: [Schema.Types.ObjectId], default: [] },
    // Templates inserted while writing it (supervisor approval rules can depend on them).
    templateIds: { type: [Schema.Types.ObjectId], default: [] },
  },
  { timestamps: true },
);

draftSchema.index({ ticketId: 1, authorId: 1, kind: 1 }, { unique: true });

export type Draft = InferSchemaType<typeof draftSchema>;
export type DraftDoc = HydratedDocument<Draft>;
export const DraftModel = model('Draft', draftSchema, 'drafts');
