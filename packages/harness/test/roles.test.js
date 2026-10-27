// M3: the roles on one item are distinct. The item records its requester, triagers, workers, criterion
// checkers and stand-in answerers by session id, and refuses an event from a session that already holds
// another role there. The person and GitHub are exempt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, init, status } from '../src/index.js';
import { apply, start, earn } from './send.js';
import { tempDir } from './tmp.js';

const as = (id) => ({ actor: { kind: 'session', id }, source: { kind: 'cli', ref: 'harness send' } });
const tap = { actor: { kind: 'person', id: 'person' }, source: { kind: 'tap', ref: 'cmsg_card' } };
const github = { actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref: 'delivery-1' } };
const sure = { choice: 'approve', confidence: 0.95, reason: 'small' };

const fresh = () => {
  const store = openStore(tempDir('harness-roles-'));
  init(store);
  start(store);
  return store;
};
const ctx = (store, id = 'a') => store.read().snapshot.children[id].snapshot.context;
const decisionOf = (store, id = 'a') => `item:${id}/${ctx(store, id).decisionId}`;
const counts = (store) => [store.read().version, store.events().length, store.outbox().length];
const refused = (store, event, to, label) => {
  const before = counts(store);
  const r = apply(store, event, { to });
  assert.equal(r.refused, true, label);
  assert.match(r.why, new RegExp(`^refused: ${event.type} in `), label);
  assert.deepEqual(counts(store), before, `${label}: nothing written`);
};

// An item in verifying, tier 1: requested by the orchestrator, triaged by `triager`, the plan answered by
// `stand-in` (not alone: recommend), approved by the person, built by `worker`.
function built(store, id = 'a') {
  apply(store, { type: 'REQUEST_RECEIVED', request: { id }, ...as('orchestrator') });
  assert.ok(!apply(store, { type: 'TRIAGED', tier: 1, criteria: [`${id} works`], ...as('triager') }, { to: `item:${id}` }).refused);
  assert.ok(!apply(store, { type: 'STAND_IN_ANSWERED', answer: sure, ...as('stand-in') }, { to: decisionOf(store, id) }).refused);
  assert.ok(!apply(store, { type: 'PERSON_DECIDED', choice: 'approve', ...tap }, { to: decisionOf(store, id) }).refused);
  assert.ok(!apply(store, { type: 'RUN_SUCCEEDED', ...as('worker') }, { to: `item:${id}` }).refused);
  assert.match(status(store).items.find((i) => i.id === id).state, /verifying/);
  return store;
}

test('the item records its requester, triagers, workers, checkers and stand-in answerers by session id', () => {
  const store = built(fresh());
  apply(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'test a', ...as('reviewer') }, { to: 'item:a' });
  const c = ctx(store);
  assert.deepEqual(
    [c.requester, c.triagers, c.workers, c.checkers, c.answerers],
    ['orchestrator', ['triager'], ['worker'], ['reviewer'], ['stand-in']]
  );
});

test('the triager cannot build, check or answer', () => {
  const store = built(fresh());
  refused(store, { type: 'RUN_SUCCEEDED', ...as('triager') }, 'item:a', 'triager builds');
  refused(store, { type: 'RUN_FAILED', ...as('triager') }, 'item:a', 'triager reports a failed build');
  refused(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'x', ...as('triager') }, 'item:a', 'triager checks');
  apply(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'test a', ...as('reviewer') }, { to: 'item:a' });
  apply(store, { type: 'CHECKS_PASSED', ...github }, { to: 'item:a' });
  refused(store, { type: 'STAND_IN_ANSWERED', answer: sure, ...as('triager') }, decisionOf(store), 'triager answers the accept');
});

test('a worker cannot triage, check or answer', () => {
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'a' }, ...as('orchestrator') });
  apply(store, { type: 'RUN_FAILED', ...as('worker') }, { to: 'item:a' });
  refused(store, { type: 'TRIAGED', tier: 1, criteria: ['a works'], ...as('worker') }, 'item:a', 'worker triages');
  apply(store, { type: 'TRIAGED', tier: 1, criteria: ['a works'], ...as('triager') }, { to: 'item:a' });
  refused(store, { type: 'STAND_IN_ANSWERED', answer: sure, ...as('worker') }, decisionOf(store), 'worker answers');
  apply(store, { type: 'STAND_IN_ANSWERED', answer: sure, ...as('stand-in') }, { to: decisionOf(store) });
  apply(store, { type: 'PERSON_DECIDED', choice: 'approve', ...tap }, { to: decisionOf(store) });
  apply(store, { type: 'RUN_SUCCEEDED', ...as('worker') }, { to: 'item:a' });
  refused(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'x', ...as('worker') }, 'item:a', 'worker checks');
});

test('a checker cannot build or answer', () => {
  const store = built(fresh());
  apply(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'unmet', evidence: 'fails', ...as('reviewer') }, { to: 'item:a' });
  apply(store, { type: 'CHECKS_PASSED', ...github }, { to: 'item:a' });
  refused(store, { type: 'STAND_IN_ANSWERED', answer: sure, ...as('reviewer') }, decisionOf(store), 'checker answers the accept');
  apply(store, { type: 'STAND_IN_FAILED', ...as('orchestrator') }, { to: decisionOf(store) });
  apply(store, { type: 'PERSON_DECIDED', choice: 'revise', ...tap }, { to: decisionOf(store) });
  assert.match(status(store).items[0].state, /building/);
  refused(store, { type: 'RUN_SUCCEEDED', ...as('reviewer') }, 'item:a', 'checker builds');
  assert.ok(!apply(store, { type: 'RUN_SUCCEEDED', ...as('worker') }, { to: 'item:a' }).refused, 'the worker builds again');
});

test('the stand-in cannot triage, build or check, once it has answered on the item', () => {
  const store = built(fresh());
  refused(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'x', ...as('stand-in') }, 'item:a', 'stand-in checks');
  refused(store, { type: 'RUN_FAILED', ...as('stand-in') }, 'item:a', 'stand-in builds');
  // A second item: the stand-in answered nothing there, so it may triage it.
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'b' }, ...as('orchestrator') });
  assert.ok(!apply(store, { type: 'TRIAGED', tier: 2, criteria: ['b works'], ...as('stand-in') }, { to: 'item:b' }).refused, 'roles are per item');
  // A revised plan goes back to triage, where the stand-in that answered the plan may not triage.
  const s2 = fresh();
  apply(s2, { type: 'REQUEST_RECEIVED', request: { id: 'c' }, ...as('orchestrator') });
  apply(s2, { type: 'TRIAGED', tier: 1, criteria: ['c works'], ...as('triager') }, { to: 'item:c' });
  apply(s2, { type: 'STAND_IN_ANSWERED', answer: { ...sure, choice: 'revise' }, ...as('stand-in') }, { to: decisionOf(s2, 'c') });
  apply(s2, { type: 'PERSON_DECIDED', choice: 'revise', ...tap }, { to: decisionOf(s2, 'c') });
  assert.match(status(s2).items[0].state, /triaging/);
  refused(s2, { type: 'TRIAGED', tier: 1, criteria: ['c works'], ...as('stand-in') }, 'item:c', 'stand-in re-triages');
  assert.ok(!apply(s2, { type: 'TRIAGED', tier: 1, criteria: ['c works'], ...as('triager') }, { to: 'item:c' }).refused, 'the triager re-triages');
});

test('a stand-in that decides alone is recorded too, and STAND_IN_RECORDED from outside is refused', () => {
  const store = fresh();
  earn(store, 'plan');
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'a' }, ...as('orchestrator') });
  apply(store, { type: 'TRIAGED', tier: 1, criteria: ['a works'], ...as('triager') }, { to: 'item:a' });
  assert.ok(!apply(store, { type: 'STAND_IN_ANSWERED', answer: sure, ...as('stand-in') }, { to: decisionOf(store) }).refused);
  assert.match(status(store).items[0].state, /building/, 'the stand-in decided the plan alone');
  assert.deepEqual(ctx(store).answerers, ['stand-in']);
  refused(store, { type: 'RUN_SUCCEEDED', ...as('stand-in') }, 'item:a', 'stand-in builds');
  refused(store, { type: 'STAND_IN_RECORDED', by: 'someone', ...as('orchestrator') }, 'item:a', 'a session claims an answer');
});

test('the person and GitHub are exempt: a person may triage and check the same item, and is not recorded', () => {
  const store = fresh();
  const person = { actor: { kind: 'person', id: 'person' }, source: { kind: 'cli', ref: 'harness send' } };
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'a' }, ...as('orchestrator') });
  assert.ok(!apply(store, { type: 'TRIAGED', tier: 0, criteria: ['a works'], ...person }, { to: 'item:a' }).refused);
  apply(store, { type: 'RUN_SUCCEEDED', ...as('worker') }, { to: 'item:a' });
  assert.ok(!apply(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'looked', ...person }, { to: 'item:a' }).refused);
  assert.ok(!apply(store, { type: 'CHECKS_PASSED', ...github }, { to: 'item:a' }).refused);
  const c = ctx(store);
  assert.deepEqual([c.triagers, c.checkers, c.answerers], [[], [], []], 'only sessions are recorded');
});
