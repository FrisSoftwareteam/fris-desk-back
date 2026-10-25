import type { Types } from 'mongoose';
import type { TicketStatus } from '../../shared.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../models/AuditLog.js';
import { MessageModel } from '../../models/Message.js';
import { SlaPolicyModel, type SlaPolicy } from '../../models/SlaPolicy.js';
import { TicketModel, type TicketDoc } from '../../models/Ticket.js';
import { notifyTicketChanged } from '../realtime/changes.js';
import { UserModel } from '../../models/User.js';
import { deliverEmail } from '../mail/send.js';
import { addBusinessMinutes, DEFAULT_BUSINESS_HOURS, type BusinessHours } from './businessHours.js';
import { overdueAfterRecalc } from './slaRules.js';

type Policy = SlaPolicy & { _id: Types.ObjectId };

/** The SLA clock doesn't run while we wait for the shareholder, or once an enquiry is resolved. */
const PAUSED: TicketStatus[] = ['awaiting_shareholder', 'resolved'];
const PAUSED_STATUSES = new Set<string>(PAUSED);

let policyCache: { policies: Policy[]; expires: number } | null = null;

async function activePolicies(): Promise<Policy[]> {
  if (policyCache && policyCache.expires > Date.now()) return policyCache.policies;
  const policies = (await SlaPolicyModel.find({ isActive: true }).lean()) as Policy[];
  policyCache = { policies, expires: Date.now() + 60_000 };
  return policies;
}

export function invalidateSlaPolicies(): void {
  policyCache = null;
}

/**
 * The most specific policy whose conditions all hold (folder, category, priority); a policy with
 * no conditions is the default. Ties go to the stricter (shorter first-response) policy.
 */
export function choosePolicy(
  policies: Policy[],
  t: { folderId?: Types.ObjectId | null; categoryIds: Types.ObjectId[]; priority: string },
): Policy | null {
  const candidates = policies.filter((p) => {
    const a = p.appliesTo ?? {};
    if (a.folderId && !t.folderId?.equals(a.folderId)) return false;
    if (a.categoryId && !t.categoryIds.some((c) => c.equals(a.categoryId!))) return false;
    if (a.priority && a.priority !== t.priority) return false;
    return true;
  });
  const specificity = (p: Policy) =>
    [p.appliesTo?.folderId, p.appliesTo?.categoryId, p.appliesTo?.priority].filter(Boolean).length;
  candidates.sort((a, b) => specificity(b) - specificity(a) || a.firstResponseMins - b.firstResponseMins);
  return candidates[0] ?? null;
}

function hoursOf(p: Policy): BusinessHours {
  const bh = p.businessHours;
  return bh?.tz
    ? { tz: bh.tz, days: bh.days?.length ? bh.days : DEFAULT_BUSINESS_HOURS.days, start: bh.start, end: bh.end }
    : DEFAULT_BUSINESS_HOURS;
}

/**
 * Sets the ticket's SLA policy and due time (doesn't save). Until the first reply the target is
 * first response; after it, resolution. Call after anything that affects which policy applies
 * (folder, categories, priority) or the clock (first reply, status).
 * Doesn't flag a newly past-due ticket overdue (the checkOverdue job does, with alerts) unless
 * `quiet` is set — see overdueAfterRecalc.
 */
export async function applySla(
  ticket: TicketDoc,
  { now = new Date(), quiet = false }: { now?: Date; quiet?: boolean } = {},
): Promise<void> {
  const policy = choosePolicy(await activePolicies(), ticket);
  ticket.slaStartAt ??= ticket.createdAt ?? now;
  if (!policy) {
    ticket.slaPolicyId = null;
    ticket.slaDueAt = null;
    ticket.isOverdue = false;
    return;
  }
  const minutes = ticket.firstResponseAt ? policy.resolutionMins : policy.firstResponseMins;
  ticket.slaPolicyId = policy._id;
  ticket.slaDueAt = addBusinessMinutes(ticket.slaStartAt, minutes, hoursOf(policy));
  ticket.isOverdue = overdueAfterRecalc(ticket.isOverdue, {
    paused: PAUSED_STATUSES.has(ticket.status),
    dueAt: ticket.slaDueAt,
    now,
    quiet,
  });
}

/**
 * Cron job: flags enquiries whose SLA has just run out, adds an internal note, and alerts the
 * policy's supervisor by email (subject to MAIL_SEND_ALLOWLIST). Each ticket escalates once.
 */
export async function checkOverdue(now = new Date()): Promise<number> {
  const due = await TicketModel.find({
    deletedAt: null,
    isOverdue: false,
    status: { $nin: PAUSED },
    slaDueAt: { $ne: null, $lt: now },
  }).limit(200);

  for (const ticket of due) {
    // Claimed atomically, so a ticket escalates once even if an officer saved it meanwhile (and
    // their save can't undo the flag or the message count).
    const claimed = await TicketModel.updateOne(
      { _id: ticket._id, isOverdue: false },
      { $set: { isOverdue: true }, $inc: { messageCount: 1 } },
    );
    if (!claimed.modifiedCount) continue;
    notifyTicketChanged(ticket._id.toString());

    const policy = ticket.slaPolicyId ? await SlaPolicyModel.findById(ticket.slaPolicyId).lean() : null;
    const supervisor = policy?.escalateToUserId ? await UserModel.findById(policy.escalateToUserId).lean() : null;
    const target = ticket.firstResponseAt ? 'resolution' : 'first response';

    await MessageModel.create({
      ticketId: ticket._id,
      direction: 'note',
      from: { name: 'Registrar Desk', email: '' },
      bodyHtml: `<p>SLA breached: the ${target} target (${policy?.name ?? 'SLA'}) passed without ${
        ticket.firstResponseAt ? 'the enquiry being resolved' : 'a reply'
      }.${supervisor ? ` Escalated to ${escapeHtml(supervisor.displayName)}.` : ''}</p>`,
      bodyText: `SLA breached: ${target} target passed.${supervisor ? ` Escalated to ${supervisor.displayName}.` : ''}`,
      sentAt: now,
    });

    let notified = false;
    if (supervisor?.email && supervisor.isActive) {
      try {
        await deliverEmail({
          ticketReference: ticket.reference,
          baseGraphMessageId: null,
          kind: 'reply',
          to: [{ name: supervisor.displayName, email: supervisor.email }],
          cc: [],
          subject: `Overdue: ${ticket.subject} [${ticket.reference}]`,
          bodyHtml:
            `<p>Enquiry <strong>${ticket.reference}</strong> from ${escapeHtml(ticket.contact.name ?? '')} has passed its ${target} target.</p>` +
            `<p>Subject: ${escapeHtml(ticket.subject)}</p><p>Please review it in Registrar Desk.</p>`,
        });
        notified = true;
      } catch (err) {
        logger.warn({ err, ticket: ticket.reference }, 'Could not email the supervisor about an overdue enquiry');
      }
    }
    await audit({
      actorId: null,
      action: 'sla.breached',
      ticketId: ticket._id,
      meta: {
        target,
        policy: policy?.name ?? null,
        supervisor: supervisor?.email ?? null,
        supervisorEmailed: notified,
      },
    });
  }
  if (due.length) logger.info({ count: due.length }, 'Flagged overdue enquiries');
  return due.length;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Recalculates the SLA policy and due time of every unresolved enquiry (or all, for the script)
 * after policies change. Quiet: enquiries that are already past due are flagged overdue without
 * notes or supervisor emails, since a policy edit could otherwise trigger a flood of alerts.
 */
export async function recalculateSla(opts: { includeResolved?: boolean } = {}): Promise<{
  updated: number;
  overdue: number;
}> {
  invalidateSlaPolicies();
  let updated = 0;
  let overdue = 0;
  const query = opts.includeResolved
    ? TicketModel.find({ deletedAt: null })
    : TicketModel.find({ deletedAt: null, status: { $ne: 'resolved' } });
  for await (const t of query.cursor()) {
    if (!t.slaStartAt) {
      // The clock starts when the first message arrived, not when it was imported.
      const first = await MessageModel.findOne({ ticketId: t._id }).sort({ sentAt: 1 }).lean();
      t.slaStartAt = first?.sentAt ?? t.createdAt;
    }
    await applySla(t, { quiet: true });
    if (t.isModified()) {
      await t.save();
      updated += 1;
    }
    if (t.isOverdue) overdue += 1;
  }
  return { updated, overdue };
}

let recalcRunning: Promise<void> | null = null;
let recalcAgain = false;

/**
 * Runs `recalculateSla` in the background after an admin saves a policy. Saves made while it runs
 * queue one more pass, so the last change always wins without overlapping runs.
 */
export function recalculateSlaInBackground(): void {
  if (recalcRunning) {
    recalcAgain = true;
    return;
  }
  recalcRunning = (async () => {
    do {
      recalcAgain = false;
      try {
        const r = await recalculateSla();
        logger.info(r, 'SLA due times recalculated after a policy change');
      } catch (err) {
        logger.error({ err }, 'SLA recalculation failed');
      }
    } while (recalcAgain);
    recalcRunning = null;
  })();
}
