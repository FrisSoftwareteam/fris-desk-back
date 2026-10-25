import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env, graphWebhookConfigured } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { syncInbox } from '../services/mail/sync.js';

export const GRAPH_WEBHOOK_PATH = '/graph/webhook';

export const graphWebhookRouter = Router();

// Only the shared secret matters; anything else in a notification is ignored.
const Notifications = z.object({
  value: z
    .array(z.object({ clientState: z.string().max(256) }))
    .min(1)
    .max(1000),
});

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Public endpoint called by Microsoft Graph (no session; exempt from the CSRF header check).
// A notification only says "something changed"; we never trust its contents, we just run a delta
// sync, which fetches the actual mail from Graph with our own credentials.
graphWebhookRouter.post(GRAPH_WEBHOOK_PATH, (req, res) => {
  // Subscription validation handshake: echo the token back as plain text within 10 seconds.
  const token = req.query.validationToken;
  if (typeof token === 'string' && token.length <= 2048) {
    res.status(200).type('text/plain').send(token);
    return;
  }

  if (!graphWebhookConfigured) {
    res.status(404).end();
    return;
  }

  const parsed = Notifications.safeParse(req.body);
  const valid = parsed.success && parsed.data.value.every((n) => sameSecret(n.clientState, env.GRAPH_WEBHOOK_SECRET!));
  if (!valid) {
    logger.warn('Rejected Graph notification with a missing or wrong clientState');
    res.status(401).end();
    return;
  }

  // Acknowledge at once (Graph expects a reply within 3 seconds), then sync.
  res.status(202).end();
  void syncInbox();
});
