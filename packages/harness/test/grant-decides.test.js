// Under the person's grant the stand-in decides whatever its confidence (#58), and a decision already waiting on the
// person goes back to the stand-in when the live grant covers it (REASK_UNDER_GRANT). Each test drives a real store
// through runtime.apply(), the way the host does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { apply, start, post, earn } from './send.js';
import { openStore, init, ack, status, apply as applyEvent, replay, renderLivePage, renderPage, auditCard, specs } from '../src/index.js';

const T0 = '2026-10-28T10:00:00.000Z';
const at = (minutes) => new Date(Date.parse(T0) + minutes * 6e4).toISOString();
const person = { actor: { kind: 'person', id: 'sd' } };
const fromMessage = (ref) => ({ ...person, source: { kind: 'message', ref }, relayedBy: 'sim-orchestrator' });
const session = (id) => ({ actor: { kind: 'session', id }, source: { kind: 'cli', ref: 'harness send' } });
const tapOn = (ref) => ({ ...person, source: { kind: 'tap', ref }, relayedBy: 'host' });

function fresh(t0 = T0) {
  const store = openStore(tempDir('harness-grant-decides-'));
  init(store, { wipLimit: 4 }, t0);
  start(store, t0);
  return store;
}
/** The person's grant in their own words (PERSON_GRANTED from a message). */
const grant = (store, picks, now = T0, ref = 'cmsg_grant') => {
  const r = applyEvent(store, { type: 'PERSON_GRANTED', picks, ...fromMessage(ref) }, { now });
  assert.equal(r.refused, undefined, r.why);
};
const STOP_ASKING = ['kind:plan', 'kind:accept', 'kind:merge', 'one-way'];
function itemAtPlan(store, id, tier = 2, now = T0) {
  apply(store, { type: 'REQUEST_RECEIVED', request: { id } }, { now });
  ack(store, store.pending().filter((e) => e.name === 'dispatchRun').map((e) => e.id));
  apply(store, { type: 'RUN_FAILED' }, { to: `item:${id}`, now });
  apply(store, { type: 'TRIAGED', tier, criteria: ['a works'] }, { to: `item:${id}`, now });
  return `item:${id}/decision:${id}:plan:1`;
}
function toMerge(store, id, now) {
  answer(store, `item:${id}/decision:${id}:plan:1`, now, { confidence: 0.95 });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: `item:${id}`, now });
  apply(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'test a' }, { to: `item:${id}`, now });
  apply(store, { type: 'CHECKS_PASSED' }, { to: `item:${id}`, now });
  answer(store, `item:${id}/decision:${id}:accept:2`, now, { confidence: 0.95 });
  return `item:${id}/decision:${id}:merge:3`;
}
const answer = (store, to, now, { choice = 'approve', confidence = 0.5, reason = 'right shape, some doubt about the tests' } = {}) => {
  const r = apply(store, { type: 'STAND_IN_ANSWERED', answer: { choice, confidence, ...(reason != null && { reason }) } }, { to, now });
  assert.equal(r.refused, undefined, r.why);
  return r;
};
const decision = (store, address) => status(store).items.flatMap((i) => i.decisions).find((d) => d.address === address);
const idOf = (address) => address.split('/')[1];
const reask = (store, address, now, by) => applyEvent(store, { type: 'REASK_UNDER_GRANT', decision: idOf(address), ...(by ?? session('sim-orchestrator')) }, { now });
const inbox = (store) => store.read().snapshot.context.inbox;
const granted = (store) => store.read().snapshot.context.granted;

test('under a live grant the stand-in decides a reasoned answer whatever its confidence, and the row shows the confidence', () => {
  const store = fresh();
  grant(store, ['kind:plan', `until:${at(600)}`]);
  const plan = itemAtPlan(store, 'low', 2, at(1));
  answer(store, plan, at(2), { confidence: 0.5 });
  assert.equal(status(store).items[0].state, 'active.building', 'a 0.5 answer decided under the grant');
  assert.deepEqual([decision(store, plan).decidedBy, decision(store, plan).authority], ['stand-in', 'grant']);
  // The confidence is recorded on the granted row, which mission control, the full page and the daily audit show.
  const [row] = granted(store);
  assert.deepEqual([row.item, row.choice, row.confidence, row.reason], ['low', 'approve', 0.5, 'right shape, some doubt about the tests']);
  assert.match(renderLivePage(store.read(), { now: at(3) }), /50% sure/);
  assert.match(renderPage(status(store)), /50%/);
  assert.match(auditCard([], granted(store)).context, /low plan: approve \(50% sure\)/);
  // Still a reason is needed: an answer with none goes to the person under the grant too.
  const bare = itemAtPlan(store, 'bare', 2, at(4));
  answer(store, bare, at(5), { confidence: 0.99, reason: null });
  assert.equal(decision(store, bare).state, 'awaitingPerson');
});

test('without a grant the ladder keeps the threshold exactly as before', () => {
  const store = fresh();
  earn(store, 'plan');
  const low = itemAtPlan(store, 'l1', 1, at(1));
  answer(store, low, at(2), { confidence: 0.85 });
  assert.equal(decision(store, low).state, 'awaitingPerson', 'below the threshold the person decides');
  const sure = itemAtPlan(store, 'l2', 1, at(3));
  answer(store, sure, at(4), { confidence: specs.decision.context.threshold });
  assert.equal(status(store).items.find((i) => i.id === 'l2').state, 'active.building', 'at the threshold the ladder decides');
  assert.deepEqual(granted(store), []);
});

test('an answer logged before the rule was loosened keeps the threshold, so an older log replays as it was routed', () => {
  const cut = specs.decision.states.routing.always[0].guard.params.thresholdBefore;
  const before = new Date(Date.parse(cut) - 36e5).toISOString();
  const store = fresh(before);
  grant(store, STOP_ASKING, before);
  const plan = itemAtPlan(store, 'old', 2, before);
  answer(store, plan, before, { confidence: 0.85 });
  assert.equal(decision(store, plan).state, 'awaitingPerson', 'the rule the answer was logged under');
  const r = replay(store);
  assert.equal(r.ok, true, JSON.stringify(r.differences.concat(r.firstDivergence ?? [])));
});

test('a decision waiting on the person goes back to the stand-in when the live grant covers it, and is decided', () => {
  const store = fresh();
  // Answered before any grant: the person's card is up.
  const plan = itemAtPlan(store, 'stuck', 2, at(1));
  answer(store, plan, at(2), { confidence: 0.85 });
  const card = post(store, plan, 'cmsg_stuck_card', at(2));
  assert.deepEqual(inbox(store), [idOf(plan)]);
  // With no grant, the re-ask is refused and writes nothing.
  const v = store.read().version;
  const none = reask(store, plan, at(3));
  assert.equal(none.refused, true);
  assert.match(none.why, /grantMissesDecision/);
  assert.equal(store.read().version, v);
  // The person grants; another session or an agent cannot re-ask, the orchestrator can.
  grant(store, STOP_ASKING, at(4));
  for (const by of [session('other'), { actor: { kind: 'agent', id: 'sim-orchestrator/a1' }, source: { kind: 'cli', ref: 'x' } }, tapOn(card)])
    assert.equal(reask(store, plan, at(5), by).refused, true, JSON.stringify(by));
  // The decision's item and the decision take the event only from inside.
  assert.equal(applyEvent(store, { type: 'REASK_UNDER_GRANT', decision: idOf(plan), ...session('sim-orchestrator') }, { to: 'item:stuck', now: at(5) }).refused, true);
  assert.equal(applyEvent(store, { type: 'REASK_UNDER_GRANT', ...session('sim-orchestrator') }, { to: plan, now: at(5) }).refused, true);
  const r = reask(store, plan, at(5));
  assert.equal(r.refused, undefined, r.why);
  assert.equal(decision(store, plan).state, 'askingStandIn');
  assert.equal(decision(store, plan).card, null, 'the old card is cleared');
  assert.deepEqual(r.effects.map((e) => [e.name, e.subject]), [['askStandIn', idOf(plan)]], 'a fresh ask for the stand-in');
  assert.deepEqual(inbox(store), [], 'it left the person\'s inbox');
  // A tap on the old card decides nothing now.
  assert.equal(applyEvent(store, { type: 'PERSON_DECIDED', choice: 'reject', ...tapOn(card) }, { to: plan, now: at(6) }).refused, true);
  // A second re-ask is refused: the decision is no longer waiting on the person.
  assert.equal(reask(store, plan, at(6)).refused, true);
  // The fresh answer decides under the grant, whatever its confidence.
  answer(store, plan, at(7), { confidence: 0.6 });
  assert.equal(status(store).items[0].state, 'active.building');
  assert.deepEqual(granted(store).map((g) => [g.item, g.confidence]), [['stuck', 0.6]]);
  assert.deepEqual(inbox(store), []);
});

test('a decision the live grant does not cover cannot leave awaitingPerson by a re-ask', () => {
  // A merge (one-way door) under a grant that names merge without the one-way-door box.
  const store = fresh();
  grant(store, ['kind:plan', 'kind:accept', 'kind:merge']);
  const merge = toMerge(store, 'm', at(1));
  answer(store, merge, at(2), { confidence: 0.99 });
  assert.equal(decision(store, merge).state, 'awaitingPerson');
  const v = store.read().version;
  const r = reask(store, merge, at(3));
  assert.equal(r.refused, true);
  assert.match(r.why, /grantMissesDecision/);
  assert.equal(store.read().version, v, 'a refusal writes nothing');
  assert.equal(decision(store, merge).state, 'awaitingPerson');
  // An ended grant covers nothing either, nor does a grant without the class; nor a decision not in the inbox.
  const s2 = fresh();
  grant(s2, ['kind:accept', `until:${at(60)}`]);
  const plan = itemAtPlan(s2, 'p', 2, at(1));
  answer(s2, plan, at(2));
  assert.equal(reask(s2, plan, at(3)).refused, true, 'plan is not in the grant');
  grant(s2, ['kind:plan', `until:${at(60)}`], at(4), 'cmsg_plan');
  assert.equal(reask(s2, plan, at(61)).refused, true, 'the grant has ended');
  assert.equal(applyEvent(s2, { type: 'REASK_UNDER_GRANT', decision: 'decision:p:plan:9', ...session('sim-orchestrator') }, { now: at(5) }).refused, true, 'no such decision waits');
  assert.equal(reask(s2, plan, at(5)).refused, undefined, 'live and covering: taken');
});

test('a re-asked decision whose fresh answer comes back to the person gets a new card', () => {
  const store = fresh();
  const plan = itemAtPlan(store, 'back', 2, at(1));
  answer(store, plan, at(2));
  const old = post(store, plan, 'cmsg_old', at(2));
  grant(store, STOP_ASKING, at(3));
  assert.equal(reask(store, plan, at(4)).refused, undefined);
  // The person narrows the grant before the fresh answer: it goes back to them, with a new card.
  grant(store, ['kind:accept'], at(5), 'cmsg_narrow');
  answer(store, plan, at(6));
  assert.equal(decision(store, plan).state, 'awaitingPerson');
  assert.deepEqual(inbox(store), [idOf(plan)]);
  assert.equal(applyEvent(store, { type: 'PERSON_DECIDED', choice: 'approve', ...tapOn(old) }, { to: plan, now: at(7) }).refused, true, 'the old card decides nothing');
  const fresh2 = post(store, plan, 'cmsg_new', at(7));
  assert.equal(applyEvent(store, { type: 'PERSON_DECIDED', choice: 'approve', ...tapOn(fresh2) }, { to: plan, now: at(8) }).refused, undefined);
  assert.equal(status(store).items[0].state, 'active.building');
  const r = replay(store);
  assert.equal(r.ok, true, JSON.stringify(r.differences.concat(r.firstDivergence ?? [])));
});
