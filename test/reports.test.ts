import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addBusinessMinutes, businessMinutesBetween } from '../src/services/automation/businessHours.ts';
import { listDays, mean, percent, slaOutcome } from '../src/services/reports/metrics.ts';
import { makeSnippet, phrasePatterns } from '../src/services/mail/sanitize.ts';
import { threadTranscript } from '../src/services/tickets/transcript.ts';

const lagos = (iso: string) => new Date(`${iso}+01:00`);

describe('businessMinutesBetween', () => {
  it('counts only working time (Mon–Fri 08:00–17:00 Lagos)', () => {
    // Fri 16:30 → Mon 08:30 is one working hour.
    assert.equal(businessMinutesBetween(lagos('2026-10-16T16:30'), lagos('2026-10-19T08:30')), 60);
    // Same working day.
    assert.equal(businessMinutesBetween(lagos('2026-10-19T09:00'), lagos('2026-10-19T11:15')), 135);
    // Overnight and outside hours on both ends: Mon 20:00 → Tue 07:00 is nothing.
    assert.equal(businessMinutesBetween(lagos('2026-10-19T20:00'), lagos('2026-10-20T07:00')), 0);
    // A full working week.
    assert.equal(businessMinutesBetween(lagos('2026-10-19T00:00'), lagos('2026-10-26T00:00')), 5 * 540);
  });
  it('is the inverse of addBusinessMinutes', () => {
    const start = lagos('2026-10-15T15:10');
    for (const mins of [1, 59, 540, 1620, 4000]) {
      assert.equal(businessMinutesBetween(start, addBusinessMinutes(start, mins)), mins);
    }
  });
  it('is zero when the end is not after the start', () => {
    assert.equal(businessMinutesBetween(lagos('2026-10-19T10:00'), lagos('2026-10-19T09:00')), 0);
  });
});

describe('report helpers', () => {
  it('lists each local day in the range once', () => {
    assert.deepEqual(listDays(lagos('2026-10-01T00:00'), lagos('2026-10-04T00:00'), 'Africa/Lagos'), [
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
    assert.deepEqual(listDays(lagos('2026-10-01T00:00'), lagos('2026-10-01T00:00'), 'Africa/Lagos'), []);
  });
  it('averages and percentages, with null when there is nothing to measure', () => {
    assert.equal(mean([]), null);
    assert.equal(mean([10, 21]), 16);
    assert.equal(percent(0, 0), null);
    assert.equal(percent(2, 3), 66.7);
  });
  it('judges SLA by the due time, ignoring enquiries without one', () => {
    const due = new Date('2026-10-19T10:00Z');
    assert.equal(slaOutcome({ resolvedAt: new Date('2026-10-19T09:59Z'), slaDueAt: due }), 'met');
    assert.equal(slaOutcome({ resolvedAt: new Date('2026-10-19T10:01Z'), slaDueAt: due }), 'missed');
    assert.equal(slaOutcome({ resolvedAt: new Date(), slaDueAt: null }), null);
  });
});

describe('external-sender phrases from settings', () => {
  it('removes the phrase and the rest of its line from the preview, as plain text', () => {
    const body = 'WARNING (external): do not click links.\nPlease update my address.';
    assert.equal(makeSnippet(body, 200, ['warning (external)']), 'Please update my address.');
    // Regex characters in a phrase are literal.
    assert.equal(phrasePatterns(['a.b'])[0]!.test('axb'), false);
  });
});

describe('escalation transcript', () => {
  it('escapes header values and keeps the sanitised body', () => {
    const html = threadTranscript([
      {
        from: { name: 'Ada <script>', email: 'ada@example.com' },
        to: [{ name: '', email: 'info@example.com' }],
        sentAt: new Date('2026-10-19T09:00Z'),
        bodyHtml: '<p>Hello</p>',
      },
    ] as never);
    assert.ok(html.includes('Ada &#60;script&#62; &#60;ada@example.com&#62;'));
    assert.ok(html.includes('<b>To:</b> info@example.com'));
    assert.ok(html.endsWith('<p>Hello</p>'));
  });
});

describe('retention', () => {
  it('purges a deleted enquiry the given number of days after it was deleted, or never', async () => {
    const { purgeDate } = await import('../src/services/tickets/retentionRules.ts');
    const deleted = new Date('2026-10-19T10:00:00Z');
    assert.equal(purgeDate(deleted, 30)?.toISOString(), '2026-11-18T10:00:00.000Z');
    assert.equal(purgeDate(deleted, null), null);
    assert.equal(purgeDate(null, 30), null);
  });
});
