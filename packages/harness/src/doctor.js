// harness doctor: checks that a store is sound before a wake writes to it. Each problem names what is
// wrong and where, so the orchestrator can stop and report instead of building on a broken store.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tryRestore } from './runtime.js';

const DAY_MS = 24 * 3600 * 1000;
const STALE_LOCK_MS = 60_000;

/** @returns {{ok: boolean, problems: string[], checked: object}} */
export function doctor(store, { now = Date.now(), pendingMaxMs = DAY_MS } = {}) {
  const problems = [];
  const events = store.events();
  // The first event is version 2 (init writes version 1 with no event).
  events.forEach((e, i) => {
    const want = i ? events[i - 1].version + 1 : e.version;
    if (e.version !== want) problems.push(`event ${e.id}: version ${e.version}, expected ${want}`);
  });
  const state = store.read();
  if (state && events.length && state.version !== events.at(-1).version)
    problems.push(`state.json is version ${state.version}, the last event is ${events.at(-1).version}`);
  const outbox = store.outbox();
  const known = new Set(outbox.map((e) => e.id));
  for (const a of store.acks()) if (!known.has(a.effectId)) problems.push(`ack names unknown effect ${a.effectId}`);
  for (const e of store.pending())
    if (now - Date.parse(e.at) > pendingMaxMs) problems.push(`effect ${e.id} (${e.name}) pending since ${e.at}`);
  const lock = join(store.dir, 'lock');
  if (existsSync(lock) && now - statSync(lock).mtimeMs > STALE_LOCK_MS) problems.push(`lock is older than ${STALE_LOCK_MS / 1000}s`);
  const { error } = tryRestore(store);
  if (error) problems.push(`state.json does not restore: ${error}`);
  return { ok: problems.length === 0, problems, checked: { events: events.length, effects: outbox.length, version: state?.version ?? null } };
}
