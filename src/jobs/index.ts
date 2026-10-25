import cron, { type ScheduledTask } from 'node-cron';
import { env, graphConfigured } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { ensureSubscription } from '../services/mail/subscription.js';
import { syncInbox, whenSyncIdle } from '../services/mail/sync.js';
import { cleanupAbandonedUploads } from './cleanupAttachments.js';
import { checkOverdue } from '../services/automation/sla.js';
import { runRetention } from '../services/tickets/retention.js';
import { checkFollowUps } from '../services/tickets/followUps.js';

const tasks: ScheduledTask[] = [];

/** Cron expression (with seconds) for "every N seconds". */
function everySeconds(n: number): string {
  if (n < 60) return `*/${n} * * * * *`;
  return `0 */${Math.max(1, Math.round(n / 60))} * * * *`;
}

/** Starts background jobs. Call once the database is connected. */
export function startJobs(): void {
  // SLA: flag newly overdue enquiries and escalate them, every 5 minutes.
  tasks.push(cron.schedule('0 */5 * * * *', () => checkOverdue(), { name: 'sla-overdue', noOverlap: true }));
  // Follow-ups: bring enquiries back when their call-back time comes, every minute.
  tasks.push(cron.schedule('0 * * * * *', () => checkFollowUps(), { name: 'follow-ups', noOverlap: true }));
  // Housekeeping that doesn't need Graph: daily at 02:30 server time.
  tasks.push(
    cron.schedule('0 30 2 * * *', () => cleanupAbandonedUploads(), { name: 'cleanup-uploads', noOverlap: true }),
  );
  // Retention (Admin → Settings; off until chosen): daily at 03:00 server time.
  tasks.push(cron.schedule('0 0 3 * * *', () => runRetention(), { name: 'retention', noOverlap: true }));

  if (!graphConfigured || !env.GRAPH_SYNC_ENABLED) {
    logger.info('Mailbox sync is off (Graph not configured or GRAPH_SYNC_ENABLED=false)');
    return;
  }

  // Mail in: poll the Inbox (also the fallback for missed push notifications).
  tasks.push(
    cron.schedule(everySeconds(env.GRAPH_POLL_INTERVAL_SECONDS), () => syncInbox(), {
      name: 'mail-sync',
      noOverlap: true,
    }),
  );
  // Keep the push subscription alive.
  tasks.push(
    cron.schedule('0 15 * * * *', () => ensureSubscription(), { name: 'graph-subscription', noOverlap: true }),
  );

  logger.info(`Mailbox sync on: checking every ${env.GRAPH_POLL_INTERVAL_SECONDS}s`);
  void ensureSubscription().then(() => syncInbox());
}

/** Stops scheduling jobs and waits for a mail sync in progress to finish its current message batch. */
export async function stopJobs(): Promise<void> {
  await Promise.all(tasks.map((t) => t.stop()));
  await whenSyncIdle();
}
