import type { Request, RequestHandler } from 'express';
import type { Role } from '../shared.js';
import type { UserDoc } from '../models/User.js';
import { getUserById } from '../services/auth/userCache.js';
import { HttpError } from '../lib/http.js';
import { bearerToken, sessionTokens } from '../services/auth/index.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserDoc;
    }
  }
}

/** Requires a valid app session and an active `users` record; sets `req.user`. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const token = bearerToken(req.headers.authorization);
  if (!token) throw new HttpError(401, 'Sign in required');

  let userId: string;
  try {
    userId = await sessionTokens.verify(token);
  } catch {
    throw new HttpError(401, 'Your session has expired. Sign in again.');
  }

  const user = await getUserById(userId);
  if (!user) throw new HttpError(401, 'Sign in required');
  if (!user.isActive) throw new HttpError(403, 'Your account is disabled. Contact an administrator.');

  req.user = user;
  next();
};

/** Allows the request only for the given roles. Use after `requireAuth`. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new HttpError(403, 'You do not have permission to do this');
    }
    next();
  };
}

/** The signed-in user. Only call in handlers mounted behind `requireAuth`. */
export function currentUser(req: Request): UserDoc {
  if (!req.user) throw new HttpError(401, 'Sign in required');
  return req.user;
}
