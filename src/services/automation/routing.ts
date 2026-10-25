import { Types } from 'mongoose';
import { logger } from '../../lib/logger.js';
import { audit } from '../../models/AuditLog.js';
import { AssignmentRuleModel, type AssignmentRule } from '../../models/AssignmentRule.js';
import { getSettings } from '../../models/Settings.js';
import { TicketModel, type TicketDoc } from '../../models/Ticket.js';
import { UserModel } from '../../models/User.js';
import { invalidateUsers } from '../auth/userCache.js';
import { deliverEmail } from '../mail/send.js';
import { decideRouting, pickFromPool, type IncomingMail, type RuleLike } from './rules.js';
import { OPEN_TICKET_STATUSES, type AssignmentMode } from '../../shared.js';

type Rule = AssignmentRule & { _id: Types.ObjectId };

let ruleCache: { rules: Rule[]; expires: number } | null = null;

async function loadRules(): Promise<Rule[]> {
  if (ruleCache && ruleCache.expires > Date.now()) return ruleCache.rules;
  const rules = (await AssignmentRuleModel.find({ isActive: true }).lean()) as Rule[];
  ruleCache = { rules, expires: Date.now() + 60_000 };
  return rules;
}

export function invalidateRules(): void {
  ruleCache = null;
}

function toLike(r: Rule): RuleLike {
  return {
    id: r._id.toString(),
    name: r.name,
    priority: r.priority,
    isActive: r.isActive,
    conditions: r.conditions.map((c) => ({ field: c.field, op: c.op, value: c.value })),
    action: {
      setFolderId: r.action?.setFolderId?.toString() ?? null,
      addCategoryIds: (r.action?.addCategoryIds ?? []).map(String),
      assignStrategy: r.action?.assignStrategy ?? null,
      assigneeId: r.action?.assigneeId?.toString() ?? null,
      redirectTo: r.action?.redirectTo ?? null,
    },
  };
}

/** Picks the next officer from a round-robin rule; the cursor moves atomically, so concurrent mail is spread fairly. */
/** Open enquiries per officer, for workload-aware assignment. */
async function openLoads(userIds: string[]): Promise<Map<string, number>> {
  const rows = await TicketModel.aggregate<{ _id: Types.ObjectId; n: number }>([
    {
      $match: {
        assigneeId: { $in: userIds.map((id) => new Types.ObjectId(id)) },
        status: { $in: OPEN_TICKET_STATUSES },
        deletedAt: null,
      },
    },
    { $group: { _id: '$assigneeId', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id.toString(), r.n]));
}

/** Picks the next officer from a rule's pool using the assignment method chosen in Settings. */
async function nextPoolOfficer(ruleId: Types.ObjectId, mode: AssignmentMode, cap: number) {
  const before = await AssignmentRuleModel.findOneAndUpdate(
    { _id: ruleId },
    { $inc: { roundRobinCursor: 1 } },
    { returnDocument: 'before' },
  ).lean();
  const pool = (before?.roundRobinPool ?? []).map(String);
  if (pool.length === 0) return null;
  const active = new Set(
    (await UserModel.find({ _id: { $in: pool }, isActive: true }, { _id: 1 }).lean()).map((u) => u._id.toString()),
  );
  const pick = pickFromPool({
    pool,
    cursor: before!.roundRobinCursor,
    isActive: (id) => active.has(id),
    mode,
    cap,
    ...(mode !== 'round_robin' && { loads: await openLoads(pool) }),
  });
  if (!pick) return null;
  // Officers were passed over: move the shared cursor past them too (atomically).
  if (pick.advance > 0) {
    await AssignmentRuleModel.updateOne({ _id: ruleId }, { $inc: { roundRobinCursor: pick.advance } });
  }
  return new Types.ObjectId(pick.userId);
}

/**
 * Applies routing rules to a brand-new email ticket (doesn't save): folder, categories, assignment
 * (specific officer or round-robin). Redirects are returned to run after the ticket is saved.
 */
export async function routeNewTicket(ticket: TicketDoc, mail: IncomingMail) {
  const rules = await loadRules();
  if (rules.length === 0) return { redirects: [] as { ruleName: string; to: string }[] };

  const decision = decideRouting(rules.map(toLike), mail);
  if (decision.matchedRuleIds.length === 0) return { redirects: [] };

  if (decision.folderId) ticket.folderId = new Types.ObjectId(decision.folderId);
  for (const c of decision.categoryIds) {
    if (!ticket.categoryIds.some((x) => x.toString() === c)) ticket.categoryIds.push(new Types.ObjectId(c));
  }

  let assignee: Types.ObjectId | null = null;
  const rule = decision.assignmentRule;
  const settings = await getSettings();
  const mode = (settings.assignmentMode ?? 'round_robin') as AssignmentMode;
  if (rule?.action.assignStrategy === 'specific' && rule.action.assigneeId) {
    const ok = await UserModel.exists({ _id: rule.action.assigneeId, isActive: true });
    if (ok) assignee = new Types.ObjectId(rule.action.assigneeId);
  } else if (rule?.action.assignStrategy === 'round_robin' && settings.roundRobinEnabled) {
    assignee = await nextPoolOfficer(new Types.ObjectId(rule.id), mode, settings.workloadCap ?? 15);
  }
  if (assignee) {
    ticket.assigneeId = assignee;
    ticket.assignedAt = new Date();
    ticket.status = 'assigned';
    invalidateUsers();
  }

  await audit({
    actorId: null,
    action: 'ticket.routed',
    ticketId: ticket._id,
    meta: {
      rules: rules.filter((r) => decision.matchedRuleIds.includes(r._id.toString())).map((r) => r.name),
      folderId: decision.folderId ?? null,
      categoryIds: decision.categoryIds,
      assigneeId: assignee?.toString() ?? null,
      assignedBy: rule
        ? `${rule.name} (${rule.action.assignStrategy === 'round_robin' ? mode : rule.action.assignStrategy})`
        : null,
    },
  });
  return { redirects: decision.redirects.map((r) => ({ ruleName: r.rule.name, to: r.to })) };
}

/** Mail redirection: forwards the original email to the rule's address (subject to MAIL_SEND_ALLOWLIST). */
export async function runRedirects(
  ticket: TicketDoc,
  graphMessageId: string,
  redirects: { ruleName: string; to: string }[],
): Promise<void> {
  for (const r of redirects) {
    try {
      await deliverEmail({
        ticketReference: ticket.reference,
        baseGraphMessageId: graphMessageId,
        kind: 'forward',
        to: [{ name: '', email: r.to }],
        cc: [],
        subject: `FW: ${ticket.subject} [${ticket.reference}]`,
        bodyHtml: `<p>Redirected automatically by the rule "${r.ruleName.replace(/[<>&"']/g, '')}".</p>`,
      });
      await audit({
        actorId: null,
        action: 'ticket.redirected',
        ticketId: ticket._id,
        meta: { rule: r.ruleName, to: r.to },
      });
    } catch (err) {
      logger.warn({ err, ticket: ticket.reference, to: r.to }, 'Rule redirect was not sent');
      await audit({
        actorId: null,
        action: 'ticket.redirect_failed',
        ticketId: ticket._id,
        meta: { rule: r.ruleName, to: r.to, reason: (err as Error).message },
      });
    }
  }
}
