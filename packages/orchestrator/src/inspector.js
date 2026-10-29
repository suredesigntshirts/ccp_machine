// A page to watch an item move: the machine drawn as a graph, and runs of it to step through. At each step the
// graph lights the state the item is in and the line that brought it there; a panel says what happened, why, by
// whom and with which commits, in the drawing's own words, and another shows only the context that step changed.
// Everything is read from the spec and the journals; where each state and line is drawn, and what each line is
// called, comes from a hand-made layout (spec/item.layout.json), and anything it does not place is still drawn.
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

const sha7 = (s) => (typeof s === 'string' && /^[0-9a-f]{40}$/.test(s) ? s.slice(0, 7) : s);

// How a piece of work came out, in a few words: a verdict and its commit, a choice and who made it, the commit a
// build made or a merge produced, a new head, or the error.
const detailOf = ({ output, error, headSha }) => {
  if (error != null) return String(error);
  if (headSha) return `head ${sha7(headSha)}`;
  if (output?.result) return `${output.result} at ${sha7(output.sha)}`;
  if (output?.choice) return `${output.choice} by ${output.by}`;
  if (output?.pr) return `commit ${sha7(output.pr.headSha)}`;
  if (output?.sha) return `as ${sha7(output.sha)}`;
  return null;
};

// Each journal entry with where it left the item, the edge it took, and the context fields it changed.
const stepsOf = (spec, graph, entries) => {
  const steps = [];
  let before = { state: null, context: {} };
  entries.forEach((entry, i) => {
    const { snapshot } = Host.replay(spec, entries.slice(0, i + 1));
    const state = String(snapshot.value);
    const context = snapshot.context;
    const changed = Object.keys(context).filter((k) => JSON.stringify(context[k] ?? null) !== JSON.stringify(before.context[k] ?? null));
    const edge = graph.edges.find((e) => e.from === before.state && e.to === state && e.when === whenOf(entry.event.type));
    steps.push({
      seq: entry.seq,
      at: entry.at,
      kind: kindOf(entry.event.type),
      what: entry.event.type === 'xstate.init' ? 'start' : whenOf(entry.event.type),
      detail: detailOf(entry.event),
      why: entry.event.output?.why ?? null,
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

// How a run ended, in one line: where it stopped, how many builds and replans it took.
const outcomeOf = (steps) => {
  if (!steps.length) return '';
  const last = steps.at(-1);
  const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const builds = steps.filter((s) => s.what === 'build done').length;
  const replans = steps.filter((s) => s.from === 'replanning' && s.state !== 'dropped').length;
  const end = last.state === 'done' ? 'Merged' : last.state === 'dropped' ? 'Dropped' : `Now in ${last.state}`;
  return [end, count(builds, 'build'), count(replans, 'replan'), count(steps.length, 'step')].join(' · ');
};

/** The inspector page, as HTML for an Artifact. runs: [{ name, about, entries }], each a journal to play; the page picks between them. */
export const itemInspector = (spec, runs = [], layout = null) => {
  const graph = graphOf(spec);
  const shown = runs.map(({ name, about, entries }) => {
    const steps = stepsOf(spec, graph, entries);
    return { name, about: about ?? '', outcome: outcomeOf(steps), steps };
  });
  const data = { description: spec.description, graph, layout, runs: shown };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return TEMPLATE.replace('__DATA__', () => json);
};

const TEMPLATE = String.raw`<title>Work Item Inspector</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
/* Layout: the drawing and its controls; the step (what happened, the run's steps); the detail (what changed, the
   state, the raw line). Three columns on a wide screen, two beside a side chat, one on a phone. */
:root{
  --bg:#f4f6f5; --panel:#ffffff; --fg:#1b2220; --muted:#5a6561; --line:#d5dcd8; --node:#ffffff; --nodeline:#7f8a86;
  --accent:#1f7a68; --accent-soft:#d6ece6; --hop:#b84c18; --code:#eef2f0;
  --fwd:#2e7d4f; --back:#9a5b0c; --bad:#b0413e; --start:#3b6fb6;
  --body:"IBM Plex Sans",system-ui,sans-serif; --mono:"IBM Plex Mono",ui-monospace,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#121715; --panel:#1a201e; --fg:#e2e8e5; --muted:#a3ada9; --line:#2c3431; --node:#1f2624; --nodeline:#6f7b77;
  --accent:#6fc7b1; --accent-soft:#1f3a33; --hop:#f0915c; --code:#232a28;
  --fwd:#73c193; --back:#e2a456; --bad:#ec8f8b; --start:#7ea6e0; color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#121715; --panel:#1a201e; --fg:#e2e8e5; --muted:#a3ada9; --line:#2c3431; --node:#1f2624; --nodeline:#6f7b77;
  --accent:#6fc7b1; --accent-soft:#1f3a33; --hop:#f0915c; --code:#232a28;
  --fwd:#73c193; --back:#e2a456; --bad:#ec8f8b; --start:#7ea6e0; color-scheme:dark}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font:14px/1.5 var(--body);margin:0}
.page{max-width:1880px;margin:0 auto;padding-block:20px 40px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:flex;flex-direction:column;gap:14px}
header{display:flex;flex-direction:column;gap:4px}
h1{font-size:1.35rem;margin:0;font-weight:600}
.sub{color:var(--muted);max-width:90ch;margin:0}
details.how{color:var(--muted);font-size:13px;max-width:90ch}
details.how summary{cursor:pointer;width:max-content}
.grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:14px;align-items:start}
.side{display:flex;flex-direction:column;gap:14px;min-width:0}
@media (min-width:1600px){.grid{grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr) minmax(0,1fr)}.side{display:contents}}
@media (max-width:980px){.grid{grid-template-columns:minmax(0,1fr)}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;min-width:0;display:flex;flex-direction:column;gap:10px}
h2{font-size:.78rem;margin:0;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;font-weight:600}
.runpick{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}
.runpick[hidden]{display:none}
.runpick select{max-width:100%;flex:1 1 220px}
.outcome{font:600 13px var(--mono)}
.about{font-size:12.5px;color:var(--muted);margin:0}
.diagram{overflow-x:auto}
.diagram svg{display:block;width:100%;min-width:560px;height:auto}
.n rect{fill:var(--node);stroke:var(--nodeline);stroke-width:1.4}
.n text{fill:var(--fg);font:600 12.5px var(--body)}
.n text.s{fill:var(--muted);font:400 10.5px var(--mono)}
.n text.cnt{fill:var(--hop);font:600 11px var(--mono)}
.n{cursor:pointer}
.n:focus-visible rect{stroke:var(--accent);stroke-width:2.4}
.n.touched rect{fill:var(--accent-soft);stroke:var(--accent)}
.n.from rect{stroke:var(--accent);stroke-dasharray:4 3;stroke-width:1.8}
.n.on rect{stroke:var(--hop);stroke-width:2.8;stroke-dasharray:none}
.n.sel rect{stroke:var(--fg);stroke-width:2.6;stroke-dasharray:none}
.start{fill:var(--fg)}
.e path{fill:none;stroke:var(--nodeline);stroke-width:1.6}
.e.back path{stroke-width:1.3;stroke-dasharray:5 3}
.e.fail path{stroke:var(--bad);stroke-width:1.2;opacity:.8}
.e text{fill:var(--muted);font:10.5px var(--mono);paint-order:stroke;stroke:var(--panel);stroke-width:4px}
.e.fail text{fill:var(--bad)}
.e.past path{stroke:var(--accent);stroke-width:2.6;opacity:1}
.e.fail.past path{stroke:var(--bad)}
.e.past text{fill:var(--fg)}
.e.now path{stroke:var(--hop);stroke-width:3;stroke-dasharray:7 5;animation:dash .7s linear infinite;opacity:1}
.e.now text{fill:var(--hop);font-weight:600}
@keyframes dash{to{stroke-dashoffset:-24}}
@media (prefers-reduced-motion:reduce){.e.now path{animation:none}}
.key{display:flex;flex-wrap:wrap;gap:4px 16px;color:var(--muted);font-size:12px}
.key svg{vertical-align:-2px;margin-right:5px}
.hint{display:none;color:var(--muted);font-size:12px;margin:0}
@media (max-width:620px){.hint{display:block}}
.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
button,select{font:500 13px var(--body);color:var(--fg);background:var(--panel);border:1px solid var(--nodeline);border-radius:6px;padding:5px 10px;cursor:pointer}
button:hover{border-color:var(--accent)} button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button.primary{background:var(--accent);color:var(--panel);border-color:var(--accent)}
input[type=range]{flex:1 1 160px;accent-color:var(--accent);min-width:0}
.mono{font-family:var(--mono)} .muted{color:var(--muted)}
.now .big{font:600 1.05rem var(--mono);overflow-wrap:anywhere;margin:2px 0}
.now .detail{font:500 13px var(--mono);overflow-wrap:anywhere}
.now .why{margin:0;font-size:13px;border-left:3px solid var(--line);padding-left:10px}
.kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 12px;font-size:13px;margin:0}
.kv dt{color:var(--muted)} .kv dd{margin:0;overflow-wrap:anywhere}
.ok{color:var(--fwd);font-weight:600} .no{color:var(--bad);font-weight:600}
ol.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
ol.steps button{width:100%;text-align:left;display:grid;grid-template-columns:2em minmax(0,1fr);gap:0 6px;padding:6px 8px;border:1px solid var(--line);border-left:4px solid var(--c);border-radius:7px;background:var(--panel)}
ol.steps .num{font:600 11px var(--mono);color:var(--muted);padding-top:2px}
ol.steps .t{font:500 12.5px var(--mono);overflow-wrap:anywhere}
ol.steps .d{grid-column:2;font:400 12px var(--mono);color:var(--muted);overflow-wrap:anywhere}
ol.steps li.later button{opacity:.55}
ol.steps li.cur button{border-color:var(--hop);border-left-color:var(--c);box-shadow:0 0 0 1px var(--hop)}
.tone-start{--c:var(--start)} .tone-fwd{--c:var(--fwd)} .tone-back{--c:var(--back)} .tone-fail{--c:var(--bad)}
.legend{display:flex;flex-wrap:wrap;gap:4px 12px;color:var(--muted);font-size:12px}
.legend span::before{content:"";display:inline-block;width:4px;height:12px;border-radius:2px;margin-right:6px;background:var(--c);vertical-align:-2px}
.tabs{display:flex;gap:6px;flex-wrap:wrap}
.tabs button[aria-pressed="true"]{background:var(--accent);color:var(--panel);border-color:var(--accent)}
.tab{display:flex;flex-direction:column;gap:10px}
.tab[hidden]{display:none}
.chg{border-top:1px solid var(--line);padding-top:6px;display:flex;flex-direction:column;gap:3px}
.chg:first-of-type{border-top:0;padding-top:0}
.chg .h{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.chg .was{font:12px var(--mono);color:var(--muted);overflow-wrap:anywhere}
.chg .v{font:12.5px var(--mono);overflow-wrap:anywhere}
pre{margin:0;background:var(--code);border-radius:6px;padding:8px;font:12px/1.45 var(--mono);overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
code{font-family:var(--mono);font-size:12.5px;overflow-wrap:anywhere}
details.all summary{cursor:pointer;color:var(--muted);font-size:13px}
ul.plain{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;font-size:13px}
.note{font-size:12.5px;color:var(--muted);border-left:3px solid var(--hop);padding-left:10px;margin:0}
</style>

<div class="page">
  <header>
    <h1>Work item inspector</h1>
    <p class="sub">One work item, from issue to merged commit. Pick a run and step through it: the drawing lights the path the item took, and the panels say what happened, why, and what changed.</p>
    <details class="how"><summary>How this page works</summary><p id="how"></p></details>
  </header>
  <div class="grid">
    <div class="card">
      <div class="runpick"><label for="run" class="muted">Run</label><select id="run"></select></div>
      <div><div class="outcome" id="outcome"></div><p class="about" id="about"></p></div>
      <div class="diagram" id="diagram"><p class="muted">Drawing the machine…</p></div>
      <p class="hint">Scroll the drawing sideways to see replanning.</p>
      <div class="key" aria-label="What the lines mean">
        <span><svg width="26" height="8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--nodeline)" stroke-width="1.6"/></svg>the way forward</span>
        <span><svg width="26" height="8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--nodeline)" stroke-width="1.3" stroke-dasharray="5 3"/></svg>goes back to try again</span>
        <span><svg width="26" height="8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--bad)" stroke-width="1.4"/></svg>went wrong, so replan</span>
        <span><svg width="26" height="8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--accent)" stroke-width="2.6"/></svg>taken so far</span>
        <span><svg width="26" height="8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--hop)" stroke-width="3" stroke-dasharray="7 5"/></svg>this step</span>
        <span>×2 entered twice</span>
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
    </div>
    <div class="side">
      <div class="card">
        <div class="now" id="now" aria-live="polite"></div>
        <h2>The run</h2>
        <ol class="steps" id="steps"></ol>
        <div class="legend"><span class="tone-fwd">forward</span><span class="tone-back">back to try again</span><span class="tone-fail">went wrong</span></div>
      </div>
      <div class="card">
        <div class="tabs" role="group" aria-label="Detail view">
          <button type="button" data-tab="step" aria-pressed="true">What changed</button>
          <button type="button" data-tab="state" aria-pressed="false">This state</button>
          <button type="button" data-tab="entry" aria-pressed="false">Raw journal line</button>
        </div>
        <div class="tab" id="tab-step"></div>
        <div class="tab" id="tab-state" hidden></div>
        <div class="tab" id="tab-entry" hidden></div>
      </div>
    </div>
  </div>
</div>
<script type="application/json" id="data">__DATA__</script>
<script>
const DATA = JSON.parse(document.getElementById('data').textContent);
const { graph, runs } = DATA;
const layout = DATA.layout || {};
let steps = runs[0]?.steps ?? [];
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
const placedOf = (e) => layout.edges?.[e.from + '>' + e.to + '>' + e.when];

let cur = 0; // the step shown; load() sets it
let tab = 'step';
let picked = null; // the state whose sheet "This state" shows; follows the step unless clicked
let drawn = null;

$('how').textContent = DATA.description + ' The drawing is read from item.machine.json; each run is a journal of the inputs the item took, replayed through the real machine, so the page cannot show a step the machine would refuse.';

// ---- Words: a step in the drawing's own words, who did it, and values cut to what a reader can scan

// A step is named by the state it left and the label of the line it took in the drawing.
const lineText = (e) => placedOf(e)?.label?.text || edgeLabel(e);
const titleOf = (s) => (s.edge ? s.from + ': ' + lineText(edgeById[s.edge]) : 'started');
const toneOf = (s) => (!s.edge ? 'start' : placedOf(edgeById[s.edge])?.kind || 'fwd');
const BY = { host: 'the host', person: 'the person', github: 'GitHub', timer: 'the timer', 'claude:builder': 'builder session', 'claude:verifier': 'verifier session', 'claude:stand-in': 'stand-in session' };
const byOf = (source) => BY[source] || (String(source).startsWith('claude:') ? 'Claude session ' + String(source).slice(7, 15) : String(source));
const when = (at) => at.slice(0, 16).replace('T', ' ') + ' UTC';
const isSha = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const isPath = (v) => typeof v === 'string' && /^(file:\/\/)?\//.test(v);
const short = (v) => (isSha(v) ? v.slice(0, 7) : isPath(v) ? '…/' + v.replace(/^file:\/\//, '').split('/').slice(-2).join('/') : v);
const tidy = (v) => (Array.isArray(v) ? v.map(tidy) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tidy(x)])) : short(v));
const shown = (v) => { const t = JSON.stringify(tidy(v)); return t.length <= 70 ? '<span class="v">' + esc(t) + '</span>' : '<pre>' + esc(JSON.stringify(tidy(v), null, 2)) + '</pre>'; };
const sha = (v) => '<code title="' + esc(v) + '">' + esc(short(v)) + '</code>';
const DONE_WORD = { approve: 'approved', reject: 'rejected', replan: 'replanned', drop: 'dropped' };

// The commits the item has handled so far, in order, with whether each check holds.
function commitsOf(c) {
  const parts = [];
  const head = c.pr?.headSha;
  if (head) parts.push('PR head ' + sha(head));
  if (c.verdict?.sha) parts.push(esc(c.verdict.result) + ' at ' + sha(c.verdict.sha) + ' ' + (c.verdict.sha === head ? '<span class="ok">✓ the PR head</span>' : '<span class="no">✗ not the PR head</span>'));
  if (c.decision?.choice) parts.push(esc(DONE_WORD[c.decision.choice] || c.decision.choice) + ' by ' + esc(c.decision.by));
  if (c.merge?.sha) parts.push('merged as ' + sha(c.merge.sha) + (c.merge.sha === c.verdict?.sha ? ' <span class="ok">✓ the verified commit</span>' : ' (a merge commit)'));
  return parts.join(' · ');
}

// ---- The graph, placed by hand in the layout file

// Where each state goes: the layout's place, or a plain row under it for a state the layout does not know.
function placeNodes() {
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
function routeOf(e, places) {
  const placed = placedOf(e);
  if (placed) return { points: placed.points, kind: placed.kind, label: { text: edgeLabel(e), ...placed.label } };
  const a = places[e.from], b = places[e.to];
  const from = [a.x + a.w / 2, a.y + a.h], to = [b.x + b.w / 2, b.y];
  return { points: [from, to], label: { x: (from[0] + to[0]) / 2 + 6, y: (from[1] + to[1]) / 2, anchor: 'start', text: edgeLabel(e) } };
}

function draw() {
  const { places, width, height } = placeNodes();
  const svg = svgEl('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': 'The work item machine: states and transitions' });
  const defs = svgEl('defs', {}, svg);
  const marker = svgEl('marker', { id: 'ah', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
  svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'context-stroke' }, marker);
  const edgeLayer = svgEl('g', {}, svg);
  const nodeLayer = svgEl('g', {}, svg);
  const edges = {}, nodes = {}, counts = {};

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
    const { points, label, kind } = routeOf(e, places);
    drawEdge(e.id, points, label, kind);
  }

  for (const n of graph.nodes) {
    const p = places[n.id];
    const group = svgEl('g', { class: 'n' + (n.final ? ' final' : ''), tabindex: 0, role: 'button', 'aria-label': 'State ' + n.id }, nodeLayer);
    svgEl('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: n.final ? p.h / 2 : 8 }, group);
    svgEl('text', { x: p.x + p.w / 2, y: p.y + (n.actor ? 21 : p.h / 2 + 4), 'text-anchor': 'middle' }, group).textContent = n.id;
    if (n.actor) svgEl('text', { x: p.x + p.w / 2, y: p.y + 38, 'text-anchor': 'middle', class: 's' }, group).textContent = 'starts ' + n.actor;
    counts[n.id] = svgEl('text', { x: p.x + p.w - 8, y: p.y + 15, 'text-anchor': 'end', class: 'cnt' }, group);
    const pick = () => { picked = n.id; setTab('state'); };
    group.addEventListener('click', pick);
    group.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); pick(); } });
    nodes[n.id] = group;
  }
  $('diagram').replaceChildren(svg);
  drawn = { nodes, edges, counts, edgeLayer };
  paint();
}

function paint() {
  const step = steps[cur];
  $('pos').textContent = steps.length ? 'Step ' + (cur + 1) + ' of ' + steps.length : 'no run';
  $('slider').value = cur + 1;
  $('slider').setAttribute('aria-valuetext', step ? 'Step ' + (cur + 1) + ' of ' + steps.length + ': ' + titleOf(step) : 'no run');
  [...$('steps').children].forEach((li, i) => { li.classList.toggle('cur', i === cur); li.classList.toggle('later', i > cur); });
  if (drawn) {
    const upto = steps.slice(0, cur + 1);
    const touched = new Set(upto.map((s) => s.state));
    const walked = new Set(upto.map((s) => s.edge).filter(Boolean));
    if (steps.length) walked.add('__init');
    for (const [id, group] of Object.entries(drawn.nodes)) {
      const entered = upto.filter((s) => s.state === id && s.from !== id).length;
      drawn.counts[id].textContent = entered > 1 ? '×' + entered : '';
      group.classList.toggle('touched', touched.has(id));
      group.classList.toggle('on', step?.state === id);
      group.classList.toggle('from', !!step && step.from === id && step.from !== step.state);
      group.classList.toggle('sel', tab === 'state' && picked === id && step?.state !== id);
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
  showNow(step);
  showChanges(step);
  showState(picked || step?.state || graph.initial);
  showEntry(step);
}

// ---- The panels

// What happened at this step, in a sentence, with its reason and the commits so far.
function showNow(step) {
  if (!step) {
    $('now').innerHTML = '<p class="note">This page was made from the spec alone, with no run to play. Click a state to see what it needs and hands on.</p>';
    return;
  }
  const commits = commitsOf(step.context);
  $('now').innerHTML =
    '<h2>Step ' + (cur + 1) + ' of ' + steps.length + ' · ' + esc(when(step.at)) + '</h2>' +
    '<div class="big">' + esc(titleOf(step)) + (step.from && step.from !== step.state ? ' → ' + esc(step.state) : '') + (step.done ? ' ✓' : '') + '</div>' +
    (step.detail ? '<div class="detail">' + esc(short(step.detail)) + '</div>' : '') +
    (step.why ? '<p class="why">' + esc(step.why) + '</p>' : '') +
    '<dl class="kv"><dt>By</dt><dd>' + esc(byOf(step.source)) + '</dd>' +
    (commits ? '<dt>Commits</dt><dd>' + commits + '</dd>' : '') +
    (step.edge && edgeById[step.edge].why ? '<dt>Rule</dt><dd>' + esc(edgeById[step.edge].why) + '</dd>' : '') + '</dl>';
}

// Only the context fields this step wrote, each with what it was before.
function showChanges(step) {
  if (!step) { $('tab-step').innerHTML = ''; return; }
  const before = cur ? steps[cur - 1].context : {};
  const rows = step.changed.filter((k) => step.context[k] != null || before[k] != null).map((k) => {
    const was = before[k], now = step.context[k];
    return '<div class="chg"><div class="h"><code>' + esc(k) + '</code>' + (now == null ? '<span class="muted">cleared</span>' : '') + '</div>' +
      (was != null ? '<div class="was">was ' + esc(JSON.stringify(tidy(was))) + '</div>' : '') +
      (now != null ? shown(now) : '') + '</div>';
  });
  $('tab-step').innerHTML = (rows.length ? rows.join('') : '<p class="muted">This step changed no context.</p>') +
    '<details class="all"><summary>All context after this step</summary><pre>' + esc(JSON.stringify(tidy(step.context), null, 2)) + '</pre></details>';
}

function showState(id) {
  const n = nodeById[id];
  const exits = graph.edges.filter((e) => e.from === id);
  const entries = graph.edges.filter((e) => e.to === id);
  $('tab-state').innerHTML =
    '<div><h2>State</h2><div class="now"><div class="big">' + esc(id) + (n.final ? ' (final)' : '') + '</div></div></div>' +
    '<div><h2>Needs before entering</h2>' + (n.needs.length ? '<ul class="plain">' + n.needs.map((g) => '<li><code>' + esc(g.name) + '</code>: ' + esc(g.conditions.join(', ')) + '</li>').join('') + '</ul>' : '<span class="muted">nothing</span>') + '</div>' +
    (n.actor ? '<div><h2>Starts ' + esc(n.actor) + ', handing it</h2><ul class="plain">' + n.input.map((i) => '<li><code>' + esc(i.name) + '</code> from <code>' + esc(i.from) + '</code></li>').join('') + '</ul></div>' : '') +
    (exits.length ? '<div><h2>Ways out</h2><ul class="plain">' + exits.map((e) => '<li><strong>' + esc(lineText(e)) + '</strong> → ' + esc(e.to) + ' <span class="muted">(on ' + esc(edgeLabel(e)) + ')</span>' + (e.writes.length ? '<br><span class="muted">saves ' + e.writes.map((w) => esc(w.field)).join(', ') + '</span>' : '') + (e.why ? '<br><span class="muted">' + esc(e.why) + '</span>' : '') + '</li>').join('') + '</ul></div>' : '') +
    '<div><h2>Ways in</h2>' + (entries.length ? '<ul class="plain">' + entries.map((e) => '<li>from ' + esc(e.from) + ': ' + esc(lineText(e)) + '</li>').join('') + '</ul>' : '<span class="muted">only the start</span>') + '</div>';
}

function showEntry(step) {
  $('tab-entry').innerHTML = step
    ? '<p class="note">The line in the item\'s journal that this step replays. The journal keeps only what came in from outside; everything else on this page is rebuilt from it, and the hash checks the rebuild.</p><pre>' + esc(JSON.stringify(step.entry, null, 2)) + '</pre>'
    : '<p class="note">No journal was given.</p>';
}

function setTab(name) {
  tab = name;
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-pressed', String(b.dataset.tab === name));
  for (const t of ['step', 'state', 'entry']) $('tab-' + t).hidden = t !== name;
  paint();
}

// ---- Controls

// Show one run from step at: its outcome, its steps, and that step.
function load(i, at = 0) {
  const run = runs[i];
  steps = run?.steps ?? [];
  cur = Math.min(Math.max(0, at), Math.max(0, steps.length - 1));
  picked = null;
  $('outcome').textContent = run?.outcome ?? '';
  $('about').textContent = run?.about ?? '';
  $('steps').innerHTML = steps.map((s, i) => '<li class="tone-' + toneOf(s) + '"><button type="button" data-i="' + i + '"><span class="num">' + (i + 1) + '</span><span class="t">' + esc(titleOf(s)) + ' → ' + esc(s.state) + '</span>' + (s.detail ? '<span class="d">' + esc(short(s.detail)) + '</span>' : '') + '</button></li>').join('') || '<li class="muted">No run.</li>';
  $('slider').max = Math.max(1, steps.length);
  paint();
}
$('run').innerHTML = runs.map((r, i) => '<option value="' + i + '">' + esc(r.name) + '</option>').join('');
$('run').closest('.runpick').hidden = !runs.length;
$('run').addEventListener('change', () => { stop(); load(Number($('run').value)); });
$('steps').addEventListener('click', (ev) => { const t = ev.target.closest('[data-i]'); if (t) { stop(); go(Number(t.dataset.i)); } });
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
// Arrows, Home and End step anywhere but in the run picker and the slider (which step on their own); Space plays
// unless a button has focus, where it presses the button.
document.addEventListener('keydown', (ev) => {
  if (ev.target.closest('select, input')) return;
  const keys = { ArrowRight: () => go(cur + 1), ArrowLeft: () => go(cur - 1), Home: () => go(0), End: () => go(steps.length - 1) };
  if (keys[ev.key]) { ev.preventDefault(); stop(); keys[ev.key](); }
  else if (ev.key === ' ' && !ev.target.closest('button, [role=button]')) { ev.preventDefault(); $('play').click(); }
});

load(0, Infinity); // the first run opens on its last step, so the whole path it walked shows at rest
try { draw(); } catch (err) { $('diagram').innerHTML = '<p class="note">The graph could not be drawn (' + esc(err.message) + '). The steps and data still work.</p>'; }
</script>
`;
