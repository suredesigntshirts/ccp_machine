// The stand-in audit. Every gate the stand-in decides alone agrees with itself, so a class nobody checks
// never gets tested and its ladder never moves. Once a day the person checks up to 3 of those decisions
// on one card: one tap confirms all of them, or reverses one. It runs through the machine (spec audit):
// AUDIT_PICKED opens it and asks for the card, the ack names the card, and the answer is the person's tap,
// AUDIT_ANSWERED, which the decision log reads as the person's decisions against the stand-in's lean.
import { apply, status } from './runtime.js';
import { readDecisionLog, reverseOf, grantDecisions } from './decision-log.js';

export const AUDIT_MAX = 3;
// Past this many untested stand-in decisions in a row, doctor says the class needs an audit.
export const UNTESTED_WARN = 20;

const tested = (r) => r.decidedBy === 'person' && r.standIn?.choice && r.choice;
export { reverseOf };

/**
 * Up to `max` stand-in decisions the person has not checked: decisions made under the person's grant first, then
 * classes with the fewest tested decisions, then the lowest confidence, then the oldest; one per class before any class gets a second.
 */
export function auditPicks(rows, { max = AUDIT_MAX } = {}) {
  const done = new Set(rows.filter((r) => r.audit).map((r) => r.audited));
  const testedIn = {};
  for (const r of rows) if (tested(r)) testedIn[r.decisionClass] = (testedIn[r.decisionClass] ?? 0) + 1;
  const candidates = rows
    .filter((r) => r.decidedBy === 'stand-in' && r.standIn?.choice && r.choice && !done.has(r.effectId))
    .sort(
      (a, b) =>
        (b.authority === 'grant') - (a.authority === 'grant') ||
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

/** request_decision arguments: option 0 confirms every pick, option i (1..n) reverses pick i. The context also lists
 * every decision made under the person's grant since the last audit (granted), each with its reason. */
export function auditCard(picks, granted = []) {
  const n = picks.length;
  const listed = grantedText(granted);
  const line = (r, i) => `#${i + 1} ${r.item} ${r.decisionClass}: ${r.choice} (${Math.round((r.standIn.confidence ?? 0) * 100)}% sure${r.standIn.reason ? `: ${r.standIn.reason}` : ''})`;
  return {
    question: `Did the stand-in call these ${n} right?`,
    context: [`The stand-in decided these alone. Your answer teaches it your taste.\n${picks.map(line).join('\n')}`.slice(0, Math.max(0, 1200 - (listed ? listed.length + 1 : 0))), listed].filter(Boolean).join('\n'),
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

// Every grant decision, one short line each: the item, class, choice and as much of the reason as fits the card.
function grantedText(granted, room = 1000) {
  if (!granted.length) return '';
  const head = `Under your grant (${granted.length}; reverse any on mission control):`;
  const each = Math.max(0, Math.floor((room - head.length) / granted.length) - 1);
  const rows = granted.map((r) => { const base = `${r.item} ${r.decisionClass}: ${r.choice}`; const why = r.standIn?.reason ?? ''; return (why ? `${base} - ${why}` : base).slice(0, Math.max(base.length, each)); });
  // Past ~40 in one day even the bare lines overflow the card: the rest are named by count, all on mission control.
  while (rows.length > 1 && [head, ...rows].join('\n').length > room) rows.pop();
  const more = granted.length - rows.length;
  return [head, ...rows, ...(more ? [`and ${more} more, listed on mission control`] : [])].join('\n');
}

/** The grant decisions an audit lists: made after the previous audit was picked and at or before this one. */
const grantedFor = (store, rows, day) => {
  const picked = store.events().filter((e) => e.event.type === 'AUDIT_PICKED').sort((a, b) => a.at.localeCompare(b.at));
  const i = picked.findIndex((e) => e.event.day === day);
  const [from, to] = i < 0 ? [picked.at(-1)?.at ?? '', '\uffff'] : [picked[i - 1]?.at ?? '', picked[i].at];
  return grantDecisions(rows).filter((r) => r.at > from && r.at <= to);
};

/**
 * Open today's audit (the UTC day of `now`) once, sent `by` the session that picks ({actor, source}): AUDIT_PICKED with up to `max`
 * picks, which queues postAuditCard. A day already picked returns that audit; no picks, nothing is sent.
 * @returns {{day: string, address: string, picks: string[], effect: string|null}}
 */
export function pickAudit(store, { by, now = new Date().toISOString(), max } = {}) {
  const day = now.slice(0, 10);
  const address = `audit:${day}`;
  const effect = () => store.outbox().find((e) => e.name === 'postAuditCard' && e.subject === address)?.id ?? null;
  const prior = store.events().find((e) => e.event.type === 'AUDIT_PICKED' && e.event.day === day);
  const rows = readDecisionLog(store);
  if (prior) return { day, address, picks: prior.event.picks, granted: grantedFor(store, rows, day), effect: effect() };
  const picks = auditPicks(rows, { max }).map((r) => r.effectId);
  if (!picks.length) return { day, address, picks, granted: [], effect: null };
  const r = apply(store, { type: 'AUDIT_PICKED', day, picks, ...by }, { id: `audit-${day}`, now });
  if (r.refused) throw new Error(r.why);
  return { day, address, picks, granted: grantedFor(store, rows, day), effect: effect() };
}

/** Every audit waiting on the person, oldest first, its picks read from one map of the decision log and its card's
 * request_decision arguments (`ask`): mission control lists them under Needs you, auditCardFor prints one. */
export function openAudits(store) {
  const log = readDecisionLog(store);
  const rows = new Map(log.map((r) => [r.effectId, r]));
  return (status(store)?.audits ?? []).filter((a) => a.state === 'awaitingPerson').sort((a, b) => a.day.localeCompare(b.day))
    .map((a) => ({ ...a, picks: a.picks.map((id) => rows.get(id) ?? { effectId: id, standIn: {} }), granted: grantedFor(store, log, a.day) })).map((a) => ({ ...a, ask: auditCard(a.picks, a.granted) }));
}

/** request_decision arguments for an open audit's postAuditCard effect, and the address its tap goes to. */
export const auditCardFor = (store, effect) => ({ address: effect.subject, ...openAudits(store).find((a) => a.address === effect.subject)?.ask });

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
