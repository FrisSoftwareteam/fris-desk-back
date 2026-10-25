import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderMergeFields } from '../src/shared.js';
import { placeAboveQuote, recipientProblem, subjectWithReference } from '../src/services/mail/sendRules.ts';
import { approvalReason } from '../src/services/mail/approvalRules.ts';

const colin = { name: 'Colin', email: 'colin.decorce@firstregistrarsnigeria.com' };
const shareholder = { name: 'Ada', email: 'ada@example.com' };

describe('recipient allowlist (development safety net)', () => {
  const allow = ['colin.decorce@firstregistrarsnigeria.com'];
  it('allows only listed addresses', () => {
    assert.equal(recipientProblem([colin], allow, false), null);
    assert.equal(
      recipientProblem([{ ...colin, email: ' Colin.Decorce@FirstRegistrarsNigeria.com ' }], allow, false),
      null,
    );
  });
  it('refuses any unlisted recipient, naming it', () => {
    assert.match(recipientProblem([colin, shareholder], allow, false)!, /Remove ada@example\.com/);
  });
  it('blocks everything outside production when the list is empty', () => {
    assert.match(recipientProblem([colin], [], false)!, /switched off/);
  });
  it('places no restriction in production when the list is empty', () => {
    assert.equal(recipientProblem([shareholder], [], true), null);
  });
  it('still enforces a list in production if one is set', () => {
    assert.notEqual(recipientProblem([shareholder], allow, true), null);
  });
});

describe('subjectWithReference', () => {
  it('appends the reference once', () => {
    assert.equal(subjectWithReference('RE: Dividend', 'REG-2026-000001'), 'RE: Dividend [REG-2026-000001]');
    assert.equal(
      subjectWithReference('RE: Dividend [REG-2026-000001]', 'REG-2026-000001'),
      'RE: Dividend [REG-2026-000001]',
    );
    assert.equal(subjectWithReference('  ', 'REG-2026-000001'), '(no subject) [REG-2026-000001]');
  });
});

describe('placeAboveQuote', () => {
  it('puts the reply right after <body>, above the quoted original', () => {
    assert.equal(
      placeAboveQuote('<html><body dir="ltr"><div>quoted</div></body></html>', '<p>Hi</p>'),
      '<html><body dir="ltr"><p>Hi</p><br><div>quoted</div></body></html>',
    );
  });
  it('prepends when there is no body tag', () => {
    assert.equal(placeAboveQuote('<div>q</div>', '<p>Hi</p>'), '<p>Hi</p><br><div>q</div>');
  });
});

describe('renderMergeFields', () => {
  const ctx = {
    contact: { name: 'Ada <script>', email: 'ada@example.com' },
    ticket: { reference: 'REG-2026-000001', subject: 'Dividend' },
    officer: { name: 'Tunde', email: 't@example.com' },
  };
  it('fills known fields, escapes values and leaves unknown ones', () => {
    assert.equal(
      renderMergeFields('Dear {{contact.name}}, ref {{ ticket.reference }}. {{nope}} — {{officer.name}}', ctx),
      'Dear Ada &lt;script&gt;, ref REG-2026-000001. {{nope}} — Tunde',
    );
  });
  it('falls back to "Shareholder" when the name is unknown', () => {
    assert.equal(
      renderMergeFields('Dear {{contact.name}}', { ...ctx, contact: { name: '', email: '' } }),
      'Dear Shareholder',
    );
  });
});

describe('approvalReason (supervisor approval)', () => {
  const off = {
    enabled: true,
    allAgentReplies: false,
    userIds: [],
    categoryIds: [],
    templateIds: [],
    includeForwards: true,
  };
  const reply = {
    authorId: 'u1',
    authorRole: 'agent' as const,
    kind: 'reply' as const,
    ticketCategoryIds: ['c1'],
    templateIds: ['t1'],
  };
  const names = { category: () => 'Complaint', template: () => 'Indemnity' };

  it('holds nothing when switched off or no rule matches', () => {
    assert.equal(approvalReason({ ...off, enabled: false, allAgentReplies: true }, reply, names), null);
    assert.equal(approvalReason(off, reply, names), null);
  });

  it('holds every agent reply, or named officers’ replies', () => {
    assert.match(approvalReason({ ...off, allAgentReplies: true }, reply, names)!, /All agent replies/);
    assert.match(approvalReason({ ...off, userIds: ['u1'] }, reply, names)!, /officer/);
    assert.equal(approvalReason({ ...off, userIds: ['u2'] }, reply, names), null);
  });

  it('holds replies on chosen categories or using chosen templates, naming them', () => {
    assert.equal(approvalReason({ ...off, categoryIds: ['c1'] }, reply, names), 'Category: Complaint');
    assert.equal(approvalReason({ ...off, templateIds: ['t1'] }, reply, names), 'Template: Indemnity');
    assert.equal(approvalReason({ ...off, templateIds: ['t9'] }, reply, names), null);
  });

  it('never holds supervisors, admins or internal notes', () => {
    const all = { ...off, allAgentReplies: true };
    assert.equal(approvalReason(all, { ...reply, authorRole: 'supervisor' }, names), null);
    assert.equal(approvalReason(all, { ...reply, authorRole: 'admin' }, names), null);
    assert.equal(approvalReason(all, { ...reply, kind: 'note' }, names), null);
  });

  it('holds forwards only when the policy includes them', () => {
    const all = { ...off, allAgentReplies: true };
    assert.notEqual(approvalReason(all, { ...reply, kind: 'forward' }, names), null);
    assert.equal(approvalReason({ ...all, includeForwards: false }, { ...reply, kind: 'forward' }, names), null);
    assert.notEqual(approvalReason({ ...all, includeForwards: false }, { ...reply, kind: 'reply_all' }, names), null);
  });
});
