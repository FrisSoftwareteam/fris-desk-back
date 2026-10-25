import type { MessageDoc } from '../../models/Message.js';

// Builds the forwarded-thread HTML for escalations. Pure, so it can be unit-tested.

const sentFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos',
  dateStyle: 'full',
  timeStyle: 'short',
});

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export const who = (a: { name?: string | null; email?: string | null }) =>
  escapeHtml(a.name && a.email ? `${a.name} <${a.email}>` : a.name || a.email || '');

/** Outlook-style header block followed by the (already sanitised) body, for each earlier message. */
export function threadTranscript(messages: Pick<MessageDoc, 'from' | 'to' | 'sentAt' | 'bodyHtml'>[]): string {
  return messages
    .map((m) => {
      const to = m.to.map(who).join('; ');
      return (
        '<hr><p style="font-size:13px">' +
        `<b>From:</b> ${who(m.from)}<br><b>Sent:</b> ${sentFormat.format(m.sentAt)}` +
        (to ? `<br><b>To:</b> ${to}` : '') +
        `</p>${m.bodyHtml}`
      );
    })
    .join('');
}
