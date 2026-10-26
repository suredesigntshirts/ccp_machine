import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, runScenarios } from '../src/index.js';

test('every golden scenario holds', () => {
  const results = runScenarios();
  assert.ok(results.length >= 8);
  for (const r of results) assert.deepEqual(r.failures, [], r.name);
});

test('a scenario names the step and expectation that broke', () => {
  const r = runScenario({
    name: 'wrong',
    steps: [
      { event: { type: 'REQUEST_RECEIVED', request: { id: 'a', tier: 0 } }, expect: { effects: ['dispatchRun:triage'] } },
      { event: { type: 'RUN_SUCCEEDED' }, to: 'item:a', expect: { items: { a: 'active.verifying' }, colour: 'blue' } }
    ]
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures.map((f) => [f.step, f.key, f.actual]), [[2, 'items', { a: 'active.building' }], [2, 'colour', 'unknown expectation']]);
});
