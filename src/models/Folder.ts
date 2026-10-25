import { Schema, model, type InferSchemaType } from 'mongoose';

// `folders` — virtual folders inside the mailbox (BUILD_SPEC §5).
const folderSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    order: { type: Number, required: true, default: 0 },
    parentId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },
  },
  { timestamps: true },
);

export type Folder = InferSchemaType<typeof folderSchema>;
export const FolderModel = model('Folder', folderSchema, 'folders');
