// harness replay: rebuilds the harness from its event log on a scratch copy and compares it with the
// store. Each logged event is a fact: it was admitted when it was sent, by the rules of the release that wrote it, so
// it is applied again without its admission rules, by the route its log row recorded, or for a row from before routes
// were recorded, by the route its logged effects took (runtime apply, fact; harness meta.store.facts). A match shows the
// store is deterministic; a difference shows a tampered store, a lost event, or a state change no route reproduces. An event today's rules would refuse or route otherwise is listed (admittedThen),
// with the release that wrote it: not a problem.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.js';
import { init, apply } from './runtime.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// The actor field can be an internal session id (x:0), so effects match on name, subject and params.
export const effectKey = (e) => JSON.stringify([e.name, e.subject ?? null, e.params ?? null]);

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

/** @returns {{ok: boolean, events: number, firstDivergence: string|null, differences: string[], notes: string[], admittedThen: object[], rebuilt: object}} rebuilt is the scratch state.json */
export function replay(store) {
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
    const events = store.events();
    for (const e of events) {
      let effects;
      try {
        const sent = { ...e.event, actor: e.actor, source: e.source, ...(e.relayedBy && { relayedBy: e.relayedBy }) };
        const at = { to: e.to === 'harness' ? undefined : e.to, id: e.id, now: e.at };
        // Today's rules, asked without writing: a refusal now of an event admitted then is a rule that changed.
        const today = apply(scratch, sent, { ...at, dryRun: true });
        const logged = JSON.stringify(outbox.get(e.id) ?? []);
        // A row records its route; one written before routes were recorded is matched to its logged effects.
        const r = apply(scratch, sent, { ...at, fact: e.route ? { route: e.route } : { matches: (fx) => JSON.stringify(fx.map(effectKey)) === logged } });
        // Today's rules would refuse it, or route it otherwise: it was admitted, and routed as logged, by the release that wrote it.
        if (today.refused || r.rerouted) admittedThen.push({ id: e.id, type: e.event.type, release: e.harness ?? null, why: today.why ?? `routed otherwise today (${e.route ? '' : 'no route logged, found by its effects: '}${r.rerouted})` });
        ({ effects } = r);
      } catch (err) {
        firstDivergence ??= `${e.id}: ${err.message}`;
        continue;
      }
      if (!firstDivergence && !same(effects.map(effectKey), outbox.get(e.id) ?? [])) firstDivergence = `${e.id} (${e.event.type}): effects differ`;
    }
    const rebuilt = scratch.read();
    const { differences } = compare(state.snapshot, rebuilt.snapshot, 'harness', { differences: [], notes });
    return { ok: !firstDivergence && differences.length === 0, events: events.length, firstDivergence, differences, notes, admittedThen, rebuilt };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
