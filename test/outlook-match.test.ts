import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planOutlookMatch, type MatchTicket } from '../src/services/mail/outlookMatchRules.ts';

const t = (id: string, extra: Partial<MatchTicket> = {}): MatchTicket => ({
  id,
  status: 'in_progress',
  origin: 'email',
  conversationId: `c-${id}`,
  ...extra,
});

describe('match Outlook unread mail', () => {
  it('keeps an enquiry whose imported message is unread, resolves one whose mail is all read', () => {
    const plan = planOutlookMatch({
      unread: [{ id: 'm1', conversationId: 'moved' }],
      knownMessageTicket: new Map([['m1', 'a']]),
      tickets: [t('a'), t('b')],
    });
    assert.deepEqual(plan, { resolveIds: ['b'], reopenIds: [], importIds: [] });
  });
  it('keeps an enquiry matched only by conversation (mail moved, new Graph id)', () => {
    const plan = planOutlookMatch({
      unread: [
        { id: 'new-id', conversationId: 'c-a' },
        { id: 'x', conversationId: 'other-a' },
      ],
      knownMessageTicket: new Map([['x', 'zzz']]),
      tickets: [t('a'), t('b', { otherConversationIds: ['other-a'] })],
    });
    assert.deepEqual(plan.resolveIds, []);
    assert.deepEqual(plan.importIds, ['new-id']);
  });
  it('never resolves phone, walk-in or manual enquiries, nor touches deleted ones', () => {
    const plan = planOutlookMatch({
      unread: [{ id: 'm', conversationId: 'c-d' }],
      knownMessageTicket: new Map(),
      tickets: [
        t('p', { origin: 'phone' }),
        t('w', { origin: 'walk_in' }),
        t('d', { status: 'resolved', deletedAt: new Date() }),
      ],
    });
    assert.deepEqual(plan.resolveIds, []);
    assert.deepEqual(plan.reopenIds, []);
  });
  it('reopens a resolved enquiry with unread mail, leaves other resolved ones', () => {
    const plan = planOutlookMatch({
      unread: [{ id: 'm', conversationId: 'c-r' }],
      knownMessageTicket: new Map([['m', 'r']]),
      tickets: [t('r', { status: 'resolved' }), t('s', { status: 'resolved' })],
    });
    assert.deepEqual(plan.reopenIds, ['r']);
    assert.deepEqual(plan.resolveIds, []);
  });
  it('imports only unread, non-draft mail not yet in the app', () => {
    const plan = planOutlookMatch({
      unread: [{ id: 'known' }, { id: 'draft', isDraft: true }, { id: 'old' }],
      knownMessageTicket: new Map([['known', 'a']]),
      tickets: [],
    });
    assert.deepEqual(plan.importIds, ['old']);
  });
});
