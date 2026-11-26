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

/**
 * Attachments a forward of the whole enquiry carries: every message's files, oldest first, once
 * each, minus `exclude` (files the officer attached themself). Each is tagged with the mailbox
 * message it came from, so the ones Graph already copied onto the forward draft can be skipped.
 */
export function threadAttachmentIds(
  thread: { attachmentIds: { toString(): string }[]; graphMessageId?: string | null }[],
  exclude: string[],
): { id: string; fromGraphMessageId: string | null }[] {
  const seen = new Set(exclude);
  const out: { id: string; fromGraphMessageId: string | null }[] = [];
  for (const m of thread) {
    for (const raw of m.attachmentIds) {
      const id = raw.toString();
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, fromGraphMessageId: m.graphMessageId ?? null });
    }
  }
  return out;
}
