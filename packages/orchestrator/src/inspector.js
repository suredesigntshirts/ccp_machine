// A page to watch an item move: the machine drawn as a graph, and the item's journal as steps to play through.
// At each step the graph lights the state the item is in and the transition that brought it there, and a
// panel shows the context with the fields that step wrote. Everything is read from the spec and the journal;
// where each state and arrow is drawn comes from a hand-made layout (spec/item.layout.json), and anything the
// layout does not place is still drawn, plainly. Its look follows the Harness Flow Replay page.
import { Host } from './host.js';

const asList = (transitions) => [transitions ?? []].flat().map((t) => (typeof t === 'string' ? { target: t } : t));
const sourceText = (source) => (typeof source === 'string' ? source : JSON.stringify(source.value));

const conditionText = (condition) => {
  if (typeof condition === 'string') return `${condition} is present`;
  if ('is' in condition) return `${condition.path} is ${JSON.stringify(condition.is)}`;
  if ('same' in condition) return `${condition.path} equals ${condition.same}`;
  return `${condition.path} is below ${condition.below}`;
};

// The machine as nodes and edges, each edge labelled by what happened and carrying what it writes.
const graphOf = (spec) => {
  const nodes = [];
  const edges = [];
  for (const [id, state] of Object.entries(spec.states)) {
    nodes.push({
      id,
      final: state.type === 'final',
      actor: state.invoke?.src ?? null,
      needs: (state.meta?.needs ?? []).map((name) => ({ name, conditions: spec.meta.guards[name].map(conditionText) })),
      input: Object.entries(state.invoke?.input ?? {}).map(([name, source]) => ({ name, from: sourceText(source) }))
    });
    const add = (when, transitions) =>
      asList(transitions).forEach((t) => {
        if (!t.target) return;
        const writes = (t.actions ?? []).flatMap(({ type, params }) =>
          type === 'inc' ? [{ field: params, from: '+ 1' }] : Object.entries(params).map(([field, from]) => ({ field, from: sourceText(from) }))
        );
        edges.push({ id: `e${edges.length}`, from: id, to: t.target, when, guard: t.guard ?? null, why: t.description ?? null, writes });
      });
    if (state.invoke) {
      add(`${state.invoke.id} done`, state.invoke.onDone);
      add(`${state.invoke.id} failed`, state.invoke.onError);
    }
    for (const [delay, t] of Object.entries(state.after ?? {})) add(`after ${delay}`, t);
    for (const [event, t] of Object.entries(state.on ?? {})) add(event, t);
  }
  return { initial: spec.initial, nodes, edges };
};

// What an event is called on an edge, and which kind of input it is (the timeline colours by kind).
const whenOf = (type) =>
  type.startsWith('xstate.done.actor.') ? `${type.slice(18)} done`
  : type.startsWith('xstate.error.actor.') ? `${type.slice(19)} failed`
  : type.startsWith('xstate.after.') ? `after ${type.split('.')[2]}`
  : type;
const kindOf = (type) =>
  type === 'xstate.init' ? 'start'
  : type.startsWith('xstate.done.actor.') ? 'done'
  : type.startsWith('xstate.error.actor.') ? 'failed'
  : type.startsWith('xstate.after.') ? 'timer'
  : 'outside';

// Each journal entry with where it left the item, the edge it took, and the context fields it changed.
const stepsOf = (spec, graph, entries) => {
  const steps = [];
  let before = { state: null, context: {} };
  entries.forEach((entry, i) => {
    const { snapshot } = Host.replay(spec, entries.slice(0, i + 1));
    const state = String(snapshot.value);
    const context = snapshot.context;
    const changed = Object.keys(context).filter((k) => JSON.stringify(context[k]) !== JSON.stringify(before.context[k]));
    const edge = graph.edges.find((e) => e.from === before.state && e.to === state && e.when === whenOf(entry.event.type));
    steps.push({
      seq: entry.seq,
      at: entry.at,
      kind: kindOf(entry.event.type),
      what: entry.event.type === 'xstate.init' ? 'start' : whenOf(entry.event.type),
      source: entry.source,
      run: entry.run ?? null,
      from: before.state,
      state,
      edge: edge?.id ?? null,
      context,
      changed,
      done: snapshot.status === 'done',
      entry
    });
    before = { state, context };
  });
  return steps;
};

/** The inspector page, as HTML for an Artifact. */
export const itemInspector = (spec, entries = [], layout = null) => {
  const graph = graphOf(spec);
  const data = { description: spec.description, graph, layout, steps: stepsOf(spec, graph, entries) };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return TEMPLATE.replace('__DATA__', () => json);
};

const TEMPLATE = String.raw`<title>Work Item Inspector</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
/* Layout: the machine's graph and the run's controls on the left, an inspector with tabs on the right; stacks on phones. */
:root{
  --bg:#f4f6f5; --panel:#ffffff; --fg:#1b2220; --muted:#5d6864; --line:#d5dcd8; --node:#ffffff; --nodeline:#aab5b0;
  --accent:#1f7a68; --accent-soft:#d6ece6; --hop:#c2551f; --code:#eef2f0;
  --k-start:#3b6fb6; --k-done:#2e7d4f; --k-failed:#b0413e; --k-timer:#a86412; --k-outside:#7a5bb5;
  --body:"IBM Plex Sans",system-ui,sans-serif; --mono:"IBM Plex Mono",ui-monospace,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#121715; --panel:#1a201e; --fg:#e2e8e5; --muted:#98a39f; --line:#2c3431; --node:#1f2624; --nodeline:#4a5551;
  --accent:#6fc7b1; --accent-soft:#1f3a33; --hop:#f0915c; --code:#232a28;
  --k-start:#7ea6e0; --k-done:#73c193; --k-failed:#e58a86; --k-timer:#e2a456; --k-outside:#b49be6; color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#121715; --panel:#1a201e; --fg:#e2e8e5; --muted:#98a39f; --line:#2c3431; --node:#1f2624; --nodeline:#4a5551;
  --accent:#6fc7b1; --accent-soft:#1f3a33; --hop:#f0915c; --code:#232a28;
  --k-start:#7ea6e0; --k-done:#73c193; --k-failed:#e58a86; --k-timer:#e2a456; --k-outside:#b49be6; color-scheme:dark}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font:14px/1.5 var(--body)}
.page{max-width:1400px;margin:0 auto;padding-block:20px 40px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:flex;flex-direction:column;gap:14px}
header{display:flex;flex-direction:column;gap:4px}
h1{font-size:1.35rem;margin:0;font-weight:600}
.sub{color:var(--muted);max-width:90ch;margin:0}
.grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:14px;align-items:start}
@media (max-width:980px){.grid{grid-template-columns:minmax(0,1fr)}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;min-width:0}
.diagram{overflow-x:auto;min-height:300px}
.diagram svg{display:block;width:100%;min-width:560px;height:auto}
.n rect{fill:var(--node);stroke:var(--nodeline);stroke-width:1.2}
.n text{fill:var(--fg);font:600 12.5px var(--body)}
.n text.s{fill:var(--muted);font:400 10.5px var(--mono)}
.n{cursor:pointer}
.n:focus-visible rect{stroke:var(--accent);stroke-width:2.4}
.n.touched rect{fill:var(--accent-soft);stroke:var(--accent)}
.n.from rect{stroke:var(--accent);stroke-dasharray:4 3;stroke-width:1.8}
.n.on rect{stroke:var(--hop);stroke-width:2.6}
.n.sel rect{stroke-dasharray:4 3;stroke:var(--fg);stroke-width:2}
.start{fill:var(--fg)}
.e path{fill:none;stroke:var(--nodeline);stroke-width:1.6}
.e.back path{stroke-width:1.2;stroke-dasharray:5 3}
.e.fail path{stroke:var(--k-failed);stroke-width:1;opacity:.45}
.e.fail text{fill:var(--k-failed)}
.e text{fill:var(--muted);font:10.5px var(--mono);paint-order:stroke;stroke:var(--panel);stroke-width:4px}
.e.past path{stroke:var(--accent);stroke-width:2;opacity:.75;stroke-dasharray:none}
.e.now path{stroke:var(--hop);stroke-width:2.8;stroke-dasharray:7 5;animation:dash .7s linear infinite;opacity:1}
.e.now text{fill:var(--hop);font-weight:600}
@keyframes dash{to{stroke-dashoffset:-24}}
@media (prefers-reduced-motion:reduce){.e.now path{animation:none}}
.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px}
button,select{font:500 13px var(--body);color:var(--fg);background:var(--panel);border:1px solid var(--nodeline);border-radius:6px;padding:5px 10px;cursor:pointer}
button:hover{border-color:var(--accent)} button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button.primary{background:var(--accent);color:var(--panel);border-color:var(--accent)}
input[type=range]{flex:1 1 200px;accent-color:var(--accent);min-width:0}
.mono{font-family:var(--mono)} .muted{color:var(--muted)}
.timeline{display:flex;gap:2px;height:26px;margin-top:10px;align-items:stretch}
.timeline i{flex:1 1 0;min-width:0;border-radius:2px;cursor:pointer;opacity:.85;background:var(--c)}
.timeline i.dim{opacity:.18} .timeline i.cur{outline:2px solid var(--fg);outline-offset:1px;opacity:1}
.key{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:4px;color:var(--muted);font-size:12px}
.key svg{vertical-align:-2px;margin-right:5px}
.hint{display:none;color:var(--muted);font-size:12px;margin:2px 0 0}
@media (max-width:620px){.hint{display:block}}
.legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:6px;color:var(--muted);font-size:12px}
.legend span::before{content:"";display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;background:var(--c);vertical-align:-1px}
.insp{display:flex;flex-direction:column;gap:12px}
.insp h2{font-size:.78rem;margin:0;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;font-weight:600}
.tabs{display:flex;gap:6px;flex-wrap:wrap}
.tabs button[aria-pressed="true"]{background:var(--accent);color:var(--panel);border-color:var(--accent)}
.tab{display:flex;flex-direction:column;gap:12px}
.tab[hidden]{display:none}
.big{font:600 1.05rem var(--mono);overflow-wrap:anywhere}
.arrow{color:var(--hop);font-weight:600}
.kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 12px;font-size:13px;margin:0}
.kv dt{color:var(--muted)} .kv dd{margin:0;overflow-wrap:anywhere}
.chg{border-top:1px solid var(--line);padding-top:6px;display:flex;flex-direction:column;gap:3px}
.chg:first-of-type{border-top:0;padding-top:0}
.chg .h{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.pill{display:inline-block;font:600 11px var(--mono);padding:1px 7px;border-radius:99px;background:var(--code);border:1px solid var(--line)}
.pill.new{color:var(--hop);border-color:currentColor}
pre{margin:0;background:var(--code);border-radius:6px;padding:8px;font:12px/1.45 var(--mono);overflow:auto;max-height:260px;white-space:pre-wrap;overflow-wrap:anywhere}
.chg.quiet pre{color:var(--muted)}
code{font-family:var(--mono);font-size:12.5px;overflow-wrap:anywhere}
ol.hops{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
ol.hops li{border:1px solid var(--line);border-radius:7px;padding:6px 8px;cursor:pointer}
ol.hops li.cur{border-color:var(--hop);box-shadow:inset 3px 0 0 var(--hop)}
ol.hops .h{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
ol.hops .num{font:600 11px var(--mono);color:var(--muted);min-width:1.6em}
ol.hops .lbl{font:500 12.5px var(--mono);overflow-wrap:anywhere}
.note{font-size:12.5px;color:var(--muted);border-left:3px solid var(--hop);padding-left:10px}
</style>

<div class="page">
  <header>
    <h1>Work item inspector</h1>
    <p class="sub" id="sub"></p>
  </header>
  <div class="grid">
    <div class="card">
      <div class="diagram" id="diagram"><p class="muted">Drawing the machine…</p></div>
      <p class="hint">Scroll the drawing sideways to see replanning.</p>
      <div class="key" aria-label="Kinds of transition">
        <span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--nodeline)" stroke-width="1.6"/></svg>the way forward</span>
        <span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--nodeline)" stroke-width="1.2" stroke-dasharray="5 3"/></svg>goes back to try again</span>
        <span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--k-failed)" stroke-width="1.4"/></svg>went wrong, so replan</span>
        <span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--hop)" stroke-width="2.6" stroke-dasharray="7 5"/></svg>this step</span>
      </div>
      <div class="controls">
        <button id="first" type="button" title="First step (Home)">⏮</button>
        <button id="prev" type="button" title="Previous step (←)">◀ Step</button>
        <button id="play" type="button" class="primary" title="Play (Space)">Play</button>
        <button id="next" type="button" title="Next step (→)">Step ▶</button>
        <input type="range" id="slider" min="1" value="1" aria-label="Step">
        <span class="mono" id="pos"></span>
      </div>
      <div class="controls">
        <label for="speed" class="muted">Speed</label>
        <select id="speed"><option value="1800">Slow</option><option value="1100" selected>Normal</option><option value="500">Fast</option></select>
        <span class="muted">Click a state to see what it needs and hands on.</span>
      </div>
      <div class="timeline" id="timeline" aria-label="The run, one mark per input; click to jump"></div>
      <div class="legend" id="legend"></div>
    </div>
    <div class="card insp">
      <div class="tabs" role="group" aria-label="Inspector view">
        <button type="button" data-tab="step" aria-pressed="true">This step</button>
        <button type="button" data-tab="state" aria-pressed="false">About this state</button>
        <button type="button" data-tab="entry" aria-pressed="false">Journal entry</button>
      </div>
      <div class="tab" id="tab-step"></div>
      <div class="tab" id="tab-state" hidden></div>
      <div class="tab" id="tab-entry" hidden></div>
      <div><h2>The run</h2><ol class="hops" id="hops"></ol></div>
    </div>
  </div>
</div>
<script type="application/json" id="data">__DATA__</script>
<script>
const DATA = JSON.parse(document.getElementById('data').textContent);
const { graph, steps } = DATA;
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs, parent) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
};
const nodeById = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
const edgeById = Object.fromEntries(graph.edges.map((e) => [e.id, e]));
const edgeLabel = (e) => e.when + (e.guard ? ' [' + e.guard + ']' : '');
const KINDS = { start: 'Start', done: 'Work done', failed: 'Work failed', timer: 'Timer', outside: 'Outside event' };

let cur = Math.max(0, steps.length - 1); // open on the last step, so the whole path walked shows at rest
let tab = 'step';
let picked = null; // the state whose sheet "About this state" shows; follows the step unless clicked
let drawn = null;

$('sub').textContent = DATA.description + ' Read from item.machine.json' + (steps.length ? ' and this item\'s journal: ' + steps.length + ' inputs, replayed through the real machine.' : '.');

// ---- The graph, placed by hand in the layout file

// Where each state goes: the layout's place, or a plain row under it for a state the layout does not know.
function placeNodes(layout) {
  const places = {};
  let spare = 0;
  for (const n of graph.nodes) {
    places[n.id] = layout.nodes?.[n.id] || { x: 20 + 170 * (spare % 4), y: (layout.height || 0) + 20 + 70 * Math.floor(spare / 4), w: 150, h: 50 };
    if (!layout.nodes?.[n.id]) spare++;
  }
  const bottom = Math.max(...Object.values(places).map((p) => p.y + p.h));
  return { places, width: layout.width || 720, height: Math.max(layout.height || 0, bottom + 20) };
}

// An edge's route: the layout's points, or a straight line between the two states' centres.
function routeOf(e, places, layout) {
  const placed = layout.edges?.[e.from + '>' + e.to + '>' + e.when];
  if (placed) return { points: placed.points, kind: placed.kind, label: { text: edgeLabel(e), ...placed.label } };
  const a = places[e.from], b = places[e.to];
  const from = [a.x + a.w / 2, a.y + a.h], to = [b.x + b.w / 2, b.y];
  return { points: [from, to], label: { x: (from[0] + to[0]) / 2 + 6, y: (from[1] + to[1]) / 2, anchor: 'start', text: edgeLabel(e) } };
}

function draw() {
  const layout = DATA.layout || {};
  const { places, width, height } = placeNodes(layout);
  const svg = svgEl('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': 'The work item machine: states and transitions' });
  const defs = svgEl('defs', {}, svg);
  const marker = svgEl('marker', { id: 'ah', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
  svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'context-stroke' }, marker);
  const edgeLayer = svgEl('g', {}, svg);
  const nodeLayer = svgEl('g', {}, svg);
  const edges = {}, nodes = {};

  const drawEdge = (id, points, label, kind) => {
    const group = svgEl('g', { class: 'e' + (kind ? ' ' + kind : '') }, edgeLayer);
    svgEl('path', { d: 'M' + points.map((p) => p.join(',')).join(' L'), 'marker-end': 'url(#ah)' }, group);
    if (label) svgEl('text', { x: label.x, y: label.y, 'text-anchor': label.anchor || 'start' }, group).textContent = label.text;
    edges[id] = group;
  };
  const start = layout.start || { x: places[graph.initial].x - 50, y: places[graph.initial].y + places[graph.initial].h / 2 };
  svgEl('circle', { cx: start.x, cy: start.y, r: 7, class: 'start' }, nodeLayer);
  drawEdge('__init', [[start.x + 7, start.y], [places[graph.initial].x, start.y]]);
  for (const e of graph.edges) {
    const { points, label, kind } = routeOf(e, places, layout);
    drawEdge(e.id, points, label, kind);
  }

  for (const n of graph.nodes) {
    const p = places[n.id];
    const group = svgEl('g', { class: 'n' + (n.final ? ' final' : ''), tabindex: 0, role: 'button', 'aria-label': 'State ' + n.id }, nodeLayer);
    svgEl('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: n.final ? p.h / 2 : 8 }, group);
    svgEl('text', { x: p.x + p.w / 2, y: p.y + (n.actor ? 21 : p.h / 2 + 4), 'text-anchor': 'middle' }, group).textContent = n.id;
    if (n.actor) svgEl('text', { x: p.x + p.w / 2, y: p.y + 38, 'text-anchor': 'middle', class: 's' }, group).textContent = 'starts ' + n.actor;
    const pick = () => { picked = n.id; setTab('state'); };
    group.addEventListener('click', pick);
    group.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
    nodes[n.id] = group;
  }
  $('diagram').replaceChildren(svg);
  drawn = { nodes, edges, edgeLayer };
  paint();
}

function paint() {
  const step = steps[cur];
  $('pos').textContent = steps.length ? 'step ' + (cur + 1) + ' / ' + steps.length : 'no run';
  $('slider').value = cur + 1;
  [...$('timeline').children].forEach((t, i) => { t.classList.toggle('cur', i === cur); t.classList.toggle('dim', i > cur); });
  [...$('hops').children].forEach((li, i) => li.classList.toggle('cur', i === cur));
  if (drawn) {
    const upto = steps.slice(0, cur + 1);
    const touched = new Set(upto.map((s) => s.state));
    const walked = new Set(upto.map((s) => s.edge).filter(Boolean));
    if (steps.length) walked.add('__init');
    for (const [id, group] of Object.entries(drawn.nodes)) {
      group.classList.toggle('touched', touched.has(id));
      group.classList.toggle('on', step?.state === id);
      group.classList.toggle('from', !!step && step.from === id && step.from !== step.state);
      group.classList.toggle('sel', tab === 'state' && picked === id);
    }
    for (const [id, group] of Object.entries(drawn.edges)) {
      const now = step && (step.edge === id || (id === '__init' && cur === 0));
      group.classList.toggle('now', !!now);
      group.classList.toggle('past', !now && walked.has(id));
    }
    // Edges that share a route (the failures into replanning) overlap: draw the walked ones, then the one just
    // taken, on top.
    for (const id of [...walked, step?.edge || (cur === 0 ? '__init' : null)].filter(Boolean)) drawn.edgeLayer.appendChild(drawn.edges[id]);
  }
  showStep(step);
  showState(picked || step?.state || graph.initial);
  showEntry(step);
}

// ---- The inspector

function showStep(step) {
  if (!step) {
    $('tab-step').innerHTML = '<p class="note">This page was made from the spec alone, with no run to play. Click a state to see what it needs and hands on.</p>';
    return;
  }
  const edge = step.edge && edgeById[step.edge];
  const fields = Object.entries(step.context).map(([k, v]) => {
    const changed = step.changed.includes(k);
    const empty = v == null;
    return '<div class="chg' + (changed ? '' : ' quiet') + '"><div class="h"><code>' + esc(k) + '</code>' + (changed ? '<span class="pill new">written now</span>' : '') + (empty ? '<span class="muted">empty</span>' : '') + '</div>' + (empty ? '' : '<pre>' + esc(JSON.stringify(v, null, 2)) + '</pre>') + '</div>';
  }).join('');
  $('tab-step').innerHTML =
    '<div><h2>Step ' + (cur + 1) + ' · ' + esc(step.at.slice(11, 19)) + '</h2><div class="big">' + (step.from ? esc(step.from) + ' <span class="arrow">→</span> ' : '<span class="arrow">→</span> ') + esc(step.state) + (step.done ? ' ✓' : '') + '</div></div>' +
    '<dl class="kv"><dt>What happened</dt><dd><span class="pill">' + esc(step.what) + '</span></dd>' +
    '<dt>From</dt><dd><code>' + esc(step.source) + '</code></dd>' +
    (step.run ? '<dt>Run</dt><dd><code>' + esc(step.run) + '</code></dd>' : '') +
    (edge && edge.why ? '<dt>Why this way</dt><dd>' + esc(edge.why) + '</dd>' : '') +
    (edge && edge.writes.length ? '<dt>Writes</dt><dd>' + edge.writes.map((w) => '<code>' + esc(w.field) + '</code> ← <code>' + esc(w.from) + '</code>').join('<br>') + '</dd>' : '') +
    '</dl><div><h2>Context after this step</h2></div>' + fields;
}

function showState(id) {
  const n = nodeById[id];
  const exits = graph.edges.filter((e) => e.from === id);
  const entries = graph.edges.filter((e) => e.to === id);
  $('tab-state').innerHTML =
    '<div><h2>State</h2><div class="big">' + esc(id) + (n.final ? ' (final)' : '') + '</div></div>' +
    '<div><h2>Needs to enter</h2>' + (n.needs.length ? n.needs.map((g) => '<div><code>' + esc(g.name) + '</code>: ' + esc(g.conditions.join(', ')) + '</div>').join('') : '<span class="muted">nothing</span>') + '</div>' +
    (n.actor ? '<div><h2>Starts ' + esc(n.actor) + ' with</h2>' + n.input.map((i) => '<div><code>' + esc(i.name) + '</code> ← <code>' + esc(i.from) + '</code></div>').join('') + '</div>' : '') +
    (exits.length ? '<div><h2>Ways out</h2><ol class="hops">' + exits.map((e) => '<li><div class="h"><span class="lbl">' + esc(edgeLabel(e)) + '</span> <span class="arrow">→</span> <strong>' + esc(e.to) + '</strong></div>' + (e.writes.length ? '<div class="muted">writes ' + e.writes.map((w) => '<code>' + esc(w.field) + '</code>').join(', ') + '</div>' : '') + (e.why ? '<div class="muted">' + esc(e.why) + '</div>' : '') + '</li>').join('') + '</ol></div>' : '') +
    '<div><h2>Ways in</h2>' + (entries.length ? entries.map((e) => '<div><code>' + esc(e.from) + '</code> on ' + esc(edgeLabel(e)) + '</div>').join('') : '<span class="muted">only the start</span>') + '</div>';
}

function showEntry(step) {
  $('tab-entry').innerHTML = step
    ? '<p class="note">The line in journal.jsonl this step replays. The journal holds only inputs from outside; the state is rebuilt from it, and the hash checks the replay.</p><pre>' + esc(JSON.stringify(step.entry, null, 2)) + '</pre>'
    : '<p class="note">No journal was given.</p>';
}

function setTab(name) {
  tab = name;
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-pressed', String(b.dataset.tab === name));
  for (const t of ['step', 'state', 'entry']) $('tab-' + t).hidden = t !== name;
  paint();
}

// ---- Controls

$('legend').innerHTML = Object.entries(KINDS).filter(([k]) => steps.some((s) => s.kind === k)).map(([k, label]) => '<span style="--c:var(--k-' + k + ')">' + label + '</span>').join('');
$('timeline').innerHTML = steps.map((s, i) => '<i style="--c:var(--k-' + s.kind + ')" title="' + esc((i + 1) + ': ' + s.what + ' → ' + s.state) + '" data-i="' + i + '"></i>').join('');
$('hops').innerHTML = steps.map((s, i) => '<li data-i="' + i + '"><div class="h"><span class="num">' + (i + 1) + '</span><span class="lbl">' + esc(s.what) + '</span><span class="arrow">→</span><span>' + esc(s.state) + '</span></div></li>').join('') || '<li class="muted">No run.</li>';
$('slider').max = Math.max(1, steps.length);
for (const id of ['timeline', 'hops']) $(id).addEventListener('click', (ev) => { const t = ev.target.closest('[data-i]'); if (t) go(Number(t.dataset.i)); });
$('slider').addEventListener('input', () => go(Number($('slider').value) - 1));
for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => { if (b.dataset.tab === 'state' && tab !== 'state') picked = null; setTab(b.dataset.tab); });

let timer = null;
const stop = () => { clearTimeout(timer); timer = null; $('play').textContent = 'Play'; };
function go(i) { cur = Math.min(Math.max(0, i), Math.max(0, steps.length - 1)); if (tab === 'state') picked = null; paint(); }
function tick() { if (cur >= steps.length - 1) return stop(); go(cur + 1); timer = setTimeout(tick, Number($('speed').value)); }
$('play').addEventListener('click', () => {
  if (timer) return stop();
  if (cur >= steps.length - 1) go(0);
  $('play').textContent = 'Pause';
  timer = setTimeout(tick, Number($('speed').value));
});
$('first').addEventListener('click', () => { stop(); go(0); });
$('prev').addEventListener('click', () => { stop(); go(cur - 1); });
$('next').addEventListener('click', () => { stop(); go(cur + 1); });
document.addEventListener('keydown', (ev) => {
  if (ev.target.closest('input, select, button, [role=button]')) return;
  if (ev.key === 'ArrowRight') { stop(); go(cur + 1); }
  else if (ev.key === 'ArrowLeft') { stop(); go(cur - 1); }
  else if (ev.key === 'Home') { stop(); go(0); }
  else if (ev.key === ' ') { ev.preventDefault(); $('play').click(); }
});

paint();
try { draw(); } catch (err) { $('diagram').innerHTML = '<p class="note">The graph could not be drawn (' + esc(err.message) + '). The steps and data still work.</p>'; }
</script>
`;
