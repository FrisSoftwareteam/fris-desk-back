// Pure rules for "Match Outlook unread mail" (Admin → Settings): officers treated unread Inbox mail
// as the to-do list, so an enquiry stays active only while some of its mail is unread in Outlook.
// No imports, so tests run without the environment.

export interface UnreadMail {
  id: string;
  conversationId?: string | null;
  isDraft?: boolean | null;
}

export interface MatchTicket {
  id: string;
  status: string;
  origin: string;
  conversationId?: string | null;
  otherConversationIds?: string[];
  deletedAt?: Date | null;
}

export interface MatchPlan {
  resolveIds: string[];
  reopenIds: string[];
  importIds: string[];
}

/**
 * `knownMessageTicket` maps the Graph id of each unread message already imported to its ticket id.
 * Conversations are matched too, because a message moved in Outlook gets a new Graph id.
 */
export function planOutlookMatch(input: {
  unread: UnreadMail[];
  knownMessageTicket: Map<string, string>;
  tickets: MatchTicket[];
}): MatchPlan {
  const unread = input.unread.filter((m) => !m.isDraft);
  const conversations = new Set(unread.map((m) => m.conversationId).filter((c): c is string => Boolean(c)));
  const backedIds = new Set(input.knownMessageTicket.values());
  const isBacked = (t: MatchTicket) =>
    backedIds.has(t.id) ||
    (t.conversationId != null && conversations.has(t.conversationId)) ||
    (t.otherConversationIds ?? []).some((c) => conversations.has(c));

  const plan: MatchPlan = { resolveIds: [], reopenIds: [], importIds: [] };
  for (const t of input.tickets) {
    if (t.deletedAt) continue;
    if (t.status === 'resolved') {
      if (isBacked(t)) plan.reopenIds.push(t.id);
    } else if (t.origin === 'email' && !isBacked(t)) {
      plan.resolveIds.push(t.id);
    }
  }
  plan.importIds = unread.filter((m) => !input.knownMessageTicket.has(m.id)).map((m) => m.id);
  return plan;
}
