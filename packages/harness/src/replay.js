// harness replay: rebuilds the harness from its event log on a scratch copy and compares it with the
// store. Each logged event is a fact: it was admitted when it was sent, by the rules of the release that wrote it, so
// it is applied again without its admission rules, by the route its log row recorded, or for a row from before routes
// were recorded, by the route its logged effects took (runtime apply, fact; harness meta.store.facts). A match shows the
// store is deterministic; a difference shows a tampered store, a lost event, or a state change no route reproduces. An
// event's closes (harness meta.store.closes) are compared with the withdrawn acks the log holds for it, with the host's
// own acks put on the scratch copy in time order so the same effects are pending. An event today's rules would refuse,
// route otherwise or close more for is listed (admittedThen), with the release that wrote it: not a problem.
// A row of an era an ERA_ENDED row ends is not applied: that row brings the era's own record of its state (meta.store.eras).
// With {steps: true} it also returns what each row did on the way (history.schema.json steps): the actors whose state
// it changed and the context fields it changed (the scratch copy before and after the row), the effects it queued with
// their detail and the store's acks for them, and its route; a row it cannot apply is a step with the reason it was refused.
// With {listed} ("<id>: <reason>" lines, as the join's report.json lists the rows it refused), a row refused for its
// listed reason is known, not a divergence (meta.store.facts): it is returned in known.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.js';
import { init, apply, writerError } from './runtime.js';
import { valueText } from './live.js';
import { specs } from './machines.js';

const ERAS = specs.harness.meta.store.eras;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// The actor field can be an internal session id (x:0), so effects match on name, subject and params.
export const effectKey = (e) => JSON.stringify([e.name, e.subject ?? null, e.params ?? null]);

/**
 * The rows replay does not apply, each with its era (harness meta.store.eras): a row of a store whose era an ERA_ENDED
 * row ends, and a row from elsewhere addressed to an item the first ERA_ENDED row after it holds.
 * @returns {Map<object, string>} row -> era
 */
export function eraFacts(rows) {
  const marks = rows.filter((r) => r.event?.type === ERAS.event);
  const ended = new Set(marks.map((m) => m.event.era));
  const out = new Map();
  for (const r of marks.length ? rows : []) {
    if (r.event?.type === ERAS.event) continue;
    const from = r.provenance?.from;
    const item = /^item:([^/]+)/.exec(r.to ?? '')?.[1];
    const era = from?.source === 'store' && ended.has(from.ref) ? from.ref : item && marks.find((m) => m.version > r.version && m.event.snapshot?.children?.[item])?.event.era;
    if (era) out.set(r, era);
  }
  return out;
}

/** Compare two persisted snapshots: state values, each child's state value, and shared context keys. */
function compare(stored, rebuilt, path = 'harness', out = { differences: [], notes: [] }) {
  if (!same(stored.value, rebuilt.value)) out.differences.push(`${path}: state ${JSON.stringify(stored.value)} stored, ${JSON.stringify(rebuilt.value)} rebuilt`);
  const keys = new Set([...Object.keys(stored.context ?? {}), ...Object.keys(rebuilt.context ?? {})]);
  for (const k of keys) {
    const inS = k in (stored.context ?? {});
    const inR = k in (rebuilt.context ?? {});
    if (inS !== inR) out.notes.push(`${path}: context.${k} only ${inS ? 'stored' : 'rebuilt'} (the spec changed)`);
    else if (!same(stored.context[k], rebuilt.context[k])) out.differences.push(`${path}: context.${k} differs`);
  }
  const children = new Set([...Object.keys(stored.children ?? {}), ...Object.keys(rebuilt.children ?? {})]);
  for (const c of children) {
    const s = stored.children?.[c]?.snapshot;
    const r = rebuilt.children?.[c]?.snapshot;
    if (!s || !r) out.differences.push(`${path}/${c}: only ${s ? 'stored' : 'rebuilt'}`);
    else compare(s, r, `${path}/${c}`, out);
  }
  return out;
}

// Every actor in a snapshot by address (harness, item:<id>, item:<id>/<child id>), with its state as text and its context.
function actorsOf(snap, address = 'harness', out = {}) {
  out[address] = { state: valueText(snap.value), context: snap.context ?? {} };
  for (const [key, c] of Object.entries(snap.children ?? {}))
    if (c?.snapshot) actorsOf(c.snapshot, address === 'harness' ? c.systemId ?? key : `${address}/${key}`, out);
  return out;
}

/** What one row changed: the actors whose state changed and the context fields that changed, each before and after (null: absent). */
export function changes(before, after) {
  const b = actorsOf(before);
  const a = actorsOf(after);
  const actors = [];
  const context = [];
  for (const address of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (b[address]?.state !== a[address]?.state) actors.push({ address, before: b[address]?.state ?? null, after: a[address]?.state ?? null });
    const was = b[address]?.context ?? {};
    const is = a[address]?.context ?? {};
    for (const field of new Set([...Object.keys(was), ...Object.keys(is)]))
      if (!same(was[field], is[field])) context.push({ address, field, before: was[field] ?? null, after: is[field] ?? null });
  }
  return { actors, context };
}

/** @returns {{ok: boolean, events: number, firstDivergence: string|null, differences: string[], notes: string[], admittedThen: object[], known: string[], rebuilt: object, steps?: object[]}} rebuilt is the scratch state.json */
export function replay(store, { steps: withSteps = false, listed = [] } = {}) {
  const state = store.read();
  if (!state) return { ok: false, events: 0, firstDivergence: null, differences: ['no state.json'], notes: [], admittedThen: [] };
  const dir = mkdtempSync(join(tmpdir(), 'harness-replay-'));
  try {
    const scratch = openStore(dir);
    init(scratch, { wipLimit: state.snapshot.context?.wipLimitAtInit ?? state.snapshot.context?.wipLimit }, store.events()[0]?.at);
    const outbox = new Map();
    for (const e of store.outbox()) outbox.set(e.eventId, [...(outbox.get(e.eventId) ?? []), effectKey(e)]);
    let firstDivergence = null;
    const notes = [];
    const admittedThen = [];
    const known = [];
    const isListed = new Set(listed);
    const events = store.events();
    // The host's acks, oldest first, go on the scratch copy as the log reached them; the withdrawn ones are the closes
    // replay writes itself, by the event that closed them ("<subject> withdrawn by <event id>").
    const acks = store.acks();
    const hostAcks = acks.filter((a) => a.outcome !== 'withdrawn').sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
    const closedBy = (id) => acks.filter((a) => a.outcome === 'withdrawn' && String(a.note ?? '').endsWith(` withdrawn by ${id}`)).map((a) => a.effectId).sort();
    let fed = 0;
    const steps = [];
    const acksOf = (id) => acks.filter((a) => a.effectId === id).map(({ outcome, at, note }) => ({ outcome, at: at ?? null, note: note ?? null }));
    let before = withSteps && scratch.read().snapshot;
    // A row it applied is a step from the scratch copy before it to the copy after; one it could not apply is refused.
    const record = (e, r, err) => {
      // An id applied already (two sources can share one) is applied once: replay passes over the later row.
      const twice = r?.duplicate && `replay applies one event per id, and row ${steps.find((s) => s.id === e.id && !s.era)?.version ?? '?'} applied ${e.id} already`;
      if (!r || twice) return steps.push({ version: e.version, id: e.id, era: null, refused: twice || err.message, route: null, actors: [], context: [], effects: [] });
      const after = scratch.read().snapshot;
      steps.push({ version: e.version, id: e.id, era: null, refused: null, route: r.route, ...changes(before, after), effects: r.effects.map((fx) => ({ id: fx.id, name: fx.name, subject: fx.subject ?? null, detail: fx.detail ?? null, acks: acksOf(fx.id) })) });
      before = after;
    };
    // A row of an era is a fact its era's record holds (harness meta.store.eras): not applied, not re-judged.
    const eras = eraFacts(events);
    // The newest release the rows so far name, per source (a history joins stores, each with its own writers): a row by
    // an older one is one writerNotOlder would refuse, by a release from before that rule or past it (harness meta.invariants).
    const newest = new Map();
    for (const e of events) {
      if (eras.has(e)) {
        if (withSteps) steps.push({ version: e.version, id: e.id, era: eras.get(e), refused: null, route: null, actors: [], context: [], effects: [] });
        continue;
      }
      let effects;
      let r = null;
      const upTo = hostAcks.slice(fed).findIndex((a) => String(a.at ?? '') > e.at);
      const next = upTo < 0 ? hostAcks.length : fed + upTo;
      scratch.withLock(() => scratch.appendAcks(hostAcks.slice(fed, next))); // every writer holds the lock (oneWriter), the scratch copy too
      fed = next;
      const from = JSON.stringify(e.provenance?.from ?? null);
      const older = e.harness && 'version' in e.harness && writerError(newest.get(from), e.harness);
      if (e.harness && 'version' in e.harness && !older) newest.set(from, e.harness);
      try {
        // The row's release goes with it; a payload that names one (a row from before harness meta.invariants envelope) keeps it.
        const sent = { harness: e.harness, ...e.event, actor: e.actor, source: e.source, ...(e.relayedBy && { relayedBy: e.relayedBy }) };
        const at = { to: e.to === 'harness' ? undefined : e.to, id: e.id, now: e.at };
        // Today's rules, asked without writing: a refusal now of an event admitted then is a rule that changed.
        const today = e.event.type === ERAS.event ? {} : apply(scratch, sent, { ...at, dryRun: true });
        const logged = JSON.stringify(outbox.get(e.id) ?? []);
        // A row records its route; one written before routes were recorded is matched to its logged effects.
        r = apply(scratch, sent, { ...at, fact: e.route ? { route: e.route } : { matches: (fx) => JSON.stringify(fx.map(effectKey)) === logged } });
        // Its closes are the ones the log holds. A row written before routes were recorded may close fewer, by a release
        // that closed less; a logged close today's rules do not give, or any difference on a routed row, is a divergence.
        const logClosed = closedBy(e.id);
        const closed = [...(r.closed ?? [])].sort();
        const closesDiffer = !same(closed, logClosed);
        if (closesDiffer && (e.route || logClosed.some((x) => !closed.includes(x))))
          throw new Error(`closes differ: the log holds ${logClosed.join(', ') || 'none'}, replay gives ${closed.join(', ') || 'none'}`);
        // Today's rules would refuse it, route it otherwise or close more: it was admitted, and applied as logged, by the release that wrote it.
        const whys = [
          today.why,
          older,
          r.rerouted && `routed otherwise today (${e.route ? '' : 'no route logged, found by its effects: '}${r.rerouted})`,
          closesDiffer && `closes more today (${closed.filter((x) => !logClosed.includes(x)).join(', ')}; the log closes ${logClosed.join(', ') || 'none'})`
        ].filter(Boolean);
        if (whys.length) admittedThen.push({ id: e.id, type: e.event.type, release: e.harness ?? null, why: whys.join('; ') });
        ({ effects } = r);
      } catch (err) {
        if (isListed.has(`${e.id}: ${err.message}`)) known.push(`${e.id}: ${err.message}`);
        else firstDivergence ??= `${e.id}: ${err.message}`;
        if (withSteps) record(e, r, err);
        continue;
      }
      if (withSteps) record(e, r);
      if (!firstDivergence && !same(effects.map(effectKey), outbox.get(e.id) ?? [])) firstDivergence = `${e.id} (${e.event.type}): effects differ`;
    }
    const rebuilt = scratch.read();
    const { differences } = compare(state.snapshot, rebuilt.snapshot, 'harness', { differences: [], notes });
    return { ok: !firstDivergence && differences.length === 0, events: events.length, firstDivergence, differences, notes, admittedThen, known, rebuilt, ...(withSteps && { steps }) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
