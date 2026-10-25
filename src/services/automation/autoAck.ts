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

  const template = await TemplateModel.findById(settings.autoAcknowledge.templateId).lean();
  if (!template) return skip('acknowledgement template not found');

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
      baseGraphMessageId: opts.graphMessageId,
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
  await audit({ actorId: null, action: 'message.auto_acknowledged', ticketId: ticket._id, meta: { to: to[0]!.email } });
}
