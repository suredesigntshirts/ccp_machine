// The stand-in audit. Every gate the stand-in decides alone agrees with itself, so a class nobody checks
// never gets tested and its ladder never moves. Once a day the person checks up to 3 of those decisions
// on one card: one tap confirms all of them, or reverses one. Each answer goes into the decision log as
// the person's decision against the stand-in's lean, which is what calibration and the ladder learn from.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDecisionLog } from './decision-log.js';

export const AUDIT_MAX = 3;
// Past this many untested stand-in decisions in a row, doctor says the class needs an audit.
export const UNTESTED_WARN = 20;

const tested = (r) => r.decidedBy === 'person' && r.standIn?.choice && r.choice;
const auditId = (r) => `audit-${r.effectId}`;
/** The choice that goes against a lean: revise an approval, approve anything else. */
export const reverseOf = (choice) => (choice === 'approve' ? 'revise' : 'approve');

/**
 * Up to `max` stand-in decisions the person has not checked: classes with the fewest tested decisions
 * first, then the lowest confidence, then the oldest; one per class before any class gets a second.
 */
export function auditPicks(rows, { max = AUDIT_MAX } = {}) {
  const done = new Set(rows.filter((r) => r.audit).map((r) => r.audited));
  const testedIn = {};
  for (const r of rows) if (tested(r)) testedIn[r.decisionClass] = (testedIn[r.decisionClass] ?? 0) + 1;
  const candidates = rows
    .filter((r) => r.decidedBy === 'stand-in' && r.standIn?.choice && r.choice && !done.has(r.effectId))
    .sort(
      (a, b) =>
        (testedIn[a.decisionClass] ?? 0) - (testedIn[b.decisionClass] ?? 0) ||
        (a.standIn.confidence ?? 1) - (b.standIn.confidence ?? 1) ||
        String(a.at).localeCompare(String(b.at))
    );
  const firsts = [];
  const rest = [];
  const seen = new Set();
  for (const r of candidates) (seen.has(r.decisionClass) ? rest : (seen.add(r.decisionClass), firsts)).push(r);
  return [...firsts, ...rest].slice(0, max);
}

/** request_decision arguments: option 0 confirms every pick, option i (1..n) reverses pick i. */
export function auditCard(picks) {
  const n = picks.length;
  const line = (r, i) => `#${i + 1} ${r.item} ${r.decisionClass}: ${r.choice} (${Math.round((r.standIn.confidence ?? 0) * 100)}% sure${r.standIn.reason ? `: ${r.standIn.reason}` : ''})`;
  return {
    question: `Did the stand-in call these ${n} right?`,
    context: `The stand-in decided these alone. Your answer teaches it your taste.\n${picks.map(line).join('\n')}`.slice(0, 1200),
    options: [
      { label: n === 1 ? 'Yes, that was right' : `All ${n} look right`, consequence: 'Logged as agreement; the stand-in keeps its autonomy for these classes.' },
      ...picks.map((r, i) => ({
        label: `Reverse #${i + 1}`.slice(0, 40),
        consequence: `Logged as ${reverseOf(r.choice)} on ${r.item} ${r.decisionClass}; the ${r.decisionClass} class drops a rung. Nothing merged is undone.`.slice(0, 200)
      }))
    ],
    recommended: 0,
    reason: 'Confirm unless one of them is plainly wrong.'
  };
}

/** Append the person's answer to the decision log: one row per pick. Answering twice adds nothing. */
export function recordAudit(store, picks, option, { at = new Date().toISOString() } = {}) {
  if (!Number.isInteger(option) || option < 0 || option > picks.length) throw new Error(`answer is 0 (all right) to ${picks.length} (reverse that pick)`);
  const file = join(store.dir, 'decisions.jsonl');
  const have = new Set(readDecisionLog(store).map((r) => r.effectId));
  const rows = picks
    .map((r, i) => ({
      effectId: auditId(r),
      at,
      item: r.item,
      decision: r.decision,
      decisionClass: r.decisionClass,
      tier: r.tier,
      question: r.question,
      choice: option === i + 1 ? reverseOf(r.choice) : r.choice,
      decidedBy: 'person',
      standIn: r.standIn,
      audit: true,
      audited: r.effectId
    }))
    .filter((r) => !have.has(r.effectId));
  if (rows.length) appendFileSync(file, rows.map((r) => JSON.stringify(r) + '\n').join(''));
  return { added: rows.length, reversed: option ? picks[option - 1].effectId : null };
}

const auditFile = (store, day) => join(store.dir, 'audits', `${day}.json`);

/** The day's audit: picked once and kept, so the card and the answer name the same decisions. */
export function dayAudit(store, day, { max } = {}) {
  const f = auditFile(store, day);
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  const audit = { day, picks: auditPicks(readDecisionLog(store), { max }), answered: null };
  if (audit.picks.length) {
    mkdirSync(join(store.dir, 'audits'), { recursive: true });
    writeFileSync(f, JSON.stringify(audit, null, 1));
  }
  return audit;
}

export function answerAudit(store, day, option, opts) {
  const audit = dayAudit(store, day);
  if (!audit.picks.length) throw new Error(`no audit for ${day}`);
  const r = recordAudit(store, audit.picks, option, opts);
  audit.answered = { option, at: opts?.at ?? new Date().toISOString() };
  writeFileSync(auditFile(store, day), JSON.stringify(audit, null, 1));
  return r;
}

/** Classes with more than UNTESTED_WARN stand-in decisions since their last tested one. */
export function untestedRuns(rows, limit = UNTESTED_WARN) {
  const run = {};
  for (const r of rows) {
    if (!r.decisionClass) continue;
    if (tested(r)) run[r.decisionClass] = 0;
    else if (r.decidedBy === 'stand-in') run[r.decisionClass] = (run[r.decisionClass] ?? 0) + 1;
  }
  return Object.entries(run)
    .filter(([, n]) => n > limit)
    .map(([decisionClass, n]) => ({ decisionClass, untested: n }));
}

/** The digest's line while today's audit waits on the person, else null. */
export function auditLine(store, day) {
  const f = auditFile(store, day);
  if (!existsSync(f)) return null;
  const a = JSON.parse(readFileSync(f, 'utf8'));
  return a.answered || !a.picks.length ? null : `${a.picks.length} to check, about 1 minute`;
}
