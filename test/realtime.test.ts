import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PresenceTracker } from '../src/services/realtime/presence.ts';
import { ChangeBatcher } from '../src/services/realtime/changes.ts';

const T1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const T2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';

describe('PresenceTracker', () => {
  it('lists each officer once, replying if any of their tabs is', () => {
    const p = new PresenceTracker();
    p.connect('tab1', { userId: 'u1', displayName: 'Bola' });
    p.connect('tab2', { userId: 'u1', displayName: 'Bola' });
    p.connect('tab3', { userId: 'u2', displayName: 'Ade' });
    p.join('tab1', T1);
    p.join('tab2', T1);
    p.join('tab3', T1);
    assert.equal(p.setReplying('tab2', T1, true), true);
    assert.deepEqual(p.viewers(T1), [
      { userId: 'u2', displayName: 'Ade', replying: false },
      { userId: 'u1', displayName: 'Bola', replying: true },
    ]);
  });

  it('only marks replying on a ticket the connection has open, and reports real changes only', () => {
    const p = new PresenceTracker();
    p.connect('c', { userId: 'u1', displayName: 'Bola' });
    assert.equal(p.setReplying('c', T1, true), false);
    p.join('c', T1);
    assert.equal(p.setReplying('c', T1, false), false);
    assert.equal(p.setReplying('c', T1, true), true);
    assert.equal(p.setReplying('c', T1, true), false);
  });

  it('forgets a connection on leave and disconnect, returning the tickets affected', () => {
    const p = new PresenceTracker();
    p.connect('c', { userId: 'u1', displayName: 'Bola' });
    p.join('c', T1);
    p.join('c', T2);
    assert.equal(p.leave('c', T1), true);
    assert.deepEqual(p.viewers(T1), []);
    assert.deepEqual(p.disconnect('c'), [T2]);
    assert.deepEqual(p.viewers(T2), []);
    assert.equal(p.join('c', T1), false, 'unknown connections cannot join');
  });
});

describe('ChangeBatcher', () => {
  it('sends a burst of changes as one batch, without duplicates', async () => {
    const batches: string[][] = [];
    const b = new ChangeBatcher(20, (ids) => batches.push(ids));
    b.add(T1);
    b.add(T2);
    b.add(T1);
    await new Promise((r) => setTimeout(r, 40));
    b.add(T2);
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(batches, [[T1, T2], [T2]]);
  });
});
