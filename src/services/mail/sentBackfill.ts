import type { JobProgressDto, SentBackfillDto, SentBackfillResultDto } from '../../shared.js';
import { HttpError } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../models/AuditLog.js';
import { MessageModel } from '../../models/Message.js';
import { getSettings } from '../../models/Settings.js';
import { countMessages, TicketModel } from '../../models/Ticket.js';
import type { UserDoc } from '../../models/User.js';
import { getGraph, type GraphService } from '../graph/GraphService.js';
import { textToHtml, toAddress } from './ingest.js';
import { pickSentToImport } from './outlookMatchRules.js';
import { htmlToText, makeSnippet, sanitizeEmailHtml } from './sanitize.js';

// "Import replies sent from Outlook" (Admin → Settings): replies officers sent from Outlook before
// the switchover sit in Sent Items, which sync never reads. This copies them into each enquiry's
// thread so officers can see what was already said. Read-only towards the mailbox; sends nothing,
// changes no status. Safe to run again: anything already in the app is skipped.

let running = false;
let lastResult: SentBackfillResultDto | null = null;
let progress: JobProgressDto | null = null;

export function sentBackfillStatus(): SentBackfillDto {
  return { running, progress: running ? progress : null, lastResult };
}

export function startSentBackfill(user: UserDoc): void {
  const graph = getGraph();
  if (!graph) throw new HttpError(503, 'The shared mailbox is not connected');
  if (running) throw new HttpError(409, 'An import is already running');
  running = true;
  void run(graph, user).finally(() => {
    running = false;
    progress = null;
  });
}

async function run(graph: GraphService, user: UserDoc) {
  const result: SentBackfillResultDto = { finishedAt: '', imported: 0, enquiries: 0, failed: 0, error: null };
  try {
    const settings = await getSettings();
    const tickets = await TicketModel.find({ origin: 'email', deletedAt: null, conversationId: { $ne: null } });
    progress = { step: 'Checking enquiries', done: 0, total: tickets.length };
    for (const ticket of tickets) {
      progress.done += 1;
      try {
        const conversations = [ticket.conversationId!, ...ticket.otherConversationIds];
        const sent = (await Promise.all(conversations.map((c) => graph.listSentInConversation(c)))).flat();
        if (sent.length === 0) continue;
        const known = await MessageModel.find(
          {
            $or: [
              { graphMessageId: { $in: sent.map((m) => m.id!) } },
              { internetMessageId: { $in: sent.map((m) => m.internetMessageId).filter(Boolean) } },
            ],
          },
          { graphMessageId: 1, internetMessageId: 1 },
        ).lean();
        const ids = new Set(
          pickSentToImport(
            sent
              .filter((m) => m.id)
              .map((m) => ({
                id: m.id!,
                internetMessageId: m.internetMessageId,
                isDraft: m.isDraft,
                to: [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])].map((r) => toAddress(r).email),
              })),
            ticket.contact.email,
            {
              graphIds: new Set(known.map((k) => k.graphMessageId!).filter(Boolean)),
              internetIds: new Set(known.map((k) => k.internetMessageId!).filter(Boolean)),
            },
          ),
        );
        let added = 0;
        for (const m of sent.filter((s) => ids.has(s.id!))) {
          const sentAt = new Date(m.sentDateTime ?? m.receivedDateTime ?? Date.now());
          const isText = m.body?.contentType === 'text';
          const bodyHtml = isText ? '' : sanitizeEmailHtml(m.body?.content ?? '');
          const bodyText = isText ? (m.body?.content ?? '') : htmlToText(bodyHtml);
          try {
            await MessageModel.create({
              ticketId: ticket._id,
              direction: 'outbound',
              from: toAddress(m.from ?? m.sender),
              to: (m.toRecipients ?? []).map(toAddress),
              cc: (m.ccRecipients ?? []).map(toAddress),
              bodyHtml: isText ? textToHtml(bodyText) : bodyHtml,
              bodyText,
              graphMessageId: m.id,
              internetMessageId: m.internetMessageId ?? null,
              authorId: null,
              sentAt,
            });
          } catch (err) {
            // Duplicate key: the same sent item is in two of this enquiry's conversations, or a rerun.
            if ((err as { code?: number }).code === 11000) continue;
            throw err;
          }
          added += 1;
          if (!ticket.firstResponseAt || sentAt < ticket.firstResponseAt) ticket.firstResponseAt = sentAt;
          if (sentAt >= ticket.lastMessageAt) {
            ticket.lastMessageAt = sentAt;
            ticket.snippet = makeSnippet(bodyText, undefined, settings.externalSenderPhrases);
          }
          await audit({
            actorId: null,
            action: 'message.backfilled',
            ticketId: ticket._id,
            meta: { graphMessageId: m.id, source: 'outlook sent items' },
          });
        }
        if (added) {
          await ticket.save();
          await countMessages(ticket, added);
          result.imported += added;
          result.enquiries += 1;
        }
      } catch (err) {
        result.failed += 1;
        logger.error({ err, ticket: ticket.reference }, 'Outlook sent import: could not import replies');
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Outlook sent import failed');
  }
  result.finishedAt = new Date().toISOString();
  lastResult = result;
  await audit({ actorId: user._id, action: 'outlook.sent_imported', meta: { ...result } }).catch((err: unknown) =>
    logger.error({ err }, 'Outlook sent import: could not write audit entry'),
  );
}
