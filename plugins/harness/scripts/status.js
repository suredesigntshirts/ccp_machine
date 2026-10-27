#!/usr/bin/env node
// The status mod's one data source (hooks/status.tsx runs it once a minute): prints one JSON line with
// the gate and the same version facts the SessionStart line uses, all from host.js. One Library read
// (the marker), no network. With `--record <session>` and the harness installed it also writes the
// mod's load record, `$HARNESS_LIBRARY_DIR/status-mod/<session>.json`. It never fails: any error is
// reported in the JSON (`error`) and it exits 0.
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { gate, version, libraryDir, markerPath } from './host.js';

/** The status line for a gate state and version: null when disabled. */
export function statusText(state, v) {
  if (state === 'disabled') return null;
  const id = `${v.name} ${v.version}`;
  if (state !== 'installed') return `${id}: available, not installed`;
  return `${id} commit ${v.commit ? v.commit.slice(0, 7) : 'unknown (no git)'} · installed`;
}

/** Where a session's load record goes; the session id is reduced to a safe file name. */
export const recordPath = (session) => join(libraryDir(), 'status-mod', `${String(session).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

export async function status({ record = null, now = () => new Date().toISOString() } = {}) {
  const state = await gate(1000);
  if (state === 'disabled') return { state, text: null };
  const v = version();
  const out = { state, text: statusText(state, v), ...v, marker: markerPath() };
  if (record && state === 'installed') {
    const path = recordPath(record);
    try {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ session: record, event: 'loaded', plugin: v.name, version: v.version, commit: v.commit, root: v.root, at: now() })}\n`);
      out.record = path;
    } catch (err) {
      out.error = `load record not written: ${err.message}`;
    }
  }
  return out;
}

const main = () => { try { return realpathSync(process.argv[1]) === import.meta.filename; } catch { return false; } };
if (main()) {
  const i = process.argv.indexOf('--record');
  let out;
  try {
    out = await status({ record: i > 0 ? process.argv[i + 1] : null });
  } catch (err) {
    out = { state: 'error', text: null, error: String(err?.message ?? err) };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}
