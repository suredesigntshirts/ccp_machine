// The page needs contract: each page declares, in pages/<page>/needs.json, the one store file it reads, the
// fields of it, the schemaVersion range it understands and the spec states and events it names. These tests
// build a store with the current runtime (the sim, never a frozen fixture) and fail naming the page and the
// missing piece when a runtime, store or spec change breaks what a page declares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { specs } from '../src/machines.js';
import { openStore, init, apply, status } from '../src/index.js';
import { PAGES, loadNeeds, checkPage, renderLivePage, slowRefreshes } from '../src/pages.js';
import { contractStore, scripted } from '../src/sim.js';
import { doctor } from '../src/doctor.js';

const clone = (x) => structuredClone(x);
let built;
const sim = async () => (built ??= await contractStore(tempDir('harness-pages-')));

test('every page is declared, and mission control is one of them', () => {
  assert.ok(PAGES.includes('mission-control'), `pages found: ${PAGES.join(', ')}`);
  for (const page of PAGES) assert.equal(loadNeeds(page).page, page, `pages/${page}/needs.json names another page`);
});

test("a store the current runtime builds meets every page's declared needs", async () => {
  const { store } = await sim();
  for (const page of PAGES) assert.deepEqual(checkPage(page, { state: store.read() }), [], `${page}'s needs are not met`);
});

test('a spec state a page names that the spec no longer has fails, naming the page and the state', async () => {
  const { store } = await sim();
  const renamed = clone(specs);
  const active = renamed.workItem.states.active.states;
  active.triagingRenamed = active.triaging;
  delete active.triaging;
  const problems = checkPage('mission-control', { state: store.read(), specs: renamed });
  assert.ok(problems.some((p) => /^mission-control: /.test(p) && p.includes('active.triaging') && p.includes('workItem')), problems.join('\n'));
});

test('an event a page names that the spec no longer has fails, naming the page and the event', async () => {
  const { store } = await sim();
  const dropped = clone(specs);
  const strip = (node) => { if (node.on) delete node.on.PERSON_DECIDED; Object.values(node.states ?? {}).forEach(strip); };
  strip(dropped.decision);
  const problems = checkPage('mission-control', { state: store.read(), specs: dropped });
  assert.ok(problems.some((p) => /^mission-control: /.test(p) && p.includes('PERSON_DECIDED')), problems.join('\n'));
});

test('a field a page needs that the store no longer has fails, naming the page and the field', async () => {
  const { store } = await sim();
  const state = clone(store.read());
  for (const c of Object.values(state.snapshot.children)) if (c.src === 'workItem') delete c.snapshot.context.title;
  const problems = checkPage('mission-control', { state });
  assert.ok(problems.some((p) => /^mission-control: /.test(p) && p.includes('context.title')), problems.join('\n'));
});

test('the contract store holds a grant and a decision made under it, and a store without them fails naming the page', async () => {
  const { store } = await sim();
  const { grant, granted } = store.read().snapshot.context;
  assert.ok(grant?.kinds?.length, 'the sim contract store has a live grant');
  assert.ok(granted?.length && granted.every((r) => r.reason), 'and a decision made under it, with its reason');
  for (const field of ['grant', 'granted']) {
    const state = clone(store.read());
    delete state.snapshot.context[field];
    const problems = checkPage('mission-control', { state });
    assert.ok(problems.some((p) => /^mission-control: /.test(p) && p.includes(`context.${field}`)), `${field}: ${problems.join('\n')}`);
  }
});

test('a field the page reads that its needs file does not declare fails, naming the page and the field', async () => {
  const { store } = await sim();
  const needs = clone(loadNeeds('mission-control'));
  needs.fields.item = needs.fields.item.filter((f) => f !== 'context.title');
  const problems = checkPage('mission-control', { state: store.read(), needs });
  assert.ok(problems.some((p) => /^mission-control: /.test(p) && p.includes('title') && p.includes('needs.json')), problems.join('\n'));
});

test('a state the view uses must be in the needs spec list, so the spec check covers it', () => {
  const needs = clone(loadNeeds('mission-control'));
  needs.spec.workItem.states = needs.spec.workItem.states.filter((s) => s !== 'active.building');
  const problems = checkPage('mission-control', { state: null, needs });
  assert.ok(problems.some((p) => /^mission-control: /.test(p) && p.includes('active.building')), problems.join('\n'));
});

test('the runtime records the spec schemaVersion on every write', () => {
  const store = openStore(tempDir('harness-schema-'));
  init(store, { wipLimit: 2 }, '2026-10-27T08:00:00Z');
  const want = specs.harness.meta.store.schemaVersion;
  assert.equal(typeof want, 'number');
  assert.equal(store.read().schemaVersion, want);
  apply(store, { type: 'ORCHESTRATOR_STARTED', ...scripted('ORCHESTRATOR_STARTED') }, { now: '2026-10-27T08:01:00Z' });
  assert.equal(store.read().schemaVersion, want);
  assert.equal(status(store).schemaVersion, want);
});

test('a store outside the page\'s schemaVersion range gets a red banner naming the mismatch and no data', async () => {
  const { store } = await sim();
  const ok = renderLivePage(store.read(), { page: 'mission-control' });
  assert.match(ok, /id="data-age"/);
  assert.match(ok, /id="refresh"/);
  const before = (html) => html.slice(0, html.indexOf('<script'));
  assert.doesNotMatch(before(ok), /class="banner bad"/);
  assert.match(before(ok), /<table/);
  for (const schemaVersion of [0, 2]) {
    const html = renderLivePage({ ...store.read(), schemaVersion }, { page: 'mission-control' });
    const shown = before(html);
    assert.match(shown, /class="banner bad"/);
    assert.match(shown, new RegExp(`schemaVersion ${schemaVersion}`));
    assert.match(shown, /reads 1 to 1/);
    assert.doesNotMatch(shown, /<table/, 'no partial data under the banner');
  }
  // A state.json written before the field has layout 1.
  const { schemaVersion, ...old } = store.read();
  assert.doesNotMatch(before(renderLivePage(old, { page: 'mission-control' })), /class="banner bad"/);
});

test('the live page embeds only the declared fields of the store', async () => {
  const { store } = await sim();
  const html = renderLivePage(store.read(), { page: 'mission-control', project: 'chan_x', path: 'harness/state/dogfood' });
  assert.ok(Buffer.byteLength(html) < 1e6);
  // Context the page does not declare (the item's roles, the decision's options) never reaches the page.
  for (const key of ['"orchestrator"', '"triagers"', '"answerers"', '"options"', '"appliedIds"']) assert.ok(!html.includes(key), `the page carries ${key}`);
  assert.match(html, /harness\/state\/dogfood\/state\.json/);
});

test('doctor flags a refresh slower than the spec threshold', async () => {
  const slow = specs.harness.meta.pages.refreshSlowMs;
  const rows = [
    { id: 'r1', data: { page: 'mission-control', at: '2026-10-27T10:00:00Z', ms: 120, storeVersion: 9, ok: true } },
    { id: 'r2', data: { page: 'mission-control', at: '2026-10-27T10:05:00Z', ms: slow + 1, storeVersion: 10, ok: true } }
  ];
  assert.deepEqual(slowRefreshes(rows).map((r) => r.id), ['r2']);
  const store = openStore(tempDir('harness-doctor-'));
  init(store, {}, '2026-10-27T08:00:00Z');
  const report = await doctor(store, { verify: false, refreshes: rows });
  assert.ok(report.ok);
  assert.ok(report.warnings.some((w) => w.includes('mission-control') && w.includes(`${slow + 1} ms`) && w.includes(`${slow} ms`)), report.warnings.join('\n'));
});
