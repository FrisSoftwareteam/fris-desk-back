import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoResolveAt,
  autoResolvesDueFilter,
  shouldClearAutoResolve,
  followUpsDueFilter,
  isSnoozed,
  shouldClearStatusReason,
  snoozedHiddenFilter,
} from '../src/services/tickets/followUpRules.ts';
import {
  BulkBody,
  BulkNotEnquiryBody,
  MAX_BULK,
  NotEnquiryBody,
  PatchBody,
  nextCategoryIds,
} from '../src/services/tickets/patchSchema.ts';

const id = (n: number) => n.toString(16).padStart(24, '0');
const now = new Date('2026-10-20T10:00:00Z');

describe('bulk patch (G-04.2)', () => {
  it('accepts a change for several enquiries', () => {
    const body = BulkBody.parse({ ids: [id(1), id(2)], patch: { priority: 'urgent', addCategoryIds: [id(9)] } });
    assert.deepEqual(body.patch, { priority: 'urgent', addCategoryIds: [id(9)] });
  });
  it('refuses an empty change, no ids, too many ids and unknown fields', () => {
    assert.throws(() => BulkBody.parse({ ids: [id(1)], patch: {} }));
    assert.throws(() => BulkBody.parse({ ids: [], patch: { isUnread: false } }));
    const many = Array.from({ length: MAX_BULK + 1 }, (_, i) => id(i + 1));
    assert.throws(() => BulkBody.parse({ ids: many, patch: { isUnread: false } }));
    assert.throws(() => BulkBody.parse({ ids: [id(1)], patch: { categoryIds: [id(2)] } }));
  });
  it('adds and removes categories without losing the ones already there', () => {
    assert.deepEqual(nextCategoryIds(['a', 'b'], ['c', 'a'], []), ['a', 'b', 'c']);
    assert.deepEqual(nextCategoryIds(['a', 'b'], [], ['a']), ['b']);
    assert.deepEqual(nextCategoryIds(['a'], ['b'], ['b']), ['a']);
  });
});

describe('priorities and follow-ups in a patch (G-04.7, G-04.3)', () => {
  it('knows all four priorities', () => {
    for (const p of ['low', 'normal', 'high', 'urgent']) assert.equal(PatchBody.parse({ priority: p }).priority, p);
    assert.throws(() => PatchBody.parse({ priority: 'critical' }));
  });
  it('takes a follow-up with a time zone, defaulting the note and snooze', () => {
    const p = PatchBody.parse({ followUp: { at: '2026-10-21T09:00:00+01:00' } });
    assert.deepEqual(p.followUp, { at: '2026-10-21T09:00:00+01:00', note: '', hide: false });
    assert.equal(PatchBody.parse({ followUp: null }).followUp, null);
    assert.throws(() => PatchBody.parse({ followUp: { at: 'tomorrow' } }));
    assert.throws(() => PatchBody.parse({ followUp: { at: '2026-10-21T09:00:00Z', note: 'x'.repeat(501) } }));
  });
});

describe('follow-up rules (G-04.3)', () => {
  it('treats only a hidden, future follow-up as snoozed', () => {
    const later = new Date(now.getTime() + 60_000);
    const earlier = new Date(now.getTime() - 60_000);
    assert.equal(isSnoozed({ at: later, hide: true }, now), true);
    assert.equal(isSnoozed({ at: later, hide: false }, now), false);
    assert.equal(isSnoozed({ at: earlier, hide: true }, now), false);
    assert.equal(isSnoozed(null, now), false);
  });
  it('lists show enquiries with no follow-up, an unhidden one, or one now due', () => {
    assert.deepEqual(snoozedHiddenFilter(now), {
      $or: [{ followUp: null }, { 'followUp.hide': false }, { 'followUp.at': { $lte: now } }],
    });
  });
  it('the job picks up each due follow-up once, ignoring deleted enquiries', () => {
    assert.deepEqual(followUpsDueFilter(now), {
      deletedAt: null,
      'followUp.at': { $lte: now },
      'followUp.dueAt': null,
    });
  });
});

describe('stages (G-04.7)', () => {
  it('drops the stage when the status changes without one', () => {
    assert.equal(shouldClearStatusReason(true, false), true);
    assert.equal(shouldClearStatusReason(true, true), false);
    assert.equal(shouldClearStatusReason(false, false), false);
  });
});

describe('not an enquiry', () => {
  it('needs a note only for "other"', () => {
    assert.deepEqual(NotEnquiryBody.parse({ reason: 'advert' }), { reason: 'advert', note: '' });
    assert.throws(() => NotEnquiryBody.parse({ reason: 'other', note: '  ' }));
    assert.equal(NotEnquiryBody.parse({ reason: 'other', note: ' newsletter ' }).note, 'newsletter');
  });
  it('refuses unknown reasons and empty bulk ids', () => {
    assert.throws(() => NotEnquiryBody.parse({ reason: 'spam' }));
    assert.throws(() => BulkNotEnquiryBody.parse({ ids: [], reason: 'cc_info' }));
    assert.deepEqual(BulkNotEnquiryBody.parse({ ids: [id(1)], reason: 'cc_info' }), {
      ids: [id(1)],
      reason: 'cc_info',
      note: '',
    });
  });
});

describe('auto-resolve', () => {
  it('accepts only the offered periods, and null to cancel', () => {
    assert.equal(PatchBody.parse({ autoResolveDays: 7 }).autoResolveDays, 7);
    assert.equal(PatchBody.parse({ autoResolveDays: null }).autoResolveDays, null);
    assert.throws(() => PatchBody.parse({ autoResolveDays: 4 }));
  });
  it('falls due after calendar days, only while awaiting the shareholder', () => {
    assert.equal(autoResolveAt(now, 3).toISOString(), '2026-10-23T10:00:00.000Z');
    assert.equal(autoResolvesDueFilter(now).status, 'awaiting_shareholder');
  });
  it('is cancelled when the status moves anywhere but Awaiting shareholder', () => {
    assert.equal(shouldClearAutoResolve(true, 'in_progress'), true);
    assert.equal(shouldClearAutoResolve(true, 'resolved'), true);
    assert.equal(shouldClearAutoResolve(true, 'awaiting_shareholder'), false);
    assert.equal(shouldClearAutoResolve(false, 'in_progress'), false);
  });
});
