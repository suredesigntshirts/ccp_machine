// The stand-in audit. Every gate the stand-in decides alone agrees with itself, so a class nobody checks
// never gets tested and its ladder never moves. Once a day the person checks up to 3 of those decisions
// on one card: one tap confirms all of them, or reverses one. It runs through the machine (spec audit):
// AUDIT_PICKED opens it and asks for the card, the ack names the card, and the answer is the person's tap,
// AUDIT_ANSWERED, which the decision log reads as the person's decisions against the stand-in's lean.
import { apply, status } from './runtime.js';
import { readDecisionLog, reverseOf } from './decision-log.js';

export const AUDIT_MAX = 3;
// Past this many untested stand-in decisions in a row, doctor says the class needs an audit.
export const UNTESTED_WARN = 20;

const tested = (r) => r.decidedBy === 'person' && r.standIn?.choice && r.choice;
export { reverseOf };

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

/**
 * Open the day's audit once, sent `by` the session that picks ({actor, source}): AUDIT_PICKED with up to `max`
 * picks, which queues postAuditCard. A day already picked returns that audit; no picks, nothing is sent.
 * @returns {{day: string, address: string, picks: string[], effect: string|null}}
 */
export function pickAudit(store, day, { by, now, max } = {}) {
  const address = `audit:${day}`;
  const effect = () => store.outbox().find((e) => e.name === 'postAuditCard' && e.subject === address)?.id ?? null;
  const prior = store.events().find((e) => e.event.type === 'AUDIT_PICKED' && e.event.day === day);
  if (prior) return { day, address, picks: prior.event.picks, effect: effect() };
  const picks = auditPicks(readDecisionLog(store), { max }).map((r) => r.effectId);
  if (!picks.length) return { day, address, picks, effect: null };
  const r = apply(store, { type: 'AUDIT_PICKED', day, picks, ...by }, { id: `audit-${day}`, now });
  if (r.refused) throw new Error(r.why);
  return { day, address, picks, effect: effect() };
}

/** Every audit waiting on the person, oldest first, its picks read from the decision log: mission control lists them under Needs you. */
export function openAudits(store) {
  const rows = new Map(readDecisionLog(store).map((r) => [r.effectId, r]));
  return (status(store)?.audits ?? [])
    .filter((a) => a.state === 'awaitingPerson')
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((a) => ({ ...a, picks: a.picks.map((id) => rows.get(id) ?? { effectId: id }) }));
}

/** request_decision arguments for a postAuditCard effect, and the address its tap goes to. */
export function auditCardFor(store, effect) {
  const rows = new Map(readDecisionLog(store).map((r) => [r.effectId, r]));
  return { address: effect.subject, ...auditCard((effect.detail?.picks ?? []).map((id) => rows.get(id) ?? { effectId: id, standIn: {} })) };
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

/** The digest's line while the day's audit waits on the person, else null. */
export function auditLine(store, day) {
  const a = openAudits(store).find((x) => x.day === day);
  return a ? `${a.picks.length} to check, about 1 minute` : null;
}
