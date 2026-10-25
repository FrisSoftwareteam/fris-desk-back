import { Schema, model, type InferSchemaType } from 'mongoose';
import { DEPARTMENT_TYPES } from '../shared.js';

// `departments` — internal escalation directory: teams and named people (BUILD_SPEC §5).
const departmentSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    type: { type: String, enum: DEPARTMENT_TYPES, required: true, default: 'department' },
    // When to escalate here; shown as a hint in the Escalate menu.
    description: { type: String, default: '' },
    order: { type: Number, required: true, default: 0 },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

export type Department = InferSchemaType<typeof departmentSchema>;
export const DepartmentModel = model('Department', departmentSchema, 'departments');
