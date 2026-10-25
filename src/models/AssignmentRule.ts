import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

// `assignmentRules` — routing + round-robin (BUILD_SPEC §5). Evaluated by services/automation.
const conditionSchema = new Schema(
  {
    field: { type: String, enum: ['subject', 'fromEmail', 'fromDomain', 'body'], required: true },
    op: { type: String, enum: ['contains', 'equals'], required: true },
    value: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const assignmentRuleSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    // Lower = evaluated first; the first matching rule decides folder and assignment.
    priority: { type: Number, required: true, default: 100 },
    isActive: { type: Boolean, required: true, default: true },
    conditions: { type: [conditionSchema], default: [] },
    action: {
      setFolderId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },
      addCategoryIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Category' }], default: [] },
      assignStrategy: { type: String, enum: ['round_robin', 'specific', null], default: null },
      assigneeId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      // Mail redirection (BUILD_SPEC §13): forward the incoming email to this address.
      redirectTo: { type: String, default: null },
    },
    roundRobinPool: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] },
    roundRobinCursor: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

export type AssignmentRule = InferSchemaType<typeof assignmentRuleSchema>;
export type AssignmentRuleDoc = HydratedDocument<AssignmentRule>;
export const AssignmentRuleModel = model('AssignmentRule', assignmentRuleSchema, 'assignmentRules');
