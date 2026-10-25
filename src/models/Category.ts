import { Schema, model, type InferSchemaType } from 'mongoose';
import { CATEGORY_TYPES } from '../shared.js';

// `categories` — Outlook-style colour labels (BUILD_SPEC §5).
const categorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: CATEGORY_TYPES, required: true },
    color: { type: String, required: true, match: /^#[0-9a-fA-F]{6}$/ },
  },
  { timestamps: true },
);

export type Category = InferSchemaType<typeof categorySchema>;
export const CategoryModel = model('Category', categorySchema, 'categories');
