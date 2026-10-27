// #39: the orchestrator changes a store's WIP limit with WIP_SET, through the machine. The refusals are guards in
// spec/harness.machine.json; raising starts queued items only while accepting; a cancelled queued item leaves the queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { openStore, init, status, budgetEvents, replay } from '../src/index.js';
import { apply, start } from './send.js';

const orchestrator = { actor: { kind: 'session', id: 'sim-orchestrator' }, source: { kind: 'cli', ref: 'harness send' } };
const wip = (limit, by = orchestrator) => ({ type: 'WIP_SET', ...(limit !== undefined && { limit }), ...by });
const fresh = (wipLimit = 1, ids = ['a', 'b', 'c']) => {
  const store = openStore(tempDir('harness-wip-'));
  init(store, { wipLimit });
  start(store);
  for (const id of ids) apply(store, { type: 'REQUEST_RECEIVED', request: { id } });
  return store;
};
const slots = (store) => {
  const { context: c } = status(store);
  return { wipLimit: c.wipLimit, inFlight: c.inFlight, queued: c.queued };
};
const clean = (store) => {
  const r = replay(store);
  assert.equal(r.ok, true, `replay: ${r.firstDivergence} ${r.differences.join('; ')}`);
};

test('WIP_SET is refused from anyone but the orchestrator session, and nothing is written', () => {
  const store = fresh();
  const before = store.events().length;
  for (const by of [
    { actor: { kind: 'session', id: 'another-thread' }, source: { kind: 'cli', ref: 'harness send' } },
    { actor: { kind: 'agent', id: 'sim-orchestrator/a1b2c3' }, source: { kind: 'cli', ref: 'harness send' } },
    { actor: { kind: 'person', id: 'person' }, source: { kind: 'tap', ref: 'cmsg_x' }, relayedBy: 'sim-orchestrator' },
    { actor: { kind: 'session', id: 'sim-orchestrator' }, source: { kind: 'tap', ref: 'cmsg_x' } }
  ]) {
    const r = apply(store, wip(2, by));
    assert.equal(r.refused, true, `${by.actor.kind}:${by.actor.id} by ${by.source.kind}`);
  }
  assert.equal(store.events().length, before);
  assert.deepEqual(slots(store), { wipLimit: 1, inFlight: ['a'], queued: ['b', 'c'] });
});

test('WIP_SET is refused unless the limit is an integer from 1 to 4', () => {
  const store = fresh();
  for (const limit of [0, 5, 2.5, '2', null, undefined, -1, Infinity]) {
    assert.equal(apply(store, wip(limit)).refused, true, `limit ${String(limit)}`);
  }
  assert.equal(slots(store).wipLimit, 1);
  for (const limit of [1, 4]) assert.equal(apply(store, wip(limit)).refused, undefined, `limit ${limit}`);
});

test('raising the limit while accepting starts exactly the free slots at once, and replay stays clean', () => {
  const store = fresh();
  assert.deepEqual(slots(store), { wipLimit: 1, inFlight: ['a'], queued: ['b', 'c'] });
  apply(store, wip(2));
  assert.deepEqual(slots(store), { wipLimit: 2, inFlight: ['a', 'b'], queued: ['c'] });
  assert.equal(status(store).items.find((i) => i.id === 'b').state, 'active.triaging');
  clean(store);
  apply(store, wip(4));
  assert.deepEqual(slots(store), { wipLimit: 4, inFlight: ['a', 'b', 'c'], queued: [] });
  clean(store);
});

test('lowering the limit stops nothing in flight; the next start waits for a free slot', () => {
  const store = fresh(3, ['a', 'b', 'c', 'd']);
  assert.deepEqual(slots(store), { wipLimit: 3, inFlight: ['a', 'b', 'c'], queued: ['d'] });
  apply(store, wip(1));
  assert.deepEqual(slots(store), { wipLimit: 1, inFlight: ['a', 'b', 'c'], queued: ['d'] });
  for (const id of ['a', 'b', 'c']) assert.equal(status(store).items.find((i) => i.id === id).state, 'active.triaging');
  apply(store, { type: 'CANCEL' }, { to: 'item:a' });
  assert.deepEqual(slots(store), { wipLimit: 1, inFlight: ['b', 'c'], queued: ['d'] }, 'still two in flight: no slot is free');
  clean(store);
});

test('while the budget drains or halts, raising the limit records it and starts nothing', () => {
  const store = fresh();
  const samples = [
    { at: '2026-10-26T01:00:00Z', sevenDay: 0.3, fiveHour: 0.1, sevenDayResetsAt: 1 },
    { at: '2026-10-26T12:00:00Z', sevenDay: 0.41, fiveHour: 0.2, sevenDayResetsAt: 1 }
  ];
  for (const e of budgetEvents(samples)) apply(store, e.event, { to: e.to, id: e.id });
  assert.equal(status(store).state.scheduler, 'halted');
  apply(store, wip(3));
  assert.deepEqual(slots(store), { wipLimit: 3, inFlight: ['a'], queued: ['b', 'c'] });

  const draining = fresh();
  apply(draining, { type: 'TICK', now: '2026-10-26T13:00:00Z' }, { to: 'budget', id: 'tick-13' });
  assert.equal(status(draining).state.scheduler, 'draining');
  apply(draining, wip(3));
  assert.deepEqual(slots(draining), { wipLimit: 3, inFlight: ['a'], queued: ['b', 'c'] });
  clean(draining);
});

test('a queued item that is cancelled leaves the queue, and a later raise never starts it', () => {
  const store = fresh();
  apply(store, { type: 'CANCEL' }, { to: 'item:b' });
  assert.equal(status(store).items.find((i) => i.id === 'b').state, 'cancelled');
  assert.deepEqual(slots(store), { wipLimit: 1, inFlight: ['a'], queued: ['c'] });
  apply(store, wip(2));
  assert.deepEqual(slots(store), { wipLimit: 2, inFlight: ['a', 'c'], queued: [] });
  clean(store);
});

test('replay rebuilds from the limit the store had before its first WIP_SET', () => {
  const store = fresh(1, ['a', 'b']);
  apply(store, wip(2));
  apply(store, wip(3));
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'c' } });
  assert.deepEqual(slots(store), { wipLimit: 3, inFlight: ['a', 'b', 'c'], queued: [] });
  assert.equal(status(store).context.wipLimitAtInit, 1);
  clean(store);
});
