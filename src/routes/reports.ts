import { Router, type Request } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { BREAKDOWN_GROUPS, REPORT_EXPORTS } from '../shared.js';
import { HttpError } from '../lib/http.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { buildReportExport, sendCsv } from '../services/reports/exports.js';
import {
  reportAgeing,
  reportAgents,
  reportBreakdown,
  reportSummary,
  type ReportFilters,
} from '../services/reports/reports.js';

// Reports and the Agent Activity Dashboard (BUILD_SPEC §6.1, §7). Supervisors and admins see the
// whole team; an agent sees only their own figures, whatever filter they ask for.
export const reportsRouter = Router();

const objectId = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');
const MAX_DAYS = 366;

const Query = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  agentId: objectId.optional(),
  folderId: objectId.optional(),
});

function filters(req: Request): ReportFilters {
  const q = Query.parse(Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '')));
  const from = new Date(q.from);
  const to = new Date(q.to);
  if (to <= from) throw new HttpError(400, 'The end date must be after the start date');
  if (to.getTime() - from.getTime() > MAX_DAYS * 86_400_000) {
    throw new HttpError(400, `Choose a range of ${MAX_DAYS} days or less`);
  }
  const user = currentUser(req);
  const agentId = user.role === 'agent' ? user._id : q.agentId ? new Types.ObjectId(q.agentId) : null;
  return { from, to, agentId, folderId: q.folderId ? new Types.ObjectId(q.folderId) : null };
}

// GET /reports/summary?from=&to=&agentId=&folderId= — the team stat tiles.
reportsRouter.get('/reports/summary', requireAuth, async (req, res) => {
  res.json(await reportSummary(filters(req)));
});

// GET /reports/agents?from=&to=&agentId=&folderId= — per-agent table and chart series.
reportsRouter.get('/reports/agents', requireAuth, async (req, res) => {
  res.json(await reportAgents(filters(req)));
});

// GET /reports/ageing?agentId=&folderId= — open enquiries now by age band (from/to still required
// so every report takes the same filters, but the range doesn't apply).
reportsRouter.get('/reports/ageing', requireAuth, async (req, res) => {
  res.json(await reportAgeing(filters(req)));
});

// GET /reports/breakdown?groupBy=category|folder&from=&to=&agentId=&folderId=
reportsRouter.get('/reports/breakdown', requireAuth, async (req, res) => {
  const groupBy = z.enum(BREAKDOWN_GROUPS).parse(req.query.groupBy);
  res.json(await reportBreakdown(filters(req), groupBy));
});

// GET /reports/export.csv?kind=&from=&to=&agentId=&folderId= — the dashboard as CSV. Figures follow
// the dashboard's scoping; the one-row-per-enquiry export (shareholder details) is for supervisors
// and admins only.
reportsRouter.get('/reports/export.csv', requireAuth, async (req, res) => {
  const kind = z.enum(REPORT_EXPORTS).parse(req.query.kind);
  if (kind === 'enquiries' && currentUser(req).role === 'agent') {
    throw new HttpError(403, 'Only supervisors and admins can export enquiries');
  }
  const f = filters(req);
  await sendCsv(req, res, await buildReportExport(kind, f), {
    kind,
    from: f.from,
    to: f.to,
    agentId: f.agentId?.toString() ?? null,
    folderId: f.folderId?.toString() ?? null,
  });
});
