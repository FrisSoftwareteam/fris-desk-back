import { Schema, model, type InferSchemaType } from 'mongoose';
import { TICKET_PRIORITIES } from '../shared.js';

// `slaPolicies` (BUILD_SPEC §5). The most specific matching policy applies to a ticket.
const slaPolicySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    isActive: { type: Boolean, required: true, default: true },
    // Empty = applies to everything (the default policy).
    appliesTo: {
      folderId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },
      categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
      priority: { type: String, enum: [...TICKET_PRIORITIES, null], default: null },
    },
    firstResponseMins: { type: Number, required: true, min: 1 },
    resolutionMins: { type: Number, required: true, min: 1 },
    businessHours: {
      tz: { type: String, required: true, default: 'Africa/Lagos' },
      days: { type: [Number], default: [1, 2, 3, 4, 5] },
      start: { type: String, required: true, default: '08:00' },
      end: { type: String, required: true, default: '17:00' },
    },
    // Supervisor notified when a ticket on this policy becomes overdue.
    escalateToUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

export type SlaPolicy = InferSchemaType<typeof slaPolicySchema>;
export const SlaPolicyModel = model('SlaPolicy', slaPolicySchema, 'slaPolicies');
