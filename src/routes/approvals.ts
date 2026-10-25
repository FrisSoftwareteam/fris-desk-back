import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import type { ApprovalPolicyDto } from '../shared.js';
import { parseBody, parsePatch } from '../lib/http.js';
import { audit } from '../models/AuditLog.js';
import { MessageModel } from '../models/Message.js';
import { getSettings, invalidateSettings, SettingsModel } from '../models/Settings.js';
import type { TicketDoc } from '../models/Ticket.js';
import { currentUser, requireAuth, requireRole } from '../middleware/auth.js';
import { toApprovalPolicy } from '../services/mail/approvalHold.js';
import { approvePendingReply, returnPendingReply } from '../services/tickets/approvals.js';
import { toTicketDetail } from '../services/tickets/dto.js';

// Supervisor approval of replies: the policy (Admin → Approvals) and the approve / return decisions.
export const approvalsRouter = Router();

const approvers = [requireAuth, requireRole('supervisor', 'admin')];
const objectId = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');
const ids = z.array(objectId).max(200);

const PolicyBody = z
  .object({
    enabled: z.boolean(),
    allAgentReplies: z.boolean(),
    userIds: ids,
    categoryIds: ids,
    templateIds: ids,
    includeForwards: z.boolean(),
  })
  .partial()
  .strict();

async function detail(ticket: TicketDoc) {
  const messages = await MessageModel.find({ ticketId: ticket._id }).sort({ sentAt: -1 });
  return toTicketDetail(ticket, messages);
}

// GET /settings/approval — which replies need a supervisor's approval.
approvalsRouter.get('/settings/approval', ...approvers, async (_req, res) => {
  const body: ApprovalPolicyDto = toApprovalPolicy(await getSettings());
  res.json(body);
});

approvalsRouter.patch('/settings/approval', ...approvers, async (req, res) => {
  const body = parsePatch(PolicyBody, req);
  const oids = (list: string[]) => list.map((id) => new Types.ObjectId(id));
  const set = Object.fromEntries(
    Object.entries(body).map(([k, v]) => [`approval.${k}`, Array.isArray(v) ? oids(v) : v]),
  );
  await SettingsModel.updateOne({ _id: 'app' }, { $set: set }, { upsert: true });
  invalidateSettings();
  const policy = toApprovalPolicy(await getSettings());
  await audit({
    actorId: currentUser(req)._id,
    action: 'approval.policy_updated',
    meta: { fields: Object.keys(body), policy },
  });
  res.json(policy);
});

// POST /pending-replies/:id/approve — send it (as the officer who wrote it), optionally edited.
const ApproveBody = z
  .object({ subject: z.string().max(400).optional(), bodyHtml: z.string().max(1_000_000).optional() })
  .strict();

approvalsRouter.post('/pending-replies/:id/approve', ...approvers, async (req, res) => {
  const body = parseBody(ApproveBody, req);
  const ticket = await approvePendingReply(objectId.parse(req.params.id), currentUser(req), body);
  res.json(await detail(ticket));
});

// POST /pending-replies/:id/return — back to the author's drafts with a comment.
const ReturnBody = z.object({ comment: z.string().trim().min(1, 'Say what needs changing').max(2000) }).strict();

approvalsRouter.post('/pending-replies/:id/return', ...approvers, async (req, res) => {
  const { comment } = parseBody(ReturnBody, req);
  const ticket = await returnPendingReply(objectId.parse(req.params.id), currentUser(req), comment);
  res.json(await detail(ticket));
});
