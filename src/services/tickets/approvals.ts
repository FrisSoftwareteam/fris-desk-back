import { Types } from 'mongoose';
import type { ApproveReplyDto } from '../../shared.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../models/AuditLog.js';
import { DraftModel } from '../../models/Draft.js';
import { MessageModel } from '../../models/Message.js';
import { PendingReplyModel, type PendingReplyDoc } from '../../models/PendingReply.js';
import { countMessages, TicketModel } from '../../models/Ticket.js';
import { UserModel, type UserDoc } from '../../models/User.js';
import { sendTicketMessage } from '../mail/send.js';
import { htmlToText, makeSnippet } from '../mail/sanitize.js';
import { notifyUsers } from '../notifications/notify.js';
import { notifyTicketChanged } from '../realtime/changes.js';
import { escapeHtml } from './transcript.js';

// Supervisor decisions on replies held for approval (see services/mail/approvalHold.ts).

/** Takes a pending reply for one supervisor, so two can't decide it at once. */
async function claim(id: string, set: Record<string, unknown>): Promise<PendingReplyDoc> {
  const reply = await PendingReplyModel.findOneAndUpdate(
    { _id: new Types.ObjectId(id), status: 'pending' },
    { $set: set },
    { returnDocument: 'after' },
  );
  if (!reply) throw new HttpError(409, 'This reply has already been approved or returned');
  return reply;
}

async function liveTicket(reply: PendingReplyDoc) {
  const ticket = await TicketModel.findOne({ _id: reply.ticketId, deletedAt: null });
  if (!ticket) throw new HttpError(404, 'Enquiry not found');
  return ticket;
}

/** Sends a held reply as the officer who wrote it, optionally with the supervisor's edits. */
export async function approvePendingReply(id: string, reviewer: UserDoc, edits: ApproveReplyDto) {
  const reply = await claim(id, { status: 'sending', reviewerId: reviewer._id });
  try {
    const ticket = await liveTicket(reply);
    const author = await UserModel.findById(reply.authorId);
    if (!author) throw new HttpError(400, 'The officer who wrote this reply no longer exists');
    const edited =
      (edits.bodyHtml !== undefined && edits.bodyHtml !== reply.bodyHtml) ||
      (edits.subject !== undefined && edits.subject !== reply.subject);

    const { message } = await sendTicketMessage(
      ticket,
      author,
      {
        kind: reply.kind,
        to: reply.to.map((a) => ({ name: a.name ?? '', email: a.email })),
        cc: reply.cc.map((a) => ({ name: a.name ?? '', email: a.email })),
        subject: edits.subject ?? reply.subject,
        bodyHtml: edits.bodyHtml ?? reply.bodyHtml,
        attachmentIds: reply.attachmentIds.map(String),
        templateIds: reply.templateIds.map(String),
      },
      { approvedBy: reviewer },
    );

    reply.status = 'approved';
    reply.decidedAt = new Date();
    reply.messageId = message!._id;
    await reply.save();
    await audit({
      actorId: reviewer._id,
      action: 'reply.approved',
      ticketId: ticket._id,
      meta: { pendingReplyId: reply._id, messageId: message!._id, author: author._id, edited },
    });
    if (!author._id.equals(reviewer._id)) {
      await notifyUsers([
        {
          userId: author._id,
          type: 'approval_sent',
          ticketId: ticket._id,
          messageId: message!._id,
          actorId: reviewer._id,
          snippet: edited ? 'Sent with changes.' : 'Sent as you wrote it.',
        },
      ]);
    }
    return ticket;
  } catch (err) {
    // Nothing went out (or it failed): put it back in the queue.
    await PendingReplyModel.updateOne(
      { _id: reply._id, status: 'sending' },
      { $set: { status: 'pending', reviewerId: null } },
    );
    throw err;
  }
}

/**
 * Sends a held reply back to its author with a comment: it returns to their drafts (unless they've
 * started another of the same kind) and a note on the enquiry records why.
 */
export async function returnPendingReply(id: string, reviewer: UserDoc, comment: string) {
  const reply = await claim(id, {
    status: 'returned',
    reviewerId: reviewer._id,
    reviewComment: comment,
    decidedAt: new Date(),
  });
  const ticket = await liveTicket(reply);
  const author = await UserModel.findById(reply.authorId, { displayName: 1 }).lean();

  const restored = await DraftModel.updateOne(
    { ticketId: ticket._id, authorId: reply.authorId, kind: reply.kind },
    {
      $setOnInsert: {
        to: reply.to,
        cc: reply.cc,
        subject: reply.subject,
        bodyHtml: reply.bodyHtml,
        attachmentIds: reply.attachmentIds,
        templateIds: reply.templateIds,
      },
    },
    { upsert: true },
  );

  const who = escapeHtml(author?.displayName ?? 'the officer');
  const commentHtml = comment
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const bodyHtml = `<p>Reply returned to <b>${who}</b> for changes before it is sent.</p>${commentHtml}`;
  const note = await MessageModel.create({
    ticketId: ticket._id,
    direction: 'note',
    from: { name: reviewer.displayName, email: reviewer.email },
    bodyHtml,
    bodyText: htmlToText(bodyHtml),
    authorId: reviewer._id,
    sentAt: new Date(),
  });
  await ticket.save();
  await countMessages(ticket);

  await audit({
    actorId: reviewer._id,
    action: 'reply.returned',
    ticketId: ticket._id,
    meta: { pendingReplyId: reply._id, author: reply.authorId, restoredToDrafts: restored.upsertedCount > 0 },
  });
  await notifyUsers([
    {
      userId: reply.authorId,
      type: 'approval_returned',
      ticketId: ticket._id,
      messageId: note._id,
      actorId: reviewer._id,
      snippet: makeSnippet(comment, 200),
    },
  ]);
  notifyTicketChanged(ticket._id.toString());
  return ticket;
}
