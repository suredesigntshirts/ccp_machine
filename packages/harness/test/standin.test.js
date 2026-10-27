import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { spawnSync } from 'node:child_process';
import { openStore, init, ack, status, readDecisionLog, logPrecedents } from '../src/index.js';
import { apply, start, earn } from './send.js';

const bin = new URL('../bin/harness.js', import.meta.url).pathname;
const harness = (dir, ...args) => spawnSync(process.execPath, [bin, ...args, '--dir', dir], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'orchestrator-session' } });
const pendingNames = (store) => store.pending().map((e) => e.name);

test('one command answers a pending plan or accept decision and acks its ask', () => {
  const dir = tempDir('harness-');
  const store = openStore(dir);
  init(store);
  start(store);
  // The stand-in has earned act on accept gates, so the machine's own rule is all that sends an accept to the person.
  earn(store, 'accept');
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'x', expect: 'a works' } });
  ack(store, store.pending().map((e) => e.id));
  apply(store, { type: 'RUN_FAILED' }, { to: 'item:x' }); // the worker's triage run fails: it is one of the item's workers
  ack(store, store.pending().map((e) => e.id));
  apply(store, { type: 'TRIAGED', tier: 1, criteria: ['a works'] }, { to: 'item:x' });
  assert.deepEqual(pendingNames(store), ['askStandIn']);

  assert.match(harness(dir, 'answer', 'x', '--approve').stderr, /--reason/);
  // The caller cannot set the gate's rules: --autonomy and --threshold are gone, and a confidence is required.
  for (const flag of ['--autonomy', '--threshold']) {
    const r = harness(dir, 'answer', 'x', '--approve', '--reason', 'standing authority', '--confidence', '0.95', flag, 'act', '--actor', 'session:stand-in');
    assert.equal(r.status, 2, flag);
    assert.match(r.stderr, new RegExp(`Unknown option '${flag}'`));
  }
  assert.match(harness(dir, 'answer', 'x', '--approve', '--reason', 'sure', '--actor', 'session:stand-in').stderr, /refused: STAND_IN_ANSWERED/, 'no confidence, no default');
  // Only the stand-in answers: not the orchestrator, not the worker that ran the item.
  for (const who of ['sim-orchestrator', 'sim-worker'])
    assert.match(harness(dir, 'answer', 'x', '--approve', '--reason', 'mine', '--confidence', '0.95', '--actor', `session:${who}`).stderr, /refused: STAND_IN_ANSWERED/, who);
  assert.ok(pendingNames(store).includes('askStandIn'), 'nothing refused was taken');

  const plan = harness(dir, 'answer', 'x', '--approve', '--reason', 'small and covered', '--confidence', '0.95', '--actor', 'session:stand-in');
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).subject, 'decision:x:plan:1');
  assert.ok(!pendingNames(store).includes('askStandIn'), 'the ask is acked');
  assert.deepEqual(store.events().at(-1).event.answer, { choice: 'approve', confidence: 0.95, reason: 'small and covered' }, 'the answer carries no rules');
  const [d] = status(store).items[0].decisions;
  assert.deepEqual([d.autonomy, d.state], ['recommend', 'awaitingPerson'], 'at the ladder\'s recommend the person decides');
  apply(store, { type: 'PERSON_DECIDED', choice: 'approve' }, { to: d.address });
  logPrecedents(store);
  assert.deepEqual([readDecisionLog(store).at(-1).choice, readDecisionLog(store).at(-1).autonomy], ['approve', 'recommend']);

  ack(store, store.pending().map((e) => e.id));
  apply(store, { type: 'RUN_SUCCEEDED', pr: 'https://github.com/o/r/pull/1' }, { to: 'item:x' });
  apply(store, { type: 'CHECKS_PASSED' }, { to: 'item:x' });
  // No criterion checked: at act and 0.95 the stand-in still cannot approve accept, so the person decides.
  const unchecked = harness(dir, 'answer', 'x', '--approve', '--reason', 'green', '--confidence', '0.95', '--actor', 'session:stand-in');
  assert.equal(unchecked.status, 0, unchecked.stderr);
  const accept = status(store).items[0].decisions.find((d) => d.decisionClass === 'accept');
  assert.deepEqual([accept.id, accept.autonomy, accept.state], ['decision:x:accept:2', 'act', 'awaitingPerson']);
  assert.ok(pendingNames(store).includes('postDecisionCard'));
  assert.match(harness(dir, 'answer', 'x', '--approve', '--reason', 'again', '--confidence', '0.95', '--actor', 'session:stand-in').stderr, /no pending stand-in question/);
  // A reviewer checks the criterion met: the gate reopens the decision, and now the stand-in may approve.
  assert.equal(harness(dir, 'send', '{"type":"CRITERION_CHECKED","criterion":"a works","verdict":"met","evidence":"test a"}', '--to', 'item:x', '--actor', 'session:sim-worker').status, 1, 'not the worker');
  const checked = harness(dir, 'send', '{"type":"CRITERION_CHECKED","criterion":"a works","verdict":"met","evidence":"test a"}', '--to', 'item:x', '--actor', 'session:reviewer');
  assert.equal(checked.status, 0, checked.stderr);
  const met = harness(dir, 'answer', 'x', '--approve', '--reason', 'every criterion met', '--confidence', '0.95', '--actor', 'session:stand-in');
  assert.equal(met.status, 0, met.stderr);
  assert.equal(JSON.parse(met.stdout).subject, 'decision:x:accept:3');
  assert.equal(status(store).items[0].state, 'active.merging', 'the stand-in approved accept alone, tier 1 merges');
});
