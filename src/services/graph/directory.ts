import type { User } from '@microsoft/microsoft-graph-types';
import type { EmailAddress } from '../../shared.js';

// Pure helpers for the To/Cc address suggestions, kept free of config so they can be unit-tested.

/** OData `$filter` matching the start of a name or address. `'` is doubled because `q` is user input. */
export function directoryFilter(q: string): string {
  const s = q.replace(/'/g, "''");
  return ['displayName', 'mail', 'givenName', 'surname'].map((f) => `startswith(${f},'${s}')`).join(' or ');
}

/** Only mailboxes on the firm's domain, as `{ name, email }`, at most `limit`. */
export function keepDomain(users: Pick<User, 'displayName' | 'mail'>[], domain: string, limit = 10): EmailAddress[] {
  const suffix = `@${domain.toLowerCase()}`;
  return users
    .filter((u): u is { displayName?: string | null; mail: string } => Boolean(u.mail?.toLowerCase().endsWith(suffix)))
    .slice(0, limit)
    .map((u) => ({ name: u.displayName ?? '', email: u.mail }));
}
