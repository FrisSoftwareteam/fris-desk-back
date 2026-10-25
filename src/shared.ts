// Enums and API shapes that define the backend <-> frontend contract (BUILD_SPEC §12).
// A matching copy lives in the frontend repo at lib/shared.ts: when you change this file, make the same
// change there so both sides agree.
// Each enum is a const tuple so it can feed both TypeScript types and Mongoose/Zod enum validators.

export const ROLES = ['agent', 'supervisor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const TICKET_STATUSES = [
  'new',
  'assigned',
  'in_progress',
  'awaiting_shareholder',
  'escalated',
  'resolved',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Statuses that count as "open" for workload and dashboard figures (§6.1). */
export const OPEN_TICKET_STATUSES: readonly TicketStatus[] = [
  'assigned',
  'in_progress',
  'awaiting_shareholder',
  'escalated',
];

/** Lowest to highest (GAP_ANALYSIS G-04.7). SLA policies can target any level. */
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

export const TICKET_ORIGINS = ['email', 'phone', 'walk_in', 'manual'] as const;
export type TicketOrigin = (typeof TICKET_ORIGINS)[number];

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound', 'note'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const CATEGORY_TYPES = ['enquiry', 'status', 'officer'] as const;
export type CategoryType = (typeof CATEGORY_TYPES)[number];

export const DEPARTMENT_TYPES = ['department', 'person'] as const;
export type DepartmentType = (typeof DEPARTMENT_TYPES)[number];

export const DRAFT_KINDS = ['reply', 'reply_all', 'forward', 'note'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export interface EmailAddress {
  name: string;
  email: string;
}

/** The shareholder on an enquiry. Email can be empty for phone/walk-in enquiries. */
export interface ContactDto extends EmailAddress {
  phone?: string;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

/** What sign-in methods the backend currently accepts (GET /api/auth/config). */
export interface AuthConfigResponse {
  microsoft: boolean;
  devLogin: boolean;
}

/**
 * A signed-in session (POST /api/auth/session and /api/auth/dev-login). The web app sends `token` as
 * `Authorization: Bearer <token>` on every API call and in the Socket.IO handshake (`auth.token`).
 */
export interface SessionDto {
  user: UserDto;
  token: string;
  /** ISO time the token stops working; sign in again after it. */
  expiresAt: string;
}

/** Header the API requires on every state-changing request (cheap CSRF guard for any request without a token). */
export const CSRF_HEADER = 'x-registrar-desk';

// ── Mail / tickets (API shapes; Phase 1 renders them from fixtures) ───────────

export interface FolderDto {
  id: string;
  name: string;
  order: number;
  parentId: string | null;
  unreadCount: number;
}

export interface CategoryDto {
  id: string;
  name: string;
  type: CategoryType;
  /** Hex colour, normally one of CATEGORY_COLORS. */
  color: string;
}

/** Outlook-style category colour presets. `color` on a category stores one of these hex values. */
export const CATEGORY_COLORS = [
  { name: 'Red', hex: '#d13438' },
  { name: 'Orange', hex: '#ca5010' },
  { name: 'Yellow', hex: '#c19c00' },
  { name: 'Green', hex: '#107c10' },
  { name: 'Teal', hex: '#038387' },
  { name: 'Blue', hex: '#0f6cbd' },
  { name: 'Purple', hex: '#8764b8' },
  { name: 'Cranberry', hex: '#c50f1f' },
  { name: 'Steel', hex: '#005b70' },
  { name: 'Grey', hex: '#616161' },
] as const;

/** One row in the message list. */
export interface TicketSummaryDto {
  id: string;
  reference: string;
  subject: string;
  snippet: string;
  status: TicketStatus;
  /** An admin-defined stage under `status` (e.g. "Awaiting documents"); see GET /status-reasons. */
  statusReasonId: string | null;
  priority: TicketPriority;
  origin: TicketOrigin;
  /** Null until routing rules or an officer file it (Phase 4/5); it still shows in "All enquiries". */
  folderId: string | null;
  contact: ContactDto;
  assignee: Pick<UserDto, 'id' | 'displayName'> | null;
  categoryIds: string[];
  isUnread: boolean;
  isOverdue: boolean;
  hasAttachments: boolean;
  hasDraft: boolean;
  messageCount: number;
  slaDueAt: string | null;
  lastMessageAt: string;
  createdAt: string;
  /** Set while the enquiry is in Deleted items (it can be restored until it's purged). */
  deletedAt: string | null;
  /** Who deleted it; null when the system did (the retention schedule). */
  deletedBy: Pick<UserDto, 'id' | 'displayName'> | null;
  /** When the scheduled purge will remove it for good; null if purging is off. */
  purgeAt: string | null;
  /** A call-back or reminder an officer set (G-04.3); null when there is none. */
  followUp: FollowUpDto | null;
}

export interface FollowUpDto {
  at: string;
  note: string;
  /** Snoozed: kept out of the usual views until it's due (or the shareholder writes again). */
  hide: boolean;
  /** The time has passed; the enquiry is back in the list, unread and flagged. */
  isDue: boolean;
  setBy: Pick<UserDto, 'id' | 'displayName'> | null;
}

export interface AttachmentDto {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface MessageDto {
  id: string;
  ticketId: string;
  direction: MessageDirection;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  /** Sanitised server-side; still rendered only inside a sandboxed iframe. */
  bodyHtml: string;
  bodyText: string;
  author: Pick<UserDto, 'id' | 'displayName'> | null;
  /** The supervisor who approved this reply before it went out (supervisor approval). */
  approvedBy: Pick<UserDto, 'id' | 'displayName'> | null;
  attachments: AttachmentDto[];
  sentAt: string;
}

export interface TicketDetailDto extends TicketSummaryDto {
  messages: MessageDto[];
  /** Replies waiting for a supervisor's approval before they are sent. */
  pendingReplies: PendingReplyDto[];
}

/**
 * Which replies need a supervisor's approval before they go out (Admin → Approvals). Only agents'
 * replies are held; supervisors' and admins' replies, and internal notes, are never held.
 */
export interface ApprovalPolicyDto {
  enabled: boolean;
  /** Every reply by an agent. */
  allAgentReplies: boolean;
  /** Replies by these officers. */
  userIds: string[];
  /** Replies on enquiries in any of these categories. */
  categoryIds: string[];
  /** Replies that used any of these templates. */
  templateIds: string[];
  /** Forwards follow the same rules (otherwise they are never held). */
  includeForwards: boolean;
}

export const PENDING_REPLY_STATUSES = ['pending', 'sending', 'approved', 'returned'] as const;
export type PendingReplyStatus = (typeof PENDING_REPLY_STATUSES)[number];

/** A reply held for approval. */
export interface PendingReplyDto {
  id: string;
  ticketId: string;
  author: Pick<UserDto, 'id' | 'displayName'> | null;
  kind: ComposeKind;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  bodyHtml: string;
  attachments: AttachmentDto[];
  /** Why it was held, e.g. "Category: Complaint". */
  reason: string;
  status: PendingReplyStatus;
  createdAt: string;
}

/** POST /tickets/:id/messages: the enquiry, plus why the reply was held if it went for approval. */
export interface SendResultDto extends TicketDetailDto {
  heldForApproval: string | null;
}

/** POST /pending-replies/:id/approve — optionally with the supervisor's edits. */
export interface ApproveReplyDto {
  subject?: string;
  bodyHtml?: string;
}

/** Built-in views shown above the folders, like Outlook's Inbox / Drafts. */
export const SYSTEM_VIEWS = [
  'inbox',
  'mine',
  'mentions',
  'approvals',
  'unassigned',
  'overdue',
  'followups',
  'drafts',
  'deleted',
] as const;
export type SystemView = (typeof SYSTEM_VIEWS)[number];

/** GET /api/tickets — newest first, paged with `nextCursor`. */
export interface TicketListResponse {
  items: TicketSummaryDto[];
  nextCursor: string | null;
}

/** GET /api/tickets/counts — numbers shown beside views and folders in the folder pane. */
export interface TicketCountsDto {
  /**
   * Unread count per system view (Overdue, Drafts and Deleted are totals; Follow-ups counts those
   * now due). Deleted is 0 for agents.
   */
  views: Record<SystemView, number>;
  /** Unread count per folder id. */
  folders: Record<string, number>;
}

/** PATCH /api/tickets/:id — every field optional. */
export interface TicketPatchDto {
  isUnread?: boolean;
  status?: TicketStatus;
  assigneeId?: string | null;
  categoryIds?: string[];
  folderId?: string | null;
  priority?: TicketPriority;
  /** Sets the stage and moves the enquiry to the stage's status; null clears the stage. */
  statusReasonId?: string | null;
  /** Null clears the follow-up. `at` must be in the future. */
  followUp?: { at: string; note?: string; hide: boolean } | null;
}

/** POST /api/tickets/bulk — one change applied to several enquiries (G-04.2). */
export interface BulkTicketPatchDto {
  ids: string[];
  patch: Omit<TicketPatchDto, 'categoryIds'> & {
    /** Categories are added or removed, so each enquiry keeps the ones it already has. */
    addCategoryIds?: string[];
    removeCategoryIds?: string[];
  };
}

/** POST /api/tickets/bulk/delete and /bulk/restore */
export interface BulkIdsDto {
  ids: string[];
}

/** Result of a bulk action: what changed and what was refused (e.g. an agent assigning others). */
export interface BulkResultDto {
  updated: string[];
  failed: { id: string; reference: string | null; error: string }[];
}

/** An admin-defined stage within a built-in status (Admin → Statuses). */
export interface StatusReasonDto {
  id: string;
  name: string;
  baseStatus: TicketStatus;
  order: number;
  isActive: boolean;
}

/** An officer as shown in pickers (GET /api/users). */
export type StaffDto = Pick<UserDto, 'id' | 'displayName' | 'email' | 'role'>;

// ── Compose, drafts and templates (Phase 3) ──────────────────────────────────

/** Kinds of message an officer can write. `note` is internal and never emailed. */
export type ComposeKind = DraftKind;

/** POST /api/tickets/:id/messages */
export interface SendMessageDto {
  kind: ComposeKind;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  bodyHtml: string;
  attachmentIds: string[];
  /** Templates inserted while writing it (supervisor approval can depend on them). */
  templateIds?: string[];
}

/** An officer's unsent compose state for one ticket (GET/PUT /api/tickets/:id/draft). */
export interface DraftDto {
  kind: ComposeKind;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  bodyHtml: string;
  attachments: AttachmentDto[];
  templateIds: string[];
  updatedAt: string;
}

export interface SaveDraftDto {
  kind: ComposeKind;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  bodyHtml: string;
  attachmentIds: string[];
  templateIds?: string[];
}

export interface TemplateDto {
  id: string;
  name: string;
  subject: string;
  bodyHtml: string;
  folderId: string | null;
  /** Form files attached to the reply whenever the template is inserted. */
  attachments: AttachmentDto[];
}

/** Create/update body for a template: files are referenced by the ids `POST /templates/files` returned. */
export type TemplateInput = Omit<TemplateDto, 'id' | 'attachments'> & { attachmentIds: string[] };

/** Values available to `{{…}}` merge fields in templates. */
export interface MergeContext {
  contact: { name: string; email: string };
  ticket: { reference: string; subject: string };
  officer: { name: string; email: string };
}

/** Merge fields officers can use in templates, with what each becomes. */
export const MERGE_FIELDS: { field: string; description: string }[] = [
  { field: '{{contact.name}}', description: "Shareholder's name" },
  { field: '{{contact.email}}', description: "Shareholder's email address" },
  { field: '{{ticket.reference}}', description: 'Reference number, e.g. REG-2026-000123' },
  { field: '{{ticket.subject}}', description: 'Enquiry subject' },
  { field: '{{officer.name}}', description: 'Your name' },
  { field: '{{officer.email}}', description: 'Your email address' },
  { field: '{{today}}', description: "Today's date" },
];

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/**
 * Fills `{{contact.name}}`-style merge fields in template HTML. Values are HTML-escaped, so a
 * shareholder's name can never inject markup. Unknown fields are left as typed.
 */
export function renderMergeFields(html: string, ctx: MergeContext, now: Date = new Date()): string {
  const values: Record<string, string> = {
    'contact.name': ctx.contact.name || 'Shareholder',
    'contact.email': ctx.contact.email,
    'ticket.reference': ctx.ticket.reference,
    'ticket.subject': ctx.ticket.subject,
    'officer.name': ctx.officer.name,
    'officer.email': ctx.officer.email,
    today: now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
  };
  return html.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) =>
    key in values ? escapeHtml(values[key]!) : match,
  );
}

// ── Automation (Phase 5) ─────────────────────────────────────────────────────

export interface RuleConditionDto {
  field: 'subject' | 'fromEmail' | 'fromDomain' | 'body';
  op: 'contains' | 'equals';
  value: string;
}

export interface AssignmentRuleDto {
  id: string;
  name: string;
  priority: number;
  isActive: boolean;
  conditions: RuleConditionDto[];
  action: {
    setFolderId: string | null;
    addCategoryIds: string[];
    assignStrategy: 'round_robin' | 'specific' | null;
    assigneeId: string | null;
    redirectTo: string | null;
  };
  roundRobinPool: string[];
}

export interface SlaPolicyDto {
  id: string;
  name: string;
  isActive: boolean;
  appliesTo: { folderId: string | null; categoryId: string | null; priority: TicketPriority | null };
  firstResponseMins: number;
  resolutionMins: number;
  businessHours: { tz: string; days: number[]; start: string; end: string };
  escalateToUserId: string | null;
}

/**
 * How a routing rule's officer pool picks who gets a new enquiry:
 * - round_robin: strict rotation.
 * - least_loaded: whoever has the fewest open enquiries (ties take turns).
 * - capped_round_robin: rotation, skipping anyone at or over `workloadCap` open enquiries; if
 *   everyone is, the least loaded.
 */
export const ASSIGNMENT_MODES = ['round_robin', 'least_loaded', 'capped_round_robin'] as const;
export type AssignmentMode = (typeof ASSIGNMENT_MODES)[number];

export interface SettingsDto {
  autoAcknowledge: { enabled: boolean; templateId: string | null };
  /** Master switch for automatic assignment from routing rules' officer pools. */
  roundRobinEnabled: boolean;
  assignmentMode: AssignmentMode;
  /** Open-enquiry limit per officer for `capped_round_robin` (1–200). */
  workloadCap: number;
  defaultPriority: TicketPriority;
  /**
   * Opening words of the notices Exchange puts on external mail (e.g. "CAUTION: This email
   * originated from outside"). Hidden from list previews, in addition to the built-in ones.
   */
  externalSenderPhrases: string[];
  /** Retention (BUILD_SPEC §10). Null switches a rule off. */
  retention: {
    /** Enquiries in Deleted items longer than this are permanently removed. */
    purgeDeletedAfterDays: number | null;
    /** Resolved enquiries untouched for longer than this move to Deleted items. */
    deleteResolvedAfterDays: number | null;
  };
}

/** Choices offered in Admin → Settings → Retention (days). */
export const PURGE_DELETED_OPTIONS = [30, 90, 180, 365] as const;
export const DELETE_RESOLVED_OPTIONS = [365, 730, 1095, 1825, 2555, 3650] as const;

/** One line of an enquiry's activity history (from the audit log). */
export interface HistoryEntryDto {
  id: string;
  at: string;
  /** Officer's name, or null when the system did it (mail sync, rules, SLA). */
  actor: string | null;
  action: string;
  /** Plain-language description. */
  summary: string;
}

/** GET /api/mailbox — the shared mailbox and how its sync is doing. */
export interface MailboxStatusDto {
  address: string | null;
  displayName: string;
  /** Mailbox sync is configured and switched on. */
  syncEnabled: boolean;
  /** Push notifications (webhook) are active; otherwise new mail arrives by polling. */
  pushEnabled: boolean;
  pollIntervalSeconds: number;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  /** When set, email can only be sent to these addresses (development safety net). */
  sendAllowlist: string[] | null;
}

/** POST /api/tickets — log a phone call or walk-in as an enquiry (BUILD_SPEC §6 "New Enquiry"). */
export interface CreateEnquiryDto {
  origin: Extract<TicketOrigin, 'phone' | 'walk_in'>;
  contact: { name: string; email?: string; phone?: string };
  subject: string;
  /** What the shareholder asked, in plain text. */
  details: string;
  folderId: string | null;
  categoryIds: string[];
  priority: TicketPriority;
  /** Assign the new enquiry to the officer logging it. */
  assignToMe: boolean;
}

// ── Real-time: presence and live updates (BUILD_SPEC §7 "Collision detection") ──

/** Someone with an enquiry open. One entry per officer, however many tabs they have open. */
export interface PresenceViewerDto {
  userId: string;
  displayName: string;
  /** They are writing a reply / forward in the composer. */
  replying: boolean;
}

/** Events the server sends. */
export interface ServerToClientEvents {
  /** Who has this enquiry open (sent to everyone viewing it whenever it changes). */
  presence: (p: { ticketId: string; viewers: PresenceViewerDto[] }) => void;
  /** These enquiries changed (new mail, assignment, status…); refresh lists and counts. */
  'tickets:changed': (p: { ticketIds: string[] }) => void;
  /** Sent only to the officer it is for (e.g. a colleague @mentioned them in a note). */
  notification: (n: NotificationDto) => void;
}

/**
 * In-app notifications (the bell). `mention`: a colleague @mentioned you in an internal note.
 * The approval types are for supervisor approval of replies.
 */
export const NOTIFICATION_TYPES = ['mention', 'approval_requested', 'approval_returned', 'approval_sent'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface NotificationDto {
  id: string;
  type: NotificationType;
  ticketId: string;
  ticketReference: string;
  ticketSubject: string;
  /** Who caused it (null for the system). */
  actorName: string | null;
  /** A short extract, e.g. the note's text. */
  snippet: string;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationListDto {
  items: NotificationDto[];
  unread: number;
}

/** Events the browser sends. */
export interface ClientToServerEvents {
  'ticket:join': (ticketId: string) => void;
  'ticket:leave': (ticketId: string) => void;
  'ticket:replying': (p: { ticketId: string; replying: boolean }) => void;
}

// ── Escalation directory (BUILD_SPEC §5 `departments`) ───────────────────────

export interface DepartmentDto {
  id: string;
  name: string;
  email: string;
  type: DepartmentType;
  /** When to escalate here; shown as a hint in the Escalate menu. */
  description: string;
  order: number;
  isActive: boolean;
}

/** POST /api/tickets/:id/escalate */
export interface EscalateDto {
  departmentId: string;
  /** Officer's note, placed above the forwarded thread. */
  note: string;
}

// ── Admin: staff (Admin → Users) ─────────────────────────────────────────────

export interface AdminUserDto extends UserDto {
  isActive: boolean;
  lastSignInAt: string | null;
  createdAt: string;
  /** Added by an admin and not signed in yet; name and email can still be corrected, or the entry removed. */
  pending: boolean;
}

export interface AdminUserCreateDto {
  email: string;
  displayName: string;
  role: Role;
}

export interface AdminUserPatchDto {
  role?: Role;
  isActive?: boolean;
  /** Only while the user is pending. */
  email?: string;
  displayName?: string;
}

// ── Reports and the Agent Activity Dashboard (BUILD_SPEC §6.1) ───────────────

/** Filters shared by both report endpoints. Dates are ISO strings; `to` is exclusive. */
export interface ReportQuery {
  from: string;
  to: string;
  agentId?: string;
  folderId?: string;
}

/** GET /api/reports/summary — the team stat tiles. Durations are in working minutes. */
export interface ReportSummaryDto {
  received: number;
  openNow: number;
  resolved: number;
  overdueNow: number;
  avgFirstResponseMins: number | null;
  /** Share of enquiries resolved in range that were resolved by their SLA due time (0–100). */
  slaMetPct: number | null;
  byOrigin: Record<TicketOrigin, number>;
}

export interface AgentRowDto {
  agentId: string;
  displayName: string;
  role: Role;
  openNow: number;
  assigned: number;
  resolved: number;
  repliesSent: number;
  avgFirstResponseMins: number | null;
  avgResolutionMins: number | null;
  overdueNow: number;
  slaMetPct: number | null;
}

/** GET /api/reports/agents — the per-agent table and the charts. */
export interface AgentReportDto {
  /** The business hours used for working-time durations (from the default SLA policy). */
  businessHours: { tz: string; days: number[]; start: string; end: string };
  agents: AgentRowDto[];
  /** One entry per day in range (YYYY-MM-DD, business time zone) with assignments per agent id. */
  assignmentsByDay: { day: string; total: number; byAgent: Record<string, number> }[];
  /** 24 entries, hour 0–23 in the business time zone. */
  assignmentsByHour: { hour: number; total: number }[];
  receivedVsResolved: { day: string; received: number; resolved: number }[];
}

// ── Ageing, breakdowns and exports (GAP_ANALYSIS G-06.2, G-06.5) ─────────────

/** Age of an open enquiry: calendar time since it started waiting. */
export const AGE_BANDS = ['Under 1 day', '1–3 days', '3–7 days', '7–14 days', '14–30 days', '30+ days'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

/** GET /api/reports/ageing — open enquiries now (the date range is ignored, like "Open now"). */
export interface AgeingDto {
  bands: { band: AgeBand; total: number; overdue: number }[];
  /** The ten longest-waiting open enquiries. */
  oldest: {
    id: string;
    reference: string;
    subject: string;
    ageDays: number;
    isOverdue: boolean;
    assignee: string | null;
  }[];
}

export const BREAKDOWN_GROUPS = ['category', 'folder'] as const;
export type BreakdownGroup = (typeof BREAKDOWN_GROUPS)[number];

export interface BreakdownRowDto {
  /** Null for "Uncategorised" / "No folder". */
  id: string | null;
  name: string;
  /** Category colour (#rrggbb); folders have none. */
  color: string | null;
  received: number;
  resolved: number;
  openNow: number;
  overdueNow: number;
  avgFirstResponseMins: number | null;
  avgResolutionMins: number | null;
  slaMetPct: number | null;
}

/** GET /api/reports/breakdown?groupBy= — an enquiry with several categories counts under each. */
export interface BreakdownDto {
  groupBy: BreakdownGroup;
  rows: BreakdownRowDto[];
}

/**
 * GET /api/reports/export.csv?kind= — CSV downloads of the dashboard. `enquiries` (one row per
 * enquiry, with shareholder details) is for supervisors and admins only.
 */
export const REPORT_EXPORTS = [
  'agents',
  'daily',
  'breakdown-category',
  'breakdown-folder',
  'ageing',
  'enquiries',
] as const;
export type ReportExport = (typeof REPORT_EXPORTS)[number];

export interface HealthResponse {
  status: 'ok' | 'degraded';
  db: 'connected' | 'connecting' | 'disconnected';
  uptimeSeconds: number;
  version: string;
  timestamp: string;
}
