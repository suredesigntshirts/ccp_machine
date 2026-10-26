import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, init, apply, writeRetro, retroDue } from '../src/index.js';

// One tier-0 item run to merge, with `ci` minutes of CI wait and `retry` failed checks.
const run = (store, id, day, { ci = 10, retry = 0 } = {}) => {
  const t = (m) => new Date(Date.parse(`${day}T10:00:00Z`) + m * 60e3).toISOString();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id, tier: 0 } }, { now: t(0) });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: `item:${id}`, now: t(2) });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: `item:${id}`, now: t(10) });
  let m = 10;
  for (let i = 0; i < retry; i++) {
    apply(store, { type: 'CHECKS_FAILED' }, { to: `item:${id}`, now: t((m += ci)) });
    apply(store, { type: 'RUN_SUCCEEDED' }, { to: `item:${id}`, now: t((m += 5)) });
  }
  apply(store, { type: 'CHECKS_PASSED' }, { to: `item:${id}`, now: t((m += ci)) });
  apply(store, { type: 'MERGED' }, { to: `item:${id}`, now: t((m += 1)) });
};
const noScenarios = () => [];

test('the retro compares two weeks, names the constraint, and the next retro checks its expectation', () => {
  const store = openStore(mkdtempSync(join(tmpdir(), 'harness-retro-')));
  init(store, { wipLimit: 10 }, '2026-10-10T00:00:00Z');
  for (const i of [1, 2]) run(store, `old${i}`, '2026-10-15', { ci: 60, retry: 1 });
  for (const i of [1, 2, 3]) run(store, `new${i}`, '2026-10-24', { ci: 30 });
  const dir = mkdtempSync(join(tmpdir(), 'reviews-'));
  const first = writeRetro(store, dir, { day: '2026-10-26', scenarios: noScenarios });
  const r = first.record;
  assert.deepEqual([r.now.items, r.before.items], [3, 2]);
  assert.ok(r.better.some((d) => d.metric === 'retriesPerItem' && d.before === 1 && d.now === 0));
  assert.ok(r.better.some((d) => d.metric === 'medianWallMin'));
  assert.equal(r.bottlenecks[0].wait, 'CI', 'CI is the constraint');
  assert.match(first.text, /## Top bottlenecks.*\n1\. \*\*Cut the time items wait on CI\*\*/);
  assert.ok(existsSync(join(dir, '2026-10-26.json')));

  assert.equal(retroDue(store, dir, '2026-10-27').due, false);
  assert.equal(retroDue(store, dir, '2026-11-02').due, true);
  for (const i of [1, 2, 3]) run(store, `fast${i}`, '2026-10-30', { ci: 1 });
  const second = writeRetro(store, dir, { day: '2026-11-02', scenarios: noScenarios });
  const ci = second.record.checks.find((c) => c.wait === 'CI');
  assert.equal(ci.met, true, 'CI share fell below the target');
  assert.match(second.text, /- met: Cut the time items wait on CI/);
});

test('with nothing finished the retro says so instead of inventing bottlenecks', () => {
  const store = openStore(mkdtempSync(join(tmpdir(), 'harness-retro-')));
  init(store, {}, '2026-10-26T00:00:00Z');
  const { record, text } = writeRetro(store, mkdtempSync(join(tmpdir(), 'reviews-')), { day: '2026-10-26', scenarios: noScenarios });
  assert.deepEqual(record.bottlenecks, []);
  assert.match(text, /no finished items to measure/);
});

test('a CI result fed late splits its wait into CI and the host', () => {
  const store = openStore(mkdtempSync(join(tmpdir(), 'harness-retro-')));
  init(store, {}, '2026-10-24T00:00:00Z');
  const t = (m) => new Date(Date.parse('2026-10-24T10:00:00Z') + m * 60e3).toISOString();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'late', tier: 0 } }, { now: t(0) });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:late', now: t(2) });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:late', now: t(10) });
  apply(store, { type: 'CHECKS_PASSED', observedAt: t(15) }, { to: 'item:late', now: t(70) });
  apply(store, { type: 'MERGED' }, { to: 'item:late', now: t(71) });
  const { record } = writeRetro(store, mkdtempSync(join(tmpdir(), 'reviews-')), { day: '2026-10-26', scenarios: noScenarios });
  assert.equal(record.now.waits.CI, 5 * 60e3);
  assert.equal(record.now.waits['the host'], 55 * 60e3);
  assert.equal(record.bottlenecks[0].wait, 'the host');
});
