// harness doctor: checks that a store is sound before a wake writes to it. Each problem names what is
// wrong and where, so the orchestrator can stop and report instead of building on a broken store; what
// cannot be checked yet (GitHub unreachable, a ledger not filed yet for a session that has just acted) is
// unverifiable, listed but not a problem.
import { existsSync, statSync } from 'node:fs';
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
 * The store's own checks, then (unless verify is false) verify-actors against the ledgers in `ledgers`,
 * verify-facts with `fetcher`, and every merged PR of an item against its verifier's PASS (gates.js verifyMerges).
 * `refreshes` (the rows of a page's refresh collection, as ArtifactData gives them) adds a warning per refresh
 * slower than the spec's threshold (meta.pages.refreshSlowMs). Problems make the store unsafe to build on (`ok` false); unverifiable and warnings
 * (an untested class) leave `ok` true.
 * @returns {Promise<{ok: boolean, problems: string[], unverifiable: string[], warnings: string[], checked: object}>}
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
  const lock = join(store.dir, 'lock');
  if (existsSync(lock) && now - statSync(lock).mtimeMs > STALE_LOCK_MS) problems.push(`lock is older than ${STALE_LOCK_MS / 1000}s (fix with harness repair)`);
  const { error } = tryRestore(store);
  if (error) problems.push(`state.json does not restore: ${error}`);
  if (!error) {
    const r = replay(store);
    if (r.firstDivergence) problems.push(`replay diverges at ${r.firstDivergence}`);
    for (const d of r.differences) problems.push(`replay: ${d}`);
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
  // A merged PR of an item needs the verifier's PASS on its merge head, in the store and as a review on GitHub.
  const merges = verify ? await verifyMerges(store, fetcher ? { fetcher } : {}) : [];
  for (const r of merges.filter((r) => r.result !== 'ok')) (r.result === 'unreachable' ? unverifiable : problems).push(`merges: ${verifyMergesText([r])}`);
  return { ok: problems.length === 0, problems, unverifiable, warnings, checked: { events: events.length, effects: outbox.length, version: state?.version ?? null, actors: actors.length, facts: facts.length, merges: merges.length } };
}
