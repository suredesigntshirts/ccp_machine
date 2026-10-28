#!/usr/bin/env node
// M1 (epic #59): joins candidate histories (JSONL files of history rows, such as extract-store.mjs writes) into one.
// Every row must pass validate() (C2); one row is kept per fact (dedupe, C4) and the rows are numbered from 1 in time
// order. --out becomes a store: events.jsonl is the history, state.json and outbox.jsonl come from replaying it with
// the current code (as harness replay does), and report.json lists the dropped rows, the conflicts and the rows the
// current code refuses. It reads its inputs only and writes nothing outside --out, which must not exist yet.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { validate, dedupe } from '../../src/history.js';
import { openStore } from '../../src/store.js';
import { init, apply } from '../../src/runtime.js';

const { values: o, positionals: candidates } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' } } });
const fail = (msg) => {
  console.error(`join: ${msg}`);
  process.exit(1);
};
if (!o.out || !candidates.length) fail('usage: join.mjs <candidates>... --out <dir>');
if (existsSync(o.out)) fail(`${o.out} exists: join writes a new store and never adds to one`);

const read = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const rows = candidates.flatMap(read);
const invalid = rows.flatMap(validate);
if (invalid.length) fail(`rows that are not history rows (spec/history.schema.json), nothing written:\n${invalid.join('\n')}`);
const { rows: kept, dropped, conflicts } = dedupe(rows);
const history = kept.map((r, i) => ({ ...r, version: i + 1 }));
if (!history.length) fail('no rows, nothing written');

// Replay the history into --out the way harness replay does, then put the history in place of the log apply wrote.
const store = openStore(o.out);
init(store, {}, history[0].at);
const refused = [];
for (const r of history) {
  try {
    const relayedBy = r.relayedBy ?? (['tap', 'message'].includes(r.source?.kind) ? 'unrecorded' : undefined);
    const res = apply(store, { ...r.event, actor: r.actor, source: r.source, relayedBy }, { to: r.to === 'harness' ? undefined : r.to, id: r.id, now: r.at });
    if (res.refused) refused.push(`${r.id}: ${res.why}`);
  } catch (e) {
    refused.push(`${r.id}: ${e.message}`);
  }
}
const state = store.read();
store.write({ ...state, version: history.at(-1).version }, state.version);
writeFileSync(join(o.out, 'events.jsonl'), history.map((r) => JSON.stringify(r) + '\n').join(''));
const report = { candidates: candidates.length, read: rows.length, rows: history.length, dropped, conflicts, refused };
writeFileSync(join(o.out, 'report.json'), JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify({ out: o.out, read: rows.length, rows: history.length, dropped: dropped.length, conflicts: conflicts.length, refused: refused.length }));
