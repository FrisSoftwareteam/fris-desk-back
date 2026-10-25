import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

// `mailboxes` — the shared mailbox(es) we monitor (BUILD_SPEC §5), plus sync bookkeeping.
const mailboxSchema = new Schema(
  {
    address: { type: String, required: true, unique: true, lowercase: true, trim: true },
    displayName: { type: String, required: true, default: 'Shareholder Enquiries' },
    graphSubscriptionId: { type: String, default: null },
    subscriptionExpiresAt: { type: Date, default: null },
    // Graph delta link for the Inbox; the next sync continues from here.
    deltaLink: { type: String, default: null },
    // Where an unfinished delta pass got to, so a restart resumes instead of starting over.
    deltaResumeLink: { type: String, default: null },
    lastSyncAt: { type: Date, default: null },
    lastSyncError: { type: String, default: null },
    // Messages that failed to import; retried on later syncs, then given up on.
    failedMessages: {
      type: [
        {
          _id: false,
          graphMessageId: { type: String, required: true },
          attempts: { type: Number, required: true },
          lastError: { type: String, required: true },
        },
      ],
      default: [],
    },
  },
  // No optimistic versioning: sync checkpoints update this record in place while a sync runs.
  { timestamps: true, versionKey: false },
);

export type Mailbox = InferSchemaType<typeof mailboxSchema>;
export type MailboxDoc = HydratedDocument<Mailbox>;
export const MailboxModel = model('Mailbox', mailboxSchema, 'mailboxes');
