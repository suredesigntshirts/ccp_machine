import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, init, apply, ack, status, readDecisionLog } from '../src/index.js';

const bin = new URL('../bin/harness.js', import.meta.url).pathname;
const harness = (dir, ...args) => spawnSync(process.execPath, [bin, ...args, '--dir', dir], { encoding: 'utf8' });
const pendingNames = (store) => store.pending().map((e) => e.name);

test('one command answers a pending plan or accept decision and acks its ask', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-'));
  const store = openStore(dir);
  init(store);
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'x', tier: 1, expect: 'a works' } });
  ack(store, store.pending().map((e) => e.id));
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:x' });
  assert.deepEqual(pendingNames(store), ['askStandIn']);

  assert.match(harness(dir, 'answer', 'x', '--approve').stderr, /--reason/);
  const plan = harness(dir, 'answer', 'x', '--approve', '--reason', 'standing authority in the 17:43 message', '--autonomy', 'act');
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).subject, 'decision:x:plan:1');
  assert.ok(!pendingNames(store).includes('askStandIn'), 'the ask is acked');
  assert.ok(!pendingNames(store).includes('logPrecedent'), 'the precedent is logged');
  assert.equal(readDecisionLog(store).at(-1).choice, 'approve');
  assert.equal(store.events().at(-1).event.answer.autonomy, 'act');

  ack(store, store.pending().map((e) => e.id));
  apply(store, { type: 'RUN_SUCCEEDED', pr: 'https://github.com/o/r/pull/1' }, { to: 'item:x' });
  apply(store, { type: 'CHECKS_PASSED' }, { to: 'item:x' });
  const refused = harness(dir, 'answer', 'x', '--approve', '--reason', 'green');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /write the check first/);
  mkdirSync(join(dir, 'checks'), { recursive: true });
  writeFileSync(join(dir, 'checks', 'x.md'), '- [met] a works | evidence: test a\n');
  assert.equal(harness(dir, 'answer', 'x', '--approve', '--reason', 'green').status, 0);
  assert.equal(store.events().find((e) => e.id === 'standin-decision:x:accept:2').event.answer.autonomy, 'recommend', 'the ladder rung by default');
  assert.match(status(store).items[0].state, /awaitingAcceptance/, 'at recommend the person still decides');
  assert.ok(pendingNames(store).includes('postDecisionCard'));
  assert.match(harness(dir, 'answer', 'x', '--approve', '--reason', 'again').stderr, /no pending stand-in question/);
});
