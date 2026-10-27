import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import {
  ASSIGNMENT_MODES,
  DELETE_RESOLVED_OPTIONS,
  PRIORITY_LABELS,
  PURGE_DELETED_OPTIONS,
  TICKET_PRIORITIES,
  type AssignmentRuleDto,
  type TicketPriority,
  type HistoryEntryDto,
  type SettingsDto,
  type SlaPolicyDto,
} from '../shared.js';
import { HttpError, parseBody } from '../lib/http.js';
import { audit, AuditLogModel } from '../models/AuditLog.js';
import { AssignmentRuleModel, type AssignmentRule } from '../models/AssignmentRule.js';
import { CategoryModel } from '../models/Category.js';
import { FolderModel } from '../models/Folder.js';
import { getSettings, invalidateSettings, SettingsModel } from '../models/Settings.js';
import { SlaPolicyModel, type SlaPolicy } from '../models/SlaPolicy.js';
import { TemplateModel } from '../models/Template.js';
import { TicketModel } from '../models/Ticket.js';
import { currentUser, requireAuth, requireRole } from '../middleware/auth.js';
import { getUserNames } from '../services/auth/userCache.js';
import { DEFAULT_BUSINESS_HOURS } from '../services/automation/businessHours.js';
import { getStatusReasons } from '../services/tickets/statusReasons.js';
import { invalidateRules } from '../services/automation/routing.js';
import { invalidateSlaPolicies, recalculateSlaInBackground } from '../services/automation/sla.js';

// Routing rules, SLA policies and settings (BUILD_SPEC §7). Admins manage them (screens: Phase 7);
// supervisors can read them. Every change is audited.
export const automationRouter = Router();

const objectId = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');
const oid = (s: string | null | undefined) => (s ? new Types.ObjectId(s) : null);
const str = (v: unknown) => (v ? String(v) : null);
const readers = [requireAuth, requireRole('supervisor', 'admin')];
const admins = [requireAuth, requireRole('admin')];

// ── Routing rules ────────────────────────────────────────────────────────────

const RuleBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    priority: z.number().int().min(0).max(100_000).default(100),
    isActive: z.boolean().default(true),
    conditions: z
      .array(
        z.object({
          field: z.enum(['subject', 'fromEmail', 'fromDomain', 'body']),
          op: z.enum(['contains', 'equals']),
          value: z.string().trim().min(1).max(300),
        }),
      )
      .min(1, 'Add at least one condition')
      .max(10),
    action: z
      .object({
        setFolderId: objectId.nullable().default(null),
        addCategoryIds: z.array(objectId).max(10).default([]),
        assignStrategy: z.enum(['round_robin', 'specific']).nullable().default(null),
        assigneeId: objectId.nullable().default(null),
        redirectTo: z.email().nullable().default(null),
      })
      .refine((a) => a.assignStrategy !== 'specific' || a.assigneeId, 'Choose who to assign to')
      .refine(
        (a) => a.setFolderId || a.addCategoryIds.length || a.assignStrategy || a.redirectTo,
        'The rule must do something: set a folder, add a category, assign or redirect',
      ),
    roundRobinPool: z.array(objectId).max(100).default([]),
  })
  .refine(
    (r) => !r.isActive || r.action.assignStrategy,
    "A rule that's switched on must assign an officer or a pool of officers",
  )
  .refine(
    (r) => r.action.assignStrategy !== 'round_robin' || r.roundRobinPool.length > 0,
    'Choose the officers to rotate between',
  );

function toRuleDto(r: AssignmentRule & { _id: Types.ObjectId }): AssignmentRuleDto {
  return {
    id: r._id.toString(),
    name: r.name,
    priority: r.priority,
    isActive: r.isActive,
    conditions: r.conditions.map((c) => ({ field: c.field, op: c.op, value: c.value })),
    action: {
      setFolderId: str(r.action?.setFolderId),
      addCategoryIds: (r.action?.addCategoryIds ?? []).map(String),
      assignStrategy: r.action?.assignStrategy ?? null,
      assigneeId: str(r.action?.assigneeId),
      redirectTo: r.action?.redirectTo ?? null,
    },
    roundRobinPool: r.roundRobinPool.map(String),
  };
}

function ruleDoc(body: z.infer<typeof RuleBody>) {
  return {
    ...body,
    action: {
      ...body.action,
      setFolderId: oid(body.action.setFolderId),
      addCategoryIds: body.action.addCategoryIds.map((c) => new Types.ObjectId(c)),
      assigneeId: oid(body.action.assigneeId),
    },
    roundRobinPool: body.roundRobinPool.map((u) => new Types.ObjectId(u)),
  };
}

automationRouter.get('/assignment-rules', ...readers, async (_req, res) => {
  const rules = await AssignmentRuleModel.find().sort({ priority: 1, name: 1 }).lean();
  res.json(rules.map((r) => toRuleDto(r as AssignmentRule & { _id: Types.ObjectId })));
});

automationRouter.post('/assignment-rules', ...admins, async (req, res) => {
  const body = parseBody(RuleBody, req);
  const rule = await AssignmentRuleModel.create(ruleDoc(body));
  invalidateRules();
  await audit({ actorId: currentUser(req)._id, action: 'rule.created', meta: { ruleId: rule._id, name: rule.name } });
  res.status(201).json(toRuleDto(rule.toObject()));
});

automationRouter.put('/assignment-rules/:id', ...admins, async (req, res) => {
  const id = new Types.ObjectId(objectId.parse(req.params.id));
  const body = parseBody(RuleBody, req);
  const rule = await AssignmentRuleModel.findByIdAndUpdate(id, ruleDoc(body), {
    returnDocument: 'after',
  }).lean();
  if (!rule) throw new HttpError(404, 'Rule not found');
  invalidateRules();
  await audit({ actorId: currentUser(req)._id, action: 'rule.updated', meta: { ruleId: rule._id, name: rule.name } });
  res.json(toRuleDto(rule as AssignmentRule & { _id: Types.ObjectId }));
});

automationRouter.delete('/assignment-rules/:id', ...admins, async (req, res) => {
  const rule = await AssignmentRuleModel.findByIdAndDelete(objectId.parse(req.params.id)).lean();
  if (!rule) throw new HttpError(404, 'Rule not found');
  invalidateRules();
  await audit({ actorId: currentUser(req)._id, action: 'rule.deleted', meta: { ruleId: rule._id, name: rule.name } });
  res.status(204).end();
});

// ── SLA policies ─────────────────────────────────────────────────────────────

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const SlaBody = z.object({
  name: z.string().trim().min(1).max(120),
  isActive: z.boolean().default(true),
  appliesTo: z
    .object({
      folderId: objectId.nullable().default(null),
      categoryId: objectId.nullable().default(null),
      priority: z.enum(TICKET_PRIORITIES).nullable().default(null),
    })
    .default({ folderId: null, categoryId: null, priority: null }),
  firstResponseMins: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 60),
  resolutionMins: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 180),
  businessHours: z
    .object({
      tz: z.string().min(1).default('Africa/Lagos'),
      days: z.array(z.number().int().min(1).max(7)).min(1).default([1, 2, 3, 4, 5]),
      start: HHMM.default('08:00'),
      end: HHMM.default('17:00'),
    })
    .refine((b) => b.start < b.end, 'Closing time must be after opening time')
    .refine((b) => Intl.supportedValuesOf('timeZone').includes(b.tz) || b.tz === 'UTC', 'Unknown time zone')
    .default({ tz: 'Africa/Lagos', days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00' }),
  escalateToUserId: objectId.nullable().default(null),
});

function toSlaDto(p: SlaPolicy & { _id: Types.ObjectId }): SlaPolicyDto {
  return {
    id: p._id.toString(),
    name: p.name,
    isActive: p.isActive,
    appliesTo: {
      folderId: str(p.appliesTo?.folderId),
      categoryId: str(p.appliesTo?.categoryId),
      priority: (p.appliesTo?.priority as SlaPolicyDto['appliesTo']['priority']) ?? null,
    },
    firstResponseMins: p.firstResponseMins,
    resolutionMins: p.resolutionMins,
    businessHours: {
      tz: p.businessHours?.tz ?? 'Africa/Lagos',
      days: p.businessHours?.days ?? [1, 2, 3, 4, 5],
      start: p.businessHours?.start ?? '08:00',
      end: p.businessHours?.end ?? '17:00',
    },
    escalateToUserId: str(p.escalateToUserId),
  };
}

function slaDoc(body: z.infer<typeof SlaBody>) {
  return {
    ...body,
    appliesTo: {
      ...body.appliesTo,
      folderId: oid(body.appliesTo.folderId),
      categoryId: oid(body.appliesTo.categoryId),
    },
    escalateToUserId: oid(body.escalateToUserId),
  };
}

automationRouter.get('/sla-policies', ...readers, async (_req, res) => {
  const policies = await SlaPolicyModel.find().sort({ name: 1 }).lean();
  res.json(policies.map((p) => toSlaDto(p as SlaPolicy & { _id: Types.ObjectId })));
});

automationRouter.post('/sla-policies', ...admins, async (req, res) => {
  const p = await SlaPolicyModel.create(slaDoc(parseBody(SlaBody, req)));
  invalidateSlaPolicies();
  // Open enquiries pick up the change straight away (in the background; it can take a while).
  recalculateSlaInBackground();
  await audit({ actorId: currentUser(req)._id, action: 'sla_policy.created', meta: { policyId: p._id, name: p.name } });
  res.status(201).json(toSlaDto(p.toObject()));
});

automationRouter.put('/sla-policies/:id', ...admins, async (req, res) => {
  const p = await SlaPolicyModel.findByIdAndUpdate(objectId.parse(req.params.id), slaDoc(parseBody(SlaBody, req)), {
    returnDocument: 'after',
  }).lean();
  if (!p) throw new HttpError(404, 'SLA policy not found');
  invalidateSlaPolicies();
  // Open enquiries pick up the change straight away (in the background; it can take a while).
  recalculateSlaInBackground();
  await audit({ actorId: currentUser(req)._id, action: 'sla_policy.updated', meta: { policyId: p._id, name: p.name } });
  res.json(toSlaDto(p as SlaPolicy & { _id: Types.ObjectId }));
});

automationRouter.delete('/sla-policies/:id', ...admins, async (req, res) => {
  const p = await SlaPolicyModel.findByIdAndDelete(objectId.parse(req.params.id)).lean();
  if (!p) throw new HttpError(404, 'SLA policy not found');
  invalidateSlaPolicies();
  // Open enquiries pick up the change straight away (in the background; it can take a while).
  recalculateSlaInBackground();
  await audit({ actorId: currentUser(req)._id, action: 'sla_policy.deleted', meta: { policyId: p._id, name: p.name } });
  res.status(204).end();
});

// ── Settings ─────────────────────────────────────────────────────────────────

function toSettingsDto(s: Awaited<ReturnType<typeof getSettings>>): SettingsDto {
  return {
    autoAcknowledge: { enabled: s.autoAcknowledge?.enabled ?? false, templateId: str(s.autoAcknowledge?.templateId) },
    roundRobinEnabled: s.roundRobinEnabled,
    defaultPool: (s.defaultPool ?? []).map(String),
    assignmentMode: (s.assignmentMode as SettingsDto['assignmentMode']) ?? 'round_robin',
    workloadCap: s.workloadCap ?? 15,
    defaultPriority: (s.defaultPriority as SettingsDto['defaultPriority']) ?? 'normal',
    externalSenderPhrases: s.externalSenderPhrases ?? [],
    retention: {
      purgeDeletedAfterDays: s.retention?.purgeDeletedAfterDays ?? null,
      deleteResolvedAfterDays: s.retention?.deleteResolvedAfterDays ?? null,
    },
  };
}

automationRouter.get('/settings', ...admins, async (_req, res) => {
  res.json(toSettingsDto(await getSettings()));
});

const SettingsBody = z
  .object({
    autoAcknowledge: z.object({ enabled: z.boolean(), templateId: objectId.nullable() }),
    roundRobinEnabled: z.boolean(),
    defaultPool: z.array(objectId).max(100),
    assignmentMode: z.enum(ASSIGNMENT_MODES),
    workloadCap: z.number().int().min(1).max(200),
    defaultPriority: z.enum(TICKET_PRIORITIES),
    externalSenderPhrases: z
      .array(z.string().trim().min(3, 'Each phrase needs at least 3 characters').max(200))
      .max(20),
    retention: z.object({
      purgeDeletedAfterDays: z
        .number()
        .refine((n) => (PURGE_DELETED_OPTIONS as readonly number[]).includes(n), 'Choose one of the offered periods')
        .nullable(),
      deleteResolvedAfterDays: z
        .number()
        .refine((n) => (DELETE_RESOLVED_OPTIONS as readonly number[]).includes(n), 'Choose one of the offered periods')
        .nullable(),
    }),
  })
  .partial()
  .strict();

automationRouter.patch('/settings', ...admins, async (req, res) => {
  const body = parseBody(SettingsBody, req);
  if (body.autoAcknowledge?.enabled && !body.autoAcknowledge.templateId) {
    throw new HttpError(400, 'Choose the template to send before turning on auto-acknowledgement');
  }
  if (body.autoAcknowledge?.templateId && !(await TemplateModel.exists({ _id: body.autoAcknowledge.templateId }))) {
    throw new HttpError(400, 'Template not found');
  }
  const current = await getSettings();
  const storedPool = (current.defaultPool ?? []).map(String);
  const pool = body.defaultPool ?? storedPool;
  if ((body.roundRobinEnabled ?? current.roundRobinEnabled) && pool.length === 0) {
    throw new HttpError(400, 'Choose the officers who get new enquiries before turning on automatic assignment');
  }
  await SettingsModel.updateOne(
    { _id: 'app' },
    {
      $set: {
        ...(body.autoAcknowledge && {
          'autoAcknowledge.enabled': body.autoAcknowledge.enabled,
          'autoAcknowledge.templateId': oid(body.autoAcknowledge.templateId),
        }),
        ...(body.roundRobinEnabled !== undefined && { roundRobinEnabled: body.roundRobinEnabled }),
        ...(body.defaultPool && { defaultPool: body.defaultPool.map((u) => new Types.ObjectId(u)) }),
        ...(body.assignmentMode && { assignmentMode: body.assignmentMode }),
        ...(body.workloadCap !== undefined && { workloadCap: body.workloadCap }),
        ...(body.defaultPriority && { defaultPriority: body.defaultPriority }),
        ...(body.externalSenderPhrases && { externalSenderPhrases: body.externalSenderPhrases }),
        ...(body.retention && {
          'retention.purgeDeletedAfterDays': body.retention.purgeDeletedAfterDays,
          'retention.deleteResolvedAfterDays': body.retention.deleteResolvedAfterDays,
        }),
      },
    },
  );
  invalidateSettings();
  await audit({ actorId: currentUser(req)._id, action: 'settings.updated', meta: { changes: body } });
  res.json(toSettingsDto(await getSettings()));
});

// ── Ticket history ───────────────────────────────────────────────────────────

const STATUS_WORDS: Record<string, string> = {
  new: 'New',
  assigned: 'Assigned',
  in_progress: 'In progress',
  awaiting_shareholder: 'Awaiting shareholder',
  escalated: 'Escalated',
  resolved: 'Resolved',
};

type Meta = Record<string, unknown>;

/** A date and time as officers read it, in the business time zone (e.g. "21 Oct 2026, 09:00"). */
function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: DEFAULT_BUSINESS_HOURS.tz,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** Turns an audit entry into a sentence an officer understands. */
function describe(
  action: string,
  meta: Meta,
  names: {
    users: Map<string, string>;
    folders: Map<string, string>;
    categories: Map<string, string>;
    stages: Map<string, string>;
  },
): string {
  const user = (id: unknown) => (id ? (names.users.get(String(id)) ?? 'a former officer') : 'nobody');
  const folder = (id: unknown) => (id ? (names.folders.get(String(id)) ?? 'a deleted folder') : 'no folder');
  const cats = (ids: unknown) =>
    String(ids ?? '')
      .split(',')
      .filter(Boolean)
      .map((id) => names.categories.get(id) ?? 'a deleted category')
      .join(', ') || 'none';
  const change = (m: Meta, key: string) => m[key] as { before: unknown; after: unknown } | undefined;

  switch (action) {
    case 'ticket.created':
      return meta.origin === 'email'
        ? 'Enquiry received by email'
        : `Enquiry logged (${meta.origin === 'phone' ? 'phone call' : 'walk-in'})`;
    case 'message.received':
      return `Email received from ${String(meta.from ?? 'the shareholder')}`;
    case 'message.sent':
      return (
        `Reply sent to ${(meta.to as string[] | undefined)?.join(', ') ?? 'the shareholder'}` +
        (meta.approvedBy ? `, approved by ${user(meta.approvedBy)}` : '')
      );
    case 'reply.held':
      return `Reply held for a supervisor's approval (${String(meta.reason ?? 'approval policy')})`;
    case 'reply.approved':
      return `Held reply approved${meta.edited ? ' with changes' : ''}`;
    case 'reply.returned':
      return `Held reply returned to ${user(meta.author)} for changes`;
    case 'message.forwarded':
      return `Forwarded to ${(meta.to as string[] | undefined)?.join(', ') ?? 'someone'}`;
    case 'note.added':
      return 'Internal note added';
    case 'message.auto_acknowledged':
      return `Acknowledgement sent automatically to ${String(meta.to ?? 'the shareholder')}`;
    case 'auto_ack.skipped':
      return `No acknowledgement sent: ${String(meta.reason ?? 'skipped')}`;
    case 'ticket.routed': {
      const parts = [`Matched ${(meta.rules as string[] | undefined)?.map((r) => `"${r}"`).join(', ') ?? 'a rule'}`];
      if (meta.folderId) parts.push(`filed in ${folder(meta.folderId)}`);
      if ((meta.categoryIds as string[] | undefined)?.length)
        parts.push(`categorised ${cats((meta.categoryIds as string[]).join(','))}`);
      if (meta.assigneeId) parts.push(`assigned to ${user(meta.assigneeId)}`);
      return parts.join('; ');
    }
    case 'ticket.redirected':
      return `Redirected to ${String(meta.to)} by the rule "${String(meta.rule)}"`;
    case 'ticket.redirect_failed':
      return `Redirect to ${String(meta.to)} was not sent: ${String(meta.reason)}`;
    case 'sla.breached':
      return `SLA breached (${String(meta.target)})${meta.supervisor ? `; escalated to ${String(meta.supervisor)}` : ''}`;
    case 'ticket.status_changed': {
      const after = (meta.after as Meta | undefined)?.status;
      return `Reopened as ${STATUS_WORDS[String(after)] ?? String(after)} because the shareholder replied`;
    }
    case 'ticket.updated': {
      const lines: string[] = [];
      const s = change(meta, 'status');
      if (s)
        lines.push(
          `status ${STATUS_WORDS[String(s.before)] ?? s.before} → ${STATUS_WORDS[String(s.after)] ?? s.after}`,
        );
      const a = change(meta, 'assigneeId');
      if (a) lines.push(a.after ? `assigned to ${user(a.after)}` : 'unassigned');
      const f = change(meta, 'folderId');
      if (f) lines.push(`moved to ${folder(f.after)}`);
      const c = change(meta, 'categoryIds');
      if (c) lines.push(`categories: ${cats(c.after)}`);
      const r = change(meta, 'statusReasonId');
      if (r) lines.push(r.after ? `stage ${names.stages.get(String(r.after)) ?? 'a deleted stage'}` : 'stage cleared');
      const p = change(meta, 'priority');
      if (p) lines.push(`priority ${PRIORITY_LABELS[p.after as TicketPriority] ?? String(p.after)}`);
      const fu = change(meta, 'followUp') as { after: unknown; note?: string } | undefined;
      if (fu)
        lines.push(
          fu.after
            ? `follow-up set for ${formatWhen(String(fu.after))}${fu.note ? ` (${fu.note})` : ''}`
            : 'follow-up cleared',
        );
      return lines.length ? lines.join('; ').replace(/^./, (x) => x.toUpperCase()) : 'Updated';
    }
    case 'followup.due':
      return `Follow-up due${meta.note ? `: ${String(meta.note)}` : ''}`;
    case 'ticket.escalated':
      return `Escalated to ${String(meta.department ?? 'another team')} (${String(meta.to ?? '')})`;
    case 'ticket.deleted':
      return String(meta.reason ?? '').startsWith('retention')
        ? 'Moved to Deleted items by the retention schedule'
        : 'Moved to Deleted items';
    case 'ticket.restored':
      return meta.reason === 'shareholder wrote again'
        ? 'Restored from Deleted items because a new email arrived'
        : 'Restored from Deleted items';
    default:
      return action.replace(/[._]/g, ' ');
  }
}

automationRouter.get('/tickets/:id/history', requireAuth, async (req, res) => {
  const id = new Types.ObjectId(objectId.parse(req.params.id));
  if (!(await TicketModel.exists({ _id: id, deletedAt: null }))) throw new HttpError(404, 'Enquiry not found');
  const [entries, users, folders, categories, stages] = await Promise.all([
    AuditLogModel.find({ ticketId: id }).sort({ at: -1 }).limit(200).lean(),
    getUserNames(),
    FolderModel.find({}, { name: 1 }).lean(),
    CategoryModel.find({}, { name: 1 }).lean(),
    getStatusReasons(),
  ]);
  const names = {
    users,
    folders: new Map(folders.map((f) => [f._id.toString(), f.name])),
    categories: new Map(categories.map((c) => [c._id.toString(), c.name])),
    stages: new Map([...stages.values()].map((r) => [r.id, r.name])),
  };
  const body: HistoryEntryDto[] = entries.map((e) => ({
    id: e._id.toString(),
    at: e.at.toISOString(),
    actor: e.actorId ? (users.get(e.actorId.toString()) ?? 'Former officer') : null,
    action: e.action,
    summary: describe(e.action, (e.meta ?? {}) as Meta, names),
  }));
  res.json(body);
});
