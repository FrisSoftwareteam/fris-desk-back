import type { Request } from 'express';
import { ipKeyGenerator, rateLimit, type Options } from 'express-rate-limit';
import { bearerToken, sessionTokens } from '../services/auth/index.js';
import { clientIpKey } from './clientIp.js';

// Rate limits (BUILD_SPEC §9 Phase 8). Counted per signed-in officer where the request carries a
// valid session token, because a whole office usually shares one public IP address; otherwise per IP.
// Counters live in memory, which suits a single API process (several would need a shared store such as Redis).

function ipKey(req: Request): string {
  return `ip:${ipKeyGenerator(clientIpKey(req.ip))}`;
}

async function userOrIp(req: Request): Promise<string> {
  const token = bearerToken(req.headers.authorization);
  if (token) {
    // Only a verified token earns its own bucket; a made-up one counts against the IP.
    const userId = await sessionTokens.verify(token).catch(() => null);
    if (userId) return `u:${userId}`;
  }
  return ipKey(req);
}

function limiter(windowMinutes: number, limit: number, message: string, extra: Partial<Options> = {}) {
  return rateLimit({
    windowMs: windowMinutes * 60_000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: userOrIp,
    handler: (_req, res, _next, options) => {
      res.setHeader('Retry-After', Math.ceil(options.windowMs / 1000));
      res.status(429).json({ error: message });
    },
    ...extra,
  });
}

/**
 * Every API call. Generous: an officer's screens poll and refresh a lot, so this only stops runaway
 * scripts or a stuck browser tab.
 */
export const apiLimiter = limiter(5, 1500, 'Too many requests. Wait a few minutes and try again.', {
  // Health checks come from monitoring; the webhook has its own limit.
  skip: (req) => req.path === '/health' || req.path.startsWith('/graph/'),
});

/** Sign-in attempts, per IP (there's no session yet). */
export const signInLimiter = limiter(15, 30, 'Too many sign-in attempts. Wait 15 minutes and try again.', {
  keyGenerator: ipKey,
});

/**
 * Anything that sends email or creates records: replies, notes, escalations, new enquiries,
 * uploads. Far above a busy officer's pace, but stops a script from mass-mailing as the mailbox.
 */
export const sendLimiter = limiter(10, 100, 'You’ve sent a lot in a short time. Wait a few minutes and try again.');

/** Microsoft Graph change notifications (public endpoint), per IP. */
export const webhookLimiter = limiter(1, 300, 'Too many notifications', { keyGenerator: ipKey });
