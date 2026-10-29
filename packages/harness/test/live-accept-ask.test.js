// #84 (and #51): checks in awaitingAcceptance must not leave asks behind that no decision can take. A check that leaves
// expectationsMet as the open decision has it keeps that decision; one that changes it reopens the decision once, and the
// withdrawn decision's pending ask and card effects are closed by the machine (spec workItem, withdrawDecision closes).
// harness answer answers the item's live decision, never a stale ask of a stopped one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir } from './tmp.js';
import { openStore, init, ack, status, replay } from '../src/index.js';
import { apply, start } from './send.js';

const bin = new URL('../bin/harness.js', import.meta.url).pathname;
const sessionOf = (args) => /^session:(.+)$/.exec(args[args.indexOf('--actor') + 1] ?? '')?.[1] ?? 'orchestrator-session';
const harness = (dir, ...args) => spawnSync(process.execPath, [bin, ...args, '--dir', dir], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionOf(args) } });
const CRITERIA = ['a works', 'b works', 'c works'];
const check = (dir, criterion, verdict, evidence = `test ${criterion}`) =>
  harness(dir, 'send', JSON.stringify({ type: 'CRITERION_CHECKED', criterion, verdict, ...(verdict === 'met' && { evidence }) }), '--to', 'item:x', '--actor', 'session:reviewer');
const asks = (store) => store.pending().filter((e) => e.name === 'askStandIn');
const copy = (store) => {
  const to = tempDir('harness-live-accept-ask-copy-');
  cpSync(store.dir, to, { recursive: true });
  return to;
};
const asksOf = (store, subject) => store.outbox().find((e) => e.name === 'askStandIn' && e.subject === subject).id;
const liveAccepts = (store) => status(store).items[0].decisions.filter((d) => d.decisionClass === 'accept');

// An item at tier 2 in awaitingAcceptance, its plan approved by the person; nothing pending but the accept's ask.
function accepting() {
  const dir = tempDir('harness-live-accept-ask-');
  const store = openStore(dir);
  init(store);
  start(store);
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'x', expect: 'a, b and c work' } });
  apply(store, { type: 'RUN_FAILED' }, { to: 'item:x' });
  apply(store, { type: 'TRIAGED', tier: 2, criteria: CRITERIA }, { to: 'item:x' });
  const plan = harness(dir, 'answer', 'x', '--approve', '--reason', 'small plan', '--confidence', '0.9', '--actor', 'session:stand-in');
  assert.equal(plan.status, 0, plan.stderr);
  apply(store, { type: 'PERSON_DECIDED', choice: 'approve' }, { to: 'item:x/decision:x:plan:1' });
  ack(store, store.pending().map((e) => e.id));
  apply(store, { type: 'RUN_SUCCEEDED', pr: 'https://github.com/o/r/pull/1' }, { to: 'item:x' });
  apply(store, { type: 'CHECKS_PASSED' }, { to: 'item:x' });
  ack(store, store.pending().filter((e) => e.name !== 'askStandIn').map((e) => e.id));
  assert.equal(status(store).items[0].state, 'active.awaitingAcceptance');
  assert.deepEqual(asks(store).map((e) => e.subject), ['decision:x:accept:2']);
  return { dir, store };
}

test('N checks in awaitingAcceptance leave one live accept decision and one pending ask, for it', () => {
  const { dir, store } = accepting();
  // Five checks; expectationsMet changes once (false to true, at the fourth).
  for (const [c, v] of [['a works', 'met'], ['b works', 'met'], ['c works', 'unclear'], ['c works', 'met'], ['a works', 'met']]) {
    const r = check(dir, c, v);
    assert.equal(r.status, 0, r.stderr);
  }
  const live = liveAccepts(store);
  assert.equal(live.length, 1, 'one live accept decision');
  assert.deepEqual(asks(store).map((e) => e.subject), [live[0].id], 'one pending askStandIn, the live decision\'s');
  assert.equal(live[0].id, 'decision:x:accept:3', 'reopened once, when expectationsMet changed');
  assert.equal(status(store).items[0].decisions.length, 1);
});

test('a decision the item stops has no pending ask or card effect left', () => {
  const { dir, store } = accepting();
  // The stand-in answers the unchecked accept: tier 2, so it goes to the person and asks for a card.
  const out = harness(dir, 'answer', 'x', '--approve', '--reason', 'looks done', '--confidence', '0.9', '--actor', 'session:stand-in');
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(store.pending().filter((e) => e.subject === 'decision:x:accept:2').map((e) => e.name), ['postDecisionCard']);
  for (const c of CRITERIA) assert.equal(check(dir, c, 'met').status, 0);
  // accept:2 was withdrawn when the last check made expectationsMet true: nothing of it stays pending.
  assert.deepEqual(store.pending().filter((e) => e.subject === 'decision:x:accept:2'), [], 'the withdrawn decision\'s effects are closed');
  const closed = store.acks().filter((a) => a.outcome === 'withdrawn');
  assert.equal(closed.length, 1, 'closed by the machine, as withdrawn');
  assert.deepEqual(asks(store).map((e) => e.subject), ['decision:x:accept:3']);
  // An ask of a decision stopped before it was answered is closed too.
  assert.equal(check(dir, 'a works', 'unmet').status, 0);
  assert.deepEqual(asks(store).map((e) => e.subject), ['decision:x:accept:4']);
  assert.equal(store.pending().filter((e) => /accept:[23]$/.test(e.subject)).length, 0);
});

test('harness answer, through the CLI, answers the live decision after several checks', () => {
  const { dir, store } = accepting();
  for (const [c, v] of [['a works', 'unclear'], ['a works', 'met'], ['b works', 'met'], ['c works', 'met'], ['b works', 'met']]) assert.equal(check(dir, c, v).status, 0);
  const [live] = liveAccepts(store);
  const out = harness(dir, 'answer', 'x', '--approve', '--reason', 'every criterion met', '--confidence', '0.95', '--actor', 'session:stand-in');
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout);
  assert.equal(r.subject, live.id);
  assert.deepEqual(asks(store), [], 'its ask is acked and no other is left');
  assert.equal(status(store).items[0].decisions[0].state, 'awaitingPerson', 'tier 2: the person decides, with the answer recorded');
});

test('harness answer skips a pending ask whose decision has no actor (a store from before the fix)', () => {
  const { dir, store } = accepting();
  // A store written before #84 holds asks of decisions the item stopped; they come first in its outbox.
  const file = join(dir, 'outbox.jsonl');
  const stale = { id: 'legacy-stale.0', eventId: 'legacy-stale', at: '2026-10-28T00:00:00.000Z', name: 'askStandIn', actor: 'x:0', params: null, subject: 'decision:x:accept:1', detail: { item: 'x', address: 'item:x/decision:x:accept:1' } };
  writeFileSync(file, JSON.stringify(stale) + '\n' + readFileSync(file, 'utf8'));
  const out = harness(dir, 'answer', 'x', '--approve', '--reason', 'looks done', '--confidence', '0.9', '--actor', 'session:stand-in');
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).subject, 'decision:x:accept:2');
  assert.deepEqual(asks(store).map((e) => e.id), ['legacy-stale.0'], 'the stale ask is left as it was: nothing acks it by hand');
  // With no live decision waiting on the stand-in, answer is refused naming why.
  const again = harness(dir, 'answer', 'x', '--approve', '--reason', 'again', '--confidence', '0.9', '--actor', 'session:stand-in');
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /no pending stand-in question/);
});

test('a check logged before the rule came in (since) reopens the decision as it did, so replay routes old logs as they ran', () => {
  const { store } = accepting();
  const before = '2026-10-28T16:00:00.000Z';
  apply(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'unclear', actor: { kind: 'session', id: 'reviewer' }, source: { kind: 'cli', ref: 'harness send' } }, { to: 'item:x', now: before });
  assert.equal(liveAccepts(store)[0].id, 'decision:x:accept:3', 'reopened under the old rule');
});

test('replay gives the closes the log holds: a withdrawn ack missing from the log is a divergence, not papered over', () => {
  const { dir, store } = accepting();
  for (const c of CRITERIA) assert.equal(check(dir, c, 'met').status, 0);
  const withdrawn = store.acks().filter((a) => a.outcome === 'withdrawn');
  assert.deepEqual(withdrawn.map((a) => a.effectId), [asksOf(store, 'decision:x:accept:2')], 'the stopped decision\'s ask is closed');
  const r = replay(store);
  assert.deepEqual([r.ok, r.firstDivergence, r.admittedThen], [true, null, []]);
  // The log loses the withdrawn ack: replay closes the ask, the log does not, and the row records its route.
  const lost = openStore(copy(store));
  writeFileSync(join(lost.dir, 'acks.jsonl'), lost.acks().filter((a) => a.outcome !== 'withdrawn').map((a) => JSON.stringify(a)).join('\n') + '\n');
  assert.match(replay(lost).firstDivergence, /closes differ: the log holds none, replay gives /);
});
