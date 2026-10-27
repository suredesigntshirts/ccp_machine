import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, init, ack, status, readDecisionLog, logPrecedents } from '../src/index.js';
import { apply, start } from './send.js';

const bin = new URL('../bin/harness.js', import.meta.url).pathname;
const harness = (dir, ...args) => spawnSync(process.execPath, [bin, ...args, '--dir', dir], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'orchestrator-session' } });
const pendingNames = (store) => store.pending().map((e) => e.name);

test('one command answers a pending plan or accept decision and acks its ask', () => {
  const dir = tempDir('harness-');
  const store = openStore(dir);
  init(store);
  start(store);
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'x', tier: 1, expect: 'a works' } });
  ack(store, store.pending().map((e) => e.id));
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:x' });
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
  const refused = harness(dir, 'answer', 'x', '--approve', '--reason', 'green', '--confidence', '0.95', '--actor', 'session:stand-in');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /write the check first/);
  mkdirSync(join(dir, 'checks'), { recursive: true });
  writeFileSync(join(dir, 'checks', 'x.md'), '- [met] a works | evidence: test a\n');
  assert.equal(harness(dir, 'answer', 'x', '--approve', '--reason', 'green', '--confidence', '0.95', '--actor', 'session:stand-in').status, 0);
  assert.match(status(store).items[0].state, /awaitingAcceptance/, 'at recommend the person still decides');
  assert.ok(pendingNames(store).includes('postDecisionCard'));
  assert.match(harness(dir, 'answer', 'x', '--approve', '--reason', 'again', '--confidence', '0.95', '--actor', 'session:stand-in').stderr, /no pending stand-in question/);
});
