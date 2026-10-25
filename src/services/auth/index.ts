import type { SessionDto } from '../../shared.js';
import { env, microsoftSignInConfigured } from '../../config/env.js';
import { toUserDto, UserModel, type UserDoc } from '../../models/User.js';
import { createEntraVerifier, type EntraIdentity } from './entraToken.js';
import { createSessionTokens } from './sessionToken.js';
import { invalidateUsers } from './userCache.js';

/** `entraId` placeholder for someone an admin added before their first sign-in (`pending:<email>`). */
export const PENDING_ENTRA_PREFIX = 'pending:';

export const sessionTokens = createSessionTokens(env.JWT_SECRET, env.SESSION_TTL_HOURS);

export const verifyEntraAccessToken = microsoftSignInConfigured
  ? createEntraVerifier({
      tenantId: env.AZURE_TENANT_ID!,
      clientId: env.AZURE_CLIENT_ID!,
      audience: env.AZURE_API_AUDIENCE,
    })
  : null;

/**
 * Updates the `users` record for someone who just signed in. Matches on Entra id, then on email
 * (an admin adds people before their first sign-in — that entry's `pending:` placeholder is
 * replaced with the real Entra id here, and its role is kept). Sign-in is by invitation: someone
 * not on the list gets null, unless listed in BOOTSTRAP_ADMIN_EMAILS (created as an admin, so the
 * first admin can get in) or `allowNew` is set (developer sign-in).
 */
export async function upsertSignedInUser(
  identity: EntraIdentity,
  { allowNew = false }: { allowNew?: boolean } = {},
): Promise<UserDoc | null> {
  const email = identity.email.toLowerCase();
  const isBootstrapAdmin = env.BOOTSTRAP_ADMIN_EMAILS.includes(email);

  const existing = (await UserModel.findOne({ entraId: identity.entraId })) ?? (await UserModel.findOne({ email }));
  if (!existing && !isBootstrapAdmin && !allowNew) return null;
  const user = existing ?? new UserModel({ role: isBootstrapAdmin ? 'admin' : 'agent' });

  user.entraId = identity.entraId;
  user.email = email;
  user.displayName = identity.displayName;
  if (isBootstrapAdmin) user.role = 'admin';
  user.lastSignInAt = new Date();
  await user.save();
  invalidateUsers();
  return user;
}

/**
 * Issues the app's session token. The web app keeps it and sends it as a Bearer header — not a
 * cookie, because the web app and API are hosted on different sites (Vercel / Azure), where browsers
 * won't send the API's cookies.
 */
export async function issueSession(user: UserDoc): Promise<SessionDto> {
  const token = await sessionTokens.sign(user._id.toString());
  return { user: toUserDto(user), token, expiresAt: new Date(Date.now() + sessionTokens.ttlMs).toISOString() };
}

/** The token from an `Authorization: Bearer …` header, if any. */
export function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() || undefined : undefined;
}
