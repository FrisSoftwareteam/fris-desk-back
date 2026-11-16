import { Types } from 'mongoose';
import { logger } from '../../lib/logger.js';
import { audit } from '../../models/AuditLog.js';
import { AssignmentRuleModel, type AssignmentRule } from '../../models/AssignmentRule.js';
import { getSettings, SettingsModel, type SettingsDoc } from '../../models/Settings.js';
import { MessageModel } from '../../models/Message.js';
import { HttpError } from '../../lib/http.js';
import { applyTicketPatch } from '../tickets/update.js';
import { TicketModel, type TicketDoc } from '../../models/Ticket.js';
import { UserModel, type UserDoc } from '../../models/User.js';
import { invalidateUsers } from '../auth/userCache.js';
import { visibleUsers } from '../auth/index.js';
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

interface PoolSource {
  /** Moves the pool's shared cursor by `n` (atomically) and returns the pool and cursor from before. */
  advance(n: number): Promise<{ pool: string[]; cursor: number } | null>;
}

const rulePool = (ruleId: Types.ObjectId): PoolSource => ({
  async advance(n) {
    const before = await AssignmentRuleModel.findOneAndUpdate(
      { _id: ruleId },
      { $inc: { roundRobinCursor: n } },
      { returnDocument: 'before' },
    ).lean();
    return before && { pool: before.roundRobinPool.map(String), cursor: before.roundRobinCursor };
  },
});

const defaultPool: PoolSource = {
  async advance(n) {
    const before = await SettingsModel.findOneAndUpdate(
      { _id: 'app' },
      { $inc: { defaultPoolCursor: n } },
      { returnDocument: 'before' },
    ).lean();
    return before && { pool: (before.defaultPool ?? []).map(String), cursor: before.defaultPoolCursor ?? 0 };
  },
};

/**
 * Picks the next officer from a pool (a rule's, or the default one in Settings) using the assignment
 * method chosen in Settings. Disabled accounts are skipped.
 */
async function nextPoolOfficer(source: PoolSource, mode: AssignmentMode, cap: number) {
  const before = await source.advance(1);
  const pool = before?.pool ?? [];
  if (pool.length === 0) return null;
  const active = new Set(
    (await UserModel.find({ _id: { $in: pool }, isActive: true, ...visibleUsers }, { _id: 1 }).lean()).map((u) => u._id.toString()),
  );
  const pick = pickFromPool({
    pool,
    cursor: before!.cursor,
    isActive: (id) => active.has(id),
    mode,
    cap,
    ...(mode !== 'round_robin' && { loads: await openLoads(pool) }),
  });
  if (!pick) return null;
  // Officers were passed over: move the shared cursor past them too (atomically).
  if (pick.advance > 0) await source.advance(pick.advance);
  return new Types.ObjectId(pick.userId);
}

/**
 * Who a rule-matched enquiry goes to: the rule's specific officer or pool, else the default pool.
 * Advances the pools' round-robin cursors.
 */
async function pickAssignee(rule: RuleLike | null, settings: SettingsDoc) {
  let assignee: Types.ObjectId | null = null;
  let assignedBy: string | null = null;
  const usesDefaultPool = settings.roundRobinEnabled && (settings.defaultPool ?? []).length > 0;
  const mode = (settings.assignmentMode ?? 'round_robin') as AssignmentMode;
  const cap = settings.workloadCap ?? 15;
  if (rule?.action.assignStrategy === 'specific' && rule.action.assigneeId) {
    const ok = await UserModel.exists({ _id: rule.action.assigneeId, isActive: true });
    if (ok) assignee = new Types.ObjectId(rule.action.assigneeId);
    assignedBy = `${rule.name} (specific)`;
  } else if (rule?.action.assignStrategy === 'round_robin' && settings.roundRobinEnabled) {
    assignee = await nextPoolOfficer(rulePool(new Types.ObjectId(rule.id)), mode, cap);
    assignedBy = `${rule.name} (${mode})`;
  }
  // Nobody assigned by a rule (no match, or its officers are unavailable): use the default pool.
  if (!assignee && usesDefaultPool) {
    assignee = await nextPoolOfficer(defaultPool, mode, cap);
    if (assignee) assignedBy = `Default pool (${mode})`;
  }
  return { assignee, assignedBy };
}

/**
 * Applies routing rules to a brand-new email ticket (doesn't save): folder, categories, assignment
 * (specific officer or a pool). Enquiries no rule assigns go to the default pool in Settings.
 * Redirects are returned to run after the ticket is saved.
 */
export async function routeNewTicket(ticket: TicketDoc, mail: IncomingMail) {
  const rules = await loadRules();
  const likes = rules.map(toLike);
  const decision = decideRouting(likes, mail);
  const settings = await getSettings();
  const usesDefaultPool = settings.roundRobinEnabled && (settings.defaultPool ?? []).length > 0;
  if (decision.matchedRuleIds.length === 0 && !usesDefaultPool) return { redirects: [] };

  if (decision.folderId) ticket.folderId = new Types.ObjectId(decision.folderId);
  for (const c of decision.categoryIds) {
    if (!ticket.categoryIds.some((x) => x.toString() === c)) ticket.categoryIds.push(new Types.ObjectId(c));
  }

  const { assignee, assignedBy } = await pickAssignee(decision.assignmentRule, settings);
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
      assignedBy,
    },
  });
  return { redirects: decision.redirects.map((r) => ({ ruleName: r.rule.name, to: r.to })) };
}

/** Mail redirection: forwards the original email to the rule's address (subject to MAIL_SEND_ALLOWLIST). */
/** The enquiries the Unassigned view lists: open and owned by nobody. */
export const UNASSIGNED_OPEN = { assigneeId: null, deletedAt: null, status: { $ne: 'resolved' as const } };

/** How many enquiries one click assigns. */
const BACKLOG_BATCH = 200;

/**
 * Shares out existing unassigned enquiries (e.g. at go-live) the way new mail is assigned: routing
 * rules first, then the default pool, with the chosen method. Only the assignee changes.
 */
export async function assignBacklog(admin: UserDoc) {
  const settings = await getSettings();
  if (!settings.roundRobinEnabled || (settings.defaultPool ?? []).length === 0) {
    throw new HttpError(400, 'Turn on automatic assignment and choose the officers first');
  }
  // shortcut: 200 per click to stay inside request timeouts; move to a background job like outlook-match if backlogs are routinely larger.
  const tickets = await TicketModel.find(UNASSIGNED_OPEN).sort({ createdAt: 1 }).limit(BACKLOG_BATCH);
  const likes = (await loadRules()).map(toLike);
  let assigned = 0;
  let skipped = 0;
  // One at a time: least-loaded and capped picks read each officer's load from the saved enquiries.
  for (const ticket of tickets) {
    const first = await MessageModel.findOne({ ticketId: ticket._id }, { bodyText: 1 }).sort({ sentAt: 1 }).lean();
    const decision = decideRouting(likes, {
      subject: ticket.subject,
      fromEmail: ticket.contact?.email ?? '',
      bodyText: first?.bodyText ?? '',
    });
    const { assignee } = await pickAssignee(decision.assignmentRule, settings);
    if (!assignee) {
      skipped++;
      continue;
    }
    await applyTicketPatch(ticket, { assigneeId: assignee.toString() }, admin, null);
    assigned++;
  }
  invalidateUsers();
  const remaining = await TicketModel.countDocuments(UNASSIGNED_OPEN);
  await audit({ actorId: admin._id, action: 'tickets.backlog_assigned', meta: { assigned, skipped, remaining } });
  return { assigned, skipped, remaining };
}

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
