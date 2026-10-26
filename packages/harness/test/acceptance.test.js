import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, init, apply, ack, acceptance, peakInFlight, touchesByTier } from '../src/index.js';

test('peak in flight counts items from their first dispatched run to their merge', () => {
  const outbox = [
    { name: 'dispatchRun', subject: 'a', at: '1' },
    { name: 'dispatchRun', subject: 'b', at: '2' },
    { name: 'dispatchRun', subject: 'a', at: '3' },
    { name: 'dispatchRun', subject: 'c', at: '5' }
  ];
  const events = [{ to: 'item:a', at: '4', event: { type: 'MERGED' } }];
  assert.deepEqual(peakInFlight(events, outbox), { peak: 2, at: '2', items: 3 });
});

test('the person\'s touches split into requests and decisions by tier', () => {
  const events = [
    { to: 'harness', event: { type: 'REQUEST_RECEIVED', request: { id: 'a', tier: 2 }, person: true } },
    { to: 'harness', event: { type: 'REQUEST_RECEIVED', request: { id: 'b', tier: 1 } } },
    { to: 'item:a/decision:a:plan:1', event: { type: 'PERSON_DECIDED', person: true } },
    { to: 'item:b', event: { type: 'CANCEL', person: true } }
  ];
  assert.deepEqual(touchesByTier(events), { requests: 1, decisions: { 2: 1 }, other: { 1: 1 } });
});

test('harness acceptance reports each v1 criterion with a verdict and evidence', () => {
  const store = openStore(mkdtempSync(join(tmpdir(), 'harness-')));
  init(store, { wipLimit: 3 });
  for (const id of ['a', 'b', 'c']) apply(store, { type: 'REQUEST_RECEIVED', request: { id, tier: 0 } }, { id: `req-${id}` });
  for (const id of ['a', 'b', 'c']) {
    ack(store, store.pending().map((e) => e.id), { note: 'done' });
    apply(store, { type: 'RUN_SUCCEEDED' }, { to: `item:${id}` });
  }
  const rows = acceptance(store, { scenarios: () => [{ file: 'x/budget-soft-limit.json', ok: true }] });
  assert.equal(rows.length, 6);
  assert.ok(rows.every((r) => ['met', 'not met', 'unknown'].includes(r.verdict) && r.evidence));
  assert.match(rows[0].evidence, /^peak 3 in flight/);
  assert.equal(rows[0].verdict, 'not met', 'none merged yet');
  assert.equal(rows[1].verdict, 'unknown', 'no ledger given');
  assert.equal(rows[2].verdict, 'met');
});
