// The flow replay and design log pages (#121, V2 and V3 of epic #59): the ledger's live page path over the one
// history. These tests render both pages on the golden history, on a history the current code builds
// (contractHistory) and, when HARNESS_DOGFOOD2_DIR names a store, on a joined copy of dogfood2, and check every count
// each page shows against the history's rows, counted here straight from the rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.js';
import { HISTORY, checkLogNeeds } from '../src/history.js';
import { loadNeeds, checkPage, renderLivePage } from '../src/pages.js';
import { parseLog, step } from '../src/live.js';
import { contractHistory } from '../src/sim.js';

const GOLDEN = fileURLToPath(new URL('./fixtures/history-golden/events.jsonl', import.meta.url));
const SCRIPTS = fileURLToPath(new URL('../scripts/history/', import.meta.url));
const DOGFOOD2 = process.env.HARNESS_DOGFOOD2_DIR;
const PAGES = ['flow-replay', 'design-log'];
const golden = () => parseLog(readFileSync(GOLDEN, 'utf8'));
let built;
const history = async () => (built ??= await contractHistory(tempDir('harness-history-pages-')));
const shown = (html) => html.slice(0, html.indexOf('<script'));
const num = (s, name) => Number(new RegExp(`data-count="${name}"[^>]*>(\\d+)<`).exec(s)?.[1]);
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// The placeholders among the fields a page declares for a row's type: what the page counts and never shows.
const placeholdersOf = (r, needs) => {
  const declared = [...(needs.events['*'] ?? []), ...(needs.events[r.event.type] ?? [])];
  return (r.provenance.placeholders ?? []).filter((p) => declared.some((d) => p === d || p.startsWith(`${d}.`))).length;
};
const timeOrder = (a, b) => a.at.localeCompare(b.at) || a.version - b.version;
const groupOf = (r) => { const m = /^item:([^/]+)/.exec(r.to); return m ? `item:${m[1]}` : '(no item)'; };

// Flow replay, counted from the rows: every row, grouped by item (the to address), each group in time order.
function expectedFlow(rows, needs = loadNeeds('flow-replay')) {
  const groups = {};
  for (const r of [...rows].sort(timeOrder)) {
    const g = (groups[groupOf(r)] ??= { rows: 0, placeholders: 0, order: [] });
    g.rows++;
    g.placeholders += placeholdersOf(r, needs);
    g.order.push(r.version);
  }
  return { rows: rows.length, groups: Object.keys(groups).length, placeholders: rows.reduce((n, r) => n + placeholdersOf(r, needs), 0), byGroup: groups };
}

// What the flow replay page shows: its tiles, and each group's counts and its rows' versions in the order it steps.
function shownFlow(html) {
  const page = shown(html);
  const first = page.indexOf('data-group=');
  const tiles = first < 0 ? page : page.slice(0, first);
  const byGroup = {};
  for (const [, g, s] of page.matchAll(/<section class="group" data-group="([^"]+)"[^>]*>(.*?)<\/section>/gs))
    byGroup[unesc(g)] = { rows: num(s, 'rows'), placeholders: num(s, 'placeholders'), order: [...s.matchAll(/data-version="(\d+)"/g)].map(([, v]) => Number(v)) };
  return { rows: num(tiles, 'rows'), groups: num(tiles, 'groups'), placeholders: num(tiles, 'placeholders'), byGroup };
}

const KINDS = { REQUEST_RECEIVED: 'requests', STAND_IN_ANSWERED: 'answers', PERSON_DECIDED: 'decisions', PERSON_GRANTED: 'grants', OUT_OF_BAND: 'outOfBand' };
// Design log, counted from the rows: each kind of decision row, its placeholders, and both lists newest first.
function expectedLog(rows, needs = loadNeeds('design-log')) {
  const of = rows.filter((r) => KINDS[r.event.type]);
  const newest = [...of].sort(timeOrder).reverse();
  const out = Object.fromEntries(Object.values(KINDS).map((k) => [k, 0]));
  for (const r of of) out[KINDS[r.event.type]]++;
  return {
    ...out,
    placeholders: of.reduce((n, r) => n + placeholdersOf(r, needs), 0),
    oob: newest.filter((r) => r.event.type === 'OUT_OF_BAND').map((r) => r.version),
    decisions: newest.filter((r) => r.event.type !== 'OUT_OF_BAND').map((r) => r.version)
  };
}

function shownLog(html) {
  const page = shown(html);
  const cut = page.indexOf('<section');
  const tiles = page.slice(0, cut);
  const versions = (re) => [...page.matchAll(re)].map(([, v]) => Number(v));
  return {
    ...Object.fromEntries(Object.values(KINDS).map((k) => [k, num(tiles, k)])),
    placeholders: num(tiles, 'placeholders'),
    oob: versions(/data-oob="(\d+)"/g),
    decisions: versions(/<tr data-kind="[a-z]+" data-version="(\d+)"/g)
  };
}

const EXPECTED = { 'flow-replay': [expectedFlow, shownFlow], 'design-log': [expectedLog, shownLog] };
const check = (page, rows) => {
  const [want, got] = EXPECTED[page];
  const html = renderLivePage(rows, { page, project: 'chan_x', path: 'harness/history' });
  assert.doesNotMatch(shown(html), /class="banner bad"/, `${page} shows a banner`);
  assert.deepEqual(got(html), want(rows), `${page}'s counts`);
  return html;
};

test('the flow replay and design log pages render the golden history, every count matching its rows', () => {
  const rows = golden();
  for (const page of PAGES) {
    const html = check(page, rows);
    // The ledger's data age, Refresh and timed refreshes, nothing beside them.
    assert.equal(shown(html).match(/id="data-age"/g).length, 1);
    assert.equal(shown(html).match(/id="refresh"/g).length, 1);
    assert.equal(shown(html).match(/id="refreshes"/g).length, 1);
    assert.match(html, /harness\/history\/events\.jsonl/);
    // A placeholder is counted, never shown as a value.
    assert.doesNotMatch(html, /predates the event envelope/);
  }
  const flow = shownFlow(renderLivePage(rows, { page: 'flow-replay' }));
  assert.ok(flow.byGroup['(no item)'], 'rows with no item address have their own group');
  assert.ok(flow.placeholders > 0, 'the golden history has placeholders flow replay counts');
  const log = expectedLog(rows);
  assert.ok(log.oob.length && log.answers && log.decisions && log.grants && log.requests, JSON.stringify(log));
});

test('the design log shows each out-of-band row with who ordered it, the message, what was done and the gates it skipped', () => {
  const rows = golden();
  const page = shown(renderLivePage(rows, { page: 'design-log' }));
  for (const r of rows.filter((r) => r.event.type === 'OUT_OF_BAND')) {
    const card = new RegExp(`data-oob="${r.version}"(.*?)</div></div>`, 's').exec(page)?.[1];
    assert.ok(card, `no card for ${r.id}`);
    assert.ok(unesc(card).includes(`${r.event.orderedBy.kind}:${r.event.orderedBy.id}`), card);
    assert.ok(unesc(card).includes(r.event.message), card);
    assert.ok(unesc(card).includes(r.event.what), card);
    for (const g of r.event.skipped) assert.ok(card.includes(g), card);
  }
  const answer = rows.find((r) => r.event.type === 'STAND_IN_ANSWERED');
  assert.ok(unesc(page).includes(answer.event.answer.reason), 'a stand-in answer shows its reason');
});

test('the flow replay page steps one row at a time: each step card shows type, time, sender and provenance', () => {
  const rows = golden();
  const page = shown(renderLivePage(rows, { page: 'flow-replay' }));
  for (const [, s] of page.matchAll(/<section class="group" data-group="[^"]+"[^>]*>(.*?)<\/section>/gs)) {
    for (const b of ['first', 'prev', 'next', 'last']) assert.match(s, new RegExp(`data-step="${b}"`));
    const cards = [...s.matchAll(/<div class="card step" data-version="\d+"( hidden)?>/g)];
    assert.equal(cards.filter(([, h]) => !h).length, 1, 'one row shown at a time');
    assert.equal(cards[0][1], undefined, 'the first row is shown first');
  }
  const r = rows.find((r) => r.actor.kind === 'person');
  const card = unesc(new RegExp(`data-version="${r.version}"[^>]*>(.*?)</div></div>`, 's').exec(page)[1]);
  for (const v of [r.event.type, r.at, `${r.actor.kind}:${r.actor.id}`, `${r.source.kind}:${r.source.ref}`, r.provenance.origin, r.provenance.from.source]) assert.ok(card.includes(v), `${v} not in ${card}`);
});

test('the page script steps a group: next, previous, first and last each show one row, and a hidden row is not drawn', () => {
  const html = renderLivePage(golden(), { page: 'flow-replay' });
  assert.match(html, /\.step\[hidden\]\{display:none\}/, 'a hidden step card is not drawn (.card sets display)');
  assert.match(html, /\$\('view'\)\.addEventListener\('click', step\)/, 'the page script wires the step buttons');
  // The group as the inlined step() sees it in the browser.
  const list = [1, 2, 3, 4].map((v, i) => ({ v, hidden: i > 0 }));
  const pos = { textContent: '1 / 4' };
  const group = { querySelectorAll: () => list, querySelector: () => pos };
  const press = (s) => step({ target: { closest: (sel) => (sel === '[data-step]' ? { dataset: { step: s }, closest: () => group } : null) } });
  const shownNow = () => list.filter((r) => !r.hidden).map((r) => r.v);
  for (const [s, want] of [['next', 2], ['next', 3], ['next', 4], ['next', 4], ['prev', 3], ['first', 1], ['prev', 1], ['last', 4]]) {
    press(s);
    assert.deepEqual(shownNow(), [want], s);
    assert.equal(pos.textContent, `${want} / 4`);
  }
});

test('both pages render a history the current code builds, with counts that match its rows', async () => {
  const { rows } = await history();
  for (const page of PAGES) {
    assert.deepEqual(checkPage(page, { history: rows }), [], `${page}'s needs are not met by the history the current code builds`);
    check(page, rows);
  }
  assert.ok(expectedLog(rows).oob.length, 'the contract history has an out-of-band row');
});

test('a field a page\'s needs file lists, dropped from the history schema, fails naming the page and the field', () => {
  // Drop one declared field: the property its path names, through $ref and anyOf, in the envelope and in the type's schema.
  const drop = (schema, type, path) => {
    const ref = (n) => (n && n.$ref ? ref(n.$ref.slice(2).split('/').reduce((x, k) => x?.[k], schema)) : n);
    const forms = (n) => { n = ref(n); return !n ? [] : n.anyOf ? n.anyOf.flatMap(forms) : [n]; };
    const keys = path.split('.');
    let nodes = [schema];
    for (const [i, k] of keys.entries()) {
      if (i === keys.length - 1) for (const n of nodes.flatMap(forms)) { if (n.properties) delete n.properties[k]; if (n.required) n.required = n.required.filter((x) => x !== k); }
      const next = nodes.flatMap(forms).map((n) => n.properties?.[k]).filter(Boolean);
      if (i === 0 && k === 'event' && type !== '*' && schema.events.types[type].schema) next.push(schema.events.types[type].schema);
      nodes = next;
    }
  };
  for (const page of [...PAGES, 'ledger']) {
    const needs = loadNeeds(page);
    assert.deepEqual(checkLogNeeds(needs), [], `${page} reads a field history.schema.json does not declare`);
    for (const [type, fields] of Object.entries(needs.events))
      for (const f of fields) {
        const schema = structuredClone(HISTORY);
        drop(schema, type, f);
        const problems = checkLogNeeds(needs, undefined, schema);
        assert.ok(problems.some((p) => p.startsWith(`${page}: `) && p.includes(f) && p.includes('history.schema.json')), `${page} ${type} ${f}: ${problems.join('\n') || 'no problem'}`);
      }
  }
});

test('a field either page reads that its needs file does not declare fails, naming the page and the field', () => {
  for (const [page, type, field] of [['flow-replay', '*', 'provenance.origin'], ['design-log', 'STAND_IN_ANSWERED', 'event.answer.reason'], ['design-log', 'OUT_OF_BAND', 'event.orderedBy']]) {
    const needs = structuredClone(loadNeeds(page));
    needs.events[type] = needs.events[type].filter((f) => f !== field);
    const problems = checkPage(page, { history: golden(), needs });
    assert.ok(problems.some((p) => p.startsWith(`${page}: reads `) && p.includes(field) && p.includes('needs.json')), `${page} ${field}: ${problems.join('\n')}`);
  }
});

test('a history outside either page\'s schemaVersion range shows the red banner and no data', () => {
  const rows = golden();
  for (const page of PAGES)
    for (const schemaVersion of [0, 2]) {
      const html = shown(renderLivePage(rows.map((r, i) => (i === 3 ? { ...r, schemaVersion } : r)), { page }));
      assert.match(html, /class="banner bad"/, page);
      assert.match(html, new RegExp(`schemaVersion ${schemaVersion}`));
      assert.doesNotMatch(html, /data-count|data-version|data-oob/, `${page}: no partial data under the banner`);
    }
});

test('both pages render a joined dogfood2 history, with counts that match its rows', { skip: !DOGFOOD2 && 'the dogfood2 case did not run: HARNESS_DOGFOOD2_DIR names no store (CI has no Library). Run it against a path to dogfood2; it works on a copy' }, () => {
  const tmp = tempDir('harness-history-pages-dogfood2-');
  const copy = join(tmp, 'dogfood2');
  cpSync(DOGFOOD2, copy, { recursive: true });
  const ex = spawnSync(process.execPath, [join(SCRIPTS, 'extract-store.mjs'), copy, 'library/harness/state/dogfood2/events.jsonl'], { encoding: 'utf8' });
  assert.equal(ex.status, 0, ex.stderr);
  writeFileSync(join(tmp, 'candidates.jsonl'), ex.stdout);
  const j = spawnSync(process.execPath, [join(SCRIPTS, 'join.mjs'), join(tmp, 'candidates.jsonl'), '--out', join(tmp, 'joined')], { encoding: 'utf8' });
  assert.equal(j.status, 0, j.stderr);
  const rows = parseLog(readFileSync(join(tmp, 'joined', 'events.jsonl'), 'utf8'));
  for (const page of PAGES) {
    assert.deepEqual(checkPage(page, { history: rows }), [], page);
    check(page, rows);
  }
  const log = expectedLog(rows);
  console.log(`dogfood2: ${rows.length} rows, ${expectedFlow(rows).groups} groups, ${log.oob.length} out-of-band, ${log.answers} stand-in answers`);
});
