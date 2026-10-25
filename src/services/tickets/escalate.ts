import type { Types } from 'mongoose';
import type { EmailAddress } from '../../shared.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../models/AuditLog.js';
import type { Department } from '../../models/Department.js';
import { MessageModel } from '../../models/Message.js';
import { countMessages, type TicketDoc } from '../../models/Ticket.js';
import type { UserDoc } from '../../models/User.js';
import { applySla } from '../automation/sla.js';
import { afterSend } from '../mail/afterSend.js';
import { assertRecipientsAllowed, deliverEmail } from '../mail/send.js';
import { subjectWithReference } from '../mail/sendRules.js';
import { escapeHtml, threadTranscript, who } from './transcript.js';

/**
 * Escalation flow (BUILD_SPEC §7): forwards the enquiry's thread from the shared mailbox to a
 * department or person, with the officer's note on top; records an internal note; marks the
 * enquiry escalated; audits. Sending is subject to MAIL_SEND_ALLOWLIST like every other email.
 *
 * The newest email from the mailbox is forwarded through Graph (so its attachments go too) and the
 * earlier messages are written out beneath the note. A phone/walk-in enquiry, with nothing in the
 * mailbox to forward, goes as a new email carrying the whole thread.
 */
export async function escalateTicket(
  ticket: TicketDoc,
  user: UserDoc,
  department: Department & { _id: Types.ObjectId },
  note: string,
): Promise<void> {
  if (ticket.status === 'resolved') throw new HttpError(400, 'Reopen the enquiry before escalating it');
  const to: EmailAddress[] = [{ name: department.name, email: department.email }];
  assertRecipientsAllowed(to);

  const thread = await MessageModel.find({ ticketId: ticket._id, direction: { $ne: 'note' } }).sort({ sentAt: 1 });
  const base = thread.filter((m) => m.graphMessageId).at(-1) ?? null;
  const earlier = thread.filter((m) => m !== base);

  const noteHtml = note
    .trim()
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const bodyHtml =
    `<p>Escalated to ${escapeHtml(department.name)} by ${escapeHtml(user.displayName)} — enquiry ` +
    `<b>${ticket.reference}</b> from ${who(ticket.contact)}.</p>` +
    noteHtml +
    (earlier.length ? `<p style="color:#616161">${base ? 'Earlier messages' : 'The enquiry'}:</p>` : '') +
    threadTranscript(earlier);

  const subject = ticket.subject.toUpperCase().startsWith('FW:') ? ticket.subject : `FW: ${ticket.subject}`;
  const internetMessageId = await deliverEmail({
    ticketReference: ticket.reference,
    baseGraphMessageId: base?.graphMessageId ?? null,
    kind: 'forward',
    to,
    cc: [],
    subject: subjectWithReference(subject, ticket.reference),
    bodyHtml,
  });

  const now = new Date();
  const noteText = note.trim();
  await MessageModel.create({
    ticketId: ticket._id,
    direction: 'note',
    from: { name: user.displayName, email: user.email },
    bodyHtml:
      `<p>Escalated to <b>${escapeHtml(department.name)}</b> (${escapeHtml(department.email)}) by ` +
      `${escapeHtml(user.displayName)}.</p>${noteHtml}`,
    bodyText: `Escalated to ${department.name} (${department.email}) by ${user.displayName}. ${noteText}`.trim(),
    authorId: user._id,
    sentAt: now,
  });

  const before = ticket.status;
  ticket.status = 'escalated';
  ticket.escalatedToId = department._id;
  ticket.escalatedAt = now;
  await applySla(ticket);
  await ticket.save();
  await countMessages(ticket);

  await audit({
    actorId: user._id,
    action: 'ticket.escalated',
    ticketId: ticket._id,
    meta: {
      departmentId: department._id,
      department: department.name,
      to: department.email,
      hasNote: Boolean(noteText),
      statusBefore: before,
    },
  });
  // Links the forward's conversation to the ticket, so the department's reply threads back here.
  afterSend(ticket._id, internetMessageId, []);
}
