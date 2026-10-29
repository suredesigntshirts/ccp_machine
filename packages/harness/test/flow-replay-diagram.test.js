// Flow replay's pretty-printed values and its architecture diagram (#130). The diagram is data
// (pages/flow-replay/diagram.json, named by the page's needs file): its boxes, arrows, which box sends a row, which
// box an actor's address is and which store files a step writes. These tests hold the data to the repo, check which
// boxes a step lights (lights(), and each card's data-lit) and drive the inlined step() as the browser would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.js';
import { loadNeeds, checkPage, renderLivePage } from '../src/pages.js';
import { renderData, lights, step, parseLog } from '../src/live.js';

const NEEDS_FILE = fileURLToPath(new URL('../pages/flow-replay/needs.json', import.meta.url));
const GOLDEN = fileURLToPath(new URL('./fixtures/history-golden/events.jsonl', import.meta.url));
const SCRIPTS = fileURLToPath(new URL('../scripts/history/', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/harness.js', import.meta.url));
const shown = (html) => (html.includes('<script') ? html.slice(0, html.indexOf('<script')) : html);

// A projected row as the page sees it, with its step.
const row = (version, { to = 'item:a', actor = { kind: 'session', id: 's1' }, source = { kind: 'cli', ref: 'harness send' }, type = 'CANCEL', step = {} } = {}) => ({
  id: `r${version}`, version, at: `2026-10-29T10:00:0${version}.000Z`, to, actor, source, event: { type }, provenance: { origin: 'live', from: { source: 'store' } },
  step: { refused: null, route: [], actors: [], context: [], effects: [], ...step }
});

test('flow replay pretty-prints every object or array before, after and context value and an effect\'s detail; short scalars stay inline', () => {
  const needs = loadNeeds('flow-replay');
  const r = row(1, {
    type: 'TRIAGED',
    actor: { kind: 'agent', id: 's1/a1', type: 'claude' },
    step: {
      actors: [{ address: 'item:a', before: 'active.triaging', after: 'active.awaitingPlanDecision' }],
      context: [
        { address: 'item:a', field: 'checks', before: {}, after: { 'login works': { verdict: 'met', by: 's1/a1' } } },
        { address: 'item:a', field: 'criteria', before: [], after: ['login works'] },
        { address: 'item:a', field: 'tier', before: null, after: 1 }
      ],
      effects: [{ id: 'r1.0', name: 'askStandIn', subject: 'decision:a:plan:1', detail: { question: 'Approve the plan?', options: ['approve', 'revise'] }, acks: [] }]
    }
  });
  const html = renderData([r], needs);
  const pre = (v) => `<pre class="json">${JSON.stringify(v, null, 2).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</pre>`;
  // A nested object: indented, one key per line, in its own block.
  assert.ok(html.includes(pre({ 'login works': { verdict: 'met', by: 's1/a1' } })), 'the nested context value is pretty-printed');
  assert.ok(html.includes('{\n  &quot;login works&quot;: {\n    &quot;verdict&quot;: &quot;met&quot;,\n    &quot;by&quot;'), 'indented, one key per line');
  assert.ok(html.includes(pre(['login works'])), 'an array is pretty-printed');
  assert.ok(html.includes(pre({ question: 'Approve the plan?', options: ['approve', 'revise'] })), 'the effect\'s detail is pretty-printed');
  // Scalars, and an empty object or array, stay inline.
  assert.ok(html.includes('<code>1</code>'), 'a number stays inline');
  assert.ok(html.includes('<code>active.triaging</code>') && html.includes('<code>active.awaitingPlanDecision</code>'), 'an actor\'s state stays inline');
  assert.ok(html.includes('<code>{}</code>') && html.includes('<code>[]</code>'), 'an empty value stays inline');
  // The block scrolls in its box and is monospace (the page's CSS).
  assert.match(renderLivePage([], { page: 'flow-replay' }), /\.step pre\.json\{[^}]*font:[^}]*var\(--mono\)[^}]*overflow:auto/);
});

const REQUIRED = ['person', 'standin', 'github', 'lead', 'triager', 'builder', 'verifier', 'spawnGate', 'identity', 'cli', 'harness', 'item', 'decision', 'budget', 'events', 'outbox', 'acks', 'state', 'steps'];

test('the diagram is data: the needs file names it, and each box has a zone, a sentence and a repo path that exists', () => {
  assert.equal(JSON.parse(readFileSync(NEEDS_FILE, 'utf8')).diagram, 'diagram.json', 'pages/flow-replay/needs.json says the page reads diagram.json');
  const d = loadNeeds('flow-replay').diagram;
  assert.equal(d.file, 'diagram.json');
  const ids = d.boxes.map((b) => b.id);
  for (const id of REQUIRED) assert.ok(ids.includes(id), `the diagram has no ${id} box`);
  for (const b of d.boxes) {
    for (const k of ['id', 'label', 'zone', 'what', 'path']) assert.ok(typeof b[k] === 'string' && b[k].length, `box ${b.id} has no ${k}`);
    assert.match(b.what, /^[^.]+(\.[^.]+)*\.$/s, `box ${b.id}: "what this is" ends a sentence`);
  }
  assert.deepEqual(checkPage('flow-replay'), [], 'every path exists, every arrow and rule names a declared box');
});

test('a box whose repo path does not exist, or an arrow, rule or actor naming an undeclared box, fails naming it', () => {
  const broken = (change) => { const needs = structuredClone(loadNeeds('flow-replay')); change(needs.diagram); return checkPage('flow-replay', { needs }); };
  assert.deepEqual(broken((d) => { d.boxes.find((b) => b.id === 'lead').path = 'plugins/harness/no-such-file.md'; }),
    ['flow-replay: diagram box lead names plugins/harness/no-such-file.md, which does not exist in the repo']);
  assert.deepEqual(broken((d) => { d.arrows.push({ from: 'lead', to: 'ghost', label: 'nothing' }); }),
    ['flow-replay: diagram arrow lead → ghost names box ghost, which diagram.json does not declare']);
  assert.deepEqual(broken((d) => { d.senders[0].boxes.push('ghost'); }),
    ['flow-replay: diagram sender rule 1 names box ghost, which diagram.json does not declare']);
  assert.deepEqual(broken((d) => { d.actors.item = 'ghost'; }),
    ['flow-replay: diagram actor kind item names box ghost, which diagram.json does not declare']);
  assert.deepEqual(broken((d) => { d.writes.ghost = 'always'; }),
    ['flow-replay: diagram writes names box ghost, which diagram.json does not declare']);
  assert.deepEqual(broken((d) => { d.boxes.find((b) => b.id === 'acks').zone = 'attic'; }),
    ['flow-replay: diagram box acks is in zone attic, which diagram.json does not declare']);
});

test('a step lights the box that sent its row, the actors it changed and the store files it wrote', () => {
  const d = loadNeeds('flow-replay').diagram;
  const lit = (r) => [...lights(r, d)].sort();
  const sorted = (...b) => b.sort();
  // A triager's TRIAGED: the agent, through the identity hooks and the CLI; the item and its new decision; the
  // history row, the snapshot and the queued effect.
  assert.deepEqual(lit(row(1, { type: 'TRIAGED', actor: { kind: 'agent', id: 's1/a1', type: 'claude' }, step: {
    actors: [{ address: 'item:a', before: 'active.triaging', after: 'active.awaitingPlanDecision' }, { address: 'item:a/decision:a:plan:1', before: null, after: 'askingStandIn' }],
    effects: [{ id: 'r1.0', name: 'askStandIn', subject: 'decision:a:plan:1', detail: null, acks: [] }]
  } })), sorted('triager', 'identity', 'cli', 'item', 'decision', 'events', 'state', 'outbox'));
  // The spawn gate records a spawn as the lead; it changes only the item's context; no effect.
  assert.deepEqual(lit(row(2, { type: 'WORKER_SPAWNED', step: { context: [{ address: 'item:a', field: 'spawns', before: [], after: [{ role: 'builder' }] }] } })),
    sorted('lead', 'spawnGate', 'identity', 'cli', 'item', 'events', 'state'));
  // SubagentStart binds the agent: the identity hooks.
  assert.deepEqual(lit(row(3, { type: 'WORKER_STARTED', actor: { kind: 'agent', id: 's1/a2', type: 'harness:builder' } })), sorted('identity', 'cli', 'events', 'state'));
  assert.deepEqual(lit(row(4, { type: 'STAND_IN_ANSWERED', actor: { kind: 'agent', id: 's1/a3', type: 'claude' } })), sorted('standin', 'identity', 'cli', 'events', 'state'));
  assert.deepEqual(lit(row(5, { type: 'RUN_SUCCEEDED', actor: { kind: 'agent', id: 's1/a2', type: 'harness:builder' } })), sorted('builder', 'identity', 'cli', 'events', 'state'));
  assert.deepEqual(lit(row(6, { type: 'VERDICT_GIVEN', actor: { kind: 'agent', id: 's1/a4', type: 'harness:verifier' } })), sorted('verifier', 'identity', 'cli', 'events', 'state'));
  // GitHub's wake, relayed by the lead; an effect with an ack lights the acks.
  assert.deepEqual(lit(row(7, { type: 'MERGED', actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref: 'o/r#1:merged' }, step: {
    actors: [{ address: 'item:a', before: 'active.merging', after: 'done' }, { address: 'harness', before: 'x', after: 'y' }],
    effects: [{ id: 'r7.0', name: 'dispatchRun', subject: 'b', detail: null, acks: [{ outcome: 'done', at: null, note: null }] }]
  } })), sorted('github', 'lead', 'identity', 'cli', 'item', 'harness', 'events', 'state', 'outbox', 'acks'));
  // The person's tap, relayed by the lead.
  assert.deepEqual(lit(row(8, { type: 'PERSON_DECIDED', actor: { kind: 'person', id: 'user_1' }, source: { kind: 'tap', ref: 'cmsg_1' }, to: 'item:a/decision:a:plan:1' })),
    sorted('person', 'lead', 'identity', 'cli', 'events', 'state'));
  assert.deepEqual(lit(row(9, { type: 'CANCEL', step: { actors: [{ address: 'budget', before: 'normal', after: 'paused' }] } })), sorted('lead', 'identity', 'cli', 'budget', 'events', 'state'));
  // A row replay could not apply wrote only the history row; a row whose sender no source recorded lights the CLI.
  assert.deepEqual(lit(row(10, { step: { refused: 'no actor at "item:x"' } })), sorted('lead', 'identity', 'cli', 'events'));
  assert.deepEqual(lit(row(11, { actor: { legacy: 'main predates the envelope' }, source: { legacy: 'main predates the envelope' }, type: 'TICK' })), sorted('cli', 'events', 'state'));
});

test('each card carries what it lights, and the diagram is drawn lit for the first row', () => {
  const needs = loadNeeds('flow-replay');
  const rows = [row(1, { type: 'RUN_SUCCEEDED', actor: { kind: 'agent', id: 's1/a2', type: 'harness:builder' }, step: { actors: [{ address: 'item:a', before: 'active.building', after: 'active.verifying' }] } }), row(2, { to: 'item:b' })];
  const html = renderData(rows, needs);
  assert.match(html, /<div class="card step" data-version="1" data-group="item:a" data-lit="builder identity cli item events state">/);
  assert.match(html, /<div class="card step" data-version="2" data-group="item:b" data-lit="lead identity cli events state" hidden>/);
  const svg = /<svg[^>]*>.*<\/svg>/s.exec(html)?.[0];
  assert.ok(svg, 'the page has the diagram');
  const on = [...svg.matchAll(/<g class="box on" data-box="([^"]+)"/g)].map(([, b]) => b).sort();
  assert.deepEqual(on, ['builder', 'cli', 'events', 'identity', 'item', 'state']);
  const arrows = [...svg.matchAll(/<g class="arrow on" data-arrow="([^"]+)"/g)].map(([, a]) => a).sort();
  assert.deepEqual(arrows, ['builder identity', 'cli events', 'cli item', 'cli state', 'identity cli']);
  // Every box is reachable by keyboard and says what it is.
  for (const b of needs.diagram.boxes) assert.match(svg, new RegExp(`data-box="${b.id}"[^>]*tabindex="0"`), b.id);
  assert.match(svg, /<text[^>]*>harness CLI · runtime<\/text>/);
});

// The section as the inlined step() sees it: cards, follow buttons, boxes and arrows with classList, the position.
function fakeSection(lit, boxes, arrows) {
  const classes = () => { const s = new Set(); return { set: s, toggle: (c, on) => (on ? s.add(c) : s.delete(c)), contains: (c) => s.has(c) }; };
  const cards = lit.map(([group, l], i) => ({ v: i + 1, hidden: i > 0, dataset: { group, version: String(i + 1), lit: l } }));
  const box = boxes.map((b) => ({ dataset: { box: b, what: `${b} is a box.`, path: `packages/${b}.js`, label: b.toUpperCase() }, classList: classes() }));
  const arrow = arrows.map((a) => ({ dataset: { arrow: a }, classList: classes() }));
  const about = { innerHTML: '' };
  const section = {
    dataset: { steps: '', repo: 'https://github.com/o/r/blob/main/' },
    querySelectorAll: (sel) => ({ '[data-version]': cards, '[data-follow]': [], '[data-box]': box, '[data-arrow]': arrow })[sel] ?? [],
    querySelector: (sel) => (sel === '[data-about]' ? about : { textContent: '' })
  };
  const press = (dataset, type = 'click') => step({ type, target: { closest: () => ({ dataset, closest: () => section }) } });
  const on = (list) => list.filter((x) => x.classList.contains('on')).map((x) => x.dataset.box ?? x.dataset.arrow);
  return { cards, box, arrow, about, press, on };
}

test('stepping lights the diagram for the row shown, following one item too', () => {
  const f = fakeSection([['item:a', 'lead identity cli item events state'], ['item:b', 'github lead identity cli events'], ['item:a', 'builder identity cli events']],
    ['lead', 'identity', 'cli', 'item', 'events', 'state', 'github', 'builder'], ['lead identity', 'identity cli', 'cli item', 'cli events', 'github lead', 'builder identity']);
  f.press({ step: 'next' });
  assert.deepEqual(f.on(f.box), ['lead', 'identity', 'cli', 'events', 'github']);
  assert.deepEqual(f.on(f.arrow), ['lead identity', 'identity cli', 'cli events', 'github lead']);
  f.press({ follow: 'item:a' });
  assert.deepEqual(f.cards.filter((c) => !c.hidden).map((c) => c.v), [1]);
  assert.deepEqual(f.on(f.box), ['lead', 'identity', 'cli', 'item', 'events', 'state']);
  f.press({ step: 'next' });
  assert.deepEqual(f.cards.filter((c) => !c.hidden).map((c) => c.v), [3]);
  assert.deepEqual(f.on(f.box), ['identity', 'cli', 'events', 'builder']);
  assert.deepEqual(f.on(f.arrow), ['identity cli', 'cli events', 'builder identity']);
});

test('clicking or focusing a box shows what it is and its repo path; focusing a step button does not step', () => {
  const f = fakeSection([['item:a', 'cli'], ['item:a', 'lead']], ['lead', 'cli'], []);
  f.press(f.box[1].dataset);
  assert.equal(f.about.innerHTML, '<b>CLI</b> cli is a box. <a href="https://github.com/o/r/blob/main/packages/cli.js"><code>packages/cli.js</code></a>');
  assert.ok(f.box[1].classList.contains('sel') && !f.box[0].classList.contains('sel'));
  f.press(f.box[0].dataset, 'focusin');
  assert.match(f.about.innerHTML, /^<b>LEAD<\/b> lead is a box\. <a href="https:\/\/github\.com\/o\/r\/blob\/main\/packages\/lead\.js">/);
  assert.deepEqual(f.cards.filter((c) => !c.hidden).map((c) => c.v), [1], 'a box shows what it is and steps nowhere');
  f.press({ step: 'next' }, 'focusin');
  assert.deepEqual(f.cards.filter((c) => !c.hidden).map((c) => c.v), [1], 'focus on a step button does not step');
  f.press({ step: 'next' });
  assert.deepEqual(f.cards.filter((c) => !c.hidden).map((c) => c.v), [2]);
  const html = renderLivePage([], { page: 'flow-replay' });
  assert.match(html, /\$\('view'\)\.addEventListener\('focusin', step\)/, 'the page script shows a box on focus');
});

test('the golden history\'s steps light what their rows did, on the page harness page --live renders', () => {
  const dir = join(tempDir('harness-flow-diagram-'), 'history');
  const j = spawnSync(process.execPath, [join(SCRIPTS, 'join.mjs'), GOLDEN, '--out', dir], { encoding: 'utf8' });
  assert.equal(j.status, 0, j.stderr);
  spawnSync(process.execPath, [BIN, 'replay', '--steps', '--dir', dir], { encoding: 'utf8' });
  const rows = parseLog(readFileSync(join(dir, 'events.jsonl'), 'utf8'));
  const steps = parseLog(readFileSync(join(dir, 'steps.jsonl'), 'utf8'));
  const page = shown(renderLivePage(rows, { page: 'flow-replay', also: { 'steps.jsonl': steps } }));
  const litOf = (v) => new RegExp(`<div class="card step" data-version="${v}" data-group="[^"]+" data-lit="([^"]*)"`).exec(page)?.[1].split(' ');
  const tap = rows.find((r) => r.event.type === 'PERSON_DECIDED');
  const tapStep = steps.find((s) => s.version === tap.version);
  assert.ok(tapStep.refused == null && tapStep.actors.some((a) => a.address.includes('/decision:')), 'the golden tap is applied and changes its decision');
  assert.deepEqual(litOf(tap.version).filter((b) => ['person', 'lead', 'decision', 'events', 'state'].includes(b)).sort(), ['decision', 'events', 'lead', 'person', 'state']);
  const merged = rows.find((r) => r.event.type === 'MERGED' && r.actor.kind === 'github');
  assert.deepEqual(litOf(merged.version).slice(0, 4), ['github', 'lead', 'identity', 'cli']);
  for (const s of steps.filter((s) => s.effects.length)) assert.ok(litOf(s.version).includes('outbox'), `row ${s.version} queued effects`);
  assert.equal(steps.filter((s) => s.effects.some((f) => f.detail !== undefined)).length, steps.filter((s) => s.effects.length).length, 'each queued effect carries its detail');
});
