import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideRouting, pickFromPool, ruleMatches, type RuleLike } from '../src/services/automation/rules.ts';
import { addBusinessMinutes } from '../src/services/automation/businessHours.ts';
import { automatedReason } from '../src/services/automation/automatedMail.ts';

const mail = {
  subject: 'Unpaid DIVIDEND for 2025',
  fromEmail: 'ada@lawfirm.example',
  bodyText: 'Please check my e-mandate',
};

function rule(partial: Partial<RuleLike> & Pick<RuleLike, 'conditions' | 'action'>): RuleLike {
  return { id: partial.name ?? 'r', name: 'r', priority: 100, isActive: true, ...partial };
}

describe('ruleMatches', () => {
  it('matches case-insensitively with contains/equals on each field', () => {
    assert.ok(ruleMatches({ conditions: [{ field: 'subject', op: 'contains', value: 'dividend' }] }, mail));
    assert.ok(ruleMatches({ conditions: [{ field: 'fromDomain', op: 'equals', value: 'LawFirm.example' }] }, mail));
    assert.ok(ruleMatches({ conditions: [{ field: 'fromEmail', op: 'equals', value: 'ada@lawfirm.example' }] }, mail));
    assert.ok(ruleMatches({ conditions: [{ field: 'body', op: 'contains', value: 'mandate' }] }, mail));
    assert.ok(!ruleMatches({ conditions: [{ field: 'fromDomain', op: 'equals', value: 'firm.example' }] }, mail));
  });
  it('requires every condition, and never matches with none or with an empty value', () => {
    assert.ok(
      !ruleMatches(
        {
          conditions: [
            { field: 'subject', op: 'contains', value: 'dividend' },
            { field: 'subject', op: 'contains', value: 'probate' },
          ],
        },
        mail,
      ),
    );
    assert.ok(!ruleMatches({ conditions: [] }, mail));
    assert.ok(!ruleMatches({ conditions: [{ field: 'subject', op: 'contains', value: '  ' }] }, mail));
  });
});

describe('decideRouting', () => {
  const rules: RuleLike[] = [
    rule({
      name: 'low',
      priority: 50,
      conditions: [{ field: 'subject', op: 'contains', value: 'dividend' }],
      action: { setFolderId: 'f-general', addCategoryIds: ['c-a'], assignStrategy: 'specific', assigneeId: 'u2' },
    }),
    rule({
      name: 'high',
      priority: 10,
      conditions: [{ field: 'subject', op: 'contains', value: 'unpaid' }],
      action: { setFolderId: 'f-dividend', addCategoryIds: ['c-b', 'c-a'], assignStrategy: 'round_robin' },
    }),
    rule({
      name: 'off',
      priority: 1,
      isActive: false,
      conditions: [{ field: 'subject', op: 'contains', value: 'dividend' }],
      action: { setFolderId: 'f-off' },
    }),
    rule({
      name: 'redirect',
      priority: 99,
      conditions: [{ field: 'fromDomain', op: 'equals', value: 'lawfirm.example' }],
      action: { redirectTo: 'legal@example.com' },
    }),
  ];
  it('lets the highest-priority match decide folder and assignment, and merges categories', () => {
    const d = decideRouting(rules, mail);
    assert.equal(d.folderId, 'f-dividend');
    assert.deepEqual(d.categoryIds, ['c-b', 'c-a']);
    assert.equal(d.assignmentRule?.name, 'high');
    assert.deepEqual(d.matchedRuleIds, ['high', 'low', 'redirect']);
    assert.deepEqual(
      d.redirects.map((r) => r.to),
      ['legal@example.com'],
    );
  });
  it('ignores inactive rules and returns nothing when no rule matches', () => {
    const d = decideRouting(rules, { subject: 'Hello', fromEmail: 'x@y.z', bodyText: '' });
    assert.equal(d.folderId, undefined);
    assert.equal(d.assignmentRule, null);
    assert.deepEqual(d.matchedRuleIds, []);
  });
});

describe('pickFromPool', () => {
  const all = () => true;
  const pick = (cursor: number, opts: Partial<Parameters<typeof pickFromPool>[0]> = {}) =>
    pickFromPool({ pool: ['a', 'b', 'c'], cursor, isActive: all, mode: 'round_robin', ...opts });

  it('round-robin rotates through the pool and skips inactive officers', () => {
    const active = (id: string) => id !== 'b';
    assert.deepEqual(pick(0, { isActive: active }), { userId: 'a', advance: 0 });
    assert.deepEqual(pick(1, { isActive: active }), { userId: 'c', advance: 1 });
    assert.deepEqual(pick(3, { isActive: active }), { userId: 'a', advance: 0 });
    // A cursor that has wrapped past the pool length keeps rotating evenly.
    assert.deepEqual(
      [5, 6, 7, 8].map(
        (c) => pickFromPool({ pool: ['a', 'b'], cursor: c, isActive: all, mode: 'round_robin' })!.userId,
      ),
      ['b', 'a', 'b', 'a'],
    );
    assert.equal(pickFromPool({ pool: ['b'], cursor: 0, isActive: active, mode: 'round_robin' }), null);
    assert.equal(pickFromPool({ pool: [], cursor: 0, isActive: active, mode: 'least_loaded' }), null);
  });

  it('round-robin ignores workload', () => {
    assert.equal(pick(0, { loads: new Map([['a', 99]]) })!.userId, 'a');
  });

  it('least loaded picks the officer with the fewest open enquiries', () => {
    const loads = new Map([
      ['a', 5],
      ['b', 1],
      ['c', 3],
    ]);
    assert.deepEqual(pick(0, { mode: 'least_loaded', loads }), { userId: 'b', advance: 1 });
    // Officers with no open enquiries count as zero.
    assert.equal(
      pick(0, {
        mode: 'least_loaded',
        loads: new Map([
          ['a', 2],
          ['b', 2],
        ]),
      })!.userId,
      'c',
    );
  });

  it('least loaded rotates between equally loaded officers', () => {
    const loads = new Map([
      ['a', 2],
      ['b', 2],
      ['c', 7],
    ]);
    assert.equal(pick(0, { mode: 'least_loaded', loads })!.userId, 'a');
    assert.equal(pick(1, { mode: 'least_loaded', loads })!.userId, 'b');
    assert.equal(pick(2, { mode: 'least_loaded', loads })!.userId, 'a');
  });

  it('least loaded skips inactive officers even if they are least loaded', () => {
    const loads = new Map([
      ['a', 4],
      ['b', 0],
      ['c', 2],
    ]);
    assert.equal(pick(0, { mode: 'least_loaded', loads, isActive: (id) => id !== 'b' })!.userId, 'c');
  });

  it('capped round-robin skips officers at or over the cap', () => {
    const loads = new Map([
      ['a', 10],
      ['b', 3],
      ['c', 9],
    ]);
    assert.deepEqual(pick(0, { mode: 'capped_round_robin', cap: 10, loads }), { userId: 'b', advance: 1 });
    assert.deepEqual(pick(2, { mode: 'capped_round_robin', cap: 10, loads }), { userId: 'c', advance: 0 });
  });

  it('capped round-robin falls back to the least loaded when everyone is capped', () => {
    const loads = new Map([
      ['a', 12],
      ['b', 15],
      ['c', 11],
    ]);
    assert.deepEqual(pick(0, { mode: 'capped_round_robin', cap: 10, loads }), { userId: 'c', advance: 2 });
  });
});

describe('addBusinessMinutes (Africa/Lagos, Mon–Fri 08:00–17:00, UTC+1)', () => {
  // Lagos is UTC+1 all year, so 09:00 Lagos = 08:00Z.
  it('adds within the same working day', () => {
    assert.equal(addBusinessMinutes(new Date('2026-10-19T08:00:00Z'), 60).toISOString(), '2026-10-19T09:00:00.000Z');
  });
  it('carries over the evening to the next morning', () => {
    // Mon 16:30 Lagos + 60 min → Tue 08:30 Lagos
    assert.equal(addBusinessMinutes(new Date('2026-10-19T15:30:00Z'), 60).toISOString(), '2026-10-20T07:30:00.000Z');
  });
  it('skips the weekend', () => {
    // Fri 16:30 Lagos + 60 min → Mon 08:30 Lagos
    assert.equal(addBusinessMinutes(new Date('2026-10-23T15:30:00Z'), 60).toISOString(), '2026-10-26T07:30:00.000Z');
  });
  it('starts the clock at opening time for mail received overnight or at the weekend', () => {
    // Sat 10:00 Lagos + 30 min → Mon 08:30 Lagos
    assert.equal(addBusinessMinutes(new Date('2026-10-24T09:00:00Z'), 30).toISOString(), '2026-10-26T07:30:00.000Z');
    // Tue 06:00 Lagos + 30 min → Tue 08:30 Lagos
    assert.equal(addBusinessMinutes(new Date('2026-10-20T05:00:00Z'), 30).toISOString(), '2026-10-20T07:30:00.000Z');
  });
  it('counts a 24-hour (1440 min) first-response target as 1440 working minutes', () => {
    // 1440 working minutes = 2 days 6 hours (9h days) → from Mon 08:00 to Wed 14:00 Lagos
    assert.equal(addBusinessMinutes(new Date('2026-10-19T07:00:00Z'), 1440).toISOString(), '2026-10-21T13:00:00.000Z');
  });
});

describe('automatedReason', () => {
  it('lets a person through', () => {
    assert.equal(automatedReason('ada.obi@example.com', [{ name: 'Precedence', value: 'normal' }]), null);
  });
  it('catches no-reply style senders', () => {
    for (const s of [
      'noreply@x.com',
      'no-reply@x.com',
      'do_not_reply@x.com',
      'MAILER-DAEMON@x.com',
      'notifications@x.com',
    ]) {
      assert.notEqual(automatedReason(s), null, s);
    }
    assert.equal(automatedReason('notificationsteam.lead@x.com'), null);
  });
  it('catches auto-replies, bulk mail and newsletters by header', () => {
    assert.match(automatedReason('a@x.com', [{ name: 'Auto-Submitted', value: 'auto-replied' }])!, /Auto-Submitted/);
    assert.equal(automatedReason('a@x.com', [{ name: 'Auto-Submitted', value: 'no' }]), null);
    assert.match(automatedReason('a@x.com', [{ name: 'Precedence', value: 'bulk' }])!, /Precedence/);
    assert.match(automatedReason('a@x.com', [{ name: 'X-Autoreply', value: 'yes' }])!, /auto-reply/);
    assert.match(automatedReason('a@x.com', [{ name: 'List-Unsubscribe', value: '<mailto:u@x.com>' }])!, /newsletter/);
  });
});
