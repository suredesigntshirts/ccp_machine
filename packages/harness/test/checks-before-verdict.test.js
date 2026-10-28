// #71: an item does not leave verifying until its verifier's verdict is recorded, in whichever order CI and the
// verifier arrive (spec workItem, verifying: awaitsVerdict, awaitsChecks). On dogfood2 CI recorded before the verifier
// moved items to awaitingAcceptance, the verifier's checks then never counted (or each reopened the accept decision),
// and the person had to tap a decision the grant should have decided. Each test drives a real store through apply().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { apply, start } from './send.js';
import { openStore, init, status, replay } from '../src/index.js';

const T0 = '2026-10-28T12:00:00.000Z';
const at = (minutes) => new Date(Date.parse(T0) + minutes * 6e4).toISOString();
const LEAD = 'sim-orchestrator';
const BRIEF = 'b'.repeat(64);
const HEAD = 'a'.repeat(40);
const OTHER = 'c'.repeat(40);
const cli = (ref) => ({ kind: 'cli', ref });
const lead = { actor: { kind: 'session', id: LEAD }, source: cli('harness send') };
const verifier = { actor: { kind: 'agent', id: `${LEAD}/v1`, type: 'harness:verifier' }, source: cli('harness verdict') };
const person = { actor: { kind: 'person', id: 'sd' }, source: { kind: 'message', ref: 'cmsg_grant' }, relayedBy: LEAD };
const ok = (r, label) => assert.equal(r.refused, undefined, `${label}: ${r.why}`);

const ci = (sha = HEAD) => ({ type: 'CHECKS_PASSED', sha: sha.slice(0, 7), actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref: `o/r#7@${sha}:checks=success` } });
const check = (criterion) => ({ type: 'CRITERION_CHECKED', criterion, verdict: 'met', evidence: `test ${criterion}`, ...verifier });
const verdict = (sha = HEAD) => ({ type: 'VERDICT_GIVEN', verdict: 'PASS', sha, review: 1, text: `PASS\n\nall met\n${BRIEF}`, ...verifier });

/** A tier-2 item under the person's stop-asking grant, plan decided by the grant, verifier brief fixed, built. */
function built(id = 'x') {
  const store = openStore(tempDir('harness-checks-before-verdict-'));
  init(store, { wipLimit: 4 }, T0);
  start(store, T0);
  ok(apply(store, { type: 'PERSON_GRANTED', picks: ['kind:plan', 'kind:accept', 'kind:merge', 'one-way'], ...person }, { now: T0 }), 'grant');
  ok(apply(store, { type: 'REQUEST_RECEIVED', request: { id } }, { now: at(1) }), 'request');
  ok(apply(store, { type: 'TRIAGED', tier: 2, criteria: ['a works', 'b works'] }, { to: `item:${id}`, now: at(1) }), 'triage');
  ok(apply(store, { type: 'STAND_IN_ANSWERED', answer: { choice: 'approve', confidence: 0.9, reason: 'small' } }, { to: `item:${id}/decision:${id}:plan:1`, now: at(2) }), 'plan');
  ok(apply(store, { type: 'VERIFIER_BRIEF_FIXED', sha256: BRIEF, ...lead }, { to: `item:${id}`, now: at(2) }), 'brief');
  ok(apply(store, { type: 'RUN_SUCCEEDED' }, { to: `item:${id}`, now: at(3) }), 'run');
  ok(apply(store, { type: 'WORKER_SPAWNED', role: 'verifier', briefSha256: BRIEF, agentType: 'harness:verifier', ...lead }, { to: `item:${id}`, now: at(3) }), 'spawn');
  ok(apply(store, { type: 'WORKER_STARTED', agent: `${LEAD}/v1`, agentType: 'harness:verifier', ...lead }, { to: `item:${id}`, now: at(3) }), 'start');
  return store;
}
const item = (store) => status(store).items[0];
const asks = (store, gate) => store.outbox().filter((e) => e.name === 'askStandIn' && String(e.subject).includes(`:${gate}:`));
const send = (store, events, from = 4) => events.forEach((e, i) => ok(apply(store, e, { to: 'item:x', now: at(from + i) }), e.type));

/** The stand-in answers the accept ask; under the grant it decides without a person. */
function acceptDecidedUnderGrant(store) {
  const [ask] = asks(store, 'accept');
  assert.ok(ask, 'the accept decision asked the stand-in');
  assert.equal(asks(store, 'accept').length, 1, 'one accept decision, asked once: nothing reopened it');
  assert.equal(store.read().snapshot.children.x.snapshot.context.expectationsMet, true, 'the verifier\'s checks counted');
  ok(apply(store, { type: 'STAND_IN_ANSWERED', answer: { choice: 'approve', confidence: 0.85, reason: 'every criterion met' } }, { to: `item:x/${ask.subject}`, now: at(20) }), 'accept');
  const accept = item(store).decisions.find((d) => d.decisionClass === 'accept');
  assert.deepEqual([accept.state, accept.decidedBy, accept.authority], ['decided', 'stand-in', 'grant']);
  assert.equal(item(store).state, 'active.awaitingMergeDecision');
  assert.equal(store.events().filter((e) => e.event.type === 'PERSON_DECIDED').length, 0, 'no person tapped');
  assert.equal(store.outbox().filter((e) => e.name === 'postDecisionCard').length, 0, 'no card was asked for');
  const r = replay(store);
  assert.equal(r.ok, true, JSON.stringify(r.differences.concat(r.firstDivergence ?? [])));
}

test('CI before the verifier: the item waits in verifying for the verdict, and the accept is decided under the grant', () => {
  const store = built();
  send(store, [ci()]);
  assert.equal(item(store).state, 'active.verifying', 'CI alone does not leave verifying');
  assert.deepEqual(asks(store, 'accept'), [], 'no accept decision yet');
  send(store, [check('a works'), check('b works')], 5);
  assert.equal(item(store).state, 'active.verifying', 'checks are taken while it waits');
  send(store, [verdict()], 7);
  assert.equal(item(store).state, 'active.awaitingAcceptance', 'the verdict on the CI head ends verifying');
  acceptDecidedUnderGrant(store);
});

test('CI after the verifier: the verdict waits for CI on its head, and the accept is decided under the grant', () => {
  const store = built();
  send(store, [check('a works'), check('b works'), verdict()]);
  assert.equal(item(store).state, 'active.verifying', 'a verdict alone does not leave verifying');
  send(store, [ci()], 7);
  assert.equal(item(store).state, 'active.awaitingAcceptance');
  acceptDecidedUnderGrant(store);
});

test('CI and the verdict must name the same head', () => {
  const store = built();
  send(store, [ci(OTHER), verdict(HEAD)]);
  assert.equal(item(store).state, 'active.verifying', 'a verdict on another head than CI passed does not end verifying');
  send(store, [ci(HEAD)], 6);
  assert.equal(item(store).state, 'active.awaitingAcceptance', 'CI on the verdict\'s head does');

  // A new build clears the CI head with the checks: CI on the old build does not carry over.
  const s2 = built();
  send(s2, [ci(HEAD), { type: 'CHECKS_FAILED', actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref: `o/r#7@${OTHER}:checks=failure` } }]);
  assert.equal(item(s2).state, 'active.building');
  assert.equal(s2.read().snapshot.children.x.snapshot.context.checksPassed, null, 'a new build clears checksPassed');
  ok(apply(s2, { type: 'RUN_SUCCEEDED' }, { to: 'item:x', now: at(8) }), 'rebuild');
  send(s2, [verdict(OTHER)], 9);
  assert.equal(item(s2).state, 'active.verifying', 'the old build\'s CI does not release the new verdict');
});

test('an item with no verifier brief cannot be given a verdict, so its CI goes on as before', () => {
  const store = openStore(tempDir('harness-checks-before-verdict-'));
  init(store, { wipLimit: 4 }, T0);
  start(store, T0);
  ok(apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'n' } }, { now: T0 }), 'request');
  ok(apply(store, { type: 'TRIAGED', tier: 0, criteria: ['it works'] }, { to: 'item:n', now: T0 }), 'triage');
  ok(apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:n', now: T0 }), 'run');
  ok(apply(store, ci(), { to: 'item:n', now: T0 }), 'ci');
  assert.equal(item(store).state, 'active.merging');
});
