import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibrateClass, calibration, renderDecisionLog } from '../src/index.js';

const at = (m) => new Date(Date.parse('2026-10-26T10:00:00Z') + m * 60000).toISOString();
const row = (i, { choice = 'approve', lean = 'approve', confidence = 0.95, by = 'person', cls = 'plan' } = {}) => ({
  at: at(i * 10), decisionClass: cls, choice, decidedBy: by, standIn: { choice: lean, confidence }
});

test('too few person decisions: not enough evidence, and the stand-in\'s own decisions never count', () => {
  const rows = [...Array.from({ length: 5 }, (_, i) => row(i)), ...Array.from({ length: 30 }, (_, i) => row(5 + i, { by: 'stand-in' }))];
  const c = calibrateClass(rows, 'plan', at(400));
  assert.deepEqual([c.decisions, c.tested, c.trust], [35, 5, 'unknown']);
});

test('a confident stand-in that is usually wrong is overconfident and stays at recommend', () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(i, { choice: i < 6 ? 'approve' : 'revise', confidence: 0.95 }));
  const c = calibrateClass(rows, 'plan', at(200));
  assert.equal(c.reversals, 6);
  assert.equal(c.agreement, 0.5);
  assert.equal(c.trust, 'no');
  assert.match(c.advice, /Overconfident.*95%.*50%/);
  assert.ok(Math.abs(c.brier - (6 * 0.05 ** 2 + 6 * 0.95 ** 2) / 12) < 1e-9);
  assert.deepEqual(c.bins.at(-1), { bin: '≥ 0.9', n: 12, agreement: 0.5 });
  assert.ok(c.msOnRung.shadow > 0 && c.msOnRung.recommend > 0, 'reversals moved it down the ladder over time');
});

test('a well calibrated, usually right class earns a lower threshold, and the page answers per class', () => {
  const rows = [...Array.from({ length: 20 }, (_, i) => row(i, { confidence: 0.97 })), row(20, { cls: 'accept' })];
  const [plan, accept] = calibration(rows, { now: at(300) });
  assert.equal(plan.trust, 'yes');
  assert.ok(plan.brier < 0.01);
  assert.ok(plan.msOnRung.act > 0, 'the 20th agreeing decision climbed it to act');
  assert.equal(accept.trust, 'unknown');
  const html = renderDecisionLog(rows);
  assert.match(html, /Can I trust the stand-in here\?/);
  assert.match(html, /plan: yes/);
  assert.match(html, /accept: not yet/);
});
