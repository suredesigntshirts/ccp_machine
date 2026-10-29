// The flow replay and design log pages (#121, V2 and V3 of epic #59): the ledger's live page path over the one
// history, and flow replay's steps beside it (#124): what each row did, from replaying the history with the current
// code (harness replay --steps). These tests build the steps of the golden history and of a history the current code
// builds (contractHistory) and, when HARNESS_DOGFOOD2_DIR names a store, of a joined copy of dogfood2, render both
// pages and check every count each page shows against the rows and the steps, counted here straight from the files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.js';
import { HISTORY, checkLogNeeds, stepProblems } from '../src/history.js';
import { loadNeeds, checkPage, renderLivePage } from '../src/pages.js';
import { parseLog, step } from '../src/live.js';
import * as live from '../src/live.js';
import { contractHistory } from '../src/sim.js';
import { openStore, init, replay } from '../src/index.js';
import { changes } from '../src/replay.js';

const GOLDEN = fileURLToPath(new URL('./fixtures/history-golden/events.jsonl', import.meta.url));
const SCRIPTS = fileURLToPath(new URL('../scripts/history/', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/harness.js', import.meta.url));
const DOGFOOD2 = process.env.HARNESS_DOGFOOD2_DIR;
const PAGES = ['flow-replay', 'design-log'];
const STEPS = 'steps.jsonl';
const shown = (html) => html.slice(0, html.indexOf('<script'));
const num = (s, name) => Number(new RegExp(`data-count="${name}"[^>]*>(\\d+)<`).exec(s)?.[1]);
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// A history joined into a store (join.mjs), and the steps `harness replay --steps` writes beside it.
const join_ = (candidates, out) => {
  const j = spawnSync(process.execPath, [join(SCRIPTS, 'join.mjs'), ...candidates, '--out', out], { encoding: 'utf8' });
  assert.equal(j.status, 0, j.stderr);
  return out;
};
function stepsOf(dir) {
  const r = spawnSync(process.execPath, [BIN, 'replay', '--steps', '--dir', dir], { encoding: 'utf8' });
  assert.ok(existsSync(join(dir, STEPS)), `harness replay --steps wrote no ${STEPS}: ${r.stderr}`);
  const printed = JSON.parse(r.stdout);
  const steps = parseLog(readFileSync(join(dir, STEPS), 'utf8'));
  assert.deepEqual(printed.steps, { file: join(dir, STEPS), steps: steps.length, refused: steps.filter((s) => s.refused != null).length });
  return { dir, rows: parseLog(readFileSync(join(dir, 'events.jsonl'), 'utf8')), steps, printed };
}
let goldenBuilt, contractBuilt;
const golden = () => (goldenBuilt ??= stepsOf(join_([GOLDEN], join(tempDir('harness-history-pages-golden-'), 'history'))));
const contract = async () => (contractBuilt ??= stepsOf((await contractHistory(tempDir('harness-history-pages-'))).dir));
const pageOf = (page, { rows, steps }) => renderLivePage(rows, { page, also: { [STEPS]: steps }, project: 'chan_x', path: 'harness/history' });

// The placeholders among the fields a page declares for a row's type: what the page counts and never shows.
const placeholdersOf = (r, needs) => {
  const declared = [...(needs.events['*'] ?? []), ...(needs.events[r.event.type] ?? [])];
  return (r.provenance.placeholders ?? []).filter((p) => declared.some((d) => p === d || p.startsWith(`${d}.`))).length;
};
const timeOrder = (a, b) => a.at.localeCompare(b.at) || a.version - b.version;
const groupOf = (r) => { const m = /^item:([^/]+)/.exec(r.to); return m ? `item:${m[1]}` : '(no item)'; };

// Flow replay, counted from the rows and the steps: every row, grouped by item (the to address), each group in time
// order, and the steps' applied rows, refusals, changed actors and queued effects.
function expectedFlow(rows, steps, needs = loadNeeds('flow-replay')) {
  const by = new Map(steps.map((s) => [s.version, s]));
  const blank = () => ({ rows: 0, steps: 0, refused: 0, actors: 0, effects: 0, placeholders: 0, order: [] });
  const add = (g, r) => {
    const s = by.get(r.version);
    g.rows++;
    g.placeholders += placeholdersOf(r, needs);
    if (s.refused != null) g.refused++;
    else { g.steps++; g.actors += s.actors.length; g.effects += s.effects.length; }
    g.order.push(r.version);
  };
  const all = blank();
  const groups = {};
  for (const r of [...rows].sort(timeOrder)) { add(all, r); add((groups[groupOf(r)] ??= blank()), r); }
  return { ...all, groups: Object.keys(groups).length, byGroup: groups };
}

// What the flow replay page shows: its tiles, each group's line, and the rows' versions in the order it steps.
function shownFlow(html) {
  const page = shown(html);
  const tiles = page.slice(0, page.indexOf('<section class="replay"'));
  const cards = [...page.matchAll(/<div class="card step" data-version="(\d+)" data-group="([^"]+)"/g)].map(([, v, g]) => [Number(v), unesc(g)]);
  const byGroup = {};
  for (const [, g, s] of page.matchAll(/<tr data-group="([^"]+)">(.*?)<\/tr>/gs))
    byGroup[unesc(g)] = { ...Object.fromEntries(['rows', 'steps', 'refused', 'actors', 'effects', 'placeholders'].map((k) => [k, num(s, k)])), order: cards.filter(([, c]) => c === unesc(g)).map(([v]) => v) };
  return { ...Object.fromEntries(['rows', 'steps', 'refused', 'actors', 'effects', 'placeholders', 'groups'].map((k) => [k, num(tiles, k)])), order: cards.map(([v]) => v), byGroup };
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

const check = (page, built) => {
  const html = pageOf(page, built);
  assert.doesNotMatch(shown(html), /class="banner bad"/, `${page} shows a banner`);
  if (page === 'flow-replay') {
    const want = expectedFlow(built.rows, built.steps);
    assert.deepEqual(shownFlow(html), { ...want, order: [...built.rows].sort(timeOrder).map((r) => r.version) }, `${page}'s counts`);
  } else assert.deepEqual(shownLog(html), expectedLog(built.rows), `${page}'s counts`);
  return html;
};

// The card of one row, as the page shows it.
const cardOf = (html, version) => new RegExp(`<div class="card step" data-version="${version}"[^>]*>(.*?)</div>(?=<div class="card step"|</section>)`, 's').exec(shown(html))?.[1];

// The refusals in a history's steps that are neither a row its join refused nor a second row of one id; and the join's
// refusals missing from the steps.
function refusals(steps, dir) {
  const joined = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')).refused;
  const listed = steps.filter((s) => s.refused != null).map((s) => `${s.id}: ${s.refused}`);
  const twice = (s) => s.refused.startsWith('replay applies one event per id') && steps.some((o) => o.id === s.id && o.version < s.version && o.refused == null);
  return [
    ...joined.filter((j) => !listed.includes(j)).map((j) => `not in the steps: ${j}`),
    ...steps.filter((s) => s.refused != null && !joined.includes(`${s.id}: ${s.refused}`) && !twice(s)).map((s) => `not a join refusal: ${s.version} ${s.id}: ${s.refused}`)
  ];
}

// Every actor's state and every context field of a snapshot, by address ({} has no state: it reads as '').
const everything = (snapshot) => changes({ value: {}, context: {} }, snapshot);

test('harness replay --steps writes one step per history row, from the replay path, each as history.schema.json declares', async () => {
  for (const built of [golden(), await contract()]) {
    const { dir, rows, steps } = built;
    assert.deepEqual(steps.map((s) => [s.version, s.id]), rows.map((r) => [r.version, r.id]), 'one step per row, in the history\'s order');
    assert.deepEqual(steps.flatMap(stepProblems), []);
    // The same replay as harness replay: asking for the steps changes nothing it reports.
    const store = openStore(dir);
    const { rebuilt, steps: again, ...withSteps } = replay(store, { steps: true });
    const { rebuilt: _, ...plain } = replay(store);
    assert.deepEqual(withSteps, plain);
    assert.deepEqual(again, steps);
    // A row replay cannot apply is a step with its reason, never dropped: the rows the join refused, and a row whose
    // id an earlier row (of another source) holds, which replay, like the join, applies once.
    assert.deepEqual(refusals(steps, dir), []);
    for (const s of steps.filter((s) => s.refused != null)) assert.deepEqual([s.route, s.actors, s.context, s.effects], [null, [], [], []]);
    // Each row's effects are the ones the store queued for it, with the store's acks for each.
    const outbox = store.outbox();
    const acks = store.acks();
    for (const s of steps.filter((s) => s.refused == null)) {
      assert.deepEqual(s.effects.map((f) => [f.id, f.name, f.subject]), outbox.filter((e) => e.eventId === s.id).map((e) => [e.id, e.name, e.subject ?? null]), s.id);
      for (const f of s.effects) assert.deepEqual(f.acks.map((a) => a.outcome), acks.filter((a) => a.effectId === f.id).map((a) => a.outcome));
    }
    // The steps add up to the state the replay ends in: each actor's last after is its state there, each field's its value.
    const start = openStore(join(tempDir('harness-history-pages-init-'), 'store'));
    const stored = store.read().snapshot.context;
    init(start, { wipLimit: stored.wipLimitAtInit ?? stored.wipLimit }, rows[0].at); // as replay starts
    const first = everything(start.read().snapshot);
    const last = everything(rebuilt.snapshot);
    const stateOf = (list, address) => list.actors.find((a) => a.address === address)?.after ?? null;
    const fieldOf = (list, address, field) => list.context.find((c) => c.address === address && c.field === field)?.after ?? null;
    const folded = new Map();
    for (const a of first.actors) folded.set(`state ${a.address}`, a.after);
    for (const c of first.context) folded.set(`${c.address} ${c.field}`, JSON.stringify(c.after));
    for (const s of steps) {
      for (const a of s.actors) {
        assert.equal(a.before, folded.get(`state ${a.address}`) ?? null, `${s.id}: ${a.address} before`);
        folded.set(`state ${a.address}`, a.after);
      }
      for (const c of s.context) {
        assert.equal(JSON.stringify(c.before), folded.get(`${c.address} ${c.field}`) ?? 'null', `${s.id}: ${c.address} ${c.field} before`);
        folded.set(`${c.address} ${c.field}`, JSON.stringify(c.after));
      }
    }
    for (const [k, v] of folded) {
      const [address, field] = k.startsWith('state ') ? [k.slice(6)] : k.split(' ');
      assert.equal(v ?? null, field ? JSON.stringify(fieldOf(last, address, field)) : stateOf(last, address), k);
    }
  }
  assert.ok(golden().steps.some((s) => s.refused != null), 'the golden history has rows replay cannot apply');
  assert.ok((await contract()).steps.some((s) => s.effects.length && s.actors.length), 'the contract history has steps that change state and queue effects');
});

test('the flow replay and design log pages render the golden history, every count matching its rows and steps', () => {
  const built = golden();
  for (const page of PAGES) {
    const html = check(page, built);
    // The ledger's data age, Refresh and timed refreshes, nothing beside them.
    assert.equal(shown(html).match(/id="data-age"/g).length, 1);
    assert.equal(shown(html).match(/id="refresh"/g).length, 1);
    assert.equal(shown(html).match(/id="refreshes"/g).length, 1);
    assert.match(html, /harness\/history\/events\.jsonl/);
    // A placeholder is counted, never shown as a value.
    assert.doesNotMatch(html, /predates the event envelope/);
  }
  // Flow replay reads the steps beside the history, through the same Refresh.
  assert.match(pageOf('flow-replay', built), /"also":\{"steps\.jsonl":"harness\/history\/steps\.jsonl"\}/);
  const flow = shownFlow(pageOf('flow-replay', built));
  assert.ok(flow.byGroup['(no item)'], 'rows with no item address have their own group');
  assert.ok(flow.placeholders > 0, 'the golden history has placeholders flow replay counts');
  const log = expectedLog(built.rows);
  assert.ok(log.oob.length && log.answers && log.decisions && log.grants && log.requests, JSON.stringify(log));
});

test('the design log shows each out-of-band row with who ordered it, the message, what was done and the gates it skipped', () => {
  const built = golden();
  const page = shown(pageOf('design-log', built));
  for (const r of built.rows.filter((r) => r.event.type === 'OUT_OF_BAND')) {
    const card = new RegExp(`data-oob="${r.version}"(.*?)</div></div>`, 's').exec(page)?.[1];
    assert.ok(card, `no card for ${r.id}`);
    assert.ok(unesc(card).includes(`${r.event.orderedBy.kind}:${r.event.orderedBy.id}`), card);
    assert.ok(unesc(card).includes(r.event.message), card);
    assert.ok(unesc(card).includes(r.event.what), card);
    for (const g of r.event.skipped) assert.ok(card.includes(g), card);
  }
  const answer = built.rows.find((r) => r.event.type === 'STAND_IN_ANSWERED');
  assert.ok(unesc(page).includes(answer.event.answer.reason), 'a stand-in answer shows its reason');
});

test('each flow replay step shows its row and what it did: changed actors before and after, changed context, queued effects, or that it changed nothing', async () => {
  for (const built of [golden(), await contract()]) {
    const html = pageOf('flow-replay', built);
    const page = shown(html);
    for (const b of ['first', 'prev', 'next', 'last']) assert.match(page, new RegExp(`data-step="${b}"`));
    assert.match(page, /<span class="m" data-pos>1 \/ \d+<\/span>/);
    const cards = [...page.matchAll(/<div class="card step" data-version="\d+" data-group="[^"]+"( hidden)?>/g)];
    assert.equal(cards.length, built.rows.length);
    assert.equal(cards.filter(([, h]) => !h).length, 1, 'one row shown at a time');
    assert.equal(cards[0][1], undefined, 'the first row is shown first');
    for (const s of built.steps) {
      const r = built.rows.find((r) => r.version === s.version);
      const card = cardOf(html, s.version);
      assert.ok(card, `no card for row ${s.version}`);
      const text = unesc(card);
      for (const v of [r.event.type, r.id]) assert.ok(text.includes(v), `${v} not in ${text}`);
      if (s.refused != null) { assert.match(card, /data-refused/); assert.ok(text.includes(s.refused), text); continue; }
      const none = !s.actors.length && !s.context.length && !s.effects.length;
      assert.equal(/data-unchanged/.test(card), none, `row ${s.version}: a step that changed nothing says so, and only that one`);
      for (const a of s.actors) {
        const li = new RegExp(`<li data-actor="${a.address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">(.*?)</li>`, 's').exec(text)?.[1];
        assert.ok(li, `row ${s.version}: ${a.address} not shown`);
        for (const v of [a.before, a.after]) assert.ok(v == null ? li.includes('none') : li.includes(v), `row ${s.version}: ${a.address} ${v} not in ${li}`);
      }
      const asText = (v) => (v == null ? 'none' : typeof v === 'string' ? v : JSON.stringify(v));
      for (const c of s.context) assert.ok(text.includes(`data-field="${c.address} ${c.field}"`) && text.includes(asText(c.before).slice(0, 40)) && text.includes(asText(c.after).slice(0, 40)), `row ${s.version}: ${c.address} ${c.field}`);
      for (const f of s.effects) assert.ok(text.includes(`data-effect="${f.id}"`) && text.includes(f.name), `row ${s.version}: effect ${f.id}`);
      for (const id of s.route ?? []) assert.ok(text.includes(id), `row ${s.version}: route ${id}`);
    }
  }
  assert.ok(golden().steps.some((s) => s.refused == null && !s.actors.length && !s.context.length && !s.effects.length) || (await contract()).steps.some((s) => s.refused == null && !s.actors.length && !s.context.length && !s.effects.length), 'a history here has a step that changed nothing');
});

test('the page script follows one item or the whole history: first, previous, next and last each show one row, with its position', () => {
  const html = renderLivePage(golden().rows, { page: 'flow-replay', also: { [STEPS]: golden().steps } });
  assert.match(html, /\.step\[hidden\]\{display:none\}/, 'a hidden step card is not drawn (.card sets display)');
  assert.match(html, /\$\('view'\)\.addEventListener\('click', step\)/, 'the page script wires the step buttons');
  // The section as the inlined step() sees it in the browser: rows 1..6 in time order, across items a and b.
  const groups = ['item:a', 'item:b', 'item:a', '(no item)', 'item:b', 'item:a'];
  const cards = groups.map((group, i) => ({ v: i + 1, hidden: i > 0, dataset: { group, version: String(i + 1) } }));
  const pos = { textContent: '1 / 6' };
  const following = { textContent: '' };
  const follows = ['', 'item:a', 'item:b', '(no item)'].map((f) => ({ dataset: { follow: f }, pressed: null, setAttribute(k, v) { this.pressed = v; } }));
  const section = { dataset: { steps: '' }, querySelectorAll: (sel) => (sel === '[data-version]' ? cards : follows), querySelector: (sel) => (sel === '[data-pos]' ? pos : following) };
  const press = (dataset) => step({ target: { closest: () => ({ dataset, closest: () => section }) } });
  const shownNow = () => cards.filter((r) => !r.hidden).map((r) => r.v);
  // The whole history, in time order across items.
  for (const [s, want] of [['next', 2], ['next', 3], ['last', 6], ['next', 6], ['prev', 5], ['first', 1], ['prev', 1]]) {
    press({ step: s });
    assert.deepEqual(shownNow(), [want], `whole history ${s}`);
    assert.equal(pos.textContent, `${want} / 6`);
  }
  assert.equal(following.textContent, 'Following the whole history');
  // Follow item:a: row 1 is in it, so it stays; then its rows only (1, 3, 6).
  press({ follow: 'item:a' });
  assert.deepEqual(shownNow(), [1]);
  assert.equal(pos.textContent, '1 / 3');
  assert.equal(following.textContent, 'Following item:a');
  assert.deepEqual(follows.map((f) => f.pressed), ['false', 'true', 'false', 'false']);
  for (const [s, want, at] of [['next', 3, 2], ['next', 6, 3], ['next', 6, 3], ['prev', 3, 2], ['first', 1, 1], ['last', 6, 3]]) {
    press({ step: s });
    assert.deepEqual(shownNow(), [want], `item:a ${s}`);
    assert.equal(pos.textContent, `${at} / 3`);
  }
  // Follow item:b from row 6 (not one of its rows): its first row; then back to the whole history, where it is row 2.
  press({ follow: 'item:b' });
  assert.deepEqual(shownNow(), [2]);
  assert.equal(pos.textContent, '1 / 2');
  press({ step: 'next' });
  assert.deepEqual(shownNow(), [5]);
  press({ follow: '' });
  assert.deepEqual(shownNow(), [5]);
  assert.equal(pos.textContent, '5 / 6');
  press({ step: 'next' });
  assert.deepEqual(shownNow(), [6]);
});

test('both pages render a history the current code builds, with counts that match its rows and steps', async () => {
  const built = await contract();
  for (const page of PAGES) {
    assert.deepEqual(checkPage(page, { history: built.rows, also: { [STEPS]: built.steps } }), [], `${page}'s needs are not met by the history the current code builds`);
    check(page, built);
  }
  assert.ok(expectedLog(built.rows).oob.length, 'the contract history has an out-of-band row');
});

// Drop one declared field from a schema: the property its path names, through $ref, anyOf and an array's items.
function drop(schema, nodes, path) {
  const ref = (n) => (n && n.$ref ? ref(n.$ref.slice(2).split('/').reduce((x, k) => x?.[k], schema)) : n);
  const forms = (n) => { n = ref(n); return !n ? [] : n.anyOf ? n.anyOf.flatMap(forms) : n.items ? [n, ...forms(n.items)] : [n]; };
  const keys = path.split('.');
  for (const [i, k] of keys.entries()) {
    if (i === keys.length - 1) for (const n of nodes.flatMap(forms)) { if (n.properties) delete n.properties[k]; if (n.required) n.required = n.required.filter((x) => x !== k); }
    nodes = nodes.flatMap(forms).map((n) => n.properties?.[k]).filter(Boolean);
  }
}

test('a field a page\'s needs file lists, dropped from the history schema or its steps, fails naming the page and the field', () => {
  for (const page of [...PAGES, 'ledger']) {
    const needs = loadNeeds(page);
    assert.deepEqual(checkLogNeeds(needs), [], `${page} reads a field history.schema.json does not declare`);
    for (const [type, fields] of Object.entries(needs.events))
      for (const f of fields) {
        const schema = structuredClone(HISTORY);
        drop(schema, [schema], f);
        if (f.startsWith('event.') && type !== '*' && schema.events.types[type].schema) drop(schema, [schema.events.types[type].schema], f.slice(6));
        const problems = checkLogNeeds(needs, undefined, schema);
        assert.ok(problems.some((p) => p.startsWith(`${page}: `) && p.includes(f) && p.includes('history.schema.json')), `${page} ${type} ${f}: ${problems.join('\n') || 'no problem'}`);
      }
  }
  // Flow replay reads the steps beside the history: each field it declares, dropped from history.schema.json steps.
  const needs = loadNeeds('flow-replay');
  assert.ok(needs.reads.with[STEPS].length, 'flow replay declares the step fields it reads');
  for (const f of needs.reads.with[STEPS]) {
    const schema = structuredClone(HISTORY);
    drop(schema, [schema.steps.row], f);
    const problems = checkLogNeeds(needs, undefined, schema);
    assert.deepEqual(problems, [`flow-replay: reads ${STEPS} field ${f}, which history.schema.json steps does not declare`]);
  }
  const other = structuredClone(needs);
  other.reads.with = { 'moves.jsonl': ['route'] };
  assert.deepEqual(checkLogNeeds(other), ['flow-replay: reads moves.jsonl beside the history, which history.schema.json does not declare']);
});

test('a field of the steps file a page declares, missing from the step file, fails naming the page and the field', () => {
  const { rows, steps } = golden();
  const needs = loadNeeds('flow-replay');
  for (const f of needs.reads.with[STEPS]) {
    const [head, ...rest] = f.split('.');
    const lacking = steps.map((s) => {
      const c = structuredClone(s);
      if (!rest.length) delete c[head];
      else for (const x of c[head]) delete x[rest.join('.')];
      return c;
    });
    if (rest.length && !steps.some((s) => s[head].length)) continue;
    const problems = checkPage('flow-replay', { history: rows, also: { [STEPS]: lacking } });
    assert.ok(problems.some((p) => p.startsWith(`flow-replay: reads ${STEPS} field ${f}, which `) && /steps? [\d, ]+/.test(p)), `${f}: ${problems.join('\n')}`);
  }
});

test('a field either page reads that its needs file does not declare fails, naming the page and the field', () => {
  const { rows, steps } = golden();
  for (const [page, type, field] of [['flow-replay', '*', 'provenance.origin'], ['design-log', 'STAND_IN_ANSWERED', 'event.answer.reason'], ['design-log', 'OUT_OF_BAND', 'event.orderedBy']]) {
    const needs = structuredClone(loadNeeds(page));
    needs.events[type] = needs.events[type].filter((f) => f !== field);
    const problems = checkPage(page, { history: rows, also: { [STEPS]: steps }, needs });
    assert.ok(problems.some((p) => p.startsWith(`${page}: reads `) && p.includes(field) && p.includes('needs.json')), `${page} ${field}: ${problems.join('\n')}`);
  }
  for (const field of ['actors.before', 'effects.acks', 'refused']) {
    const needs = structuredClone(loadNeeds('flow-replay'));
    needs.reads.with[STEPS] = needs.reads.with[STEPS].filter((f) => f !== field);
    const problems = checkPage('flow-replay', { history: rows, also: { [STEPS]: steps }, needs });
    assert.ok(problems.includes(`flow-replay: reads ${STEPS} field ${field}, which pages/flow-replay/needs.json does not declare`), `${field}: ${problems.join('\n')}`);
  }
});

test('a history outside either page\'s schemaVersion range, or without its steps, shows the red banner and no data', () => {
  const { rows, steps } = golden();
  for (const page of PAGES)
    for (const schemaVersion of [0, 2]) {
      const html = shown(pageOf(page, { rows: rows.map((r, i) => (i === 3 ? { ...r, schemaVersion } : r)), steps }));
      assert.match(html, /class="banner bad"/, page);
      assert.match(html, new RegExp(`schemaVersion ${schemaVersion}`));
      assert.doesNotMatch(html, /data-count|data-version|data-oob/, `${page}: no partial data under the banner`);
    }
  // Flow replay with no steps, or steps of another history, shows the banner and says how to build them.
  for (const [also, says] of [[{}, /reads steps\.jsonl beside this events\.jsonl, and there is none/], [{ [STEPS]: steps.slice(1) }, /not this history's: row 1 \(/], [{ [STEPS]: [...steps, { ...steps[0], version: 999 }] }, /29 steps for 28 rows/]]) {
    const html = shown(renderLivePage(rows, { page: 'flow-replay', also }));
    assert.match(html, /class="banner bad"/);
    assert.match(html, says);
    assert.match(html, /harness replay --steps/);
    assert.doesNotMatch(html, /data-count|data-version/);
  }
  // The design log reads no steps, so it needs none.
  assert.doesNotMatch(shown(renderLivePage(rows, { page: 'design-log' })), /class="banner bad"/);
});

test('harness page --live renders flow replay from a history and the steps beside it, and refuses without them', () => {
  const dir = join_([GOLDEN], join(tempDir('harness-history-pages-cli-'), 'history'));
  const page = () => spawnSync(process.execPath, [BIN, 'page', '--live', '--page', 'flow-replay', '--dir', dir, '--files-path', 'harness/h'], { encoding: 'utf8' });
  const without = page();
  assert.equal(without.status, 1);
  assert.match(without.stderr, /no steps\.jsonl in .*harness replay --steps writes it/);
  stepsOf(dir);
  const r = page();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).reads, 'harness/h/events.jsonl, harness/h/steps.jsonl');
  const html = readFileSync(join(dir, 'flow-replay-live.html'), 'utf8');
  assert.doesNotMatch(shown(html), /class="banner bad"/);
  assert.equal(num(shown(html), 'steps'), golden().steps.filter((s) => s.refused == null).length);
});

// The design log's paging and calendar (#131), on a history of more than 50 design-log rows over five UTC days in two
// months (the golden history and rows added on 2026-09-29, 2026-09-30 and 2026-10-28, renumbered in time order).
const CALENDAR = fileURLToPath(new URL('./fixtures/history-design-log/events.jsonl', import.meta.url));
const dayOf = (r) => r.at.slice(0, 10);
const calendarRows = () => parseLog(readFileSync(CALENDAR, 'utf8'));

// The design log as the inlined turn() sees it in the browser: the rendered page's rows, out-of-band cards, month
// grids and controls, each with its dataset and hidden flag, and a press of a control by its data attribute.
function logDom(html) {
  const page = shown(html);
  const el = (attrs, hidden) => {
    const dataset = {};
    for (const [, k, v] of attrs.matchAll(/data-([a-z]+)="([^"]*)"/g)) dataset[k] = unesc(v);
    return { dataset, hidden: Boolean(hidden), pressed: null, setAttribute(k, v) { if (k === 'aria-pressed') this.pressed = v; } };
  };
  const all = (re) => [...page.matchAll(re)].map(([, a, h]) => el(a, h));
  const rows = all(/<tr( data-kind="[a-z]+" data-version="\d+" data-on="[^"]*")( hidden)?>/g);
  const cards = all(/<div class="card"( data-oob="\d+" data-on="[^"]*")( hidden)?>/g);
  const months = all(/<table class="cal"( data-cal="[^"]*")( hidden)?>/g);
  const days = all(/<button type="button"( data-day="[^"]*")[^>]*>/g);
  const text = (name) => ({ textContent: unesc(new RegExp(`<span[^>]* data-${name}>([^<]*)</span>`).exec(page)?.[1] ?? '') });
  const pos = text('pos');
  const showing = text('showing');
  const log = /<div class="log" data-log="([^"]*)" data-at="(\d+)">/.exec(page);
  const section = {
    dataset: { log: log?.[1], at: log?.[2] },
    querySelectorAll: (sel) => ({ 'tr[data-on]': rows, '[data-oob]': cards, '[data-cal]': months, '[data-day]': days })[sel],
    querySelector: (sel) => ({ '[data-pos]': pos, '[data-showing]': showing })[sel]
  };
  const press = (dataset) => live.turn({ target: { closest: () => ({ dataset, closest: () => section }) } });
  const versions = (list) => list.filter((x) => !x.hidden).map((x) => Number(x.dataset.version ?? x.dataset.oob));
  return { page, log, rows, cards, months, days, pos, showing, press, shownRows: () => versions(rows), shownCards: () => versions(cards), month: () => months.filter((m) => !m.hidden).map((m) => m.dataset.cal) };
}

test('the design log shows 50 rows a page, newest first, with first, previous, next and last and its position', () => {
  const rows = calendarRows();
  const html = renderLivePage(rows, { page: 'design-log' });
  assert.deepEqual(shownLog(html), expectedLog(rows), 'the tiles count the whole history and every row is on the page');
  const newest = expectedLog(rows).decisions;
  assert.ok(newest.length > 50, `the fixture has ${newest.length} decision rows`);
  const dom = logDom(html);
  assert.ok(dom.log, 'the design log is one section the page script pages');
  for (const b of ['first', 'prev', 'next', 'last']) assert.match(dom.page, new RegExp(`<button type="button" data-page="${b}">`));
  const pages = Math.ceil(newest.length / 50);
  const at = (p) => `page ${p} of ${pages} · rows ${(p - 1) * 50 + 1} to ${Math.min(p * 50, newest.length)} of ${newest.length}`;
  // As rendered, before any script runs: page 1.
  assert.deepEqual(dom.shownRows(), newest.slice(0, 50));
  assert.equal(dom.pos.textContent, at(1));
  for (const [b, p] of [['next', 2], ['next', 2], ['first', 1], ['prev', 1], ['last', pages], ['prev', pages - 1]]) {
    dom.press({ page: b });
    assert.deepEqual(dom.shownRows(), newest.slice((p - 1) * 50, p * 50), `${b}: page ${p}`);
    assert.equal(dom.pos.textContent, at(p));
  }
  assert.equal(pages, 2);
});

test('the design log calendar marks each UTC day with its rows, Monday first; a day shows only its rows and cards, paged the same way', () => {
  const rows = calendarRows();
  const html = renderLivePage(rows, { page: 'design-log' });
  const dom = logDom(html);
  const want = expectedLog(rows);
  const of = rows.filter((r) => KINDS[r.event.type]);
  const perDay = {};
  for (const r of of) perDay[dayOf(r)] = (perDay[dayOf(r)] ?? 0) + 1;
  assert.ok(Object.keys(perDay).length >= 3 && new Set(Object.keys(perDay).map((d) => d.slice(0, 7))).size >= 2, JSON.stringify(perDay));
  // Each day with rows is a control carrying its count; the months with rows are grids, the newest shown.
  const counts = Object.fromEntries([...dom.page.matchAll(/data-day="(\d{4}-\d{2}-\d{2})"[^>]*>.*?<b data-count="day">(\d+)<\/b>/g)].map(([, d, n]) => [d, Number(n)]));
  assert.deepEqual(counts, perDay);
  assert.deepEqual(dom.months.map((m) => m.dataset.cal), ['2026-09', '2026-10']);
  assert.deepEqual(dom.month(), ['2026-10'], 'the calendar opens on the month of the newest row');
  for (const m of dom.months) {
    const [y, mo] = m.dataset.cal.split('-').map(Number);
    const grid = new RegExp(`<table class="cal" data-cal="${m.dataset.cal}"[^>]*>(.*?)</table>`, 's').exec(dom.page)[1];
    assert.match(grid, /<th>Mo<\/th><th>Tu<\/th><th>We<\/th><th>Th<\/th><th>Fr<\/th><th>Sa<\/th><th>Su<\/th>/);
    const weeks = [...grid.matchAll(/<tr>(<td.*?)<\/tr>/gs)].map(([, w]) => [...w.matchAll(/<td>(.*?)<\/td>/gs)].map(([, c]) => c));
    for (const w of weeks) assert.equal(w.length, 7, 'a week is a row of seven days');
    const cells = weeks.flat();
    const first = cells.findIndex((c) => c);
    assert.equal(first, (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7, `${m.dataset.cal}: day 1 under its weekday`);
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const days = cells.filter((c) => c);
    assert.equal(days.length, last, `${m.dataset.cal}: every day shown`);
    days.forEach((c, i) => {
      const day = `${m.dataset.cal}-${String(i + 1).padStart(2, '0')}`;
      assert.equal(/<button/.test(c), Boolean(perDay[day]), `${day}: a control only when it has rows`);
      assert.match(c, new RegExp(`>${i + 1}<`));
    });
  }
  // Months with rows can be moved between.
  dom.press({ month: 'next' });
  assert.deepEqual(dom.month(), ['2026-10']);
  dom.press({ month: 'prev' });
  assert.deepEqual(dom.month(), ['2026-09']);
  dom.press({ month: 'prev' });
  assert.deepEqual(dom.month(), ['2026-09']);
  // A day shows only its rows, newest first, and only its out-of-band cards; the busiest is paged.
  const busiest = Object.entries(perDay).sort((a, b) => b[1] - a[1])[0][0];
  for (const day of ['2026-09-30', '2026-09-29', busiest]) {
    dom.press({ day });
    const mine = want.decisions.filter((v) => dayOf(rows.find((r) => r.version === v)) === day);
    const cards = want.oob.filter((v) => dayOf(rows.find((r) => r.version === v)) === day);
    const pages = Math.max(1, Math.ceil(mine.length / 50));
    assert.deepEqual(dom.shownRows(), mine.slice(0, 50), `${day}: its rows`);
    assert.deepEqual(dom.shownCards(), cards, `${day}: its out-of-band cards`);
    assert.equal(dom.pos.textContent, `page 1 of ${pages} · rows 1 to ${Math.min(50, mine.length)} of ${mine.length}`);
    assert.equal(dom.showing.textContent, `Showing ${day} (UTC)`);
    assert.deepEqual(dom.days.filter((b) => b.pressed === 'true').map((b) => b.dataset.day), [day]);
    if (day === busiest) {
      assert.ok(mine.length > 50, `the busiest day has ${mine.length} decision rows`);
      dom.press({ page: 'next' });
      assert.deepEqual(dom.shownRows(), mine.slice(50, 100));
      assert.equal(dom.pos.textContent, `page 2 of 2 · rows 51 to ${mine.length} of ${mine.length}`);
    } else assert.ok(cards.length || day !== '2026-09-30', 'a September day has out-of-band cards');
  }
  // All days: every row again from page 1, every card.
  dom.press({ day: '' });
  assert.deepEqual(dom.shownRows(), want.decisions.slice(0, 50));
  assert.deepEqual(dom.shownCards(), want.oob);
  assert.equal(dom.showing.textContent, 'Showing all days');
  assert.deepEqual(dom.days.filter((b) => b.pressed === 'true').map((b) => b.dataset.day), ['']);
  assert.match(html, /\$\('view'\)\.addEventListener\('click', turn\)/, 'the page script wires the design log controls');
  assert.deepEqual(shownLog(html), want, 'the tiles stay the whole history\'s counts');
});

test('both pages render a joined dogfood2 history, and its steps hold every row as a step or a listed refusal', { skip: !DOGFOOD2 && 'the dogfood2 case did not run: HARNESS_DOGFOOD2_DIR names no store (CI has no Library). Run it against a path to dogfood2; it works on a copy' }, () => {
  const tmp = tempDir('harness-history-pages-dogfood2-');
  const copy = join(tmp, 'dogfood2');
  cpSync(DOGFOOD2, copy, { recursive: true });
  const ex = spawnSync(process.execPath, [join(SCRIPTS, 'extract-store.mjs'), copy, 'library/harness/state/dogfood2/events.jsonl'], { encoding: 'utf8' });
  assert.equal(ex.status, 0, ex.stderr);
  writeFileSync(join(tmp, 'candidates.jsonl'), ex.stdout);
  const built = stepsOf(join_([join(tmp, 'candidates.jsonl')], join(tmp, 'joined')));
  const { rows, steps } = built;
  assert.deepEqual(steps.map((s) => [s.version, s.id]), rows.map((r) => [r.version, r.id]), 'every row is a step or a refusal');
  assert.deepEqual(steps.flatMap(stepProblems), []);
  const refused = steps.filter((s) => s.refused != null);
  for (const s of refused) assert.ok(s.refused.length, `${s.id}: a refusal names its reason`);
  assert.deepEqual(refusals(steps, built.dir), []);
  for (const page of PAGES) {
    assert.deepEqual(checkPage(page, { history: rows, also: { [STEPS]: steps } }), [], page);
    check(page, built);
  }
  const log = expectedLog(rows);
  const flow = expectedFlow(rows, steps);
  console.log(`dogfood2: ${rows.length} rows, ${flow.groups} groups, ${flow.steps} steps, ${flow.refused} refused, ${flow.actors} changed actors, ${flow.effects} effects, ${log.oob.length} out-of-band, ${log.answers} stand-in answers`);
});
