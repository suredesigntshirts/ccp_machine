// harness replay: rebuilds the harness from its event log on a scratch copy and compares it with the
// store. A match shows the store is deterministic; a difference shows either a tampered store or a spec
// change that no longer reproduces the state already stored.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.js';
import { init, apply } from './runtime.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// The actor field can be an internal session id (x:0), so effects match on name, subject and params.
const effectKey = (e) => JSON.stringify([e.name, e.subject ?? null, e.params ?? null]);

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

/** @returns {{ok: boolean, events: number, firstDivergence: string|null, differences: string[], notes: string[]}} */
export function replay(store) {
  const state = store.read();
  if (!state) return { ok: false, events: 0, firstDivergence: null, differences: ['no state.json'], notes: [] };
  const dir = mkdtempSync(join(tmpdir(), 'harness-replay-'));
  try {
    const scratch = openStore(dir);
    init(scratch, { wipLimit: state.snapshot.context?.wipLimit }, store.events()[0]?.at);
    const outbox = new Map();
    for (const e of store.outbox()) outbox.set(e.eventId, [...(outbox.get(e.eventId) ?? []), effectKey(e)]);
    let firstDivergence = null;
    const events = store.events();
    for (const e of events) {
      let effects;
      try {
        ({ effects } = apply(scratch, e.event, { to: e.to === 'harness' ? undefined : e.to, id: e.id, now: e.at }));
      } catch (err) {
        firstDivergence ??= `${e.id}: ${err.message}`;
        continue;
      }
      if (!firstDivergence && !same(effects.map(effectKey), outbox.get(e.id) ?? [])) firstDivergence = `${e.id} (${e.event.type}): effects differ`;
    }
    const { differences, notes } = compare(state.snapshot, scratch.read().snapshot);
    return { ok: !firstDivergence && differences.length === 0, events: events.length, firstDivergence, differences, notes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
