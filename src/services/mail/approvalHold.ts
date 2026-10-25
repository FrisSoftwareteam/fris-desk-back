import { Types } from 'mongoose';
import type { ApprovalPolicyDto, SendMessageDto } from '../../shared.js';
import { audit } from '../../models/AuditLog.js';
import { CategoryModel } from '../../models/Category.js';
import { DraftModel } from '../../models/Draft.js';
import { PendingReplyModel, type PendingReplyDoc } from '../../models/PendingReply.js';
import { getSettings, type SettingsDoc } from '../../models/Settings.js';
import { TemplateModel } from '../../models/Template.js';
import type { TicketDoc } from '../../models/Ticket.js';
import { UserModel, type UserDoc } from '../../models/User.js';
import { notifyTicketChanged } from '../realtime/changes.js';
import { notifyUsers } from '../notifications/notify.js';
import { approvalReason } from './approvalRules.js';
import { htmlToText, makeSnippet } from './sanitize.js';

/** Settings → the policy as the API shows it. */
export function toApprovalPolicy(s: SettingsDoc): ApprovalPolicyDto {
  const a = s.approval;
  return {
    enabled: a?.enabled ?? false,
    allAgentReplies: a?.allAgentReplies ?? false,
    userIds: (a?.userIds ?? []).map(String),
    categoryIds: (a?.categoryIds ?? []).map(String),
    templateIds: (a?.templateIds ?? []).map(String),
    includeForwards: a?.includeForwards ?? true,
  };
}

/** Who is told a reply is waiting: active supervisors, or the admins if there are none. */
async function approvers(): Promise<Types.ObjectId[]> {
  const supervisors = await UserModel.find({ role: 'supervisor', isActive: true }, { _id: 1 }).lean();
  const list = supervisors.length
    ? supervisors
    : await UserModel.find({ role: 'admin', isActive: true }, { _id: 1 }).lean();
  return list.map((u) => u._id);
}

/**
 * If the approval policy says this reply must be approved, stores it for a supervisor instead of
 * sending it, and tells the approvers. Returns the held reply, or null to send as normal.
 * `bodyHtml` is the sanitised body with merge fields already filled in.
 */
export async function holdForApproval(
  ticket: TicketDoc,
  user: UserDoc,
  input: SendMessageDto,
  bodyHtml: string,
): Promise<PendingReplyDoc | null> {
  const policy = toApprovalPolicy(await getSettings());
  if (!policy.enabled) return null;

  const templateIds = input.templateIds ?? [];
  const [categories, templates] = await Promise.all([
    CategoryModel.find({ _id: { $in: policy.categoryIds } }, { name: 1 }).lean(),
    TemplateModel.find({ _id: { $in: policy.templateIds } }, { name: 1 }).lean(),
  ]);
  const reason = approvalReason(
    policy,
    {
      authorId: user._id.toString(),
      authorRole: user.role,
      kind: input.kind,
      ticketCategoryIds: ticket.categoryIds.map(String),
      templateIds,
    },
    {
      category: (id) => categories.find((c) => c._id.toString() === id)?.name,
      template: (id) => templates.find((t) => t._id.toString() === id)?.name,
    },
  );
  if (!reason) return null;

  const held = await PendingReplyModel.create({
    ticketId: ticket._id,
    authorId: user._id,
    kind: input.kind,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    bodyHtml,
    attachmentIds: input.attachmentIds.map((id) => new Types.ObjectId(id)),
    templateIds: templateIds.map((id) => new Types.ObjectId(id)),
    reason,
  });
  await DraftModel.deleteOne({ ticketId: ticket._id, authorId: user._id, kind: input.kind });
  await audit({
    actorId: user._id,
    action: 'reply.held',
    ticketId: ticket._id,
    meta: { pendingReplyId: held._id, reason, to: input.to.map((r) => r.email) },
  });
  const snippet = makeSnippet(htmlToText(bodyHtml), 200);
  await notifyUsers(
    (await approvers())
      .filter((id) => !id.equals(user._id))
      .map((userId) => ({
        userId,
        type: 'approval_requested' as const,
        ticketId: ticket._id,
        actorId: user._id,
        snippet,
      })),
  );
  notifyTicketChanged(ticket._id.toString());
  return held;
}
