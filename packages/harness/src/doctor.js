// harness doctor: checks that a store is sound before a wake writes to it. Each problem names what is
// wrong and where, so the orchestrator can stop and report instead of building on a broken store; what
// cannot be checked yet (GitHub unreachable, a ledger not filed yet for a session that has just acted) is
// unverifiable, listed but not a problem.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tryRestore } from './runtime.js';
import { replay } from './replay.js';
import { readDecisionLog } from './decision-log.js';
import { untestedRuns, UNTESTED_WARN } from './audit.js';
import { verifyActors, verifyActorsText } from './verify-actors.js';
import { verifyFacts, verifyFactsText } from './verify-facts.js';
import { verifyMerges, verifyMergesText } from './gates.js';
import { slowRefreshes, slowRefreshText } from './pages.js';
import { specs } from './machines.js';
import { outOfBand, validate, placeholders } from './history.js';
import { prKey } from './pr-binding.js';

const DAY_MS = 24 * 3600 * 1000;
const STALE_LOCK_MS = 60_000;
// The Stop hook files a session's ledger after its turn: until then, its missing ledger is not yet a problem.
const LEDGER_GRACE_MS = 10 * 60_000;

// Every actor in the snapshot that sits in a state whose spec names meta.waitsOn, with no pending effect of that
// name for it (subject: its context.id): an actor waiting on an ask nobody holds.
function waitingOnNothing(snapshot, pending, src = 'harness', path = []) {
  const at = [];
  const visit = (node, value, names) => {
    for (const [k, v] of typeof value === 'string' ? [[value, null]] : Object.entries(value ?? {})) {
      const child = node?.states?.[k];
      if (child?.meta?.waitsOn && !pending.some((e) => e.name === child.meta.waitsOn && e.subject === snapshot.context?.id))
        at.push(`${path.join('/') || 'harness'} is in ${[...names, k].join('.')} with no pending ${child.meta.waitsOn} effect (meta.waitsOn)`);
      if (v) visit(child, v, [...names, k]);
    }
  };
  if (snapshot.status === 'active') visit(specs[src], snapshot.value, []);
  for (const [key, c] of Object.entries(snapshot.children ?? {})) if (c?.snapshot) at.push(...waitingOnNothing(c.snapshot, pending, c.src, [...path, c.systemId ?? key]));
  return at;
}

/**
 * The store's own checks (for a history, its rows against history.schema.json, with its placeholder counts and the rows its
 * join's report lists refused, by reason class: history), then (unless verify is false) verify-actors against the ledgers in `ledgers`,
 * verify-facts with `fetcher`, and every PR landed on main, bound or not, against its verifier's PASS (gates.js verifyMerges).
 * `refreshes` (the rows of a page's refresh collection, as ArtifactData gives them) adds a warning per refresh
 * slower than the spec's threshold (meta.pages.refreshSlowMs). Problems make the store unsafe to build on (`ok` false); unverifiable, warnings
 * (an untested class) and admittedThen (events the rules have changed for since they were written) leave `ok` true.
 * @returns {Promise<{ok: boolean, problems: string[], unverifiable: string[], warnings: string[], history?: {rows: number, schemaErrors: string[], placeholders: object}, checked: object}>}
 */
export async function doctor(store, { now = Date.now(), pendingMaxMs = DAY_MS, ledgers, fetcher, verify = true, refreshes } = {}) {
  const problems = [];
  const events = store.events();
  // The first event is version 2 (init writes version 1 with no event).
  events.forEach((e, i) => {
    const want = i ? events[i - 1].version + 1 : e.version;
    if (e.version !== want) problems.push(`event ${e.id}: version ${e.version}, expected ${want}`);
  });
  const state = store.read();
  if (state && events.length && state.version !== events.at(-1).version)
    problems.push(
      `state.json is version ${state.version}, the last event is ${events.at(-1).version}` +
        (state.version > events.at(-1).version ? ' (a write stopped before the log: fix with harness repair --rebuild, then resend the event)' : '')
    );
  for (const u of store.unreadable())
    problems.push(`${u.file} line ${u.line} is not JSON${u.last ? ' (a torn last write: fix with harness repair)' : ' (not the last line: repair by hand)'}`);
  const outbox = store.outbox();
  const known = new Set(outbox.map((e) => e.id));
  for (const a of store.acks()) if (!known.has(a.effectId)) problems.push(`ack names unknown effect ${a.effectId}`);
  if (state?.snapshot) problems.push(...waitingOnNothing(state.snapshot, store.pending()));
  for (const e of store.pending())
    if (now - Date.parse(e.at) > pendingMaxMs) problems.push(`effect ${e.id} (${e.name}) pending since ${e.at}`);
  // A history (its rows carry provenance: history.schema.json, as scripts/history/join.mjs writes it): every row held
  // to the schema, each error a problem, and its legacy placeholders counted by era and field.
  const history = events.some((e) => e.provenance) ? { rows: events.length, schemaErrors: events.flatMap(validate), placeholders: placeholders(events), refused: {} } : null;
  // The rows the join could not apply, as its report lists them ("<id>: <reason>"): known, not a divergence (harness meta.store.facts).
  const report = join(store.dir, 'report.json');
  const listed = history && existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')).refused ?? [] : [];
  if (history) problems.push(...history.schemaErrors.map((e) => `schema: ${e}`));
  const lock = join(store.dir, 'lock');
  if (existsSync(lock) && now - statSync(lock).mtimeMs > STALE_LOCK_MS) problems.push(`lock is older than ${STALE_LOCK_MS / 1000}s (fix with harness repair)`);
  const { error } = tryRestore(store);
  if (error) problems.push(`state.json does not restore: ${error}`);
  // An event today's rules would refuse or route otherwise was admitted by the release that wrote it: listed, not a
  // problem (harness meta.store.facts). A divergence or a different state is: the store is corrupt or lost an event.
  let admittedThen = [];
  if (!error) {
    const r = replay(store, { listed });
    if (r.firstDivergence) problems.push(`replay diverges at ${r.firstDivergence}`);
    for (const k of r.known) {
      const reason = k.slice(k.indexOf(': ') + 2).replace(/"[^"]*"/g, '"…"');
      history.refused[reason] = (history.refused[reason] ?? 0) + 1;
    }
    for (const d of r.differences) problems.push(`replay: ${d}`);
    admittedThen = r.admittedThen.map((a) => `${a.id} (${a.type}): admitted when written by harness ${a.release?.version ?? 'unknown'}${a.release?.commit ? `@${a.release.commit.slice(0, 7)}` : ''}; today's rules: ${a.why}`);
  }
  const warnings = [
    ...untestedRuns(readDecisionLog(store)).map(
      (w) => `${w.decisionClass}: ${w.untested} stand-in decisions in a row with none checked by the person (over ${UNTESTED_WARN}); run harness audit`
    ),
    ...(refreshes ? slowRefreshes(refreshes).map((r) => slowRefreshText(r)) : [])
  ];
  const unverifiable = [];
  const actors = verify ? verifyActors(store, ledgers ? { dir: ledgers } : {}) : [];
  const facts = verify ? await verifyFacts(store, fetcher ? { fetcher } : {}) : [];
  const lastAt = Object.fromEntries(events.filter((e) => e.actor?.kind === 'session' || e.actor?.kind === 'agent').map((e) => [e.actor.id, Date.parse(e.at)]));
  for (const r of actors.filter((r) => r.result !== 'ok'))
    (['no ledger', 'no record'].includes(r.result) && /^no /.test(r.why) && now - lastAt[r.id] < LEDGER_GRACE_MS ? unverifiable : problems).push(`verify-actors: ${verifyActorsText([r])}`);
  for (const r of facts.filter((r) => r.result !== 'ok')) (r.result === 'unreachable' ? unverifiable : problems).push(`verify-facts: ${verifyFactsText([r])}`);
  // A PR landed on main, bound or not, needs the verifier's PASS on its landed head, in the store and as a review on GitHub.
  const merges = verify ? await verifyMerges(store, fetcher ? { fetcher } : {}) : [];
  for (const r of merges.filter((r) => !['ok', 'outOfBand', 'era'].includes(r.result))) (r.result === 'unreachable' ? unverifiable : problems).push(`merges: ${verifyMergesText([r])}`);
  // A landing before its era's end was judged by that era's rules (harness meta.invariants reviewOnHead): one line per era.
  const byEra = Map.groupBy(merges.filter((r) => r.result === 'era'), (r) => r.era);
  for (const [era, rows] of [...byEra].sort(([, a], [, b]) => a[0].ended.localeCompare(b[0].ended)))
    admittedThen.push(`era ${era}: ${rows.length} landing${rows.length === 1 ? '' : 's'} before its ERA_ENDED (${rows[0].ended}), judged by that era's rules; today's rule finds no verifier PASS: ${rows.map((r) => r.pr).join(', ')}`);
  // Work done outside the gates (history.schema.json OUT_OF_BAND): listed, never a problem by itself.
  const outOfBandRows = outOfBand(events).map(
    (o) => `${o.id}: ${o.what} (${[o.pr && prKey(o.pr), o.to, o.sha && `at ${o.sha.slice(0, 7)}`].filter(Boolean).join(' ')}), ordered by ${o.orderedBy.kind}:${o.orderedBy.id}, skipped ${o.skipped.join(', ')}`
  );
  return { ok: problems.length === 0, problems, unverifiable, warnings, outOfBand: outOfBandRows, admittedThen, ...(history && { history }), checked: { events: events.length, effects: outbox.length, version: state?.version ?? null, actors: actors.length, facts: facts.length, merges: merges.length } };
}
