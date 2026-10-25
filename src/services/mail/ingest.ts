import type { Message as GraphMessage, Recipient } from '@microsoft/microsoft-graph-types';
import { Types } from 'mongoose';
import type { EmailAddress, TicketStatus } from '../../shared.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../models/AuditLog.js';
import { nextTicketReference } from '../../models/Counter.js';
import { MessageModel } from '../../models/Message.js';
import { getSettings } from '../../models/Settings.js';
import { countMessages, TicketModel, type TicketDoc } from '../../models/Ticket.js';
import { attachmentStore, type AttachmentMeta } from '../attachments/AttachmentStore.js';
import type { GraphService } from '../graph/GraphService.js';
import { findTicketReference, htmlToText, makeSnippet, sanitizeEmailHtml } from './sanitize.js';
import { autoAcknowledge } from '../automation/autoAck.js';
import { routeNewTicket, runRedirects } from '../automation/routing.js';
import { applySla } from '../automation/sla.js';
import { restoreTicket } from '../tickets/retention.js';

/** Larger attachments are skipped (recorded in the log) rather than stored in GridFS. */
const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;
const FILE_ATTACHMENT = '#microsoft.graph.fileAttachment';

export type IngestResult = 'created' | 'threaded' | 'duplicate' | 'skipped';

function toAddress(r: Recipient | null | undefined): EmailAddress {
  return { name: r?.emailAddress?.name?.trim() ?? '', email: r?.emailAddress?.address?.trim().toLowerCase() ?? '' };
}

/** Where an existing ticket goes when the shareholder writes again. */
function statusAfterInbound(ticket: TicketDoc): TicketStatus {
  if (ticket.status === 'resolved' || ticket.status === 'awaiting_shareholder') {
    return ticket.assigneeId ? 'in_progress' : 'new';
  }
  return ticket.status;
}

/** Finds the ticket a message belongs to: same Graph conversation, else a REG- reference in the subject. */
// Deleted enquiries are included: new mail on one brings it back out of Deleted items (below), so
// the conversation stays in one place instead of starting a second enquiry.
async function findTicket(conversationId: string | null | undefined, subject: string | null | undefined) {
  if (conversationId) {
    const byConversation = await TicketModel.findOne({
      $or: [{ conversationId }, { otherConversationIds: conversationId }],
    }).sort({ deletedAt: 1, createdAt: -1 });
    if (byConversation) return byConversation;
  }
  const reference = findTicketReference(subject);
  if (reference) return TicketModel.findOne({ reference });
  return null;
}

/**
 * Imports one Inbox message as a ticket message. Idempotent: a message already imported is skipped.
 * Read-only towards the mailbox — it never marks mail as read, moves or changes it.
 */
export async function ingestMessage(graph: GraphService, graphMessageId: string): Promise<IngestResult> {
  if (await MessageModel.exists({ graphMessageId })) return 'duplicate';

  const msg: GraphMessage = await graph.getMessage(graphMessageId);
  const from = toAddress(msg.from ?? msg.sender);
  if (msg.isDraft) return 'skipped';
  // Mail the shared mailbox sent to itself (e.g. our own replies copied in) isn't a new enquiry.
  if (from.email === graph.mailbox.toLowerCase()) return 'skipped';

  const receivedAt = msg.receivedDateTime ? new Date(msg.receivedDateTime) : new Date();
  const existing = await findTicket(msg.conversationId, msg.subject);
  if (existing?.deletedAt) await restoreTicket(existing, null, 'shareholder wrote again');
  // Replies go to the Reply-To address if the shareholder set one.
  const contact = msg.replyTo?.[0]?.emailAddress?.address ? toAddress(msg.replyTo[0]) : from;

  const settings = await getSettings();
  const ticket =
    existing ??
    new TicketModel({
      reference: await nextTicketReference(receivedAt),
      subject: msg.subject?.trim() || '(no subject)',
      status: 'new',
      origin: 'email',
      // Rules can still raise it; this is the starting point set in Admin → Settings.
      priority: settings.defaultPriority ?? 'normal',
      contact: { name: contact.name || contact.email, email: contact.email },
      conversationId: msg.conversationId ?? null,
      lastMessageAt: receivedAt,
      slaStartAt: receivedAt,
      isUnread: true,
    });
  const isNewTicket = !existing;
  if (isNewTicket) await ticket.save();

  let bodyText = '';
  // Filled as attachments are stored, so a failed import can remove what it already saved.
  const attachments: AttachmentMeta[] = [];
  try {
    await importAttachments(graph, msg, ticket, attachments);
    const bodyHtml = sanitizeEmailHtml(rewriteInlineImages(msg.body?.content ?? '', attachments));
    bodyText = msg.body?.contentType === 'text' ? (msg.body.content ?? '') : htmlToText(bodyHtml);

    await MessageModel.create({
      ticketId: ticket._id,
      direction: 'inbound',
      from,
      to: (msg.toRecipients ?? []).map(toAddress),
      cc: (msg.ccRecipients ?? []).map(toAddress),
      bodyHtml: msg.body?.contentType === 'text' ? textToHtml(bodyText) : bodyHtml,
      bodyText,
      graphMessageId,
      internetMessageId: msg.internetMessageId ?? null,
      attachmentIds: attachments.map((a) => a.id),
      authorId: null,
      sentAt: receivedAt,
    });
  } catch (err) {
    // Don't leave an empty ticket or stray attachments behind; the next sync retries the message.
    await attachmentStore
      .remove(attachments.map((a) => new Types.ObjectId(a.id)))
      .catch((cleanupErr: unknown) => logger.warn({ err: cleanupErr }, 'Could not remove attachments of a failed import'));
    if (isNewTicket) await TicketModel.deleteOne({ _id: ticket._id, messageCount: 0 });
    // Duplicate key: a concurrent sync imported this message first.
    if ((err as { code?: number }).code === 11000) return 'duplicate';
    throw err;
  }

  const before = { status: ticket.status };
  if (!isNewTicket) ticket.status = statusAfterInbound(ticket);
  if (receivedAt >= ticket.lastMessageAt) {
    ticket.lastMessageAt = receivedAt;
    ticket.snippet = makeSnippet(bodyText, undefined, settings.externalSenderPhrases);
  }
  ticket.isUnread = true;
  // A snoozed enquiry comes back when the shareholder writes; the follow-up time itself stays.
  if (ticket.followUp?.hide) ticket.followUp.hide = false;
  ticket.hasAttachments ||= Boolean(msg.hasAttachments);
  if (ticket.status !== 'resolved') ticket.resolvedAt = null;

  // New enquiries: routing rules first (folder/categories feed SLA policy choice), then the SLA.
  let redirects: { ruleName: string; to: string }[] = [];
  if (isNewTicket) {
    try {
      redirects = (await routeNewTicket(ticket, { subject: ticket.subject, fromEmail: from.email, bodyText }))
        .redirects;
    } catch (err) {
      logger.error({ err, ticket: ticket.reference }, 'Routing rules failed; the enquiry stays unrouted');
    }
  }
  if (isNewTicket || before.status !== ticket.status) await applySla(ticket);
  await ticket.save();
  await countMessages(ticket);

  if (isNewTicket) {
    await audit({
      actorId: null,
      action: 'ticket.created',
      ticketId: ticket._id,
      meta: { origin: 'email', reference: ticket.reference },
    });
  } else if (before.status !== ticket.status) {
    await audit({
      actorId: null,
      action: 'ticket.status_changed',
      ticketId: ticket._id,
      meta: { before, after: { status: ticket.status }, reason: 'shareholder replied' },
    });
  }
  if (isNewTicket) {
    // Both send mail; failures are logged/audited inside and never undo the import.
    if (redirects.length) await runRedirects(ticket, graphMessageId, redirects);
    await autoAcknowledge(ticket, { receivedAt, graphMessageId, headers: msg.internetMessageHeaders ?? [] }).catch(
      (err: unknown) => logger.warn({ err, ticket: ticket.reference }, 'Auto-acknowledgement failed'),
    );
  }
  await audit({
    actorId: null,
    action: 'message.received',
    ticketId: ticket._id,
    meta: { graphMessageId, from: from.email },
  });

  return isNewTicket ? 'created' : 'threaded';
}

/** Stores the message's file attachments, appending each to `saved` as soon as it's stored. */
async function importAttachments(
  graph: GraphService,
  msg: GraphMessage,
  ticket: TicketDoc,
  saved: AttachmentMeta[],
): Promise<void> {
  const hasInline = /\bcid:/i.test(msg.body?.content ?? '');
  if (!msg.id || (!msg.hasAttachments && !hasInline)) return;

  const list = await graph.listAttachments(msg.id);
  for (const a of list) {
    const type = (a as { '@odata.type'?: string })['@odata.type'];
    if (type !== FILE_ATTACHMENT || !a.id) {
      // Attached emails/calendar items and cloud links aren't stored in the MVP.
      logger.info({ ticket: ticket.reference, type, name: a.name }, 'Skipped non-file attachment');
      continue;
    }
    if ((a.size ?? 0) > MAX_ATTACHMENT_BYTES) {
      logger.warn({ ticket: ticket.reference, name: a.name, size: a.size }, 'Skipped attachment over size limit');
      continue;
    }
    const contentId = a.contentId ?? undefined;
    const messageId = msg.id;
    const attachmentId = a.id;
    saved.push(
      await attachmentStore.save(
        {
          filename: a.name?.trim() || 'attachment',
          contentType: a.contentType || 'application/octet-stream',
          size: a.size ?? 0,
          ticketId: ticket._id,
          contentId: contentId?.replace(/^<|>$/g, '') ?? null,
          isInline: Boolean(a.isInline),
          graphMessageId: messageId,
          graphAttachmentId: attachmentId,
        },
        // Only downloaded when attachments are copied into the database (ATTACHMENT_STORAGE=database).
        () => graph.getAttachmentContent(messageId, attachmentId),
      ),
    );
  }
}

/** Points cid: image references at our attachment endpoint so inline images display. */
function rewriteInlineImages(html: string, attachments: AttachmentMeta[]): string {
  const byCid = new Map(attachments.filter((a) => a.contentId).map((a) => [a.contentId!.toLowerCase(), a.id]));
  return html.replace(/(["'])cid:([^"']+)\1/gi, (match, quote: string, cid: string) => {
    const id = byCid.get(cid.toLowerCase());
    return id ? `${quote}${env.APP_BASE_URL}/api/attachments/${id}${quote}` : match;
  });
}

function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}
