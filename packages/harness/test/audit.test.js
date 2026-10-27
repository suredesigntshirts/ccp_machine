import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { existsSync } from 'node:fs';
import { logged, start, post, apply } from './send.js';
import { join } from 'node:path';
import { openStore, init, readDecisionLog, logPrecedents, auditPicks, auditCard, pickAudit, untestedRuns, auditLine, openAudits, renderPage, calibrateClass, ladder, doctor, renderDigest, status } from '../src/index.js';

const lean = (confidence) => ({ choice: 'approve', confidence, threshold: 0.9, autonomy: 'act', reason: 'looks fine' });
const standIn = (n, cls, confidence, at) => ({ effectId: `s${n}`, at, item: `i${n}`, decision: `decision:i${n}:${cls}:1`, decisionClass: cls, tier: 1, question: `${cls}: i${n}`, choice: 'approve', decidedBy: 'stand-in', standIn: lean(confidence) });

function storeWith(rows) {
  const store = openStore(tempDir('harness-'));
  init(store, {}, '2026-10-26T09:00:00Z');
  start(store, '2026-10-26T09:00:00Z');
  logged(store, rows);
  return store;
}

test('picks favour untested classes, low confidence and age, one per class first', () => {
  const rows = [
    standIn(1, 'plan', 0.95, '2026-10-26T10:00:00Z'),
    standIn(2, 'plan', 0.91, '2026-10-26T10:01:00Z'),
    standIn(3, 'accept', 0.99, '2026-10-26T10:02:00Z'),
    standIn(4, 'plan', 0.91, '2026-10-26T09:59:00Z'),
    { ...standIn(5, 'merge', 0.5, '2026-10-26T10:03:00Z'), decidedBy: 'person', choice: 'approve' }
  ];
  // merge has a tested decision, so it comes last; plan's lowest confidence, oldest first.
  assert.deepEqual(auditPicks(rows).map((r) => r.effectId), ['s4', 's3', 's2']);
  assert.deepEqual(auditPicks(rows, { max: 1 }).map((r) => r.effectId), ['s4']);
});

test('the card confirms all with option 0 and reverses pick i with option i', () => {
  const picks = [standIn(1, 'plan', 0.9), standIn(2, 'accept', 0.8)];
  const card = auditCard(picks);
  assert.equal(card.options.length, 3);
  assert.equal(card.recommended, 0);
  assert.match(card.context, /#2 i2 accept: approve \(80% sure: looks fine\)/);
  assert.ok(card.options.every((o) => o.label.length <= 40 && o.consequence.length <= 200));
});

const orchestrator = { actor: { kind: 'session', id: 'orchestrator' }, source: { kind: 'cli', ref: 'harness audit' } };
// The person's tap on the audit card the host posted for `day`.
const answer = (store, day, option, now) => apply(store, { type: 'AUDIT_ANSWERED', option, actor: { kind: 'person', id: 'sd' }, source: { kind: 'tap', ref: `cmsg_audit_${day.replace(/-/g, '')}` } }, { to: `audit:${day}`, now });

test('an answer becomes the person\'s decisions, which calibration and the ladder learn from', () => {
  const store = storeWith([standIn(1, 'plan', 0.9, '2026-10-26T10:00:00Z'), standIn(2, 'plan', 0.8, '2026-10-26T10:01:00Z'), standIn(3, 'accept', 0.9, '2026-10-26T10:02:00Z')]);
  const day = '2026-10-26';
  assert.equal(pickAudit(store, day, { by: orchestrator }).picks.length, 3);
  assert.equal(auditLine(store, day), '3 to check, about 1 minute');
  assert.match(renderDigest(status(store), { day, audit: auditLine(store, day) }), /\*\*Stand-in audit:\*\* 3 to check, about 1 minute\./);
  // Picks are fixed for the day: the card and the answer name the same decisions.
  assert.deepEqual(pickAudit(store, day, { by: orchestrator }).picks, ['s2', 's3', 's1']);
  post(store, `audit:${day}`, `cmsg_audit_${day.replace(/-/g, '')}`);
  assert.equal(answer(store, day, 1, '2026-10-26T12:00:00Z').refused, undefined);
  assert.equal(answer(store, day, 1).refused, true, 'answered: the audit is done, and answering twice adds nothing');
  assert.equal(auditLine(store, day), null);
  const rows = readDecisionLog(store);
  const plan = calibrateClass(rows, 'plan', '2026-10-26T13:00:00Z');
  assert.deepEqual([plan.tested, plan.reversals], [2, 1]);
  assert.equal(ladder(rows, 'plan').autonomy, 'shadow', 'a reversal drops the class a rung');
  assert.equal(calibrateClass(rows, 'accept').tested, 1);
  assert.deepEqual(auditPicks(rows), [], 'audited decisions are not picked again');
});

test('the empty early effects are left out of the log, and the log is the store\'s own records: no decisions.jsonl', () => {
  const empty = { effectId: 'e7.0', at: '2026-10-26T17:55:44Z', item: 'ledger', decision: 'decision:ledger:plan:1', decisionClass: 'plan', tier: null, question: null, choice: null, decidedBy: null, standIn: null };
  const store = storeWith([empty, standIn(1, 'plan', 0.9, '2026-10-26T18:00:00Z')]);
  assert.deepEqual(readDecisionLog(store).map((r) => r.effectId), ['s1']);
  logPrecedents(store);
  assert.equal(existsSync(join(store.dir, 'decisions.jsonl')), false);
  assert.deepEqual(readDecisionLog(store).map((r) => r.effectId), ['s1']);
});

test('doctor warns, without failing, when a class goes 21 stand-in decisions unchecked', () => {
  const rows = Array.from({ length: 21 }, (_, i) => standIn(i, 'plan', 0.9, `2026-10-26T10:${String(i).padStart(2, '0')}:00Z`));
  assert.deepEqual(untestedRuns(rows), [{ decisionClass: 'plan', untested: 21 }]);
  assert.deepEqual(untestedRuns([...rows, { ...rows[0], effectId: 'p', decidedBy: 'person' }]), []);
  const report = doctor(storeWith(rows));
  assert.equal(report.ok, true);
  assert.match(report.warnings[0], /^plan: 21 stand-in decisions in a row/);
});

test('an unanswered audit counts under Needs you on mission control until it is answered', () => {
  const store = storeWith([standIn(1, 'plan', 0.9, '2026-10-26T10:00:00Z')]);
  const day = '2026-10-26';
  const page = () => renderPage(status(store), { audits: openAudits(store) });
  assert.match(page(), /Nothing is waiting on you/, 'no audit picked yet');
  pickAudit(store, day, { by: orchestrator });
  assert.equal(openAudits(store).length, 1);
  assert.match(page(), /Needs you<\/span><b>1<\/b>/);
  assert.match(page(), /Did the stand-in call these 1 right\?[\s\S]*AUDIT_ANSWERED[\s\S]*--to audit:2026-10-26/);
  post(store, `audit:${day}`, `cmsg_audit_${day.replace(/-/g, '')}`);
  answer(store, day, 0);
  assert.deepEqual(openAudits(store), []);
  assert.match(page(), /Nothing is waiting on you/);
});
