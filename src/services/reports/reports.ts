import { Types, type PipelineStage } from 'mongoose';
import {
  AGE_BANDS,
  OPEN_TICKET_STATUSES,
  TICKET_ORIGINS,
  type AgeingDto,
  type AgentReportDto,
  type AgentRowDto,
  type BreakdownDto,
  type BreakdownGroup,
  type BreakdownRowDto,
  type ReportSummaryDto,
  type TicketOrigin,
} from '../../shared.js';
import { AuditLogModel } from '../../models/AuditLog.js';
import { CategoryModel } from '../../models/Category.js';
import { FolderModel } from '../../models/Folder.js';
import { MessageModel } from '../../models/Message.js';
import { SlaPolicyModel } from '../../models/SlaPolicy.js';
import { TicketModel } from '../../models/Ticket.js';
import { UserModel } from '../../models/User.js';
import { businessMinutesBetween, DEFAULT_BUSINESS_HOURS, type BusinessHours } from '../automation/businessHours.js';
import { getUserNames } from '../auth/userCache.js';
import { ageBand, listDays, mean, percent, slaOutcome } from './metrics.js';

// Reporting (BUILD_SPEC §6.1, §7 /reports/*). Everything is computed from `tickets`, `messages` and
// `auditLogs` — no separate analytics collection. Counts use aggregation pipelines with day/hour
// buckets in the business time zone; response and resolution times are working minutes (the
// default SLA policy's business hours), so a Friday-evening email answered on Monday morning
// isn't counted as a 60-hour wait.

export interface ReportFilters {
  from: Date;
  to: Date;
  agentId: Types.ObjectId | null;
  folderId: Types.ObjectId | null;
}

// ── Queries ──────────────────────────────────────────────────────────────────

/** Business hours of the default SLA policy (the one with no conditions), else Mon–Fri 08:00–17:00 Lagos. */
export async function reportBusinessHours(): Promise<BusinessHours> {
  const policies = await SlaPolicyModel.find({ isActive: true }).lean();
  const p =
    policies.find((x) => !x.appliesTo?.folderId && !x.appliesTo?.categoryId && !x.appliesTo?.priority) ?? policies[0];
  const bh = p?.businessHours;
  return bh?.tz
    ? { tz: bh.tz, days: bh.days?.length ? bh.days : DEFAULT_BUSINESS_HOURS.days, start: bh.start, end: bh.end }
    : DEFAULT_BUSINESS_HOURS;
}

const range = (f: ReportFilters) => ({ $gte: f.from, $lt: f.to });

function ticketScope(f: ReportFilters) {
  return {
    deletedAt: null,
    ...(f.folderId && { folderId: f.folderId }),
    ...(f.agentId && { assigneeId: f.agentId }),
  };
}

/** Tickets in the folder filter, for narrowing audit-log and message queries (null = no filter). */
async function folderTicketIds(f: ReportFilters): Promise<Types.ObjectId[] | null> {
  if (!f.folderId) return null;
  return (await TicketModel.find({ folderId: f.folderId, deletedAt: null }, { _id: 1 }).lean()).map((t) => t._id);
}

/**
 * Enquiries that arrived in range: by the email's arrival time (not when it was imported), or
 * creation for those without one.
 */
const arrivedIn = (f: ReportFilters) => ({
  $or: [{ slaStartAt: range(f) }, { slaStartAt: null, createdAt: range(f) }],
});

/** When a ticket started waiting: the email's arrival (not its import), else creation. */
const waitStart = (t: { slaStartAt?: Date | null; createdAt: Date }) => t.slaStartAt ?? t.createdAt;

export async function reportSummary(f: ReportFilters): Promise<ReportSummaryDto> {
  const scope = ticketScope(f);
  const hours = await reportBusinessHours();
  const [received, openNow, overdueNow, responded, resolved] = await Promise.all([
    TicketModel.aggregate<{ _id: TicketOrigin; n: number }>([
      { $match: { ...scope, ...arrivedIn(f) } },
      { $group: { _id: '$origin', n: { $sum: 1 } } },
    ]),
    TicketModel.countDocuments({ ...scope, status: { $ne: 'resolved' } }),
    TicketModel.countDocuments({ ...scope, status: { $ne: 'resolved' }, isOverdue: true }),
    TicketModel.find(
      { ...scope, firstResponseAt: range(f) },
      { slaStartAt: 1, createdAt: 1, firstResponseAt: 1 },
    ).lean(),
    TicketModel.find({ ...scope, resolvedAt: range(f) }, { resolvedAt: 1, slaDueAt: 1 }).lean(),
  ]);

  const byOrigin = Object.fromEntries(TICKET_ORIGINS.map((o) => [o, 0])) as Record<TicketOrigin, number>;
  for (const r of received) byOrigin[r._id] = r.n;
  const outcomes = resolved.map(slaOutcome).filter(Boolean);
  return {
    received: received.reduce((a, r) => a + r.n, 0),
    openNow,
    resolved: resolved.length,
    overdueNow,
    avgFirstResponseMins: mean(responded.map((t) => businessMinutesBetween(waitStart(t), t.firstResponseAt!, hours))),
    slaMetPct: percent(outcomes.filter((o) => o === 'met').length, outcomes.length),
    byOrigin,
  };
}

/**
 * Assignment events from the audit log, with who received the enquiry: a manual (re)assignment,
 * a routing rule, an officer logging an enquiry to themselves, or an officer taking ownership by
 * replying to an unassigned one.
 */
function assignmentEvents(f: ReportFilters, ticketIds: Types.ObjectId[] | null, tz: string): PipelineStage[] {
  const assignee = {
    $switch: {
      branches: [
        { case: { $eq: ['$action', 'ticket.updated'] }, then: '$meta.assigneeId.after' },
        { case: { $eq: ['$action', 'ticket.routed'] }, then: '$meta.assigneeId' },
        {
          case: { $and: [{ $eq: ['$action', 'ticket.created'] }, { $eq: ['$meta.assignedToSelf', true] }] },
          then: { $toString: '$actorId' },
        },
        {
          case: {
            $and: [
              { $in: ['$action', ['message.sent', 'message.forwarded']] },
              { $eq: [{ $ifNull: ['$meta.ticketBefore.assigneeId', null] }, null] },
            ],
          },
          then: '$meta.ticketAfter.assigneeId',
        },
      ],
      default: null,
    },
  };
  return [
    {
      $match: {
        at: range(f),
        action: { $in: ['ticket.updated', 'ticket.routed', 'ticket.created', 'message.sent', 'message.forwarded'] },
        ...(ticketIds && { ticketId: { $in: ticketIds } }),
      },
    },
    { $project: { at: 1, assignee: assignee } },
    { $match: { assignee: f.agentId ? f.agentId.toString() : { $type: 'string' } } },
    {
      $project: {
        assignee: 1,
        day: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: tz } },
        hour: { $hour: { date: '$at', timezone: tz } },
      },
    },
  ];
}

export async function reportAgents(f: ReportFilters): Promise<AgentReportDto> {
  const hours = await reportBusinessHours();
  const tz = hours.tz;
  const scope = ticketScope(f);
  const ticketIds = await folderTicketIds(f);
  const dayOf = (field: unknown) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: tz } });

  const [users, open, assignedByDay, assignedByHour, replies, responded, resolved, received, resolvedByDay] =
    await Promise.all([
      UserModel.find(f.agentId ? { _id: f.agentId } : { isActive: true }, { displayName: 1, role: 1 })
        .sort({ displayName: 1 })
        .lean(),
      TicketModel.aggregate<{ _id: Types.ObjectId; open: number; overdue: number }>([
        { $match: { ...scope, assigneeId: f.agentId ?? { $ne: null }, status: { $in: OPEN_TICKET_STATUSES } } },
        { $group: { _id: '$assigneeId', open: { $sum: 1 }, overdue: { $sum: { $cond: ['$isOverdue', 1, 0] } } } },
      ]),
      AuditLogModel.aggregate<{ _id: { assignee: string; day: string }; n: number }>([
        ...assignmentEvents(f, ticketIds, tz),
        { $group: { _id: { assignee: '$assignee', day: '$day' }, n: { $sum: 1 } } },
      ]),
      AuditLogModel.aggregate<{ _id: number; n: number }>([
        ...assignmentEvents(f, ticketIds, tz),
        { $group: { _id: '$hour', n: { $sum: 1 } } },
      ]),
      MessageModel.aggregate<{ _id: Types.ObjectId; n: number }>([
        {
          $match: {
            direction: 'outbound',
            sentAt: range(f),
            authorId: f.agentId ?? { $ne: null },
            ...(ticketIds && { ticketId: { $in: ticketIds } }),
          },
        },
        { $group: { _id: '$authorId', n: { $sum: 1 } } },
      ]),
      TicketModel.find(
        { ...scope, firstResponseAt: range(f) },
        { assigneeId: 1, slaStartAt: 1, createdAt: 1, firstResponseAt: 1 },
      ).lean(),
      TicketModel.find(
        { ...scope, resolvedAt: range(f) },
        { assigneeId: 1, slaStartAt: 1, createdAt: 1, resolvedAt: 1, slaDueAt: 1 },
      ).lean(),
      TicketModel.aggregate<{ _id: string; n: number }>([
        { $match: { ...scope, ...arrivedIn(f) } },
        { $group: { _id: dayOf({ $ifNull: ['$slaStartAt', '$createdAt'] }), n: { $sum: 1 } } },
      ]),
      TicketModel.aggregate<{ _id: string; n: number }>([
        { $match: { ...scope, resolvedAt: range(f) } },
        { $group: { _id: dayOf('$resolvedAt'), n: { $sum: 1 } } },
      ]),
    ]);

  const key = (id: Types.ObjectId | string | null | undefined) => (id ? id.toString() : '');
  const openBy = new Map(open.map((o) => [key(o._id), o]));
  const repliesBy = new Map(replies.map((r) => [key(r._id), r.n]));
  const assignedTotal = new Map<string, number>();
  for (const a of assignedByDay) assignedTotal.set(a._id.assignee, (assignedTotal.get(a._id.assignee) ?? 0) + a.n);
  const group = <T extends { assigneeId?: Types.ObjectId | null }>(list: T[]) => {
    const m = new Map<string, T[]>();
    for (const t of list) pushTo(m, key(t.assigneeId), t);
    return m;
  };
  const respondedBy = group(responded);
  const resolvedBy = group(resolved);

  const rows: AgentRowDto[] = users.map((u) => {
    const id = key(u._id);
    const done = resolvedBy.get(id) ?? [];
    const outcomes = done.map(slaOutcome).filter(Boolean);
    return {
      agentId: id,
      displayName: u.displayName,
      role: u.role,
      openNow: openBy.get(id)?.open ?? 0,
      assigned: assignedTotal.get(id) ?? 0,
      resolved: done.length,
      repliesSent: repliesBy.get(id) ?? 0,
      avgFirstResponseMins: mean(
        (respondedBy.get(id) ?? []).map((t) => businessMinutesBetween(waitStart(t), t.firstResponseAt!, hours)),
      ),
      avgResolutionMins: mean(done.map((t) => businessMinutesBetween(waitStart(t), t.resolvedAt!, hours))),
      overdueNow: openBy.get(id)?.overdue ?? 0,
      slaMetPct: percent(outcomes.filter((o) => o === 'met').length, outcomes.length),
    };
  });
  // Agents always appear (§6.1: one row per onboarded officer); supervisors and admins only when
  // they actually handled enquiries.
  const agents = rows.filter(
    (r) => f.agentId || r.role === 'agent' || r.openNow || r.assigned || r.resolved || r.repliesSent,
  );

  const days = listDays(f.from, f.to, tz);
  const perDay = new Map(days.map((d) => [d, { day: d, total: 0, byAgent: {} as Record<string, number> }]));
  for (const a of assignedByDay) {
    const bucket = perDay.get(a._id.day);
    if (!bucket) continue;
    bucket.total += a.n;
    bucket.byAgent[a._id.assignee] = (bucket.byAgent[a._id.assignee] ?? 0) + a.n;
  }
  const receivedBy = new Map(received.map((r) => [r._id, r.n]));
  const resolvedByDayMap = new Map(resolvedByDay.map((r) => [r._id, r.n]));
  const hourBy = new Map(assignedByHour.map((h) => [h._id, h.n]));

  return {
    businessHours: hours,
    agents,
    assignmentsByDay: [...perDay.values()],
    assignmentsByHour: Array.from({ length: 24 }, (_, hour) => ({ hour, total: hourBy.get(hour) ?? 0 })),
    receivedVsResolved: days.map((day) => ({
      day,
      received: receivedBy.get(day) ?? 0,
      resolved: resolvedByDayMap.get(day) ?? 0,
    })),
  };
}

// ── Ageing and breakdowns (GAP_ANALYSIS G-06.5) ──────────────────────────────

/** Open enquiries now, by how long they have been waiting. The date range doesn't apply. */
export async function reportAgeing(f: ReportFilters): Promise<AgeingDto> {
  const [open, names] = await Promise.all([
    TicketModel.find(
      { ...ticketScope(f), status: { $ne: 'resolved' } },
      { reference: 1, subject: 1, slaStartAt: 1, createdAt: 1, isOverdue: 1, assigneeId: 1 },
    ).lean(),
    getUserNames(),
  ]);
  const now = new Date();
  const bands = AGE_BANDS.map((band) => ({ band, total: 0, overdue: 0 }));
  for (const t of open) {
    const b = bands.find((x) => x.band === ageBand(waitStart(t), now))!;
    b.total++;
    if (t.isOverdue) b.overdue++;
  }
  const oldest = [...open]
    .sort((a, b) => waitStart(a).getTime() - waitStart(b).getTime())
    .slice(0, 10)
    .map((t) => ({
      id: t._id.toString(),
      reference: t.reference,
      subject: t.subject ?? '',
      ageDays: Math.floor((now.getTime() - waitStart(t).getTime()) / 86_400_000),
      isOverdue: t.isOverdue,
      assignee: t.assigneeId ? (names.get(t.assigneeId.toString()) ?? 'Former user') : null,
    }));
  return { bands, oldest };
}

/**
 * Received, resolved, open and timing figures per category or per folder. An enquiry with several
 * categories counts under each, so category rows can add up to more than the total.
 */
export async function reportBreakdown(f: ReportFilters, groupBy: BreakdownGroup): Promise<BreakdownDto> {
  const scope = ticketScope(f);
  const fields = { categoryIds: 1, folderId: 1 };
  const [hours, groups, received, responded, resolved, open] = await Promise.all([
    reportBusinessHours(),
    groupBy === 'category'
      ? CategoryModel.find({}, { name: 1, color: 1 }).sort({ name: 1 }).lean()
      : FolderModel.find({}, { name: 1 }).sort({ order: 1, name: 1 }).lean(),
    TicketModel.find({ ...scope, ...arrivedIn(f) }, fields).lean(),
    TicketModel.find(
      { ...scope, firstResponseAt: range(f) },
      { ...fields, slaStartAt: 1, createdAt: 1, firstResponseAt: 1 },
    ).lean(),
    TicketModel.find(
      { ...scope, resolvedAt: range(f) },
      { ...fields, slaStartAt: 1, createdAt: 1, resolvedAt: 1, slaDueAt: 1 },
    ).lean(),
    TicketModel.find({ ...scope, status: { $ne: 'resolved' } }, { ...fields, isOverdue: 1 }).lean(),
  ]);

  const keysOf = (t: { categoryIds?: Types.ObjectId[]; folderId?: Types.ObjectId | null }): string[] =>
    groupBy === 'category'
      ? t.categoryIds?.length
        ? t.categoryIds.map(String)
        : ['']
      : [t.folderId ? t.folderId.toString() : ''];
  const bucket = <T extends Parameters<typeof keysOf>[0]>(list: T[]) => {
    const m = new Map<string, T[]>();
    for (const t of list) for (const k of keysOf(t)) pushTo(m, k, t);
    return m;
  };
  const receivedBy = bucket(received);
  const respondedBy = bucket(responded);
  const resolvedBy = bucket(resolved);
  const openBy = bucket(open);

  const named = groups.map((g) => ({
    id: g._id.toString(),
    name: g.name,
    color: 'color' in g ? (g.color as string) : null,
  }));
  const none = { id: '', name: groupBy === 'category' ? 'Uncategorised' : 'No folder', color: null };
  const rows: BreakdownRowDto[] = [...named, none].map((g) => {
    const done = resolvedBy.get(g.id) ?? [];
    const outcomes = done.map(slaOutcome).filter(Boolean);
    const openNow = openBy.get(g.id) ?? [];
    return {
      id: g.id || null,
      name: g.name,
      color: g.color,
      received: receivedBy.get(g.id)?.length ?? 0,
      resolved: done.length,
      openNow: openNow.length,
      overdueNow: openNow.filter((t) => t.isOverdue).length,
      avgFirstResponseMins: mean(
        (respondedBy.get(g.id) ?? []).map((t) => businessMinutesBetween(waitStart(t), t.firstResponseAt!, hours)),
      ),
      avgResolutionMins: mean(done.map((t) => businessMinutesBetween(waitStart(t), t.resolvedAt!, hours))),
      slaMetPct: percent(outcomes.filter((o) => o === 'met').length, outcomes.length),
    };
  });
  // Busiest first; the "none" row only when something falls in it.
  const busy = (r: BreakdownRowDto) => r.received + r.resolved + r.openNow;
  return {
    groupBy,
    rows: rows
      .filter((r) => r.id !== null || busy(r) > 0)
      .sort((a, b) => b.received - a.received || b.openNow - a.openNow || a.name.localeCompare(b.name)),
  };
}

/** Most rows one CSV export returns (a year of enquiries at today's volumes fits comfortably). */
export const EXPORT_ROW_LIMIT = 20_000;

/** Enquiries that arrived in range, newest first, for the "Enquiries in this period" export. */
export async function enquiriesInRange(f: ReportFilters) {
  return TicketModel.find({ ...ticketScope(f), ...arrivedIn(f) })
    .sort({ createdAt: -1, _id: -1 })
    .limit(EXPORT_ROW_LIMIT)
    .lean();
}

/** Adds `item` to the list under `key` (in place; copying the list each time is quadratic). */
function pushTo<K, V>(groups: Map<K, V[]>, key: K, item: V): void {
  const list = groups.get(key);
  if (list) list.push(item);
  else groups.set(key, [item]);
}
