import { Schema, model, type InferSchemaType } from 'mongoose';

// `templates` — canned responses with {{merge.fields}} (BUILD_SPEC §5).
const templateSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    subject: { type: String, default: '' },
    bodyHtml: { type: String, required: true },
    // Optional: only offered for tickets in this folder.
    folderId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },
    // Form files (e.g. a change-of-address PDF) copied into the reply whenever the template is used.
    // Always kept in the database, never swept as abandoned uploads (see cleanupAttachments).
    attachmentIds: { type: [Schema.Types.ObjectId], ref: 'Attachment', default: [] },
  },
  { timestamps: true },
);

export type Template = InferSchemaType<typeof templateSchema>;
export const TemplateModel = model('Template', templateSchema, 'templates');
