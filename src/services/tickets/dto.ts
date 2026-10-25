import type { Types } from 'mongoose';
import type { MessageDto, PendingReplyDto, TicketDetailDto, TicketSummaryDto } from '../../shared.js';
import { PendingReplyModel } from '../../models/PendingReply.js';
import type { MessageDoc } from '../../models/Message.js';
import type { TicketDoc } from '../../models/Ticket.js';
import { getUserNames } from '../auth/userCache.js';
import { attachmentStore } from '../attachments/AttachmentStore.js';
import { purgeDate } from './retentionRules.js';
import { getSettings } from '../../models/Settings.js';

type NameMap = Map<string, string>;

/** Display names for the given user ids (served from the short-lived user cache). */
export async function loadNames(ids: (Types.ObjectId | null | undefined)[]): Promise<NameMap> {
  if (!ids.some(Boolean)) return new Map();
  return getUserNames();
}

/** Names for everyone a list of enquiries mentions (assignee, who deleted it, who set a follow-up). */
export function namesForTickets(tickets: TicketDoc[]): Promise<NameMap> {
  return loadNames(tickets.flatMap((t) => [t.assigneeId, t.deletedById, t.followUp?.setById]));
}

function person(id: Types.ObjectId | null | undefined, names: NameMap) {
  if (!id) return null;
  return { id: id.toString(), displayName: names.get(id.toString()) ?? 'Former user' };
}

export function toTicketSummary(
  t: TicketDoc,
  names: NameMap,
  draftTicketIds: Set<string> = new Set(),
  /** Admin → Settings retention, so deleted enquiries can say when they'll be purged. */
  purgeAfterDays: number | null = null,
): TicketSummaryDto {
  return {
    id: t._id.toString(),
    reference: t.reference,
    subject: t.subject,
    snippet: t.snippet,
    status: t.status,
    statusReasonId: t.statusReasonId ? t.statusReasonId.toString() : null,
    priority: t.priority,
    origin: t.origin,
    folderId: t.folderId ? t.folderId.toString() : null,
    contact: {
      name: t.contact.name ?? '',
      email: t.contact.email ?? '',
      ...(t.contact.phone && { phone: t.contact.phone }),
    },
    assignee: person(t.assigneeId, names),
    categoryIds: t.categoryIds.map(String),
    isUnread: t.isUnread,
    isOverdue: t.isOverdue,
    hasAttachments: t.hasAttachments,
    hasDraft: draftTicketIds.has(t._id.toString()),
    messageCount: t.messageCount,
    slaDueAt: t.slaDueAt ? t.slaDueAt.toISOString() : null,
    lastMessageAt: t.lastMessageAt.toISOString(),
    createdAt: t.createdAt.toISOString(),
    deletedAt: t.deletedAt ? t.deletedAt.toISOString() : null,
    deletedBy: person(t.deletedById, names),
    purgeAt: purgeDate(t.deletedAt, purgeAfterDays)?.toISOString() ?? null,
    followUp: t.followUp
      ? {
          at: t.followUp.at.toISOString(),
          note: t.followUp.note ?? '',
          hide: t.followUp.hide,
          isDue: t.followUp.at.getTime() <= Date.now(),
          setBy: person(t.followUp.setById, names),
        }
      : null,
  };
}

export async function toTicketDetail(t: TicketDoc, messages: MessageDoc[]): Promise<TicketDetailDto> {
  // Independent lookups, so run them together rather than one round trip after another.
  const pending = await PendingReplyModel.find({ ticketId: t._id, status: { $in: ['pending', 'sending'] } }).sort({
    createdAt: 1,
  });
  const [names, attachments, settings] = await Promise.all([
    loadNames([t.assigneeId, t.deletedById, t.followUp?.setById, ...messages.map((m) => m.authorId)]),
    attachmentStore.getMeta([...messages.flatMap((m) => m.attachmentIds), ...pending.flatMap((p) => p.attachmentIds)]),
    getSettings(),
  ]);
  const byId = new Map(attachments.map((a) => [a.id, a]));
  const files = (ids: Types.ObjectId[]) =>
    ids
      .map((id) => byId.get(id.toString()))
      .filter((a) => a !== undefined && !a.isInline)
      .map((a) => ({ id: a!.id, filename: a!.filename, contentType: a!.contentType, size: a!.size }));

  const messageDtos: MessageDto[] = messages.map((m) => ({
    id: m._id.toString(),
    ticketId: t._id.toString(),
    direction: m.direction,
    from: { name: m.from.name ?? '', email: m.from.email ?? '' },
    to: m.to.map((a) => ({ name: a.name ?? '', email: a.email ?? '' })),
    cc: m.cc.map((a) => ({ name: a.name ?? '', email: a.email ?? '' })),
    bodyHtml: m.bodyHtml,
    bodyText: m.bodyText,
    author: person(m.authorId, names),
    approvedBy: person(m.approvedById, names),
    // Inline images appear inside the body, so they aren't listed as attachments (as in Outlook).
    attachments: files(m.attachmentIds),
    sentAt: m.sentAt.toISOString(),
  }));

  return {
    ...toTicketSummary(t, names, undefined, settings.retention?.purgeDeletedAfterDays ?? null),
    messages: messageDtos,
    pendingReplies: pending.map((p): PendingReplyDto => ({
      id: p._id.toString(),
      ticketId: t._id.toString(),
      author: person(p.authorId, names),
      kind: p.kind,
      to: p.to.map((a) => ({ name: a.name ?? '', email: a.email })),
      cc: p.cc.map((a) => ({ name: a.name ?? '', email: a.email })),
      subject: p.subject,
      bodyHtml: p.bodyHtml,
      attachments: files(p.attachmentIds),
      reason: p.reason,
      status: p.status,
      createdAt: p.createdAt.toISOString(),
    })),
  };
}
