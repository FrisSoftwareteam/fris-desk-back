import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { TICKET_ORIGINS, TICKET_PRIORITIES, TICKET_STATUSES } from '../shared.js';
import { notifyTicketChanged } from '../services/realtime/changes.js';
import { shouldClearStatusReason } from '../services/tickets/followUpRules.js';

const addressSchema = new Schema(
  { name: { type: String, default: '' }, email: { type: String, default: '' }, phone: { type: String, default: '' } },
  { _id: false },
);

// A call-back or reminder (GAP_ANALYSIS G-04.3). `hide` snoozes the enquiry out of the usual lists
// until `at`; `dueAt` is set by the job when the time passes and the enquiry comes back unread.
const followUpSchema = new Schema(
  {
    at: { type: Date, required: true },
    note: { type: String, default: '' },
    hide: { type: Boolean, required: true, default: false },
    setById: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    dueAt: { type: Date, default: null },
  },
  { _id: false },
);

// `tickets` — one per shareholder enquiry, i.e. the conversation (BUILD_SPEC §5).
const ticketSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true },
    subject: { type: String, default: '' },
    status: { type: String, enum: TICKET_STATUSES, required: true, default: 'new' },
    // Optional admin-defined stage within `status` (models/StatusReason.ts).
    statusReasonId: { type: Schema.Types.ObjectId, ref: 'StatusReason', default: null },
    folderId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },
    assigneeId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    contact: { type: addressSchema, required: true },
    categoryIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Category' }], default: [] },
    priority: { type: String, enum: TICKET_PRIORITIES, required: true, default: 'normal' },
    slaPolicyId: { type: Schema.Types.ObjectId, ref: 'SlaPolicy', default: null },
    // When the SLA clock started: when the email arrived (not when it was imported) or was logged.
    slaStartAt: { type: Date, default: null },
    slaDueAt: { type: Date, default: null },
    isOverdue: { type: Boolean, required: true, default: false },
    firstResponseAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    lastMessageAt: { type: Date, required: true },
    conversationId: { type: String, default: null },
    // Outlook starts a new conversation when our reply's subject gains the [REG-…] reference, so the
    // conversations of messages we send are recorded too; replies to them then find this ticket.
    otherConversationIds: { type: [String], default: [] },
    origin: { type: String, enum: TICKET_ORIGINS, required: true, default: 'email' },
    assignedAt: { type: Date, default: null },
    escalatedToId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    escalatedAt: { type: Date, default: null },
    followUp: { type: followUpSchema, default: null },

    // List-pane helpers, kept in step whenever a message is added.
    isUnread: { type: Boolean, required: true, default: true },
    snippet: { type: String, default: '' },
    messageCount: { type: Number, required: true, default: 0 },
    hasAttachments: { type: Boolean, required: true, default: false },

    // Soft delete (BUILD_SPEC §10): "Deleted items" until restored or removed by the scheduled
    // purge (services/tickets/retention.ts). deletedById is null when the retention schedule did it.
    deletedAt: { type: Date, default: null },
    deletedById: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// Lists sort newest first (lastMessageAt, _id); the views that filter by officer or folder get the
// sort in the same index. Unread counts for the folder pane run on every live change.
ticketSchema.index({ status: 1, lastMessageAt: -1 });
ticketSchema.index({ lastMessageAt: -1, _id: -1 });
ticketSchema.index({ assigneeId: 1, lastMessageAt: -1, _id: -1 });
ticketSchema.index({ folderId: 1, lastMessageAt: -1, _id: -1 });
ticketSchema.index({ isUnread: 1, deletedAt: 1, assigneeId: 1 });
ticketSchema.index({ conversationId: 1 });
ticketSchema.index({ otherConversationIds: 1 });
ticketSchema.index({ isOverdue: 1, slaDueAt: 1 });
ticketSchema.index({ deletedAt: 1 });
ticketSchema.index({ 'followUp.at': 1 }, { sparse: true });
// Reports (by when an enquiry was received, answered, resolved) and the empty-ticket cleanup.
ticketSchema.index({ createdAt: 1 });
ticketSchema.index({ slaStartAt: 1 });
ticketSchema.index({ firstResponseAt: 1 });
ticketSchema.index({ resolvedAt: 1 });

// Whatever changes the status (an officer, new mail, escalation), a stage chosen for the old status
// no longer applies, and a resolved enquiry needs no follow-up.
ticketSchema.pre('save', function () {
  if (shouldClearStatusReason(this.isModified('status'), this.isModified('statusReasonId'))) {
    this.statusReasonId = null;
  }
  if (this.isModified('status') && this.status === 'resolved') this.followUp = null;
});

// Every saved change (new mail, assignment, status, SLA…) is pushed to open browsers so lists and
// counts update live. Bulk updates (deleting a folder or category) don't announce themselves.
ticketSchema.post('save', (doc) => notifyTicketChanged(doc._id.toString()));

export type Ticket = InferSchemaType<typeof ticketSchema>;
export type TicketDoc = HydratedDocument<Ticket>;
export const TicketModel = model('Ticket', ticketSchema, 'tickets');

/**
 * Counts new messages on a ticket with an atomic `$inc`, after the ticket's own save. Saving a
 * changed `messageCount` would write the value this copy last read, losing a count added meanwhile
 * (e.g. a shareholder's email imported while a reply was being sent).
 */
export async function countMessages(ticket: TicketDoc, n = 1): Promise<void> {
  const updated = await TicketModel.findOneAndUpdate(
    { _id: ticket._id },
    { $inc: { messageCount: n } },
    { returnDocument: 'after', projection: { messageCount: 1 } },
  ).lean();
  if (updated) {
    ticket.messageCount = updated.messageCount;
    ticket.unmarkModified('messageCount');
  }
}

/**
 * Reloads a ticket in place, discarding this copy's unsaved changes. For code that held a ticket
 * across slow work (sending through Microsoft Graph) and is about to change and save it.
 */
export async function reloadTicket(ticket: TicketDoc): Promise<void> {
  const fresh = await TicketModel.findById(ticket._id).lean();
  if (fresh) ticket.init(fresh as never);
}
