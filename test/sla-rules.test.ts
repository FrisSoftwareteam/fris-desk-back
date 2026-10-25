import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { overdueAfterRecalc } from '../src/services/automation/slaRules.ts';

const now = new Date('2026-10-26T12:00:00Z');
const past = new Date('2026-10-26T11:00:00Z');
const future = new Date('2026-10-26T13:00:00Z');

describe('overdueAfterRecalc', () => {
  it('leaves flagging a newly past-due ticket to the checkOverdue job (so it alerts)', () => {
    assert.equal(overdueAfterRecalc(false, { paused: false, dueAt: past, now, quiet: false }), false);
  });
  it('keeps an existing overdue flag while still past due', () => {
    assert.equal(overdueAfterRecalc(true, { paused: false, dueAt: past, now, quiet: false }), true);
  });
  it('flags past-due tickets directly in quiet recalculations', () => {
    assert.equal(overdueAfterRecalc(false, { paused: false, dueAt: past, now, quiet: true }), true);
  });
  it('clears the flag when the deadline moves into the future, the clock pauses, or there is no SLA', () => {
    assert.equal(overdueAfterRecalc(true, { paused: false, dueAt: future, now, quiet: false }), false);
    assert.equal(overdueAfterRecalc(true, { paused: true, dueAt: past, now, quiet: true }), false);
    assert.equal(overdueAfterRecalc(true, { paused: false, dueAt: null, now, quiet: true }), false);
  });
});
