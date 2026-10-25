import { GraphError } from '@microsoft/microsoft-graph-client';
import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { MailboxModel, type MailboxDoc } from '../../models/Mailbox.js';
import { MessageModel } from '../../models/Message.js';
import { TicketModel } from '../../models/Ticket.js';
import { getGraph, type GraphService } from '../graph/GraphService.js';
import { ingestMessage, type IngestResult } from './ingest.js';

/** A message that keeps failing to import is given up on after this many attempts. */
const MAX_ATTEMPTS = 5;
/** Conversations imported in parallel. Messages within one conversation stay in order. */
const CONCURRENCY = 4;

export async function ensureMailbox(address: string): Promise<MailboxDoc> {
  return MailboxModel.findOneAndUpdate(
    { address: address.toLowerCase() },
    { $setOnInsert: { address: address.toLowerCase(), displayName: 'Shareholder Enquiries' } },
    { upsert: true, returnDocument: 'after' },
  );
}

export type SyncSummary = Record<IngestResult | 'failed', number>;

interface FailedMessage {
  graphMessageId: string;
  attempts: number;
  lastError: string;
}

let running: Promise<SyncSummary> | null = null;
let rerunRequested = false;

/**
 * Pulls new Inbox mail via Graph delta and imports it. Only one sync runs at a time; a request that
 * arrives mid-sync (e.g. a webhook) schedules one more run straight after, so nothing is missed.
 */
export function syncInbox(): Promise<SyncSummary> {
  if (running) {
    rerunRequested = true;
    return running;
  }
  running = (async () => {
    try {
      let summary = await runSyncSafely();
      while (rerunRequested) {
        rerunRequested = false;
        summary = await runSyncSafely();
      }
      return summary;
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Resolves when no sync is running, without starting further passes (for shutdown). */
export async function whenSyncIdle(): Promise<void> {
  rerunRequested = false;
  await running?.catch(() => undefined);
}

// Kept in memory because a failure to write to the database can't be recorded in the database.
let lastRunProblem: string | null = null;

/** Why the last sync couldn't run at all (e.g. the database refused writes), or null. */
export function currentSyncProblem(): string | null {
  return lastRunProblem;
}

/** A failed sync (e.g. the database refusing writes) is logged; it must never crash the server. */
async function runSyncSafely(): Promise<SyncSummary> {
  try {
    const summary = await runSync();
    lastRunProblem = null;
    return summary;
  } catch (err) {
    lastRunProblem = describeError(err);
    logger.error({ err }, 'Mailbox sync could not run');
    return { created: 0, threaded: 0, duplicate: 0, skipped: 0, failed: 0 };
  }
}

async function runSync(): Promise<SyncSummary> {
  const summary: SyncSummary = { created: 0, threaded: 0, duplicate: 0, skipped: 0, failed: 0 };
  const graph = getGraph();
  if (!graph) return summary;

  const mailbox = await ensureMailbox(graph.mailbox);
  const failures = new Map<string, FailedMessage>(
    mailbox.failedMessages.map((f) => [
      f.graphMessageId,
      { graphMessageId: f.graphMessageId, attempts: f.attempts, lastError: f.lastError },
    ]),
  );

  const importOne = async (id: string) => {
    try {
      summary[await ingestMessage(graph, id)] += 1;
      failures.delete(id);
    } catch (err) {
      summary.failed += 1;
      const previous = failures.get(id);
      const attempts = (previous?.attempts ?? 0) + 1;
      const lastError = describeError(err);
      logger.error({ err, graphMessageId: id, attempts }, 'Failed to import message');
      if (attempts >= MAX_ATTEMPTS) {
        logger.error({ graphMessageId: id }, `Giving up on message after ${MAX_ATTEMPTS} attempts`);
        failures.delete(id);
      } else {
        failures.set(id, { graphMessageId: id, attempts, lastError });
      }
    }
  };

  try {
    await removeOrphanTickets();
    // Retry earlier failures first.
    for (const id of [...failures.keys()]) await importOne(id);

    const since = new Date(Date.now() - env.GRAPH_INITIAL_SYNC_DAYS * 86_400_000);
    // Resume an interrupted pass if there is one; otherwise continue from the last completed pass.
    let link: string | null = mailbox.deltaResumeLink ?? mailbox.deltaLink ?? null;
    if (mailbox.deltaResumeLink) logger.info('Resuming an interrupted mailbox sync from its last checkpoint');
    let deltaLink: string | undefined;
    do {
      const page = await getDeltaPage(graph, link, since, mailbox);
      const fresh = page.messages
        .filter((m) => !m['@removed'] && !m.isDraft && m.id)
        // Oldest first, so a thread's first message creates the ticket and replies attach to it.
        .sort((a, b) => (a.receivedDateTime ?? '').localeCompare(b.receivedDateTime ?? ''));
      // One query to skip everything already imported, instead of one round trip per message.
      const known = new Set(
        (
          await MessageModel.find({ graphMessageId: { $in: fresh.map((m) => m.id!) } }, { graphMessageId: 1 }).lean()
        ).map((m) => m.graphMessageId),
      );
      summary.duplicate += known.size;
      await importByConversation(
        fresh.filter((m) => !known.has(m.id!)),
        importOne,
      );
      link = page.nextLink ?? null;
      deltaLink = page.deltaLink;
      // Checkpoint after every page, so a restart picks up here rather than rescanning everything.
      if (link) {
        mailbox.deltaResumeLink = link;
        await MailboxModel.updateOne(
          { _id: mailbox._id },
          { $set: { deltaResumeLink: link, failedMessages: [...failures.values()] } },
        );
      }
    } while (link);

    mailbox.deltaLink = deltaLink ?? mailbox.deltaLink;
    mailbox.deltaResumeLink = null;
    mailbox.lastSyncAt = new Date();
    mailbox.lastSyncError = null;
  } catch (err) {
    mailbox.lastSyncError = describeError(err);
    logger.error({ err }, 'Mailbox sync failed');
  }

  mailbox.set('failedMessages', [...failures.values()]);
  await mailbox.save();

  if (summary.created || summary.threaded || summary.failed) logger.info({ summary }, 'Mailbox sync finished');
  return summary;
}

/**
 * Imports messages with up to CONCURRENCY conversations at a time. Messages of the same conversation
 * run one after another (oldest first), so two replies can't race to create two tickets.
 */
async function importByConversation(
  messages: { id?: string | null; conversationId?: string | null }[],
  importOne: (id: string) => Promise<void>,
) {
  const groups = new Map<string, string[]>();
  for (const m of messages) {
    const key = m.conversationId ?? m.id!;
    const ids = groups.get(key);
    if (ids) ids.push(m.id!);
    else groups.set(key, [m.id!]);
  }
  const queue = [...groups.values()];
  const worker = async () => {
    for (let ids = queue.shift(); ids; ids = queue.shift()) {
      for (const id of ids) await importOne(id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
}

/**
 * A restart mid-import can leave a ticket created but its first message not yet saved. Such empty
 * email tickets are removed (the message itself is imported again on the next sync). One whose
 * message was saved but whose own update was cut short keeps its message; its count is repaired.
 */
async function removeOrphanTickets() {
  const cutoff = new Date(Date.now() - 10 * 60_000);
  const candidates = await TicketModel.find({ origin: 'email', messageCount: 0, createdAt: { $lt: cutoff } })
    .select('_id')
    .lean<{ _id: Types.ObjectId }[]>();
  if (candidates.length === 0) return;
  // Keep any ticket whose message was saved before the interruption (only its count is stale).
  const counts = await MessageModel.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { ticketId: { $in: candidates.map((t) => t._id) } } },
    { $group: { _id: '$ticketId', n: { $sum: 1 } } },
  ]);
  for (const c of counts) {
    await TicketModel.updateOne({ _id: c._id, messageCount: 0 }, { $set: { messageCount: c.n } });
    logger.warn({ ticketId: c._id.toString() }, 'Repaired the message count of an interrupted import');
  }
  const withMessages = new Set(counts.map((c) => c._id.toString()));
  const empty = candidates.filter((t) => !withMessages.has(t._id.toString())).map((t) => t._id);
  if (empty.length === 0) return;
  await TicketModel.deleteMany({ _id: { $in: empty } });
  logger.warn({ count: empty.length }, 'Removed empty tickets left by an interrupted import');
}

/** Fetches a delta page; if the stored delta link has expired, starts a fresh delta. */
async function getDeltaPage(graph: GraphService, link: string | null, since: Date, mailbox: MailboxDoc) {
  try {
    return await graph.getInboxDelta(link, since);
  } catch (err) {
    const expired = err instanceof GraphError && (err.statusCode === 410 || err.code === 'SyncStateNotFound');
    if (!link || !expired) throw err;
    logger.warn('Graph delta link expired; restarting the delta from the initial sync window');
    mailbox.deltaLink = null;
    mailbox.deltaResumeLink = null;
    return graph.getInboxDelta(null, since);
  }
}

function describeError(err: unknown): string {
  if (err instanceof GraphError) return `Graph ${err.statusCode} ${err.code ?? ''}: ${err.message}`.trim();
  return err instanceof Error ? err.message : String(err);
}
