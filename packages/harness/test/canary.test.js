import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, init, apply, status, canaryRequest, canaryReport, renderDigest } from '../src/index.js';

const day = '2026-10-26';
const at = (hm) => `${day}T${hm}:00Z`;
const fresh = () => {
  const store = openStore(mkdtempSync(join(tmpdir(), 'harness-canary-')));
  init(store, {}, at('08:00'));
  return store;
};
const file = (store) => apply(store, canaryRequest(day), { id: `req-canary-${day}`, now: at('09:00') });
const step = (store, type, hm, id) => apply(store, { type }, { to: `item:canary-${day}`, now: at(hm), id });

test('the canary is filed once a day as a tier-0 item and times each stage to the merge', () => {
  const store = fresh();
  assert.equal(file(store).effects[0].params.step, 'triage');
  assert.equal(file(store).duplicate, true);
  step(store, 'RUN_SUCCEEDED', '09:02');
  step(store, 'RUN_SUCCEEDED', '09:10');
  step(store, 'CHECKS_PASSED', '09:13');
  step(store, 'MERGED', '09:14');
  assert.equal(status(store).items[0].state, 'done');
  const r = canaryReport(store.events(), day, at('12:00'));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.stages.map((s) => [s.stage, s.ms / 60e3, s.slow]), [['triage', 2, false], ['build', 8, false], ['verify', 3, false], ['merge', 1, false]]);
  assert.equal(r.line, 'Canary 2026-10-26 merged in 14m: triage 2m, build 8m, verify 3m, merge 1m.');
  assert.match(renderDigest(status(store), { events: store.events(), day }), /\*\*Canary:\*\* Canary 2026-10-26 merged in 14m/);
});

test('a canary not merged after 2 hours is late, names its stage, and the digest leads with it', () => {
  const store = fresh();
  file(store);
  step(store, 'RUN_SUCCEEDED', '09:02');
  assert.equal(canaryReport(store.events(), day, at('10:00')).status, 'running');
  const late = canaryReport(store.events(), day, at('11:30'));
  assert.equal(late.status, 'late');
  assert.match(late.line, /stuck at build/);
  assert.ok(late.stages[1].slow);
  const st = { ...status(store), updatedAt: at('11:30') };
  assert.match(renderDigest(st, { events: store.events(), day }), /^# Harness digest, 2026-10-26\n\n\*\*Look here first:\*\* Canary 2026-10-26 has not finished after 2\.5h/);
});

test('a failed stage is reported, and a missing canary says so', () => {
  const store = fresh();
  file(store);
  step(store, 'RUN_SUCCEEDED', '09:02');
  step(store, 'RUN_SUCCEEDED', '09:05');
  step(store, 'CHECKS_FAILED', '09:08');
  const r = canaryReport(store.events(), day, at('09:30'));
  assert.equal(r.status, 'failed');
  assert.match(r.line, /failed at CHECKS_FAILED \(09:08 UTC\)/);
  assert.equal(canaryReport([], day).status, 'missing');
});
