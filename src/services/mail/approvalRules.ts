import type { ApprovalPolicyDto, ComposeKind, Role } from '../../shared.js';

// Pure supervisor-approval rules (no database), so they can be unit-tested.

export interface ReplyFacts {
  authorId: string;
  authorRole: Role;
  kind: ComposeKind;
  ticketCategoryIds: string[];
  templateIds: string[];
}

export interface ApprovalNames {
  category: (id: string) => string | undefined;
  template: (id: string) => string | undefined;
}

/**
 * Why a reply must wait for a supervisor, or null if it can go straight out. Only agents' replies
 * are ever held; notes never are, and forwards only when the policy includes them.
 */
export function approvalReason(policy: ApprovalPolicyDto, reply: ReplyFacts, names: ApprovalNames): string | null {
  if (!policy.enabled || reply.authorRole !== 'agent' || reply.kind === 'note') return null;
  if (reply.kind === 'forward' && !policy.includeForwards) return null;
  if (policy.allAgentReplies) return 'All agent replies need approval';
  if (policy.userIds.includes(reply.authorId)) return 'This officer’s replies need approval';
  const category = reply.ticketCategoryIds.find((id) => policy.categoryIds.includes(id));
  if (category) return `Category: ${names.category(category) ?? 'restricted category'}`;
  const template = reply.templateIds.find((id) => policy.templateIds.includes(id));
  if (template) return `Template: ${names.template(template) ?? 'restricted template'}`;
  return null;
}
