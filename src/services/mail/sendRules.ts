import type { EmailAddress } from '../../shared.js';

// Pure rules used when sending, kept free of server config so they can be unit-tested.

/**
 * Development safety net: with an allowlist, every recipient must be on it. Outside production an
 * empty allowlist blocks all sending, so a dev copy can never email a real shareholder.
 * Returns why sending is refused, or null when it's allowed.
 */
export function recipientProblem(
  recipients: EmailAddress[],
  allowlist: string[],
  isProduction: boolean,
): string | null {
  if (allowlist.length === 0) {
    return isProduction ? null : 'Sending is switched off here: MAIL_SEND_ALLOWLIST is empty in this environment.';
  }
  const blocked = recipients.filter((r) => !allowlist.includes(r.email.trim().toLowerCase()));
  if (blocked.length === 0) return null;
  return `Test mode: email can only be sent to ${allowlist.join(', ')}. Remove ${blocked.map((b) => b.email).join(', ')}.`;
}

/** Subjects carry the ticket reference so replies thread back even if the conversation changes. */
export function subjectWithReference(subject: string, reference: string): string {
  const clean = subject.trim() || '(no subject)';
  return clean.includes(reference) ? clean : `${clean} [${reference}]`;
}

/** Inserts the officer's text above the quoted original that Graph put in a reply draft. */
export function placeAboveQuote(draftHtml: string, ourHtml: string): string {
  const bodyTag = /<body[^>]*>/i.exec(draftHtml);
  if (!bodyTag) return `${ourHtml}<br>${draftHtml}`;
  const at = bodyTag.index + bodyTag[0].length;
  return `${draftHtml.slice(0, at)}${ourHtml}<br>${draftHtml.slice(at)}`;
}
