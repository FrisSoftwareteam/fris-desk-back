// Recognises mail that must never get an automatic acknowledgement: auto-replies, bounces,
// newsletters and no-reply senders. Acknowledging those causes mail loops and spam.

export interface MailHeader {
  name?: string | null;
  value?: string | null;
}

const NO_REPLY_SENDER =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounce[s]?|notifications?|alerts?|newsletter)([+@.-]|$)/i;

/** Why a message looks automated, or null if it looks like a person wrote it. */
export function automatedReason(fromEmail: string, headers: MailHeader[] = []): string | null {
  const local = fromEmail.split('@')[0] ?? '';
  if (!fromEmail) return 'no sender address';
  if (NO_REPLY_SENDER.test(local)) return `sender looks automated (${local})`;

  const get = (name: string) =>
    headers
      .find((h) => h.name?.toLowerCase() === name)
      ?.value?.trim()
      .toLowerCase() ?? '';
  const autoSubmitted = get('auto-submitted');
  if (autoSubmitted && autoSubmitted !== 'no') return `Auto-Submitted: ${autoSubmitted}`;
  const precedence = get('precedence');
  if (['bulk', 'list', 'junk', 'auto_reply'].includes(precedence)) return `Precedence: ${precedence}`;
  if (get('x-autoreply') || get('x-autorespond') || get('x-auto-response-suppress').includes('all')) {
    return 'auto-reply header';
  }
  if (get('list-id') || get('list-unsubscribe')) return 'mailing list or newsletter';
  return null;
}
