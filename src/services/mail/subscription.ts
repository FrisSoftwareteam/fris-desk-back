import { env, graphWebhookConfigured } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { getGraph } from '../graph/GraphService.js';
import { ensureMailbox } from './sync.js';

// Graph change notifications for new Inbox mail. Mail subscriptions last at most ~7 days, so a cron
// job renews them well before expiry. Polling keeps running as the safety net either way.

const LIFETIME_MS = 6 * 24 * 60 * 60 * 1000;
const RENEW_WHEN_LESS_THAN_MS = 2 * 24 * 60 * 60 * 1000;

export async function ensureSubscription(): Promise<void> {
  const graph = getGraph();
  if (!graph || !graphWebhookConfigured) return;
  const expires = new Date(Date.now() + LIFETIME_MS);

  try {
    const mailbox = await ensureMailbox(graph.mailbox);
    if (mailbox.graphSubscriptionId && mailbox.subscriptionExpiresAt) {
      if (mailbox.subscriptionExpiresAt.getTime() - Date.now() > RENEW_WHEN_LESS_THAN_MS) return;
      try {
        const renewed = await graph.renewSubscription(mailbox.graphSubscriptionId, expires);
        mailbox.subscriptionExpiresAt = new Date(renewed.expirationDateTime!);
        await mailbox.save();
        logger.info({ expires: mailbox.subscriptionExpiresAt }, 'Renewed Graph mail subscription');
        return;
      } catch (err) {
        logger.warn({ err }, 'Could not renew Graph subscription; creating a new one');
      }
    }

    const created = await graph.createInboxSubscription(env.GRAPH_WEBHOOK_URL!, env.GRAPH_WEBHOOK_SECRET!, expires);
    mailbox.graphSubscriptionId = created.id ?? null;
    mailbox.subscriptionExpiresAt = created.expirationDateTime ? new Date(created.expirationDateTime) : null;
    await mailbox.save();
    logger.info({ expires: mailbox.subscriptionExpiresAt }, 'Created Graph mail subscription (push notifications on)');
  } catch (err) {
    // Usually the webhook URL isn't reachable from the internet. Polling still delivers mail.
    logger.error({ err }, 'Could not set up Graph push notifications; continuing with polling only');
  }
}
