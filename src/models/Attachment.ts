import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

export const ATTACHMENT_STORAGE = ['mailbox', 'database'] as const;
export type AttachmentStorage = (typeof ATTACHMENT_STORAGE)[number];

// `attachments` — details of every email attachment. The bytes live either in the shared mailbox
// (fetched through Graph when opened) or in GridFS, per ATTACHMENT_STORAGE (see AttachmentStore).
const attachmentSchema = new Schema(
  {
    filename: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    ticketId: { type: Schema.Types.ObjectId, ref: 'Ticket', default: null, index: true },
    // For inline images referenced from the email body as cid:<contentId>.
    contentId: { type: String, default: null },
    isInline: { type: Boolean, required: true, default: false },
    storage: { type: String, enum: ATTACHMENT_STORAGE, required: true },
    // storage = 'mailbox': where to fetch it from.
    graphMessageId: { type: String, default: null },
    graphAttachmentId: { type: String, default: null },
    // storage = 'database': the GridFS file holding the bytes.
    blobId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true },
);

export type Attachment = InferSchemaType<typeof attachmentSchema>;
export type AttachmentDoc = HydratedDocument<Attachment>;
export const AttachmentModel = model('Attachment', attachmentSchema, 'attachments');
