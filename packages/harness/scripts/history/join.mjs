#!/usr/bin/env node
// M1 (epic #59): joins candidate histories (JSONL files of history rows, such as extract-store.mjs writes) into one.
// Every row must pass validate() (C2); one row is kept per fact (dedupe, C4) and the rows are numbered from 1 in time
// order. --out becomes a store: events.jsonl is the history, state.json and outbox.jsonl come from replaying it with
// the current code (as harness replay does, each row a fact), and report.json lists the dropped rows, the conflicts and
// the rows that could not be applied. With --from <dir> (a copy of the Library's harness/ folder) it builds the one
// history from every source SOURCES lists: it runs the extractors on each (E1 extract-store.mjs, E3 extract-github.mjs,
// E2 extract-session.mjs) and joins their rows; each store is an era, ended by an ERA_ENDED row carrying its state.json
// and the effects it never acked (history.js eraEnd, harness meta.store.eras), so replay takes each item's state at its
// era's end from the store's own record and applies today's machine only to the rows after; report.json also lists each
// source's rows and skips, each skip with its reason, and each era's rows, items and pending effects. It reads its
// inputs only and writes nothing outside --out, which must not exist yet.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validate, dedupe, eraEnd } from '../../src/history.js';
import { openStore } from '../../src/store.js';
import { init, apply } from '../../src/runtime.js';
import { effectKey, eraFacts } from '../../src/replay.js';
import { specs } from '../../src/machines.js';

// The one history's sources under --from: these stores (state/<name>), these repos (archive/github/<owner>--<repo>)
// and every session archived (archive/sessions/<id>). Each is read as the archive ref it is joined under.
const SOURCES = { stores: ['main', 'dogfood', 'dogfood2'], github: ['suredesigntshirts--ccp_machine', 'suredesigntshirts--ccp_machine_test'], sessions: 'archive/sessions' };

const { values: o, positionals: files } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, outbox: { type: 'string', multiple: true }, from: { type: 'string' } } });
const fail = (msg) => {
  console.error(`join: ${msg}`);
  process.exit(1);
};
if (!o.out || !(files.length || o.from) || (o.from && (files.length || o.outbox)))
  fail('usage: join.mjs <candidates>... [--outbox <outbox.jsonl>]... --out <dir>, or join.mjs --from <harness dir> --out <dir>');
if (existsSync(o.out)) fail(`${o.out} exists: join writes a new store and never adds to one`);

const parse = (text) => text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const read = (f) => parse(readFileSync(f, 'utf8'));
const readIf = (f) => (existsSync(f) ? read(f) : []);

// The rows: each candidate file's or, with --from, each source's by its extractor, each store's ended by its era's mark.
const sources = [];
let rows = [];
if (o.from) {
  const at = (...p) => join(o.from, ...p);
  const need = (dir) => (existsSync(dir) ? dir : fail(`${dir}: a source of the one history is missing, nothing written`));
  const plan = [
    ...SOURCES.stores.map((s) => ['extract-store.mjs', need(at('state', s)), s]),
    ...SOURCES.github.map((g) => ['extract-github.mjs', need(at('archive', 'github', g)), `github/${g}`]),
    ...readdirSync(need(at(SOURCES.sessions))).sort().map((s) => ['extract-session.mjs', at(SOURCES.sessions, s), `sessions/${s}`]),
  ];
  for (const [script, dir, ref] of plan) {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), dir, ref], { encoding: 'utf8', maxBuffer: 1 << 30 });
    if (r.status !== 0) fail(`${script} ${dir}: ${r.stderr.trim()}`);
    const got = parse(r.stdout);
    rows.push(...got);
    sources.push({ ref, rows: got.length, skips: parse(r.stderr).filter((l) => l.skip).map(({ skip, reason }) => ({ ...skip, reason })) });
    if (script !== 'extract-store.mjs') continue;
    const state = existsSync(join(dir, 'state.json')) ? JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) : fail(`${dir}: no state.json, the record that ends its era; nothing written`);
    rows.push(eraEnd(ref, state, readIf(join(dir, 'outbox.jsonl')), readIf(join(dir, 'acks.jsonl')), got.map((r) => r.at).sort().at(-1)));
  }
} else rows = files.flatMap(read);

const invalid = rows.flatMap(validate);
if (invalid.length) fail(`rows that are not history rows (spec/history.schema.json), nothing written:\n${invalid.join('\n')}`);
const { rows: kept, dropped, conflicts } = dedupe(rows);
const history = kept.map((r, i) => ({ ...r, version: i + 1 }));
if (!history.length) fail('no rows, nothing written');

// Replay the history into --out the way harness replay does, then put the history in place of the log apply wrote.
const store = openStore(o.out);
init(store, {}, history[0].at);
// Each row is a fact, admitted when it was written: it is applied without the admission rules (harness meta.store.facts),
// so no row is refused for a rule that changed since. A row of an era an ERA_ENDED row ends is not applied at all: the
// mark brings the era's own record of it (harness meta.store.eras). A row that cannot be applied is listed as refused.
// A row that records its route takes it. For a row from before routes were recorded, the effects its source store
// logged (--outbox, by event id): a row whose effects today's route does not give takes the route that gives them, as
// replay does. Without an outbox such a row takes today's route.
const logged = new Map();
for (const f of o.outbox ?? []) for (const e of read(f)) logged.set(e.eventId, [...(logged.get(e.eventId) ?? []), effectKey(e)]);

const eras = eraFacts(history);
const applied = new Map(); // event id -> the version of the row replay applied under it
const refused = [];
for (const r of history) {
  if (eras.has(r)) continue;
  try {
    const fact = r.route ? { route: r.route } : o.outbox ? { matches: (fx) => JSON.stringify(fx.map(effectKey)) === JSON.stringify(logged.get(r.id) ?? []) } : {};
    const done = apply(store, { harness: r.harness, ...r.event, actor: r.actor, source: r.source, ...(r.relayedBy && { relayedBy: r.relayedBy }) }, { to: r.to === 'harness' ? undefined : r.to, id: r.id, now: r.at, fact });
    // An id applied already (two sources can share one) is applied once, as replay applies it: the later row is refused.
    if (done.duplicate) refused.push(`${r.id}: replay applies one event per id, and row ${applied.get(r.id)} applied ${r.id} already`);
    else applied.set(r.id, r.version);
  } catch (e) {
    refused.push(`${r.id}: ${e.message}`);
  }
}
const state = store.read();
store.write({ ...state, version: history.at(-1).version }, state.version);
writeFileSync(join(o.out, 'events.jsonl'), history.map((r) => JSON.stringify(r) + '\n').join(''));
// Each era: the rows it holds as facts, the items its record holds and the effects it left pending.
const eraReport = Object.fromEntries(history.filter((r) => r.event.type === specs.harness.meta.store.eras.event).map((m) => [m.event.era, { rows: [...eras.values()].filter((e) => e === m.event.era).length, items: Object.keys(m.event.snapshot.children ?? {}).length, pending: m.event.pending.length }]));
const report = { candidates: o.from ? sources.length : files.length, read: rows.length, rows: history.length, dropped, conflicts, refused, eras: eraReport, ...(o.from && { sources }) };
writeFileSync(join(o.out, 'report.json'), JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify({ out: o.out, read: rows.length, rows: history.length, dropped: dropped.length, conflicts: conflicts.length, refused: refused.length, eras: Object.keys(eraReport).length, ...(o.from && { skips: sources.reduce((n, s) => n + s.skips.length, 0) }) }));
