import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import type { ReportExport } from '../../shared.js';
import { audit } from '../../models/AuditLog.js';
import { CategoryModel } from '../../models/Category.js';
import { DepartmentModel } from '../../models/Department.js';
import { FolderModel } from '../../models/Folder.js';
import { currentUser } from '../../middleware/auth.js';
import { getStatusReasons } from '../tickets/statusReasons.js';
import { getUserNames } from '../auth/userCache.js';
import { businessMinutesBetween, localDayAndHour, type BusinessHours } from '../automation/businessHours.js';
import { csvDateTime, csvFilename, hours, toCsv, type CsvCell } from './csv.js';
import { slaOutcome } from './metrics.js';
import {
  enquiriesInRange,
  reportAgeing,
  reportAgents,
  reportBreakdown,
  reportBusinessHours,
  type ReportFilters,
} from './reports.js';

// CSV exports of the dashboard and the message list (GAP_ANALYSIS G-06.2). Durations are working
// hours (same business hours as the dashboard); dates are in the business time zone.

export interface CsvExport {
  filename: string;
  csv: string;
  rows: number;
}

/** Sends a CSV download and records who exported what (exports can carry personal data). */
export async function sendCsv(req: Request, res: Response, file: CsvExport, meta: Record<string, unknown>) {
  await audit({ actorId: currentUser(req)._id, action: 'report.exported', meta: { ...meta, rows: file.rows } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(file.csv);
}

const yesNo = (b: boolean) => (b ? 'Yes' : 'No');

export async function buildReportExport(kind: ReportExport, f: ReportFilters): Promise<CsvExport> {
  const bh = await reportBusinessHours();
  const firstDay = localDayAndHour(f.from, bh.tz).day;
  const lastDay = localDayAndHour(new Date(f.to.getTime() - 1), bh.tz).day;
  const file = (name: string, headers: string[], rows: CsvCell[][], dated = true): CsvExport => ({
    filename: dated ? csvFilename(name, firstDay, lastDay) : csvFilename(name, localDayAndHour(new Date(), bh.tz).day),
    csv: toCsv(headers, rows),
    rows: rows.length,
  });

  switch (kind) {
    case 'agents': {
      const r = await reportAgents(f);
      return file(
        'officers',
        [
          'Officer',
          'Role',
          'Open now',
          'Assigned',
          'Resolved',
          'Replies sent',
          'Avg first response (working hours)',
          'Avg resolution (working hours)',
          'Overdue now',
          'Resolved within SLA (%)',
        ],
        r.agents.map((a) => [
          a.displayName,
          a.role,
          a.openNow,
          a.assigned,
          a.resolved,
          a.repliesSent,
          hours(a.avgFirstResponseMins),
          hours(a.avgResolutionMins),
          a.overdueNow,
          a.slaMetPct,
        ]),
      );
    }
    case 'daily': {
      const r = await reportAgents(f);
      const byDay = new Map(r.assignmentsByDay.map((d) => [d.day, d]));
      return file(
        'daily',
        ['Day', 'Received', 'Resolved', 'Assignments', ...r.agents.map((a) => `Assigned to ${a.displayName}`)],
        r.receivedVsResolved.map((d) => {
          const a = byDay.get(d.day);
          return [d.day, d.received, d.resolved, a?.total ?? 0, ...r.agents.map((x) => a?.byAgent[x.agentId] ?? 0)];
        }),
      );
    }
    case 'breakdown-category':
    case 'breakdown-folder': {
      const groupBy = kind === 'breakdown-category' ? 'category' : 'folder';
      const r = await reportBreakdown(f, groupBy);
      return file(
        groupBy === 'category' ? 'by-category' : 'by-folder',
        [
          groupBy === 'category' ? 'Category' : 'Folder',
          'Received',
          'Resolved',
          'Open now',
          'Overdue now',
          'Avg first response (working hours)',
          'Avg resolution (working hours)',
          'Resolved within SLA (%)',
        ],
        r.rows.map((x) => [
          x.name,
          x.received,
          x.resolved,
          x.openNow,
          x.overdueNow,
          hours(x.avgFirstResponseMins),
          hours(x.avgResolutionMins),
          x.slaMetPct,
        ]),
      );
    }
    case 'ageing': {
      const r = await reportAgeing(f);
      return file(
        'open-enquiries-by-age',
        ['Waiting', 'Open', 'Overdue'],
        r.bands.map((b) => [b.band, b.total, b.overdue]),
        false,
      );
    }
    case 'enquiries': {
      const tickets = await enquiriesInRange(f);
      return { ...(await enquiryCsv(tickets, bh)), filename: csvFilename('enquiries', firstDay, lastDay) };
    }
  }
}

/** The fields of a ticket that the enquiry CSV uses (a lean `tickets` document). */
export interface EnquiryRowSource {
  reference: string;
  subject?: string | null;
  status: string;
  statusReasonId?: Types.ObjectId | null;
  priority: string;
  origin: string;
  contact: { name?: string | null; email?: string | null; phone?: string | null };
  folderId?: Types.ObjectId | null;
  categoryIds?: Types.ObjectId[];
  assigneeId?: Types.ObjectId | null;
  slaStartAt?: Date | null;
  createdAt: Date;
  firstResponseAt?: Date | null;
  resolvedAt?: Date | null;
  slaDueAt?: Date | null;
  isOverdue: boolean;
  escalatedToId?: Types.ObjectId | null;
  lastMessageAt: Date;
  followUp?: { at: Date; note?: string | null } | null;
}

/** One row per enquiry, with shareholder details: supervisors and admins only (NDPA). */
export async function enquiryCsv(tickets: EnquiryRowSource[], bh?: BusinessHours): Promise<CsvExport> {
  const [businessHours, folders, categories, departments, names, stages] = await Promise.all([
    bh ?? reportBusinessHours(),
    FolderModel.find({}, { name: 1 }).lean(),
    CategoryModel.find({}, { name: 1 }).lean(),
    DepartmentModel.find({}, { name: 1 }).lean(),
    getUserNames(),
    getStatusReasons(),
  ]);
  const tz = businessHours.tz;
  const nameOf = (list: { _id: Types.ObjectId; name: string }[]) =>
    new Map(list.map((x) => [x._id.toString(), x.name]));
  const folderName = nameOf(folders);
  const categoryName = nameOf(categories);
  const departmentName = nameOf(departments);
  const working = (from: Date, to: Date | null | undefined) =>
    to ? hours(businessMinutesBetween(from, to, businessHours)) : null;

  const rows = tickets.map((t): CsvCell[] => {
    const received = t.slaStartAt ?? t.createdAt;
    const outcome = slaOutcome(t);
    return [
      t.reference,
      t.subject ?? '',
      t.contact.name ?? '',
      t.contact.email ?? '',
      t.contact.phone ?? '',
      t.origin,
      t.status,
      t.statusReasonId ? (stages.get(t.statusReasonId.toString())?.name ?? '') : '',
      t.priority,
      t.folderId ? (folderName.get(t.folderId.toString()) ?? '') : '',
      (t.categoryIds ?? [])
        .map((id) => categoryName.get(id.toString()) ?? '')
        .filter(Boolean)
        .join('; '),
      t.assigneeId ? (names.get(t.assigneeId.toString()) ?? 'Former user') : '',
      csvDateTime(received, tz),
      csvDateTime(t.firstResponseAt, tz),
      csvDateTime(t.resolvedAt, tz),
      csvDateTime(t.lastMessageAt, tz),
      working(received, t.firstResponseAt),
      working(received, t.resolvedAt),
      csvDateTime(t.slaDueAt, tz),
      outcome === 'met' ? 'Met' : outcome === 'missed' ? 'Missed' : '',
      t.resolvedAt ? '' : yesNo(t.isOverdue),
      t.escalatedToId ? (departmentName.get(t.escalatedToId.toString()) ?? '') : '',
      csvDateTime(t.followUp?.at, tz),
      t.followUp?.note ?? '',
    ];
  });
  return {
    filename: csvFilename('enquiries', localDayAndHour(new Date(), tz).day),
    csv: toCsv(
      [
        'Reference',
        'Subject',
        'Shareholder',
        'Email',
        'Phone',
        'Channel',
        'Status',
        'Stage',
        'Priority',
        'Folder',
        'Categories',
        'Assigned to',
        'Received',
        'First response',
        'Resolved',
        'Last message',
        'First response (working hours)',
        'Resolution (working hours)',
        'SLA due',
        'SLA',
        'Overdue now',
        'Escalated to',
        'Follow up',
        'Follow-up note',
      ],
      rows,
    ),
    rows: rows.length,
  };
}
