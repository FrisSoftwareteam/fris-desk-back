import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { ASSIGNMENT_MODES } from '../shared.js';

// `settings` — one document of admin-editable, non-secret configuration (BUILD_SPEC §5).
// Secrets never go here; they live in backend/.env.
const settingsSchema = new Schema(
  {
    _id: { type: String, default: 'app' },
    autoAcknowledge: {
      enabled: { type: Boolean, required: true, default: false },
      templateId: { type: Schema.Types.ObjectId, ref: 'Template', default: null },
    },
    // Master switch for round-robin assignment by routing rules.
    roundRobinEnabled: { type: Boolean, required: true, default: true },
    // How a rule's officer pool picks someone (ASSIGNMENT_MODES) and the cap for capped_round_robin.
    assignmentMode: { type: String, enum: ASSIGNMENT_MODES, default: 'round_robin' },
    workloadCap: { type: Number, default: 15, min: 1, max: 200 },
    // Priority given to new enquiries that no rule sets otherwise.
    defaultPriority: { type: String, enum: ['normal', 'high'], default: 'normal' },
    // Opening words of external-sender notices to hide from list previews (Admin → Settings).
    externalSenderPhrases: { type: [String], default: [] },
    // Supervisor approval (Admin → Approvals): which agents' replies are held until approved.
    approval: {
      enabled: { type: Boolean, default: false },
      allAgentReplies: { type: Boolean, default: false },
      userIds: { type: [Schema.Types.ObjectId], default: [] },
      categoryIds: { type: [Schema.Types.ObjectId], default: [] },
      templateIds: { type: [Schema.Types.ObjectId], default: [] },
      includeForwards: { type: Boolean, default: true },
    },
    // Retention (BUILD_SPEC §10). Null = off; both are off until an admin chooses.
    retention: {
      purgeDeletedAfterDays: { type: Number, default: null },
      deleteResolvedAfterDays: { type: Number, default: null },
    },
  },
  { timestamps: true },
);

export type Settings = InferSchemaType<typeof settingsSchema>;
export type SettingsDoc = HydratedDocument<Settings>;
export const SettingsModel = model('Settings', settingsSchema, 'settings');

let cached: { doc: SettingsDoc; expires: number } | null = null;

/** The settings document (created with defaults on first use), cached for 30 seconds. */
export async function getSettings(): Promise<SettingsDoc> {
  if (cached && cached.expires > Date.now()) return cached.doc;
  const doc = await SettingsModel.findOneAndUpdate(
    { _id: 'app' },
    { $setOnInsert: { _id: 'app' } },
    { upsert: true, returnDocument: 'after' },
  );
  cached = { doc, expires: Date.now() + 30_000 };
  return doc;
}

export function invalidateSettings(): void {
  cached = null;
}
