import { Router } from 'express';
import { z } from 'zod';
import { ROLES, type AuthConfigResponse } from '../shared.js';
import { env } from '../config/env.js';
import { HttpError, parseBody } from '../lib/http.js';
import { audit } from '../models/AuditLog.js';
import { toUserDto } from '../models/User.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { issueSession, upsertSignedInUser, verifyEntraAccessToken } from '../services/auth/index.js';
import { invalidateUsers } from '../services/auth/userCache.js';

export const authRouter = Router();

authRouter.get('/auth/config', (_req, res) => {
  const body: AuthConfigResponse = {
    microsoft: verifyEntraAccessToken !== null,
    devLogin: env.AUTH_DEV_LOGIN,
  };
  res.json(body);
});

// Exchanges a Microsoft (MSAL) access token for this API into an app session token.
authRouter.post('/auth/session', async (req, res) => {
  if (!verifyEntraAccessToken) {
    throw new HttpError(503, 'Microsoft sign-in is not configured on the server');
  }
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'Missing Microsoft access token');

  let identity;
  try {
    identity = await verifyEntraAccessToken(header.slice('Bearer '.length));
  } catch (err) {
    req.log.warn({ err }, 'Rejected Microsoft access token');
    throw new HttpError(401, 'Microsoft sign-in could not be verified. Sign in again.');
  }

  const user = await upsertSignedInUser(identity);
  if (!user) {
    req.log.warn({ email: identity.email }, 'Refused sign-in: not on the Users list');
    await audit({ actorId: null, action: 'auth.refused', meta: { email: identity.email, reason: 'not-invited' } });
    throw new HttpError(
      403,
      `${identity.email} hasn’t been given access to Registrar Desk. Ask an administrator to add you under Admin → Users.`,
    );
  }
  if (!user.isActive) throw new HttpError(403, 'Your account is disabled. Contact an administrator.');

  res.json(await issueSession(user));
});

const DevLoginBody = z.object({
  email: z.email(),
  displayName: z.string().trim().min(1).max(100),
  role: z.enum(ROLES),
});

// Local development only: sign in as any user and role without Microsoft. Disabled unless
// AUTH_DEV_LOGIN=true, which env validation refuses in production.
authRouter.post('/auth/dev-login', async (req, res) => {
  if (!env.AUTH_DEV_LOGIN) throw new HttpError(404, 'Not found');
  const body = parseBody(DevLoginBody, req);

  const user = (await upsertSignedInUser(
    { entraId: `dev:${body.email.toLowerCase()}`, email: body.email, displayName: body.displayName },
    { allowNew: true },
  ))!;
  user.role = body.role;
  await user.save();
  invalidateUsers();

  res.json(await issueSession(user));
});

// Session tokens are stateless: signing out is the web app forgetting its token. Kept so older
// clients' calls succeed. A disabled account is refused on its next call regardless.
authRouter.post('/auth/logout', (_req, res) => {
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json(toUserDto(currentUser(req)));
});
