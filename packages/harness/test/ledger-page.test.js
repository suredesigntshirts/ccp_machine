// The ledger page (#89, V1 of epic #59): the live page path mission control has (needs file, data age, Refresh,
// timed refreshes, schemaVersion banner), over the one history instead of a store. These tests build the history
// with the current code (the sim's contract store through extract-store.mjs and join.mjs, never a frozen fixture),
// render the page on it, on the golden history and, when HARNESS_DOGFOOD2_DIR names a store, on a joined copy of
// dogfood2, and check every count the page shows against the history's rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.js';
import { specs } from '../src/machines.js';
import { openStore, init } from '../src/index.js';
import { HISTORY } from '../src/history.js';
import { loadNeeds, checkPage, renderLivePage } from '../src/pages.js';
import { parseLog } from '../src/live.js';
import { contractHistory } from '../src/sim.js';
import { doctor } from '../src/doctor.js';

const GOLDEN = fileURLToPath(new URL('./fixtures/history-golden/events.jsonl', import.meta.url));
const SCRIPTS = fileURLToPath(new URL('../scripts/history/', import.meta.url));
const DOGFOOD2 = process.env.HARNESS_DOGFOOD2_DIR;
const golden = () => parseLog(readFileSync(GOLDEN, 'utf8'));
let built;
const history = async () => (built ??= await contractHistory(tempDir('harness-ledger-page-')));
const shown = (html) => html.slice(0, html.indexOf('<script'));

// What the page must show, counted straight from the rows: the declared fields of each type are the only ones it reads.
function expected(rows, needs = loadNeeds('ledger')) {
  const count = (type) => rows.filter((r) => r.event.type === type).length;
  const item = (r) => /^item:([^/]+)/.exec(r.to)?.[1];
  const items = {};
  for (const [type, key] of [['WORKER_SPAWNED', 'spawns'], ['WORKER_STARTED', 'starts'], ['RUN_SUCCEEDED', 'runs']])
    for (const r of rows.filter((r) => r.event.type === type && item(r))) {
      items[item(r)] ??= { spawns: 0, starts: 0, runs: 0 };
      items[item(r)][key]++;
    }
  const eras = {};
  for (const r of rows) {
    const e = (eras[r.provenance.from.ref] ??= { rows: 0, placeholders: 0 });
    e.rows++;
    const declared = [...(needs.events['*'] ?? []), ...(needs.events[r.event.type] ?? [])];
    e.placeholders += (r.provenance.placeholders ?? []).filter((p) => declared.some((d) => p === d || p.startsWith(`${d}.`))).length;
  }
  return { rows: rows.length, spawns: count('WORKER_SPAWNED'), starts: count('WORKER_STARTED'), runs: count('RUN_SUCCEEDED'), usage: count('USAGE_SAMPLED'), items, eras };
}

// The counts the page shows, read from its data-count cells.
function counts(html) {
  const page = shown(html);
  const cell = (s, name) => Number(new RegExp(`data-count="${name}"[^>]*>(\\d+)<`).exec(s)?.[1]);
  const tiles = page.slice(0, page.indexOf('data-item') === -1 ? undefined : page.indexOf('data-item'));
  const rowsOf = (attr) =>
    Object.fromEntries([...page.matchAll(new RegExp(`<tr ${attr}="([^"]+)">(.*?)</tr>`, 'g'))].map(([, k, s]) => [k.replace(/&amp;/g, '&'), s]));
  return {
    rows: cell(tiles, 'rows'),
    spawns: cell(tiles, 'spawns'),
    starts: cell(tiles, 'starts'),
    runs: cell(tiles, 'runs'),
    usage: cell(tiles, 'usage'),
    items: Object.fromEntries(Object.entries(rowsOf('data-item')).map(([k, s]) => [k, { spawns: cell(s, 'spawns'), starts: cell(s, 'starts'), runs: cell(s, 'runs') }])),
    eras: Object.fromEntries(Object.entries(rowsOf('data-era')).map(([k, s]) => [k, { rows: cell(s, 'rows'), placeholders: cell(s, 'placeholders') }]))
  };
}

test('the ledger page declares its needs over the history, and spec machines take every event type it reads', () => {
  const needs = loadNeeds('ledger');
  assert.equal(needs.reads.file, 'events.jsonl');
  assert.deepEqual(needs.reads.schemaVersion, { min: 1, max: 1 }, 'the ledger page names the history schemaVersion range it reads');
  const named = Object.values(needs.spec ?? {}).flatMap((m) => m.events ?? []);
  for (const type of Object.keys(needs.events).filter((t) => t !== '*')) assert.ok(named.includes(type), `pages/ledger/needs.json spec does not name ${type}`);
});

test('a history the current code builds (sim, extract-store, join) meets the ledger page\'s needs', async () => {
  const { rows } = await history();
  assert.deepEqual(checkPage('ledger', { history: rows }), []);
});

test('an event the ledger page reads that the spec machines no longer take fails, naming the page and the event', () => {
  const dropped = structuredClone(specs);
  const strip = (node) => { if (node.on) delete node.on.WORKER_SPAWNED; Object.values(node.states ?? {}).forEach(strip); };
  Object.values(dropped).forEach(strip);
  const problems = checkPage('ledger', { history: golden(), specs: dropped });
  assert.ok(problems.some((p) => /^ledger: /.test(p) && p.includes('WORKER_SPAWNED') && p.includes('workItem')), problems.join('\n'));
});

test('a field the runtime stops writing fails, naming the ledger page and the field', async () => {
  const { rows } = await history();
  const lacking = rows.map((r) => (r.event.type === 'WORKER_STARTED' ? { ...r, event: { ...r.event, agentType: undefined } } : r));
  const problems = checkPage('ledger', { history: lacking });
  assert.ok(problems.some((p) => /^ledger: /.test(p) && p.includes('event.agentType')), problems.join('\n'));
});

test('a field the ledger page reads that its needs file does not declare fails, naming the page and the field', () => {
  const needs = structuredClone(loadNeeds('ledger'));
  needs.events.WORKER_SPAWNED = needs.events.WORKER_SPAWNED.filter((f) => f !== 'event.model');
  const problems = checkPage('ledger', { history: golden(), needs });
  assert.ok(problems.some((p) => /^ledger: /.test(p) && p.includes('event.model') && p.includes('needs.json')), problems.join('\n'));
});

test('the ledger page renders the golden history: data age, Refresh, and every count it shows matches the rows', () => {
  const rows = golden();
  const html = renderLivePage(rows, { page: 'ledger', project: 'chan_x', path: 'harness/history' });
  assert.match(html, /id="data-age"/);
  assert.match(html, /id="refresh"/);
  assert.match(html, /harness\/history\/events\.jsonl/);
  assert.doesNotMatch(shown(html), /class="banner bad"/);
  assert.deepEqual(counts(html), expected(rows));
  assert.ok(Object.values(counts(html).eras).some((e) => e.placeholders > 0), 'the golden history has placeholders the page counts');
  // A placeholder is counted, never shown as a value; fields the page does not declare never reach it.
  assert.doesNotMatch(html, /predates the event envelope/);
  for (const key of ['briefSha256', 'toolUseId', '"criteria"', '"request"']) assert.ok(!html.includes(key), `the page carries ${key}`);
});

test('the ledger page renders a history the current code builds, with counts that match its rows', async () => {
  const { rows } = await history();
  const html = renderLivePage(rows, { page: 'ledger' });
  const want = expected(rows);
  assert.ok(want.spawns && want.starts && want.runs && want.usage, JSON.stringify(want));
  assert.deepEqual(counts(html), want);
});

test('a history outside the ledger page\'s schemaVersion range gets a red banner naming the mismatch and no data', () => {
  const rows = golden();
  for (const schemaVersion of [0, 2]) {
    const bad = rows.map((r, i) => (i === 3 ? { ...r, schemaVersion } : r));
    const page = shown(renderLivePage(bad, { page: 'ledger' }));
    assert.match(page, /class="banner bad"/);
    assert.match(page, new RegExp(`schemaVersion ${schemaVersion}`));
    assert.match(page, /reads 1 to 1/);
    assert.doesNotMatch(page, /<table|data-count/, 'no partial data under the banner');
  }
  // A row without a schemaVersion was written before the field: absentMeans.
  assert.equal(HISTORY.absentMeans, 1);
  // A store's own events.jsonl (rows without provenance) is not a history.
  const store = rows.map(({ provenance, ...r }) => r);
  const page = shown(renderLivePage(store, { page: 'ledger' }));
  assert.match(page, /class="banner bad"/);
  assert.doesNotMatch(page, /<table|data-count/);
});

test('doctor flags a ledger page refresh slower than the threshold mission control set', async () => {
  const slow = specs.harness.meta.pages.refreshSlowMs;
  const rows = [{ id: 'r1', data: { page: 'ledger', at: '2026-10-28T10:00:00Z', ms: slow + 5, storeVersion: 30, bytes: 20000, ok: true } }];
  const store = openStore(tempDir('harness-ledger-doctor-'));
  init(store, {}, '2026-10-28T08:00:00Z');
  const report = await doctor(store, { verify: false, refreshes: rows });
  assert.ok(report.warnings.some((w) => w.includes('ledger') && w.includes(`${slow + 5} ms`)), report.warnings.join('\n'));
});

test('the ledger page renders a joined dogfood2 history, with counts that match its rows', { skip: !DOGFOOD2 && 'the dogfood2 case did not run: HARNESS_DOGFOOD2_DIR names no store (CI has no Library). Run it against a path to dogfood2; it works on a copy' }, () => {
  const tmp = tempDir('harness-ledger-dogfood2-');
  const copy = join(tmp, 'dogfood2');
  cpSync(DOGFOOD2, copy, { recursive: true });
  const ex = spawnSync(process.execPath, [join(SCRIPTS, 'extract-store.mjs'), copy, 'library/harness/state/dogfood2/events.jsonl'], { encoding: 'utf8' });
  assert.equal(ex.status, 0, ex.stderr);
  writeFileSync(join(tmp, 'candidates.jsonl'), ex.stdout);
  const j = spawnSync(process.execPath, [join(SCRIPTS, 'join.mjs'), join(tmp, 'candidates.jsonl'), join(SCRIPTS, 'recovered/dogfood2.jsonl'), '--out', join(tmp, 'joined')], { encoding: 'utf8' });
  assert.equal(j.status, 0, j.stderr);
  const rows = parseLog(readFileSync(join(tmp, 'joined', 'events.jsonl'), 'utf8'));
  const html = renderLivePage(rows, { page: 'ledger' });
  assert.doesNotMatch(shown(html), /class="banner bad"/);
  assert.deepEqual(counts(html), expected(rows));
  console.log(`dogfood2: ${rows.length} rows, ${expected(rows).spawns} spawns, ${Object.keys(expected(rows).items).length} items`);
});
