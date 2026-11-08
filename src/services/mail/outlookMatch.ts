import type { OutlookMatchDto, OutlookMatchResultDto } from '../../shared.js';
import { HttpError } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../models/AuditLog.js';
import { MessageModel } from '../../models/Message.js';
import { TicketModel, type TicketDoc } from '../../models/Ticket.js';
import type { TicketPatch } from '../tickets/patchSchema.js';
import type { UserDoc } from '../../models/User.js';
import { getGraph, type GraphService } from '../graph/GraphService.js';
import { applyTicketPatch } from '../tickets/update.js';
import { ingestMessage } from './ingest.js';
import { planOutlookMatch, type MatchPlan } from './outlookMatchRules.js';

// "Match Outlook unread mail" (Admin → Settings): a one-off switchover action. Read-only towards
// the mailbox; imports send no email. Runs in the background (it can outlast an HTTP request).

let running = false;
let lastResult: OutlookMatchResultDto | null = null;

async function buildPlan(graph: GraphService) {
  const unread = (await graph.listUnreadInbox()).filter((m) => m.id && !m.isDraft);
  const known = await MessageModel.find(
    { graphMessageId: { $in: unread.map((m) => m.id!) } },
    { graphMessageId: 1, ticketId: 1 },
  ).lean();
  const knownMessageTicket = new Map(known.map((m) => [m.graphMessageId!, m.ticketId.toString()]));
  const conversations = [...new Set(unread.map((m) => m.conversationId).filter((c): c is string => Boolean(c)))];
  const tickets = await TicketModel.find(
    {
      deletedAt: null,
      $or: [
        { status: { $ne: 'resolved' }, origin: 'email' },
        {
          status: 'resolved',
          $or: [
            { _id: { $in: [...knownMessageTicket.values()] } },
            { conversationId: { $in: conversations } },
            { otherConversationIds: { $in: conversations } },
          ],
        },
      ],
    },
    { status: 1, origin: 1, conversationId: 1, otherConversationIds: 1, deletedAt: 1 },
  ).lean();
  const plan = planOutlookMatch({
    unread: unread.map((m) => ({ id: m.id!, conversationId: m.conversationId })),
    knownMessageTicket,
    tickets: tickets.map((t) => ({ ...t, id: t._id.toString() })),
  });
  // Oldest first, so a thread's first message creates the enquiry and later ones join it.
  const received = new Map(unread.map((m) => [m.id!, m.receivedDateTime ?? '']));
  plan.importIds.sort((a, b) => received.get(a)!.localeCompare(received.get(b)!));
  return plan;
}

function requireGraph(): GraphService {
  const graph = getGraph();
  if (!graph) throw new HttpError(503, 'The shared mailbox is not connected');
  return graph;
}

export async function previewOutlookMatch(): Promise<OutlookMatchDto> {
  const plan: MatchPlan = running ? { resolveIds: [], reopenIds: [], importIds: [] } : await buildPlan(requireGraph());
  return {
    toResolve: plan.resolveIds.length,
    toReopen: plan.reopenIds.length,
    toImport: plan.importIds.length,
    running,
    lastResult,
  };
}

export function startOutlookMatch(user: UserDoc): void {
  const graph = requireGraph();
  if (running) throw new HttpError(409, 'A match is already running');
  running = true;
  void run(graph, user).finally(() => {
    running = false;
  });
}

async function run(graph: GraphService, user: UserDoc) {
  const result: OutlookMatchResultDto = {
    finishedAt: '',
    imported: 0,
    resolved: 0,
    reopened: 0,
    failed: 0,
    error: null,
  };
  try {
    for (const id of (await buildPlan(graph)).importIds) {
      try {
        const r = await ingestMessage(graph, id, { quiet: true });
        if (r === 'created' || r === 'threaded') result.imported += 1;
      } catch (err) {
        result.failed += 1;
        logger.error({ err, graphMessageId: id }, 'Outlook match: could not import message');
      }
    }
    // Planned again: imports may have reopened enquiries already.
    const plan = await buildPlan(graph);
    const change = async (ids: string[], patchFor: (t: TicketDoc) => TicketPatch, key: 'resolved' | 'reopened') => {
      for (const id of ids) {
        const ticket = await TicketModel.findById(id);
        if (!ticket) continue;
        try {
          await applyTicketPatch(ticket, patchFor(ticket), user, null);
          result[key] += 1;
        } catch (err) {
          result.failed += 1;
          logger.error({ err, ticket: ticket.reference }, 'Outlook match: could not update enquiry');
        }
      }
    };
    await change(plan.resolveIds, () => ({ status: 'resolved', isUnread: false }), 'resolved');
    await change(plan.reopenIds, (t) => ({ status: t.assigneeId ? 'in_progress' : 'new', isUnread: true }), 'reopened');
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Outlook match failed');
  }
  result.finishedAt = new Date().toISOString();
  lastResult = result;
  await audit({ actorId: user._id, action: 'outlook.matched', meta: { ...result } }).catch((err: unknown) =>
    logger.error({ err }, 'Outlook match: could not write audit entry'),
  );
}
