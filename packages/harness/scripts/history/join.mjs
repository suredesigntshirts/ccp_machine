#!/usr/bin/env node
// M1 (epic #59): joins candidate histories (JSONL files of history rows, such as extract-store.mjs writes) into one.
// Every row must pass validate() (C2); one row is kept per fact (dedupe, C4) and the rows are numbered from 1 in time
// order. --out becomes a store: events.jsonl is the history, state.json and outbox.jsonl come from replaying it with
// the current code (as harness replay does, each row a fact), and report.json lists the dropped rows, the conflicts and
// the rows that could not be applied. With --from <dir> (a copy of the Library's harness/ folder) it builds the one
// history from every source SOURCES lists: it runs the extractors on each (E1 extract-store.mjs, E3 extract-github.mjs,
// E2 extract-session.mjs) and joins their rows; each store's outbox gives its rows their routes, its acks go to the
// effects replay queued again for its rows (acks.jsonl), and report.json also lists each source's rows and skips, each
// skip with its reason. It reads its inputs only and writes nothing outside --out, which must not exist yet.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validate, dedupe } from '../../src/history.js';
import { openStore } from '../../src/store.js';
import { init, apply } from '../../src/runtime.js';
import { effectKey } from '../../src/replay.js';

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

// The rows: each candidate file's or, with --from, each source's by its extractor, and each store's outbox and acks.
const sources = [];
const stores = new Map();
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
    if (script === 'extract-store.mjs') stores.set(ref, { outbox: readIf(join(dir, 'outbox.jsonl')), acks: readIf(join(dir, 'acks.jsonl')) });
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
// so no row is refused for a rule that changed since. A row that cannot be applied at all is listed as refused.
// A row that records its route takes it. For a row from before routes were recorded, the effects its source store
// logged (its outbox; --outbox, by event id): a row whose effects today's route does not give takes the route that
// gives them, as replay does. Without an outbox such a row takes today's route.
const logged = new Map();
const key = (ref, id) => `${ref}\n${id}`;
for (const f of o.outbox ?? []) for (const e of read(f)) logged.set(key('', e.eventId), [...(logged.get(key('', e.eventId)) ?? []), effectKey(e)]);
for (const [ref, s] of stores) for (const e of s.outbox) logged.set(key(ref, e.eventId), [...(logged.get(key(ref, e.eventId)) ?? []), effectKey(e)]);
const loggedFor = (r) => logged.get(key(stores.has(r.provenance.from.ref) ? r.provenance.from.ref : '', r.id)) ?? [];
const routing = o.outbox || stores.size;

// A store's acks (not its withdrawals, which replay writes itself as each row closes them) go to the joined store in
// time order, as replay feeds them: an ack reaches the effect replay queued again with the same id and the same name,
// subject and params, for the row of that store that replay applied under that id.
const appliedFrom = new Map(); // event id -> the row replay applied under it: its source ref and version
const hostAcks = [...stores].flatMap(([ref, s]) => {
  const effects = new Map(s.outbox.map((e) => [e.id, e]));
  return s.acks.filter((a) => a.outcome !== 'withdrawn' && effects.has(a.effectId)).map((a) => ({ ref, ack: a, effect: effects.get(a.effectId) }));
}).sort((a, b) => String(a.ack.at ?? '').localeCompare(String(b.ack.at ?? '')));
let fed = 0;
let acked = 0;
const feed = (upTo) => {
  const batch = [];
  let outbox;
  for (; fed < hostAcks.length && (upTo === undefined || String(hostAcks[fed].ack.at ?? '') <= upTo); fed++) {
    const { ref, ack, effect } = hostAcks[fed];
    if (appliedFrom.get(effect.eventId)?.ref !== ref) continue;
    outbox ??= new Map(store.outbox().map((e) => [e.id, e]));
    const queued = outbox.get(effect.id);
    if (queued && effectKey(queued) === effectKey(effect)) batch.push(ack);
  }
  if (batch.length) store.withLock(() => store.appendAcks(batch));
  acked += batch.length;
};

const refused = [];
for (const r of history) {
  feed(r.at);
  try {
    const fact = r.route ? { route: r.route } : routing ? { matches: (fx) => JSON.stringify(fx.map(effectKey)) === JSON.stringify(loggedFor(r)) } : {};
    const done = apply(store, { ...r.event, actor: r.actor, source: r.source, ...(r.relayedBy && { relayedBy: r.relayedBy }) }, { to: r.to === 'harness' ? undefined : r.to, id: r.id, now: r.at, fact });
    // An id applied already (two sources can share one) is applied once, as replay applies it: the later row is refused.
    if (done.duplicate) refused.push(`${r.id}: replay applies one event per id, and row ${appliedFrom.get(r.id).version} applied ${r.id} already`);
    else appliedFrom.set(r.id, { ref: r.provenance.from.ref, version: r.version });
  } catch (e) {
    refused.push(`${r.id}: ${e.message}`);
  }
}
feed();
const state = store.read();
store.write({ ...state, version: history.at(-1).version }, state.version);
writeFileSync(join(o.out, 'events.jsonl'), history.map((r) => JSON.stringify(r) + '\n').join(''));
const report = { candidates: o.from ? sources.length : files.length, read: rows.length, rows: history.length, dropped, conflicts, refused, acks: acked, ...(o.from && { sources }) };
writeFileSync(join(o.out, 'report.json'), JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify({ out: o.out, read: rows.length, rows: history.length, dropped: dropped.length, conflicts: conflicts.length, refused: refused.length, acks: acked, ...(o.from && { skips: sources.reduce((n, s) => n + s.skips.length, 0) }) }));
