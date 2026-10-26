// harness repair: fixes only what is safe to fix without a person. A torn last line of a log is a write
// that never finished, so dropping it loses nothing that was acknowledged; a stale lock belongs to a
// writer that is gone. With rebuild, a state.json ahead of its log (a crash after the snapshot, before
// the log) is rebuilt from events.jsonl, which drops the unlogged event so the host can resend it.
import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { replay } from './replay.js';

const STALE_LOCK_MS = 60_000;

/** @returns {{fixed: string[], left: string[]}} */
export function repair(store, { rebuild = false, now = Date.now() } = {}) {
  const fixed = [];
  const left = [];
  for (const u of store.unreadable()) {
    if (!u.last) {
      left.push(`${u.file} line ${u.line} is not JSON and is not the last line`);
      continue;
    }
    const f = join(store.dir, u.file);
    const lines = readFileSync(f, 'utf8').split('\n');
    writeFileSync(f, lines.slice(0, u.line - 1).join('\n') + (u.line > 1 ? '\n' : ''));
    fixed.push(`dropped torn line ${u.line} of ${u.file}`);
  }
  const lock = join(store.dir, 'lock');
  if (existsSync(lock) && now - statSync(lock).mtimeMs > STALE_LOCK_MS) {
    unlinkSync(lock);
    fixed.push('cleared a stale lock');
  }
  const state = store.read();
  const last = store.events().at(-1)?.version;
  if (state && last != null && state.version !== last) {
    if (!rebuild || state.version < last) left.push(`state.json is version ${state.version}, the log ends at ${last}${state.version > last ? ' (run with --rebuild)' : ''}`);
    else {
      const { rebuilt } = replay(store);
      store.write({ ...rebuilt, version: last, updatedAt: new Date(now).toISOString() }, state.version);
      fixed.push(`rebuilt state.json from events.jsonl at version ${last}`);
    }
  }
  return { fixed, left };
}
