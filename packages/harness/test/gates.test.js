// M2c: the gates an item could skip. A tier never goes down, an item with no criteria waits on the person
// (counted and listed as such) without holding a slot, and each clause of the gate guards is pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActor, initialTransition, transition } from 'xstate';
import { machines, expectationsMet } from '../src/machines.js';
import { openStore, init, status, renderPage, renderDigest } from '../src/index.js';
import { apply, start, decide } from './send.js';
import { tempDir } from './tmp.js';

const triager = { actor: { kind: 'session', id: 'triager' }, source: { kind: 'cli', ref: 'harness send' } };
const triaged = (tier, criteria = ['a works']) => ({ type: 'TRIAGED', tier, criteria, ...triager });
const step = (machine, snapshot, events) => {
  let s = snapshot;
  const effects = [];
  for (const e of events) {
    const [next, actions] = transition(machine, s, e);
    s = next;
    effects.push(...actions.map((a) => a.type + (a.params?.step ? `:${a.params.step}` : '')));
  }
  return [s, effects];
};
const item0 = () => initialTransition(machines.workItem, { id: 'a', orchestrator: 'orchestrator', requester: 'filer' })[0];

// 1. A tier never goes down.

test('a tier never goes down: after a revise, a re-triage to a lower tier is refused, an equal or higher one is taken', () => {
  for (const [tier, lower, higher] of [[2, [0, 1], []], [1, [0], [2]]]) {
    const [plan] = step(machines.workItem, item0(), [{ type: 'START' }, triaged(tier)]);
    assert.deepEqual(plan.value, { active: 'awaitingPlanDecision' });
    const [back] = transition(machines.workItem, plan, { type: 'DECISION_MADE', choice: 'revise' });
    assert.deepEqual([back.value, back.context.tier], [{ active: 'triaging' }, tier], 'revise goes back to triage and keeps the tier');
    for (const t of lower) {
      assert.equal(back.can(triaged(t)), false, `tier ${tier} re-triaged to ${t}`);
      assert.equal(back.can(triaged(t, [])), false, `tier ${tier} re-triaged to ${t} with no criteria`);
    }
    for (const t of [tier, ...higher]) assert.equal(back.can(triaged(t)), true, `tier ${tier} re-triaged to ${t}`);
    // A failed triage run re-enters triage and keeps the floor too.
    const [retried] = transition(machines.workItem, back, { type: 'RUN_FAILED', actor: { kind: 'session', id: 'worker' }, source: triager.source });
    assert.deepEqual([retried.value, retried.context.tier], [{ active: 'triaging' }, tier]);
    for (const t of lower) assert.equal(retried.can(triaged(t)), false, `after a failed run, ${tier} to ${t}`);
  }
  assert.equal(item0().can({ type: 'START' }), true);
  const [first] = step(machines.workItem, item0(), [{ type: 'START' }]);
  for (const t of [0, 1, 2]) assert.equal(first.can(triaged(t)), true, `a first triage may give tier ${t}`);
});

const fresh = () => {
  const store = openStore(tempDir('harness-gates-'));
  init(store);
  start(store);
  return store;
};
const itemOf = (store, id) => status(store).items.find((i) => i.id === id);

test('a tier never goes down, through the store: the person picks revise on a tier-2 plan, re-triage to 0 or 1 is refused and nothing is written', () => {
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'x' } });
  apply(store, { type: 'TRIAGED', tier: 2, criteria: ['x works'] }, { to: 'item:x' });
  apply(store, { type: 'STAND_IN_ANSWERED', answer: { choice: 'approve', confidence: 0.99 } }, { to: 'item:x/decision:x:plan:1' });
  const revised = decide(store, 'item:x/decision:x:plan:1', 'revise');
  assert.equal(revised.refused, undefined, revised.why);
  assert.deepEqual([itemOf(store, 'x').state, itemOf(store, 'x').tier], ['active.triaging', 2]);
  const before = { state: JSON.stringify(store.read()), events: store.events().length, outbox: store.outbox().length };
  for (const tier of [0, 1]) {
    for (const criteria of [['x works'], []]) {
      const r = apply(store, { type: 'TRIAGED', tier, criteria }, { to: 'item:x' });
      assert.equal(r.refused, true, `re-triage to ${tier}`);
      assert.match(r.why, /refused: TRIAGED in active\.triaging/);
    }
  }
  assert.deepEqual({ state: JSON.stringify(store.read()), events: store.events().length, outbox: store.outbox().length }, before, 'the store is unchanged');
  const again = apply(store, { type: 'TRIAGED', tier: 2, criteria: ['x works', 'x has a test'] }, { to: 'item:x' });
  assert.equal(again.refused, undefined, again.why);
  assert.deepEqual([itemOf(store, 'x').state, itemOf(store, 'x').tier], ['active.awaitingPlanDecision', 2]);
});

// 2. needsCriteria shows to the person and keeps no slot.

test('needsCriteria is in the person\'s inbox and gives up its slot; leaving it takes it out of the inbox', () => {
  const root = createActor(machines.harness, { systemId: 'harness', input: { wipLimit: 1 } }).start();
  root.send({ type: 'ORCHESTRATOR_STARTED', actor: { kind: 'session', id: 'orchestrator' }, source: triager.source });
  for (const id of ['n', 'm']) root.send({ type: 'REQUEST_RECEIVED', request: { id } });
  assert.deepEqual([root.getSnapshot().context.inFlight, root.getSnapshot().context.queued], [['n'], ['m']]);
  const n = root.system.get('item:n');
  n.send(triaged(1, []));
  assert.deepEqual(n.getSnapshot().value, { active: 'needsCriteria' });
  let ctx = root.getSnapshot().context;
  assert.deepEqual([ctx.inFlight, ctx.queued], [['m'], []], 'n gives up its slot and m starts');
  assert.deepEqual(ctx.inbox, ['needsCriteria:n']);
  assert.ok(root.getSnapshot().hasTag('needs-human'), 'the harness needs the person');
  n.send({ type: 'CANCEL' });
  ctx = root.getSnapshot().context;
  assert.deepEqual([ctx.inFlight, ctx.inbox], [['m'], []]);
  assert.ok(!root.getSnapshot().hasTag('needs-human'));
  // An ITEM_PARKED from outside is refused: only an item entering needsCriteria gives up a slot.
  assert.equal(root.getSnapshot().can({ type: 'ITEM_PARKED', id: 'm', actor: { kind: 'session', id: 'orchestrator' }, source: triager.source }), false);
});

test('needsCriteria never goes to building: UNBLOCKED is refused there, and BLOCK then UNBLOCKED comes back to it', () => {
  const [s, effects] = step(machines.workItem, item0(), [{ type: 'START' }, triaged(0, [])]);
  assert.deepEqual(s.value, { active: 'needsCriteria' });
  assert.ok(effects.includes('giveUpSlot'), effects.join());
  assert.equal(s.can({ type: 'UNBLOCKED' }), false, 'UNBLOCKED from needsCriteria');
  const [back, after] = step(machines.workItem, s, [{ type: 'BLOCK' }, { type: 'UNBLOCKED' }]);
  assert.deepEqual(back.value, { active: 'needsCriteria' });
  assert.ok(!after.includes('dispatchRun:build'), after.join());
});

test('status, mission control and the digest count a needsCriteria item as waiting on the person, and list it', () => {
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'n', title: 'Make it better' } });
  apply(store, { type: 'TRIAGED', tier: 1, criteria: [] }, { to: 'item:n' });
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'p' } });
  apply(store, { type: 'TRIAGED', tier: 2, criteria: ['p works'] }, { to: 'item:p' });
  apply(store, { type: 'STAND_IN_ANSWERED', answer: { choice: 'approve', confidence: 0.99 } }, { to: 'item:p/decision:p:plan:1' });
  const st = status(store);
  assert.equal(st.needsPerson, true);
  assert.deepEqual(st.context.inFlight, ['p'], 'n keeps no slot');
  assert.deepEqual(st.waitingOnPerson.map((w) => [w.item, w.why]), [['n', 'no criteria'], ['p', 'plan gate']]);
  const page = renderPage(st);
  assert.match(page, /<span class="eyebrow">Needs you<\/span><b>2<\/b>/);
  const needsYou = page.slice(page.indexOf('<h2>Needs you'), page.indexOf('<h2>In flight'));
  assert.match(needsYou, /no criteria/);
  assert.match(needsYou, /Make it better/);
  assert.match(needsYou, /--to item:n/);
  const digest = renderDigest(st, { day: '2026-10-26' });
  assert.match(digest, /Waiting on you \(2\)\*\*\n- n: no criteria\n- p: plan gate/);
});

// 4. Every clause of the gate guards is pinned by a direct guard test.

const wg = machines.workItem.implementations.guards;
const dg = machines.decision.implementations.guards;

test('tierBelow: a null or missing tier is below nothing, so an untriaged item at a gate takes the gate', () => {
  for (const tier of [null, undefined, '0'])
    for (const below of [1, 2]) assert.equal(wg.tierBelow({ context: { tier } }, { tier: below }), false, `tier ${tier} below ${below}`);
  assert.equal(wg.tierBelow({ context: { tier: 0 } }, { tier: 1 }), true);
  assert.equal(wg.tierBelow({ context: { tier: 1 } }, { tier: 1 }), false);
  assert.equal(wg.tierBelow({ context: { tier: 1 } }, { tier: 2 }), true);
});

test('standInMayDecide: a null tier never lets the stand-in decide', () => {
  const ok = { tier: 1, autonomy: 'act', threshold: 0.9, standIn: { confidence: 0.95 }, decisionClass: 'plan', expectationsMet: null };
  assert.equal(dg.standInMayDecide({ context: ok }), true);
  for (const tier of [null, undefined, '1']) assert.equal(dg.standInMayDecide({ context: { ...ok, tier } }), false, `tier ${tier}`);
  assert.equal(dg.standInMayDecide({ context: { ...ok, tier: 2 } }), false, 'tier 2');
  assert.equal(dg.standInMayDecide({ context: { ...ok, decisionClass: 'accept' } }), false, 'accept without expectationsMet');
  assert.equal(dg.standInMayDecide({ context: { ...ok, decisionClass: 'accept', expectationsMet: true } }), true);
});

test('expectationsMet: each clause (some criteria, met, evidence, a checker, not the orchestrator, not a worker) is needed', () => {
  const ok = { criteria: ['a', 'b'], checks: { a: { verdict: 'met', evidence: 'test a', by: 'reviewer' }, b: { verdict: 'met', evidence: 'test b', by: 'reviewer' } }, orchestrator: 'orchestrator', workers: ['worker'] };
  assert.equal(wg.expectationsMet, expectationsMet);
  assert.equal(expectationsMet({ context: ok }), true);
  const withA = (over) => ({ ...ok, checks: { ...ok.checks, a: { ...ok.checks.a, ...over } } });
  for (const [why, context] of [
    ['no criteria (non-empty)', { ...ok, criteria: [], checks: {} }],
    ['unmet', withA({ verdict: 'unmet' })],
    ['unchecked', { ...ok, checks: { b: ok.checks.b } }],
    ['no evidence', withA({ evidence: '' })],
    ['blank evidence', withA({ evidence: '  ' })],
    ['evidence not text', withA({ evidence: 1 })],
    ['no checker', withA({ by: null })],
    ['the orchestrator', withA({ by: 'orchestrator' })],
    ['a worker', withA({ by: 'worker' })]
  ])
    assert.equal(expectationsMet({ context }), false, why);
});
