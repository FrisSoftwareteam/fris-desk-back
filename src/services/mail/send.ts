import type { Readable } from 'node:stream';
import { Types } from 'mongoose';
import type { Recipient } from '@microsoft/microsoft-graph-types';
import { renderMergeFields, type EmailAddress, type SendMessageDto } from '../../shared.js';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../models/AuditLog.js';
import { DraftModel } from '../../models/Draft.js';
import { MessageModel, type MessageDoc } from '../../models/Message.js';
import { countMessages, reloadTicket, type TicketDoc } from '../../models/Ticket.js';
import type { UserDoc } from '../../models/User.js';
import { attachmentStore } from '../attachments/AttachmentStore.js';
import { getGraph } from '../graph/GraphService.js';
import { htmlToText, makeSnippet, sanitizeEmailHtml, sanitizeNoteHtml } from './sanitize.js';
import { extractMentionIds } from '../notifications/mentions.js';
import { notifyUsers } from '../notifications/notify.js';
import { UserModel } from '../../models/User.js';
import { placeAboveQuote, recipientProblem, subjectWithReference } from './sendRules.js';
import { afterSend } from './afterSend.js';
import { holdForApproval } from './approvalHold.js';
import type { PendingReplyDoc } from '../../models/PendingReply.js';
import { applySla } from '../automation/sla.js';

/** MAIL_SEND_ALLOWLIST, applied to every outgoing email. */
export function assertRecipientsAllowed(recipients: EmailAddress[]): void {
  const problem = recipientProblem(recipients, env.MAIL_SEND_ALLOWLIST, env.NODE_ENV === 'production');
  if (problem) throw new HttpError(403, problem);
}

const toRecipients = (list: EmailAddress[]): Recipient[] =>
  list.map((r) => ({ emailAddress: { address: r.email, name: r.name || r.email } }));

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export interface Delivery {
  ticketReference: string;
  /** Mailbox message to reply to / forward; null sends a brand-new email. */
  baseGraphMessageId: string | null;
  kind: 'reply' | 'reply_all' | 'forward';
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  bodyHtml: string;
  attachments?: { name: string; contentType: string; data: Buffer }[];
}

/**
 * Sends one email as the shared mailbox through Graph and returns its Internet Message-ID. Enforces
 * MAIL_SEND_ALLOWLIST. Used for officers' replies and for automatic mail (acknowledgements,
 * redirects, SLA alerts). An unsent draft is removed from the mailbox if any step fails.
 */
export async function deliverEmail(d: Delivery): Promise<string | null> {
  assertRecipientsAllowed([...d.to, ...d.cc]);
  const graph = getGraph();
  if (!graph) throw new HttpError(503, 'Sending email is not configured on the server');

  const draft = d.baseGraphMessageId
    ? await graph.createResponseDraft(d.baseGraphMessageId, d.kind).catch((err: unknown) => {
        // The original was deleted or moved out of the Inbox: send as a new email instead.
        logger.warn({ err, ticket: d.ticketReference }, 'Original email unavailable; sending as a new message');
        return graph.createNewDraft();
      })
    : await graph.createNewDraft();
  if (!draft.id) throw new Error('Graph did not return a draft id');

  try {
    const updated = await graph.updateDraft(draft.id, {
      subject: d.subject,
      toRecipients: toRecipients(d.to),
      ccRecipients: toRecipients(d.cc),
      body: {
        contentType: 'html',
        content: draft.body?.content ? placeAboveQuote(draft.body.content, d.bodyHtml) : d.bodyHtml,
      },
    });
    for (const file of d.attachments ?? []) await graph.addDraftAttachment(draft.id, file);
    await graph.sendDraft(draft.id);
    return updated.internetMessageId ?? null;
  } catch (err) {
    await graph.deleteMessage(draft.id).catch((e: unknown) => logger.warn({ err: e }, 'Could not remove unsent draft'));
    throw err;
  }
}

export interface SendOptions {
  /** Set when a supervisor approved this held reply: it is sent as `user` (the author). */
  approvedBy?: UserDoc;
}

/** Either the stored message, or the reply held for a supervisor's approval instead of sending. */
export type SendOutcome = { message: MessageDoc; held: null } | { message: null; held: PendingReplyDoc };

/**
 * Sends a reply / reply-all / forward from the shared mailbox, or records an internal note,
 * and updates the ticket. Replies the approval policy covers are held for a supervisor instead.
 */
export async function sendTicketMessage(
  ticket: TicketDoc,
  user: UserDoc,
  input: SendMessageDto,
  opts: SendOptions = {},
): Promise<SendOutcome> {
  const ctx = {
    contact: { name: ticket.contact.name ?? '', email: ticket.contact.email ?? '' },
    ticket: { reference: ticket.reference, subject: ticket.subject },
    officer: { name: user.displayName, email: user.email },
  };
  // Officers' HTML is sanitised too: other officers view it, so it must be as safe as inbound mail.
  // Notes may also keep @mentions of colleagues.
  const sanitize = input.kind === 'note' ? sanitizeNoteHtml : sanitizeEmailHtml;
  const bodyHtml = sanitize(renderMergeFields(input.bodyHtml, ctx));
  const bodyText = htmlToText(bodyHtml);
  if (!bodyText.trim()) throw new HttpError(400, 'Write a message before sending');
  const attachmentIds = input.attachmentIds.map((id) => new Types.ObjectId(id));

  if (input.kind === 'note') {
    const note = await MessageModel.create({
      ticketId: ticket._id,
      direction: 'note',
      from: { name: user.displayName, email: user.email },
      bodyHtml,
      bodyText,
      attachmentIds,
      authorId: user._id,
      sentAt: new Date(),
    });
    await countMessages(ticket);
    await DraftModel.deleteOne({ ticketId: ticket._id, authorId: user._id, kind: 'note' });

    // @mentions: tell each active colleague named in the note (never the author themself).
    const mentionIds = extractMentionIds(bodyHtml).filter((id) => id !== user._id.toString());
    const mentioned = mentionIds.length
      ? await UserModel.find({ _id: { $in: mentionIds }, isActive: true }, { _id: 1 }).lean()
      : [];
    await audit({
      actorId: user._id,
      action: 'note.added',
      ticketId: ticket._id,
      meta: { messageId: note._id, ...(mentioned.length && { mentioned: mentioned.map((u) => u._id) }) },
    });
    await notifyUsers(
      mentioned.map((u) => ({
        userId: u._id,
        type: 'mention' as const,
        ticketId: ticket._id,
        messageId: note._id,
        actorId: user._id,
        snippet: makeSnippet(bodyText, 200),
      })),
    );
    return { message: note, held: null };
  }

  if (input.to.length === 0) throw new HttpError(400, 'Add at least one recipient');
  assertRecipientsAllowed([...input.to, ...input.cc]);
  // Supervisor approval: hold it instead of sending (already approved ones go straight out).
  if (!opts.approvedBy) {
    const held = await holdForApproval(ticket, user, input, bodyHtml);
    if (held) return { message: null, held };
  }
  const mailbox = getGraph()?.mailbox ?? '';

  const subject = subjectWithReference(renderMergeFields(input.subject, ctx), ticket.reference);
  // One at a time: each may be up to 25 MB.
  const attachments: { name: string; contentType: string; data: Buffer }[] = [];
  for (const id of attachmentIds) {
    const file = await attachmentStore.open(id.toString());
    if (!file || (file.meta.ticketId && file.meta.ticketId !== ticket._id.toString())) {
      file?.stream.destroy();
      throw new HttpError(400, 'An attachment could not be found. Remove it and attach it again.');
    }
    attachments.push({ name: file.meta.filename, contentType: file.meta.contentType, data: await readAll(file.stream) });
  }

  // Reply to the newest email the shareholder sent, so it threads under it in their mail app.
  const base = await MessageModel.findOne({ ticketId: ticket._id, graphMessageId: { $ne: null } }).sort({ sentAt: -1 });
  const internetMessageId = await deliverEmail({
    ticketReference: ticket.reference,
    baseGraphMessageId: base?.graphMessageId ?? null,
    kind: input.kind,
    to: input.to,
    cc: input.cc,
    subject,
    bodyHtml,
    attachments,
  });

  // The send took a while; pick up anything that changed meanwhile (e.g. the shareholder's next
  // email arriving) so saving below doesn't overwrite it.
  await reloadTicket(ticket);
  const now = new Date();
  const message = await MessageModel.create({
    ticketId: ticket._id,
    direction: 'outbound',
    from: { name: 'Shareholder Enquiries', email: mailbox },
    to: input.to,
    cc: input.cc,
    bodyHtml,
    bodyText,
    internetMessageId,
    attachmentIds,
    authorId: user._id,
    approvedById: opts.approvedBy?._id ?? null,
    sentAt: now,
  });

  const before = { status: ticket.status, assigneeId: ticket.assigneeId?.toString() ?? null };
  if (input.kind !== 'forward' && !ticket.firstResponseAt) ticket.firstResponseAt = now;
  // Whoever replies to an unassigned enquiry takes ownership of it.
  if (!ticket.assigneeId) {
    ticket.assigneeId = user._id;
    ticket.assignedAt = now;
  }
  if (ticket.status === 'new' || ticket.status === 'assigned') ticket.status = 'in_progress';
  // The first reply moves the SLA clock from the response target to the resolution target.
  await applySla(ticket);
  ticket.lastMessageAt = now;
  ticket.snippet = makeSnippet(bodyText);
  ticket.isUnread = false;
  if (attachments.length) ticket.hasAttachments = true;
  await ticket.save();
  await countMessages(ticket);

  // An approved reply's draft was cleared when it was held; the author may have started another since.
  if (!opts.approvedBy) await DraftModel.deleteOne({ ticketId: ticket._id, authorId: user._id, kind: input.kind });
  await audit({
    // Credited to the officer who wrote it (reports count replies per officer).
    actorId: user._id,
    action: input.kind === 'forward' ? 'message.forwarded' : 'message.sent',
    ticketId: ticket._id,
    meta: {
      messageId: message._id,
      to: input.to.map((r) => r.email),
      cc: input.cc.map((r) => r.email),
      attachments: attachments.length,
      ...(opts.approvedBy && { approvedBy: opts.approvedBy._id }),
      ticketBefore: before,
      ticketAfter: { status: ticket.status, assigneeId: ticket.assigneeId?.toString() ?? null },
    },
  });
  afterSend(ticket._id, internetMessageId, attachmentIds);
  return { message, held: null };
}
