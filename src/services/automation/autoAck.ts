import type { Types } from 'mongoose';
import { renderMergeFields } from '../../shared.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../models/AuditLog.js';
import { MessageModel } from '../../models/Message.js';
import { getSettings } from '../../models/Settings.js';
import { TemplateModel } from '../../models/Template.js';
import { countMessages, type TicketDoc } from '../../models/Ticket.js';
import { getGraph } from '../graph/GraphService.js';
import { deliverEmail } from '../mail/send.js';
import { htmlToText, sanitizeEmailHtml } from '../mail/sanitize.js';
import { subjectWithReference } from '../mail/sendRules.js';
import { automatedReason, type MailHeader } from './automatedMail.js';

/** Only mail this recent is acknowledged, so importing older mail never sends anything. */
const MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Auto-acknowledgement (BUILD_SPEC §7): when enabled in settings, replies to a brand-new enquiry
 * with the chosen template, reference number merged in. Skips old mail, automated senders and
 * anything MAIL_SEND_ALLOWLIST blocks. Doesn't count as the first response for the SLA.
 */
export async function autoAcknowledge(
  ticket: TicketDoc,
  opts: { receivedAt: Date; graphMessageId: string | null; headers?: MailHeader[] },
): Promise<void> {
  const settings = await getSettings();
  if (!settings.autoAcknowledge?.enabled || !settings.autoAcknowledge.templateId) return;

  const skip = async (reason: string) => {
    logger.info({ ticket: ticket.reference, reason }, 'Auto-acknowledgement skipped');
    await audit({ actorId: null, action: 'auto_ack.skipped', ticketId: ticket._id, meta: { reason } });
  };

  if (!ticket.contact.email) return skip('no email address');
  if (Date.now() - opts.receivedAt.getTime() > MAX_AGE_MS) return; // historical import: silently skip
  const automated = automatedReason(ticket.contact.email, opts.headers);
  if (automated) return skip(automated);

  await sendTemplateEmail(ticket, settings.autoAcknowledge.templateId, opts.graphMessageId, 'message.auto_acknowledged', skip);
}

/**
 * Resolution email: when enabled in settings, tells the shareholder their enquiry is resolved
 * (asking them to confirm they're satisfied) as a reply in the same conversation. A reply back
 * reopens the enquiry through ingest. Doesn't change the ticket's status.
 */
export async function sendResolutionEmail(ticket: TicketDoc): Promise<void> {
  const settings = await getSettings();
  if (!settings.resolutionEmail?.enabled || !settings.resolutionEmail.templateId) return;

  const skip = async (reason: string) => {
    logger.info({ ticket: ticket.reference, reason }, 'Resolution email skipped');
    await audit({ actorId: null, action: 'resolution_email.skipped', ticketId: ticket._id, meta: { reason } });
  };
  if (!ticket.contact.email) return skip('no email address');
  const automated = automatedReason(ticket.contact.email);
  if (automated) return skip(automated);

  const lastInbound = await MessageModel.findOne(
    { ticketId: ticket._id, direction: 'inbound', graphMessageId: { $type: 'string' } },
    { graphMessageId: 1 },
  )
    .sort({ sentAt: -1 })
    .lean();
  await sendTemplateEmail(
    ticket,
    settings.resolutionEmail.templateId,
    lastInbound?.graphMessageId ?? null,
    'message.resolution_emailed',
    skip,
  );
}

/** When enabled in settings, marks the enquiry's inbound emails read in the shared mailbox. */
export async function markMailRead(ticket: TicketDoc): Promise<void> {
  const settings = await getSettings();
  const graph = getGraph();
  if (!settings.markReadOnResolve || !graph) return;
  const messages = await MessageModel.find(
    { ticketId: ticket._id, direction: 'inbound', graphMessageId: { $type: 'string' } },
    { graphMessageId: 1 },
  ).lean();
  const results = await Promise.allSettled(messages.map((m) => graph.markRead(m.graphMessageId!)));
  for (const r of results) {
    // 404: moved or deleted in Outlook since import (message ids aren't immutable) — nothing to mark.
    if (r.status === 'rejected' && (r.reason as { statusCode?: number })?.statusCode !== 404) {
      logger.warn({ err: r.reason, ticket: ticket.reference }, 'Could not mark email read');
    }
  }
}

/** Sends a template as the shared mailbox, records it on the ticket and audits `action`. */
async function sendTemplateEmail(
  ticket: TicketDoc,
  templateId: Types.ObjectId,
  graphMessageId: string | null,
  action: string,
  skip: (reason: string) => Promise<void>,
): Promise<void> {
  const template = await TemplateModel.findById(templateId).lean();
  if (!template) return skip('template not found');

  const graph = getGraph();
  const ctx = {
    contact: { name: ticket.contact.name ?? '', email: ticket.contact.email },
    ticket: { reference: ticket.reference, subject: ticket.subject },
    officer: { name: 'Shareholder Enquiries', email: graph?.mailbox ?? '' },
  };
  const bodyHtml = sanitizeEmailHtml(renderMergeFields(template.bodyHtml, ctx));
  const subject = subjectWithReference(
    template.subject ? renderMergeFields(template.subject, ctx) : `RE: ${ticket.subject}`,
    ticket.reference,
  );
  const to = [{ name: ticket.contact.name ?? '', email: ticket.contact.email }];

  let internetMessageId: string | null;
  try {
    internetMessageId = await deliverEmail({
      ticketReference: ticket.reference,
      baseGraphMessageId: graphMessageId,
      kind: 'reply',
      to,
      cc: [],
      subject,
      bodyHtml,
    });
  } catch (err) {
    return skip((err as Error).message);
  }

  const now = new Date();
  await MessageModel.create({
    ticketId: ticket._id,
    direction: 'outbound',
    from: { name: 'Shareholder Enquiries', email: graph?.mailbox ?? '' },
    to,
    bodyHtml,
    bodyText: htmlToText(bodyHtml),
    internetMessageId,
    authorId: null,
    sentAt: now,
  });
  await ticket.save();
  await countMessages(ticket);
  await audit({ actorId: null, action, ticketId: ticket._id, meta: { to: to[0]!.email } });
}
