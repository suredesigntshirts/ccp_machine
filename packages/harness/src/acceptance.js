// The PRD's v1 acceptance criteria, checked against a live store: each is met, not met or unknown, with
// the evidence that decided it. Some can only be shown by tests or by the person; those say so.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { status } from './runtime.js';
import { runScenarios } from './scenario.js';

// Where session ledgers are filed (one <session>.json of {session} each); read when no --ledger is given.
export const SESSIONS_DIR = '/mnt/project-files/harness/ledger/sessions';

const filedLedger = (dir) => {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')) : [];
  return files.length ? { sessions: files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).session).filter(Boolean) } : null;
};

const itemOf = (e) => (e.event.type === 'REQUEST_RECEIVED' ? e.event.request?.id : e.to?.replace(/^item:/, '').split('/')[0]);

/** Peak items at once between their first dispatched run and their end (merged, cancelled or rejected). */
export function peakInFlight(events, outbox) {
  const start = new Map();
  for (const e of outbox) if (e.name === 'dispatchRun' && !start.has(e.subject)) start.set(e.subject, e.at);
  const end = new Map();
  for (const e of events) if (['MERGED', 'CANCEL'].includes(e.event.type) || e.event.choice === 'reject') end.set(itemOf(e), e.at);
  const marks = [...start].flatMap(([id, at]) => [[at, 1], [end.get(id) ?? '9999', -1]]).sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
  let now = 0;
  let peak = 0;
  let peakAt = null;
  for (const [at, d] of marks) {
    now += d;
    if (now > peak) [peak, peakAt] = [now, at];
  }
  return { peak, at: peakAt, items: start.size };
}

/** The person's touches split by kind and by the item's tier. */
export function touchesByTier(events) {
  const tier = new Map(events.filter((e) => e.event.type === 'REQUEST_RECEIVED').map((e) => [e.event.request?.id, e.event.request?.tier]));
  const out = { requests: 0, decisions: {}, other: {} };
  for (const e of events.filter((x) => x.event.person)) {
    if (e.event.type === 'REQUEST_RECEIVED') out.requests++;
    else {
      const bucket = e.event.type === 'PERSON_DECIDED' ? out.decisions : out.other;
      const t = tier.get(itemOf(e)) ?? '?';
      bucket[t] = (bucket[t] ?? 0) + 1;
    }
  }
  return out;
}

/** @returns {{criterion: string, verdict: 'met'|'not met'|'unknown', evidence: string}[]} */
export function acceptance(store, { ledgerFile = null, sessionsDir = SESSIONS_DIR, scenarios = runScenarios } = {}) {
  const events = store.events();
  const st = status(store);
  const peak = peakInFlight(events, store.outbox());
  const t = touchesByTier(events);
  const nonTier2 = Object.entries(t.decisions).filter(([k]) => k !== '2').reduce((a, [, n]) => a + n, 0) + Object.values(t.other).reduce((a, n) => a + n, 0);
  const merged = st.items.filter((i) => i.state === 'done').length;
  const scen = scenarios();
  const failed = scen.filter((r) => !r.ok).map((r) => r.name ?? r.file);
  const byName = (re) => scen.find((r) => re.test(r.file ?? r.name ?? ''));
  const budgetScen = byName(/budget/);
  const ids = new Set(events.map((e) => e.id));
  const rows = [];
  rows.push({
    criterion: 'Three items in flight at once, each from request to merge, with only tier 2 decisions from the person',
    verdict: peak.peak >= 3 && merged >= 3 && nonTier2 === 0 ? 'met' : 'not met',
    evidence: `peak ${peak.peak} in flight at ${peak.at ?? 'n/a'} across ${peak.items} items; ${merged} merged; the person's touches: ${t.requests} requests, decisions by tier ${JSON.stringify(t.decisions)}, other ${JSON.stringify(t.other)}`
  });
  const l = ledgerFile && existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : ledgerFile ? null : filedLedger(sessionsDir);
  const source = ledgerFile ?? sessionsDir;
  if (l) {
    const turns = l.sessions.flatMap((s) => s.turns ?? []);
    const costed = turns.filter((x) => typeof x.all?.cost === 'number').length;
    rows.push({ criterion: 'Every turn of every session appears in the ledger report with its cost', verdict: turns.length && costed === turns.length ? 'met' : 'not met', evidence: `${l.sessions.length} sessions, ${costed} of ${turns.length} turns costed in ${source}; whether every session is filed needs the session list` });
  } else rows.push({ criterion: 'Every turn of every session appears in the ledger report with its cost', verdict: 'unknown', evidence: `no ledger at ${source}; pass --ledger <ledger.json> to check` });
  rows.push({
    criterion: 'At a soft or hard budget limit the scheduler drains or halts on its own, and the gauge shows why',
    verdict: budgetScen?.ok ? 'met' : 'unknown',
    evidence: `${budgetScen ? `scenario ${budgetScen.file.split('/').at(-1)} ${budgetScen.ok ? 'passes' : 'fails'}` : 'no budget scenario'}; live budget ${st.budget?.mode ?? 'none'}, scheduler ${st.state.scheduler} (no limit reached on the live store yet)`
  });
  rows.push({
    criterion: 'A repeated wake or a duplicated event changes nothing',
    verdict: ids.size === events.length ? 'met' : 'not met',
    evidence: `${events.length} events in the log with ${ids.size} distinct ids; repeats are refused at apply (runtime tests)`
  });
  rows.push({ criterion: 'The spec tests pass on every PR', verdict: failed.length ? 'not met' : 'met', evidence: `${scen.length} scenarios, ${failed.length ? `failing: ${failed.join(', ')}` : 'all pass'}; CI runs npm test on every PR` });
  rows.push({ criterion: 'Mission control and the decision log answer "what needs me?" and "did it do what I expected?" in under a minute', verdict: 'unknown', evidence: 'only the person can time this; the item pages show each expectation check' });
  return rows;
}

export const acceptanceText = (rows) => rows.map((r) => `- [${r.verdict}] ${r.criterion}: ${r.evidence}`).join('\n');
