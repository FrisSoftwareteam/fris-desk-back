import { Schema, model, type InferSchemaType } from 'mongoose';
import { TICKET_STATUSES } from '../shared.js';

// `statusReasons` — admin-defined stages within a built-in status, e.g. "Awaiting documents" under
// Awaiting shareholder (GAP_ANALYSIS G-04.7). The built-in status still drives behaviour (SLA
// pause, reopening on new mail); the stage is a label officers can see, filter and report on.
const statusReasonSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    baseStatus: { type: String, enum: TICKET_STATUSES, required: true },
    order: { type: Number, required: true, default: 0 },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

export type StatusReason = InferSchemaType<typeof statusReasonSchema>;
export const StatusReasonModel = model('StatusReason', statusReasonSchema, 'statusReasons');
