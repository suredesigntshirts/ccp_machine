import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, runScenarios } from '../src/index.js';

const orchestrator = { actor: { kind: 'session', id: 'orchestrator' }, source: { kind: 'cli', ref: 'harness send' } };

test('every golden scenario holds', () => {
  const results = runScenarios();
  assert.ok(results.length >= 9);
  for (const r of results) assert.deepEqual(r.failures, [], r.name);
});

test('a scenario names the step and expectation that broke', () => {
  const r = runScenario({
    name: 'wrong',
    steps: [
      { event: { type: 'ORCHESTRATOR_STARTED', ...orchestrator } },
      { event: { type: 'REQUEST_RECEIVED', request: { id: 'a', tier: 0 }, ...orchestrator }, expect: { effects: ['dispatchRun:triage'] } },
      { event: { type: 'RUN_SUCCEEDED', actor: { kind: 'session', id: 'worker' }, source: orchestrator.source }, to: 'item:a', expect: { items: { a: 'active.verifying' }, colour: 'blue' } }
    ]
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures.map((f) => [f.step, f.key, f.actual]), [[3, 'items', { a: 'active.building' }], [3, 'colour', 'unknown expectation']]);
});
