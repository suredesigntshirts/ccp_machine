// A page to watch an item move: the machine drawn as a graph, and runs of it to step through. The page is a fixed
// frame: the drawing, the step's story, the run's steps and the detail each keep one box whatever the step, and
// only what is inside a box changes. Each step is told as a sentence (who did what, and what it found); each run
// opens with a sentence saying how it ended and why; the detail shows everything the item holds, with what the
// step added, changed or cleared marked as a diff. Everything is read from the spec and the journals; where each
// state and line is drawn, and what things are called, comes from a hand-made layout (spec/item.layout.json), and
// anything it does not place or name is still drawn, by its spec name.
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

// What an event is called on an edge, and which kind of input it is.
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

const CHOSEN = { approve: 'approved', reject: 'rejected', replan: 'replan chosen', drop: 'dropped' };
const sha7 = (s) => (typeof s === 'string' && /^[0-9a-f]{40}$/.test(s) ? s.slice(0, 7) : s);

// How a piece of work came out, in a few words: a verdict and its commit, a choice and who made it, the commit a
// build made or a merge produced, a new head, or the error.
const detailOf = ({ output, error, headSha }) => {
  if (error != null) return String(error);
  if (headSha) return `head ${sha7(headSha)}`;
  if (output?.result) return `${output.result} at ${sha7(output.sha)}`;
  if (output?.choice) return `${CHOSEN[output.choice] ?? output.choice} by the ${output.by}`;
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
      report: entry.event.output?.report ?? null,
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

// ---- Words: each step as a sentence, each run's steps in chapters, and each run's ending in one sentence.

// The most builds the item may make before it must be replanned: the bound in the guard on context.builds.
const buildLimitOf = (spec) =>
  Object.values(spec.meta?.guards ?? {}).flat().find((c) => typeof c === 'object' && c.path === 'context.builds' && 'below' in c)?.below ?? null;
const duration = (ms) => {
  const min = Math.round(ms / 60000);
  return min < 60 ? `${min} min` : `${+(min / 60).toFixed(1)} h`;
};
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const quoted = (t) => `“${String(t).replace(/\b[0-9a-f]{8,40}\b/g, (h) => h.slice(0, 7))}”`;
// A sentence's end: a period, unless it already ends in one (or in a quote that does).
const stop = (t) => (/[.!?]”?$/.test(t) ? t : t + '.');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Who did a step: whoever the answer names, else the role of the run it finished, else where it came from.
const ROLES = { brief: 'the host', build: 'the builder', verify: 'the verifier', ask: 'the stand-in', merge: 'the host' };
const SOURCES = { host: 'the host', person: 'the person', github: 'GitHub', timer: 'the time limit' };
const actorOf = (s) => {
  const named = s.entry.event.output?.by;
  if (named) return named === 'person' ? 'the person' : `the ${named}`;
  const role = s.run && s.source !== 'host' ? ROLES[s.run.split('.')[1]] : null;
  return role || SOURCES[s.source] || String(s.source).replace(/^claude:/, 'the ');
};
const byOf = (s) => actorOf(s) + (/^claude:[0-9a-f]{8}-/.test(s.source) ? ` (session ${s.source.slice(7, 15)})` : '');

const BUILD_PHASE = new Set(['building', 'verifying', 'awaitingMerge', 'merging']);

/** Sentences, chapters and the ending of one run's steps, in the layout's names. Adds sentence, by and chapter to each step. */
const tell = (steps, { names = {}, limit = null, delays = {} } = {}) => {
  const name = (id) => names[id] || id;
  const of = (n) => (limit ? `${n} of ${limit}` : String(n));
  const chapters = [];
  let build = 0;
  steps.forEach((s, i) => {
    const prev = steps[i - 1];
    const ev = s.entry.event, out = ev.output ?? {}, c = s.context, b = prev?.context ?? {};
    const err = ev.error != null ? String(ev.error) : '';
    const goesTo = s.state === 'replanning' ? ' The item goes to replanning.' : '';
    const actor = actorOf(s);
    const say = (() => {
      switch (s.what) {
        case 'start': return `${cap(actor)} opened the item for ${c.issue?.title ? quoted(c.issue.title) : `the issue ${c.issue?.url ?? ''}`}.`;
        case 'brief done': return `${cap(actor)} wrote the builder's and the verifier's briefs${c.why ? ', using the five whys' : ''}.`;
        case 'brief failed': return `The briefs could not be written: ${err}.${goesTo}`;
        case 'build done': return `The builder made commit ${sha7(out.pr?.headSha)}, build ${of(c.builds)}.`;
        case 'build failed': return `The builder's session failed in build ${of((b.builds ?? 0) + 1)}: ${err}.${goesTo}`;
        case 'verify done': {
          const v = sha7(out.sha), head = sha7(c.pr?.headSha);
          if (s.state === 'awaitingMerge') return `The verifier passed commit ${v}, the PR head. It now waits for approval to merge.`;
          if (s.state === 'building') return `The verifier failed commit ${v}. ${limit ? plural(limit - c.builds, 'build') + ' left, so' : 'So'} the builder builds again with the verdict.`;
          if (out.result === 'PASS') return `The verifier passed commit ${v}, but the PR head is now ${head}, so the PASS does not count.${goesTo}`;
          return `The verifier failed commit ${v}, and no builds are left (${of(c.builds)} made).${goesTo}`;
        }
        case 'verify failed': return `The verifier's session failed: ${err}.${goesTo}`;
        case 'pr.pushed': return s.from === 'verifying'
          ? `A new push moved the PR head from ${sha7(b.pr?.headSha)} to ${sha7(ev.headSha)}, so verification starts again on the new head.`
          : `A new push moved the PR head from ${sha7(b.pr?.headSha)} to ${sha7(ev.headSha)} after it passed, so the verdict no longer covers the head and it goes back to verifying.`;
        case 'ask done':
          if (s.from === 'awaitingMerge') return out.choice === 'approve'
            ? `${cap(actor)} approved merging commit ${sha7(c.verdict?.sha)}.`
            : stop(`${cap(actor)} rejected the merge${out.why ? ': ' + quoted(out.why) : ''}`) + goesTo;
          if (s.state === 'briefing') return `${cap(actor)} chose to replan, with a written five whys. Briefing starts again and the build count goes back to 0.`;
          return stop(`${cap(actor)} dropped the item${out.why ? ': ' + quoted(out.why) : ''}`);
        case 'ask failed': return s.from === 'replanning'
          ? `Nobody answered the replanning question${err && !/answer/i.test(err) ? ` (${err})` : ''}, so the item was dropped.`
          : `The approval question failed: ${err}.${goesTo}`;
        case 'merge done': return `${cap(actor)} merged the PR as ${sha7(out.sha)}, which contains the verified commit ${sha7(c.verdict?.sha)}.`;
        case 'merge failed': return `The merge failed: ${err}.${goesTo}`;
        default:
          if (s.what.startsWith('after ')) {
            const key = s.what.slice(6), ran = prev ? Date.parse(s.at) - Date.parse(prev.at) : null;
            const lim = delays[key] != null ? `its ${duration(delays[key])} time limit` : 'its time limit';
            return `Build ${of((b.builds ?? 0) + 1)} ran ${ran != null ? duration(ran) + ', reaching ' : 'past '}${lim}.${goesTo}`;
          }
          return `${cap(actor)}: ${s.what}. The item is now in ${name(s.state)}.`;
      }
    })();
    s.sentence = say;
    s.by = byOf(s);
    // Chapters follow where the event happened: briefing, a build (from building to merging), or replanning.
    const phase = s.from == null || s.from === 'briefing' ? 'briefing' : BUILD_PHASE.has(s.from) ? 'build' : s.from;
    const last = chapters.at(-1);
    if (!last || last.phase !== phase || (phase === 'build' && last.build !== build)) {
      const briefings = chapters.filter((ch) => ch.phase === 'briefing').length;
      const title = phase === 'briefing' ? (briefings ? 'Briefing again' : 'Briefing')
        : phase === 'build' ? `Build ${of(build)}`
        : phase === 'replanning' ? 'Replanning' : name(phase);
      chapters.push({ phase, build, title, first: i, last: i, marks: [] });
    } else last.last = i;
    const ch = chapters.at(-1);
    s.chapter = chapters.length - 1;
    // What the chapter came to, in a few words: its commits, verdicts and decisions in order.
    const mark = (() => {
      switch (s.what) {
        case 'brief done': return 'briefs written';
        case 'brief failed': return 'no briefs';
        case 'build done': return `commit ${sha7(out.pr?.headSha)}`;
        case 'build failed': return 'session failed';
        case 'verify done': return `${out.result}${out.result === 'PASS' && out.sha !== c.pr?.headSha ? ' on an old commit' : ''}`;
        case 'verify failed': return 'verifier failed';
        case 'pr.pushed': return `pushed ${sha7(ev.headSha)}`;
        case 'ask done': return s.from === 'replanning' ? (s.state === 'briefing' ? `replanned by ${actor}` : `dropped by ${actor}`) : `${CHOSEN[out.choice] ?? out.choice}`;
        case 'ask failed': return s.from === 'replanning' ? 'no answer, dropped' : 'no answer';
        case 'merge done': return `merged as ${sha7(out.sha)}`;
        case 'merge failed': return 'merge failed';
        default: return s.what.startsWith('after ') ? 'time limit' : null;
      }
    })();
    if (mark) ch.marks.push(mark);
    if (s.state === 'building' && s.from !== 'building') build = (c.builds ?? 0) + 1; // the build the next steps belong to
  });
  return chapters.map(({ phase, marks, ...rest }) => ({ ...rest, summary: marks.join(' · ') }));
};

// Why a run went to replanning, in a few words, from the step that took it there.
const causeOf = (s) => {
  const out = s.entry.event.output ?? {};
  switch (s.what) {
    case 'brief failed': return 'briefing failed';
    case 'build failed': return 'the build session failed';
    case 'verify done': return out.result === 'PASS' ? 'a PASS on an old commit' : s.context.builds > 1 ? `${s.context.builds} failed builds` : 'a failed build';
    case 'verify failed': return 'the verifier session failed';
    case 'ask done': return 'the stand-in rejected the merge';
    case 'ask failed': return 'the approval question failed';
    case 'merge failed': return 'the merge failed';
    default: return s.what.startsWith('after ') ? 'the build reached its time limit' : 'it stalled';
  }
};

// How a run ended, as a sentence that says why, and its counts as a second, shorter line.
const outcomeOf = (steps, { names = {}, limit = null } = {}) => {
  if (!steps.length) return { outcome: '', counts: '' };
  const last = steps.at(-1), c = last.context, out = last.entry.event.output ?? {};
  const builds = steps.filter((s) => s.state === 'building' && s.from !== 'building').length;
  const replans = steps.filter((s) => s.from === 'replanning' && s.state !== 'dropped').length;
  const counts = [plural(builds, 'build'), replans ? plural(replans, 'replan') : 'no replans', plural(steps.length, 'step')].join(' · ');
  const stalled = steps.findLast((s) => s.state === 'replanning' && s.from !== 'replanning');
  let outcome;
  if (last.state === 'done') {
    outcome = `Merged as ${sha7(c.merge?.sha)}, from commit ${sha7(c.verdict?.sha)}, which passed verification in build ${limit ? `${c.builds} of ${limit}` : c.builds}${replans ? `, after ${plural(replans, 'replan')}` : ''}.`;
  } else if (last.state === 'dropped') {
    const cause = stalled ? ` after ${causeOf(stalled)}` : '';
    outcome = last.what === 'ask failed'
      ? `Dropped${cause}: nobody answered the replanning question.`
      : `Dropped by ${actorOf(last)}${cause}${out.why ? ': ' + quoted(out.why) : '.'}`;
  } else outcome = `Not finished: the item is in ${names[last.state] || last.state}.`;
  return { outcome, counts };
};

/** The inspector page, as HTML for an Artifact. runs: [{ name, about, entries, example? }], each a journal to play; the page picks between them. */
export const itemInspector = (spec, runs = [], layout = null) => {
  const graph = graphOf(spec);
  const words = { names: layout?.names ?? {}, limit: buildLimitOf(spec), delays: spec.meta?.delays ?? {} };
  const shown = runs.map(({ name, about, entries, example }) => {
    const steps = stepsOf(spec, graph, entries);
    const chapters = tell(steps, words);
    return { name, about: about ?? '', example: !!example, ...outcomeOf(steps, words), chapters, steps };
  });
  const data = { description: spec.description, graph, layout, buildLimit: words.limit, runs: shown };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return TEMPLATE.replace('__DATA__', () => json);
};

const TEMPLATE = String.raw`<title>Work Item Inspector</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
/* A fixed frame the height of the window. Every region has a box that does not depend on the step, the run or
   what is open: the drawing, the transport, the step's story, the run's steps and the detail. Long content
   scrolls inside its own box; the page itself never scrolls. One colour key for the whole page: lines and step
   bars are grey going forward, blue going back to try again and red when something went wrong; "now" is a ring,
   not a colour; green, amber and grey strike mark what a step added, changed and cleared. */
:root{
  --bg:#f2f4f3; --panel:#ffffff; --raised:#e6eae8; --fg:#1b201f; --muted:#59625f; --line:#d4dad7; --node:#ffffff; --nodeline:#89928f;
  --fwd:#7d8784; --back:#2c66ad; --bad:#b0352f; --add:#1d6b35; --addbg:#d5efdc; --chg:#7a4f00; --chgbg:#f9e7bd; --del:#59625f;
  --body:"IBM Plex Sans",system-ui,sans-serif; --mono:"IBM Plex Mono",ui-monospace,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#111413; --panel:#191d1c; --raised:#2a302e; --fg:#e4e8e6; --muted:#a3aca9; --line:#2d3432; --node:#1d2221; --nodeline:#6c7773;
  --fwd:#7f8a86; --back:#80b2f0; --bad:#f08e88; --add:#86d69d; --addbg:#1c3b26; --chg:#f1c76f; --chgbg:#3f3216; --del:#a3aca9; color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#111413; --panel:#191d1c; --raised:#2a302e; --fg:#e4e8e6; --muted:#a3aca9; --line:#2d3432; --node:#1d2221; --nodeline:#6c7773;
  --fwd:#7f8a86; --back:#80b2f0; --bad:#f08e88; --add:#86d69d; --addbg:#1c3b26; --chg:#f1c76f; --chgbg:#3f3216; --del:#a3aca9; color-scheme:dark}
*{box-sizing:border-box}
html,body{height:100%}
body{background:var(--bg);color:var(--fg);font:14px/1.45 var(--body);margin:0;overflow:hidden}
.app{height:100vh;height:100dvh;display:grid;gap:12px;padding:12px max(16px,env(safe-area-inset-right,0px)) 12px max(16px,env(safe-area-inset-left,0px));
  grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-rows:56px 212px minmax(0,1fr) 44px 244px;
  grid-template-areas:"top top" "draw story" "draw detail" "trans detail" "side detail"}
@media (min-width:1600px){.app{grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr);grid-template-rows:56px 212px minmax(0,1fr) 44px;
  grid-template-areas:"top top top" "draw story detail" "draw side detail" "trans side detail"}}
.top{grid-area:top}.drawcard{grid-area:draw}.transport{grid-area:trans}.story{grid-area:story}.side{grid-area:side}.detail{grid-area:detail}.views{display:none}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;min-width:0;min-height:0;overflow:hidden;display:flex;flex-direction:column}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.muted{color:var(--muted)} .mono{font-family:var(--mono)}
code{font-family:var(--mono);font-size:12.5px}
h2{font:600 11.5px var(--body);margin:0;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}
button,select{font:500 13px var(--body);color:var(--fg);background:var(--panel);border:1px solid var(--nodeline);border-radius:6px;padding:5px 10px;cursor:pointer}
button:hover{border-color:var(--fg)}
button:focus-visible,select:focus-visible,input:focus-visible,summary:focus-visible,.n:focus-visible{outline:2px solid var(--fg);outline-offset:1px}
button.primary{background:var(--fg);color:var(--panel);border-color:var(--fg)}

/* Top: which run, and how it ended. One line each; the full text is on hover. */
.top{display:flex;flex-direction:column;justify-content:center;gap:3px;min-width:0}
.l1{display:flex;align-items:center;gap:10px;min-width:0;height:30px}
h1{font-size:1.1rem;margin:0 8px 0 0;font-weight:600;white-space:nowrap}
#run{width:min(380px,100%);flex:0 1 auto;min-width:0}
.how{margin-left:auto;position:relative;flex:none}
.how summary{cursor:pointer;color:var(--muted);font-size:13px;list-style:none;padding:4px 8px;border:1px solid var(--line);border-radius:6px}
.how summary::-webkit-details-marker{display:none}
.how .pop{position:absolute;right:0;top:calc(100% + 6px);width:min(460px,86vw);z-index:5;background:var(--panel);border:1px solid var(--nodeline);border-radius:8px;padding:10px 14px;box-shadow:0 8px 24px rgba(0,0,0,.25);font-size:13px}
.how .pop p{margin:0 0 8px}
.outcome{margin:0;height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14px}
.outcome strong{font-weight:600}

/* The drawing, fitted to its box, and the one key. */
.diagram{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:6px 8px 0}
.diagram svg{display:block;width:100%;height:100%}
.n rect{fill:var(--node);stroke:var(--nodeline);stroke-width:1.4}
.n rect.halo{fill:none;stroke:none}
.n text{fill:var(--fg);font:600 12.5px var(--body)}
.n text.s{fill:var(--muted);font:400 10.5px var(--mono)}
.n text.cnt{fill:var(--fg);font:600 11px var(--mono)}
.n{cursor:pointer}
.n.touched rect.box{fill:var(--raised)}
.n.on rect.box{stroke:var(--fg);stroke-width:2.6}
.n.on rect.halo{stroke:var(--fg);stroke-width:7;opacity:.22}
.n.sel rect.box{stroke:var(--fg);stroke-width:2;stroke-dasharray:2 3}
.n.bonly rect.box{stroke:var(--fg);stroke-width:2;stroke-dasharray:1 4;stroke-linecap:round}
.start{fill:var(--fg)}
.e path{fill:none;stroke:var(--fwd);stroke-width:1.3;opacity:.6}
.e.back path{stroke:var(--back);stroke-dasharray:5 3}
.e.fail path{stroke:var(--bad)}
.e text{fill:var(--muted);font:10.5px var(--mono);paint-order:stroke;stroke:var(--panel);stroke-width:4px}
.e.back text{fill:var(--back)} .e.fail text{fill:var(--bad)}
.e.past path,.e.now path{opacity:1;stroke-width:3}
.e.past:not(.back):not(.fail) path,.e.now:not(.back):not(.fail) path{stroke:var(--fg)}
.e.past text{fill:var(--fg)} .e.back.past text{fill:var(--back)} .e.fail.past text{fill:var(--bad)}
.e.now path{stroke-width:4.5;stroke-dasharray:8 5;animation:dash .8s linear infinite}
.e.now text{font-weight:600}
.e.bonly path{opacity:1;stroke:var(--fg);stroke-width:2.6;stroke-dasharray:1 5;stroke-linecap:round}
@keyframes dash{to{stroke-dashoffset:-26}}
@media (prefers-reduced-motion:reduce){.e.now path{animation:none}}
.key{flex:none;height:46px;overflow:hidden;display:flex;flex-wrap:wrap;align-content:flex-start;gap:2px 14px;padding:4px 12px 6px;color:var(--muted);font-size:12px}
.key svg{vertical-align:-2px;margin-right:5px}
.key .onlyb{visibility:hidden}
.app[data-cmp="on"] .key .onlyb{visibility:visible}

/* Transport: every control has a fixed width, so nothing moves under the pointer. */
.transport{display:flex;align-items:center;gap:6px;min-width:0}
.transport button{flex:none;height:34px;padding:0}
#first,#last{width:36px} #prev,#next{width:78px} #play{width:76px}
#slider{flex:1 1 60px;min-width:40px;accent-color:var(--fg)}
#pos{flex:none;width:10.5ch;white-space:nowrap;font:500 13px var(--mono);text-align:right}
#speed{flex:none;width:92px}

/* The step's story: a fixed box. Position and chapter, the step as a sentence (up to three lines), who did it,
   and the commit check, always four cells. */
.story{padding:11px 14px 10px;gap:5px}
.story .meta{height:17px;font:600 11.5px var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.story .sent{margin:0;font-size:15px;line-height:21px;height:63px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
.story .byline{height:19px;font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.story .byline b{color:var(--fg);font-weight:600}
.commits{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px 12px;margin:auto 0 0;padding-top:7px;border-top:1px solid var(--line)}
.commits dt{font:600 10.5px var(--body);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);white-space:nowrap}
.commits dd{margin:0;font:12.5px/17px var(--mono);height:34px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.commits .none{color:var(--muted);font-family:var(--body)}
.fail-word{color:var(--bad);font-weight:600}

/* The run's steps, in chapters; the list scrolls inside its box. */
.side .head,.detail .tabs{flex:none;height:38px;display:flex;align-items:center;gap:4px;padding:0 12px;border-bottom:1px solid var(--line)}
#steps{flex:1;min-height:0;overflow:auto;margin:0;padding:4px 8px 10px;list-style:none;position:relative}
#steps li.ch{padding:9px 6px 3px;font:600 11px var(--body);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#steps li.ch .chs{font:400 11.5px var(--mono);text-transform:none;letter-spacing:0;margin-left:6px}
#steps button{width:100%;height:30px;display:grid;grid-template-columns:2.2em minmax(0,1fr) auto;align-items:center;gap:6px;text-align:left;border:0;border-left:4px solid var(--c);border-radius:5px;background:transparent;padding:0 8px 0 6px}
#steps .num{font:600 11px var(--mono);color:var(--muted)}
#steps .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}
#steps .to{font:11.5px var(--mono);color:var(--muted);white-space:nowrap}
#steps li.later .t{color:var(--muted)}
#steps li.cur button{background:var(--raised);box-shadow:inset 0 0 0 1px var(--fg)}
#steps li.cur .t{font-weight:600}
.tone-start,.tone-fwd{--c:var(--fwd)} .tone-back{--c:var(--back)} .tone-fail{--c:var(--bad)}

/* The detail: tabs whose panels each scroll inside the same box. Compare runs is a fourth view of this box. */
.detail .tabs{padding:0 8px;overflow:hidden}
.tabs .short{display:none}
.detail .tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;background:none;height:37px;padding:0 9px;color:var(--muted);white-space:nowrap}
.detail .tabs button[aria-selected="true"]{border-bottom-color:var(--fg);color:var(--fg);font-weight:600}
.detail .tabs [data-tab="cmp"]{margin-left:auto}
.tab{flex:1;min-height:0;display:flex;flex-direction:column}
.tab[hidden]{display:none}
.tabhead{flex:none;padding:8px 14px;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--muted);min-height:36px}
.scroll{flex:1;min-height:0;overflow:auto;padding:6px 14px 14px}
ins{text-decoration:none;border-radius:3px;padding:0 3px}
s{color:var(--del)}
.mk{display:inline-block;width:1.3em;text-align:center;font:600 13px var(--mono);border-radius:3px}
.mk.add,tr.add td.m{color:var(--add);background:var(--addbg)} .mk.chg,tr.chg td.m{color:var(--chg);background:var(--chgbg)} .mk.del,tr.del td.m{color:var(--del);background:var(--raised)}
.changed-here{display:flex;flex-wrap:wrap;gap:2px 12px;align-items:center;height:20px;overflow:hidden}
.changed-here b{color:var(--fg);font-weight:600}
.changed-here .jump{cursor:pointer}
.changed-here .jump:hover{color:var(--fg);text-decoration:underline}
table.holds{width:100%;border-collapse:collapse;font-size:13px;position:relative}
#holds-scroll{position:relative}
table.holds th,table.holds td{text-align:left;vertical-align:top;padding:3px 6px}
table.holds tr.grp th{font:600 11px var(--body);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding-top:12px}
table.holds tr.grp.touched th,table.holds tr.solo.touched td.k{color:var(--fg)}
table.holds tr.part td.k{padding-left:18px}
table.holds tr.solo td{padding-top:12px}
table.holds tr.solo td.k{font:600 11px/1.9 var(--body);text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}

table.holds td.m{width:1.6em;text-align:center;font:600 13px var(--mono);border-radius:3px}
table.holds td.k{color:var(--muted);width:10.5em}
table.holds td.v{font:12.5px/1.5 var(--mono);overflow-wrap:anywhere}
table.holds tr.add ins{background:var(--addbg);color:var(--add)}
table.holds tr.chg ins{background:var(--chgbg);color:var(--chg)}
table.holds tr.empty td.v{color:var(--muted)}
.state h3{margin:6px 0 0;font-size:1.1rem}
.state h4{margin:14px 0 4px;font:600 11px var(--body);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.state ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;font-size:13.5px}
.state .tk{font-weight:600}
.state details{margin-top:16px;font-size:12.5px;color:var(--muted)}
.state summary{cursor:pointer}
#st-follow{margin-left:8px;padding:1px 8px;font-size:12px}
pre{margin:0;background:var(--raised);border-radius:6px;padding:8px;font:12px/1.45 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}

/* Compare runs: A is the run being stepped, B the one picked below. */
.cmphead{flex:none;height:150px;overflow:auto;padding:8px 14px;border-bottom:1px solid var(--line);font-size:13px;display:flex;flex-direction:column;gap:5px}
.cmphead p{margin:0}
.ab{display:grid;grid-template-columns:1.6em minmax(0,1fr);gap:6px;align-items:baseline}
.badge{display:inline-block;width:1.4em;text-align:center;font:600 11px/1.6 var(--mono);border:1.5px solid var(--fg);border-radius:4px}
.badge.b{border-style:dotted}
.ab .nm{font-weight:600;margin-right:6px} .ab .oc{color:var(--muted)}
.diffline button{padding:1px 8px;font-size:12px;margin-left:6px}
ol.cmplist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
ol.cmplist li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;padding:7px 4px;border-top:1px solid var(--line);align-items:center}
ol.cmplist li.isA{background:var(--raised)}
ol.cmplist .pick{border:0;background:none;padding:0;text-align:left;min-width:0}
ol.cmplist .pick .nm{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
ol.cmplist .pick .oc{display:block;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
ol.cmplist .tag{font:600 11px var(--mono);width:5.5em;text-align:right}
ol.cmplist .open{padding:1px 8px;font-size:12px}
.cells{grid-column:1 / -1;display:flex;gap:2px}
.cells i{font:600 10px/18px var(--mono);font-style:normal;width:22px;height:20px;text-align:center;border-radius:3px;border-bottom:3px solid var(--c);background:var(--raised);color:var(--fg)}
.cells i.div{outline:2px solid var(--fg);outline-offset:0}
.cells i.at{background:var(--fg);color:var(--panel)}
.letters{font-size:12px;color:var(--muted);padding:8px 4px 0}

/* Phone: the story stays on top, the transport is a bar fixed to the bottom, and one region at a time fills
   the middle: the detail, the steps or the drawing. */
@media (max-width:760px){
  .app{grid-template-columns:minmax(0,1fr);grid-template-rows:64px 232px 34px minmax(0,1fr) 46px;gap:8px;
    padding:8px max(16px,env(safe-area-inset-right,0px)) max(8px,env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px));
    grid-template-areas:"top" "story" "views" "view" "trans"}
  .drawcard,.side,.detail{grid-area:view}
  .app:not([data-view="draw"]) .drawcard,.app:not([data-view="side"]) .side,.app:not([data-view="detail"]) .detail{display:none}
  .views{grid-area:views;display:flex;gap:4px}
  .views button{flex:1;padding:0;height:32px}
  .views button[aria-pressed="true"]{background:var(--fg);color:var(--panel);border-color:var(--fg)}
  h1{display:none}
  .how summary{padding:4px 6px}
  .outcome{white-space:normal;height:34px;line-height:17px;font-size:13px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .story .sent{font-size:14px;line-height:19px;height:57px}
  .commits{grid-template-columns:repeat(2,minmax(0,1fr))}
  .commits dd{height:17px;-webkit-line-clamp:1}
  .diagram{overflow:auto;display:block;padding:6px}
  .diagram svg{width:600px;height:533px}
  #speed,.transport .lbl{display:none}
  #prev,#next{width:42px} #play{width:60px} #pos{width:8.5ch}
  .detail .tabs button{padding:0 6px;font-size:12.5px}
  .tabs .short{display:inline} .tabs .long{display:none}
  table.holds td.k{width:6.5em}
}
</style>

<div class="app" id="app" data-view="detail">
  <header class="top">
    <div class="l1">
      <h1>Work item inspector</h1>
      <label for="run" class="sr">Run</label><select id="run"></select>
      <details class="how" id="how"><summary>How this page works</summary><div class="pop">
        <p>Pick a run and step through it. The drawing rings the state the item is in and thickens the lines it has taken; the panel beside it says what happened at this step, and the detail shows everything the item holds, with what this step added, changed or cleared marked.</p>
        <p>Each run is rebuilt from its journal, the record of what came in from outside: session results, answers, pushes and time limits. The page replays it with the harness's own rules, so every step shown is one the harness accepted.</p>
        <p>Keys: ← and → step, Home and End jump, Space plays.</p>
      </div></details>
    </div>
    <p class="outcome" id="outcomeline"><strong id="outcome"></strong> <span class="muted" id="counts"></span></p>
  </header>

  <section class="card drawcard" aria-label="Drawing of the machine">
    <div class="diagram" id="diagram"><p class="muted">Drawing the machine…</p></div>
    <div class="key" aria-label="What the drawing means">
      <span><svg width="24" height="8" aria-hidden="true"><line x1="0" y1="4" x2="24" y2="4" stroke="var(--fwd)" stroke-width="1.6"/></svg>forward</span>
      <span><svg width="24" height="8" aria-hidden="true"><line x1="0" y1="4" x2="24" y2="4" stroke="var(--back)" stroke-width="1.6" stroke-dasharray="5 3"/></svg>back, to try again</span>
      <span><svg width="24" height="8" aria-hidden="true"><line x1="0" y1="4" x2="24" y2="4" stroke="var(--bad)" stroke-width="1.6"/></svg>went wrong, to replan</span>
      <span><svg width="24" height="8" aria-hidden="true"><line x1="0" y1="4" x2="24" y2="4" stroke="var(--fg)" stroke-width="3"/></svg>taken so far</span>
      <span><svg width="24" height="14" aria-hidden="true"><rect x="3" y="3" width="18" height="8" rx="3" fill="none" stroke="var(--fg)" stroke-width="2"/><rect x="1" y="1" width="22" height="12" rx="4" fill="none" stroke="var(--fg)" stroke-opacity=".25" stroke-width="2"/></svg>where it is now</span>
      <span>×2 entered 2 times</span>
      <span>Click a state to see what it needs and passes on.</span>
      <span class="onlyb"><svg width="24" height="8" aria-hidden="true"><line x1="1" y1="4" x2="23" y2="4" stroke="var(--fg)" stroke-width="2.6" stroke-dasharray="1 5" stroke-linecap="round"/></svg>only in run B</span>
    </div>
  </section>

  <div class="transport" role="group" aria-label="Step through the run">
    <button id="first" type="button" title="First step (Home)" aria-label="First step">⏮</button>
    <button id="prev" type="button" title="Previous step (←)" aria-label="Previous step">◀<span class="lbl"> Step</span></button>
    <button id="play" type="button" class="primary" title="Play (Space)">Play</button>
    <button id="next" type="button" title="Next step (→)" aria-label="Next step"><span class="lbl">Step </span>▶</button>
    <button id="last" type="button" title="Last step (End)" aria-label="Last step">⏭</button>
    <input type="range" id="slider" min="1" value="1" aria-label="Step">
    <span id="pos"></span>
    <label for="speed" class="sr">Speed</label>
    <select id="speed"><option value="1800">Slow</option><option value="1100" selected>Normal</option><option value="500">Fast</option></select>
  </div>

  <section class="card story" id="now" aria-label="This step">
    <div class="meta"><span id="s-pos"></span> · <span id="s-ch"></span> · <span id="s-when"></span></div>
    <p class="sent" id="s-sent"></p>
    <div class="byline">By <b id="s-by"></b> · now in <b id="s-to"></b></div>
    <dl class="commits" aria-label="Which commit">
      <div><dt>PR head</dt><dd id="c-head"></dd></div>
      <div><dt>Last verdict</dt><dd id="c-verdict"></dd></div>
      <div><dt>Decision</dt><dd id="c-dec"></dd></div>
      <div><dt>Merged</dt><dd id="c-merge"></dd></div>
    </dl>
    <span class="sr" id="said" aria-live="polite"></span>
  </section>

  <nav class="views" aria-label="Show">
    <button type="button" data-view="detail" aria-pressed="true">Detail</button>
    <button type="button" data-view="side" aria-pressed="false">Steps</button>
    <button type="button" data-view="draw" aria-pressed="false">Drawing</button>
  </nav>

  <section class="card side" aria-label="Steps in this run">
    <div class="head"><h2>Steps in this run</h2></div>
    <ol id="steps"></ol>
  </section>

  <section class="card detail" aria-label="Detail">
    <div class="tabs" role="tablist" aria-label="Detail view">
      <button type="button" role="tab" data-tab="step" aria-selected="true" aria-controls="tab-step"><span class="long">What the item holds</span><span class="short">Item</span></button>
      <button type="button" role="tab" data-tab="state" aria-selected="false" aria-controls="tab-state"><span class="long">This state</span><span class="short">State</span></button>
      <button type="button" role="tab" data-tab="entry" aria-selected="false" aria-controls="tab-entry"><span class="long">Journal line</span><span class="short">Journal</span></button>
      <button type="button" role="tab" data-tab="cmp" aria-selected="false" aria-controls="tab-cmp"><span class="long">Compare runs</span><span class="short">Compare</span></button>
    </div>
    <div class="tab" id="tab-step" role="tabpanel">
      <div class="tabhead"><div class="changed-here" id="changed"></div></div>
      <div class="scroll" id="holds-scroll"><table class="holds"><tbody id="holds"></tbody></table></div>
    </div>
    <div class="tab state" id="tab-state" role="tabpanel" hidden>
      <div class="tabhead"><span id="st-head"></span><button type="button" id="st-follow" hidden>Follow the step</button></div>
      <div class="scroll" id="state-scroll">
        <h3 id="st-name"></h3><div class="muted" id="st-note"></div>
        <h4>Needs before it can enter</h4><ul id="st-needs"></ul>
        <div id="st-passes-box"><h4>Passes on to its session</h4><ul id="st-passes"></ul></div>
        <h4>Ways out</h4><ul id="st-out"></ul>
        <h4>Ways in</h4><ul id="st-in"></ul>
        <details id="st-spec"><summary>Names in the spec</summary><div id="st-specbody"></div></details>
      </div>
    </div>
    <div class="tab" id="tab-entry" role="tabpanel" hidden>
      <div class="tabhead">The line in the run's journal that this step replays. The journal keeps only what came in from outside; the rest of the page is rebuilt from it.</div>
      <div class="scroll" id="entry-scroll"><pre id="entry"></pre></div>
    </div>
    <div class="tab" id="tab-cmp" role="tabpanel" hidden>
      <div class="cmphead">
        <p class="ab"><span class="badge">A</span><span><span class="nm" id="cA-name"></span><span class="oc" id="cA-out"></span></span></p>
        <p class="ab"><span class="badge b">B</span><span><span class="nm" id="cB-name"></span><span class="oc" id="cB-out"></span></span></p>
        <p class="diffline" id="cDiff"></p>
      </div>
      <div class="scroll" id="cmp-scroll"><ol class="cmplist" id="runs"></ol><p class="letters" id="letters"></p></div>
    </div>
  </section>
</div>
<script type="application/json" id="data">__DATA__</script>
<script>
const DATA = JSON.parse(document.getElementById('data').textContent);
const { graph, runs } = DATA;
const layout = DATA.layout || {};
const LIMIT = DATA.buildLimit;
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

// What the reader has set up. None of it is reset by stepping or by switching runs; only the reader changes it.
let ri = 0;          // the run being stepped (A)
let steps = [];
let cur = 0;         // the step shown
let tab = 'step';    // the detail view
let picked = null;   // a state the reader clicked; null follows the step
let cmpB = null;     // the run picked to compare with
let drawn = null;
let timer = null;

// ---- Words
const nameOf = (id) => layout.names?.[id] || id;
const shortOf = (id) => layout.short?.[id] || nameOf(id).slice(0, 2);
const lineText = (e) => placedOf(e)?.label?.text || edgeLabel(e);
const toneOf = (s) => (!s.edge ? 'start' : placedOf(edgeById[s.edge])?.kind || 'fwd');
const when = (at) => at.slice(0, 16).replace('T', ' ') + ' UTC';
const isSha = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const isPath = (v) => typeof v === 'string' && /^(file:\/\/)?\//.test(v);
const short = (v) => (isSha(v) ? v.slice(0, 7) : isPath(v) ? '…/' + v.replace(/^file:\/\//, '').split('/').slice(-2).join('/') : v);
const tidy = (v) => (Array.isArray(v) ? v.map(tidy) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tidy(x)])) : short(v));
const code = (v) => '<code title="' + esc(v) + '">' + esc(short(v)) + '</code>';
const DONE_WORD = { approve: 'approved', reject: 'rejected', replan: 'replanned', drop: 'dropped' };
const whoWord = (by) => (by === 'person' ? 'the person' : 'the ' + by);
const of = (n) => (LIMIT ? n + ' of ' + LIMIT : String(n));

// ---- What the item holds: one row per field (or part of a field), always all of them, in the same order.
const FIELDS = layout.fields || {};
const contextKeys = [...new Set(runs.flatMap((r) => r.steps.flatMap((s) => Object.keys(s.context))))];
const fieldOrder = [...Object.keys(FIELDS).filter((k) => contextKeys.includes(k)), ...contextKeys.filter((k) => !(k in FIELDS))];
const fieldLabel = (path) => { const [f, p] = path.split('.'); return p ? FIELDS[f]?.parts?.[p] || path : FIELDS[f]?.label || f; };
function valueHtml(field, part, v) {
  if (v == null || v === '') return '';
  if (Array.isArray(v)) return v.map((x) => esc(short(x))).join('<br>');
  if (typeof v === 'object') return esc(JSON.stringify(tidy(v)));
  if (field === 'builds') return esc(of(v));
  if (field === 'decision' && part === 'choice') return esc(DONE_WORD[v] || v);
  if (field === 'decision' && part === 'by') return esc(whoWord(v));
  if (isSha(v) || isPath(v)) return code(v);
  return esc(String(v).replace(/\b[0-9a-f]{8,39}\b/g, (h) => h.slice(0, 7)));
}
const rows = [];
const groups = [];
(function buildHolds() {
  const body = $('holds');
  const add = (field, part, label, group) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="m"></td><td class="k">' + esc(label) + '</td><td class="v"></td>';
    body.appendChild(tr);
    rows.push({ field, part, tr, m: tr.cells[0], v: tr.cells[2], group, label: part ? (group ? group.label + ': ' : '') + label : label });
  };
  for (const f of fieldOrder) {
    const parts = FIELDS[f]?.parts;
    if (parts) {
      const tr = document.createElement('tr');
      tr.className = 'grp';
      tr.innerHTML = '<td class="m"></td><th colspan="2">' + esc(FIELDS[f].label || f) + '</th>';
      body.appendChild(tr);
      const group = { tr, label: FIELDS[f].label || f };
      groups.push(group);
      for (const [p, label] of Object.entries(parts)) add(f, p, label, group);
    } else add(f, null, FIELDS[f]?.label || f, null);
  }
})();
const MARK = { add: ['+', 'added'], chg: ['~', 'changed'], del: ['−', 'cleared'] };
function showHolds(step) {
  const before = cur ? steps[cur - 1].context : {};
  const now = step ? step.context : {};
  const get = (ctx, r) => (r.part ? ctx[r.field]?.[r.part] : ctx[r.field]);
  const touched = new Set();
  const changes = [];
  for (const r of rows) {
    const a = get(before, r), b = get(now, r);
    const same = JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const kind = same ? (b == null ? 'empty' : 'same') : a == null ? 'add' : b == null ? 'del' : 'chg';
    r.tr.className = (r.part ? 'part ' : 'solo ') + kind + (MARK[kind] ? ' touched' : '');
    r.m.textContent = MARK[kind]?.[0] || '';
    r.m.title = MARK[kind]?.[1] || '';
    const va = valueHtml(r.field, r.part, a), vb = valueHtml(r.field, r.part, b);
    r.v.innerHTML = kind === 'chg' ? '<s>' + va + '</s> <ins>' + vb + '</ins>'
      : kind === 'add' ? '<ins>' + vb + '</ins>'
      : kind === 'del' ? '<s>' + va + '</s> <span class="muted">cleared</span>'
      : kind === 'empty' ? '—' : vb;
    if (MARK[kind]) { if (r.group) touched.add(r.group); changes.push([kind, r.label, rows.indexOf(r)]); }
  }
  for (const g of groups) g.tr.classList.toggle('touched', touched.has(g));
  $('changed').innerHTML = !step ? '' : changes.length
    ? '<b>This step:</b>' + changes.map(([k, label, ri2]) => '<span class="jump" data-row="' + ri2 + '"><span class="mk ' + k + '" title="' + MARK[k][1] + '">' + MARK[k][0] + '</span> ' + esc(label) + '</span>').join('')
    : '<b>This step changed nothing the item holds.</b>';
}

// ---- The graph, placed by hand in the layout file
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
function routeOf(e, places) {
  const placed = placedOf(e);
  if (placed) return { points: placed.points, kind: placed.kind, label: { text: edgeLabel(e), ...placed.label } };
  const a = places[e.from], b = places[e.to];
  const from = [a.x + a.w / 2, a.y + a.h], to = [b.x + b.w / 2, b.y];
  return { points: [from, to], label: { x: (from[0] + to[0]) / 2 + 6, y: (from[1] + to[1]) / 2, anchor: 'start', text: edgeLabel(e) } };
}
function draw() {
  const { places, width, height } = placeNodes();
  const svg = svgEl('svg', { viewBox: '0 0 ' + width + ' ' + height, preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'The work item machine: states and transitions' });
  const defs = svgEl('defs', {}, svg);
  const marker = svgEl('marker', { id: 'ah', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' }, defs);
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
  for (const e of graph.edges) { const { points, label, kind } = routeOf(e, places); drawEdge(e.id, points, label, kind); }
  for (const n of graph.nodes) {
    const p = places[n.id];
    const group = svgEl('g', { class: 'n' + (n.final ? ' final' : ''), tabindex: 0, role: 'button', 'aria-label': 'State ' + nameOf(n.id) + ': see what it needs and passes on' }, nodeLayer);
    const r = n.final ? p.h / 2 : 8;
    svgEl('rect', { class: 'halo', x: p.x - 4, y: p.y - 4, width: p.w + 8, height: p.h + 8, rx: r + 4 }, group);
    svgEl('rect', { class: 'box', x: p.x, y: p.y, width: p.w, height: p.h, rx: r }, group);
    const note = layout.notes?.[n.id] || (n.actor ? 'starts ' + n.actor : '');
    svgEl('text', { x: p.x + p.w / 2, y: p.y + (note ? 21 : p.h / 2 + 4), 'text-anchor': 'middle' }, group).textContent = nameOf(n.id);
    if (note) svgEl('text', { x: p.x + p.w / 2, y: p.y + 38, 'text-anchor': 'middle', class: 's' }, group).textContent = note;
    counts[n.id] = svgEl('text', { x: p.x + p.w - 8, y: p.y + 15, 'text-anchor': 'end', class: 'cnt' }, group);
    const pick = () => { picked = n.id; setTab('state'); setView('detail'); };
    group.addEventListener('click', pick);
    group.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); pick(); } });
    nodes[n.id] = group;
  }
  $('diagram').replaceChildren(svg);
  drawn = { nodes, edges, counts, edgeLayer };
  paint();
}

function paintDrawing(step) {
  if (!drawn) return;
  const upto = steps.slice(0, cur + 1);
  const touched = new Set(upto.map((s) => s.state));
  const walked = new Set(upto.map((s) => s.edge).filter(Boolean));
  if (steps.length) walked.add('__init');
  // In Compare runs, what run B walked that A never does is dotted.
  const B = tab === 'cmp' && cmpB != null ? runs[cmpB].steps : null;
  const aAll = new Set(steps.flatMap((s) => [s.edge, 'n:' + s.state]));
  const bOnly = new Set(B ? B.flatMap((s) => [s.edge, 'n:' + s.state]).filter((x) => x && !aAll.has(x)) : []);
  $('app').dataset.cmp = B ? 'on' : 'off';
  for (const [id, group] of Object.entries(drawn.nodes)) {
    const entered = upto.filter((s) => s.state === id && s.from !== id).length;
    drawn.counts[id].textContent = entered > 1 ? '×' + entered : '';
    group.classList.toggle('touched', touched.has(id));
    group.classList.toggle('on', !!step && step.state === id);
    group.classList.toggle('sel', tab === 'state' && picked === id && step?.state !== id);
    group.classList.toggle('bonly', bOnly.has('n:' + id));
  }
  const nowId = step?.edge || (cur === 0 && steps.length ? '__init' : null);
  for (const [id, group] of Object.entries(drawn.edges)) {
    group.classList.toggle('now', id === nowId);
    group.classList.toggle('past', id !== nowId && walked.has(id));
    group.classList.toggle('bonly', bOnly.has(id));
  }
  // Lines that share a route (the failures into replanning) overlap: the walked ones go on top, the one just taken last.
  for (const id of [...bOnly].filter((x) => drawn.edges[x])) drawn.edgeLayer.appendChild(drawn.edges[id]);
  for (const id of [...walked, nowId].filter(Boolean)) drawn.edgeLayer.appendChild(drawn.edges[id]);
}

// ---- The panels: each keeps its elements; a step changes only the text inside them.
const NONE = '<span class="none">none yet</span>';
function showStory(step) {
  if (!step) {
    $('s-pos').textContent = 'No run'; $('s-ch').textContent = ''; $('s-when').textContent = '';
    $('s-sent').textContent = 'This page was made from the spec alone, with no run to play. Click a state to see what it needs and passes on.';
    $('s-by').textContent = '—'; $('s-to').textContent = '—';
    for (const id of ['c-head', 'c-verdict', 'c-dec', 'c-merge']) $(id).innerHTML = NONE;
    return;
  }
  const run = runs[ri];
  $('s-pos').textContent = 'Step ' + (cur + 1) + ' of ' + steps.length;
  $('s-ch').textContent = run.chapters?.[step.chapter]?.title || '';
  $('s-when').textContent = when(step.at);
  $('s-sent').textContent = step.sentence || step.what;
  $('s-sent').title = step.sentence || '';
  $('s-by').textContent = step.by || '';
  $('s-to').textContent = nameOf(step.state);
  const c = step.context, head = c.pr?.headSha, v = c.verdict;
  $('c-head').innerHTML = head ? code(head) : NONE;
  $('c-verdict').innerHTML = v?.sha
    ? '<span class="' + (v.result === 'FAIL' ? 'fail-word' : '') + '">' + esc(v.result) + '</span> for ' + code(v.sha) + (head ? (v.sha === head ? ', the PR head' : ', <strong>not the PR head</strong>') : '')
    : NONE;
  $('c-dec').innerHTML = c.decision?.choice ? esc(DONE_WORD[c.decision.choice] || c.decision.choice) + ' by ' + esc(whoWord(c.decision.by)) : NONE;
  $('c-merge').innerHTML = c.merge?.sha ? 'as ' + code(c.merge.sha) + (v?.sha ? ', from verified ' + code(v.sha) : '') : '<span class="none">not yet</span>';
  for (const id of ['c-head', 'c-dec', 'c-merge']) $(id).title = $(id).textContent;
  $('c-verdict').title = v?.sha ? v.result + ' for ' + v.sha + (head && v.sha !== head ? '; the PR head is ' + head : '') : '';
}

const passesText = (i) => {
  if (layout.inputs?.[i.from]) return layout.inputs[i.from];
  try {
    const v = JSON.parse(i.from);
    if (Array.isArray(v)) return 'the choices: ' + v.join(' or ');
    if (i.name === 'question') return 'the question “' + v + '”';
    return i.name + ': ' + v;
  } catch { return i.name + ': ' + i.from.replace(/^context\./, ''); }
};
const needText = (g) => layout.guards?.[g.name] || g.conditions.map((t) => t.replace(/context\./g, '')).join(', and ');
let shownState = null;
function showState() {
  const step = steps[cur];
  const id = picked || step?.state || graph.initial;
  const n = nodeById[id];
  const taken = new Set(steps.slice(0, cur + 1).map((s) => s.edge));
  const following = !picked || picked === step?.state;
  $('st-head').innerHTML = following ? 'The state the item is in at this step.' : 'You picked <b>' + esc(nameOf(id)) + '</b>; the item is in ' + esc(nameOf(step?.state || graph.initial)) + '.';
  $('st-follow').hidden = following;
  $('st-out').innerHTML = graph.edges.filter((e) => e.from === id).map((e) =>
    '<li><b>' + esc(lineText(e)) + '</b> → ' + esc(nameOf(e.to)) + (taken.has(e.id) ? ' · <span class="tk">✓ taken in this run so far</span>' : '') +
    (e.writes.length ? '<div class="muted">records ' + e.writes.map((w) => esc(fieldLabel(w.field))).join(', ') + '</div>' : '') + '</li>').join('') || '<li class="muted">None: the item ends here.</li>';
  if (shownState === id) return; // the rest describes the state, not the step
  shownState = id;
  $('st-name').textContent = nameOf(id);
  $('st-note').textContent = (n.final ? 'The item ends here.' : layout.notes?.[id] ? cap(layout.notes[id]) + '.' : '');
  $('st-needs').innerHTML = n.needs.length ? n.needs.map((g) => '<li>' + esc(needText(g)) + '</li>').join('') : '<li class="muted">Nothing.</li>';
  $('st-passes-box').hidden = !n.actor;
  $('st-passes').innerHTML = n.input.map((i) => '<li>' + esc(passesText(i)) + '</li>').join('');
  const ins = graph.edges.filter((e) => e.to === id);
  $('st-in').innerHTML = (id === graph.initial ? '<li>at the start</li>' : '') + ins.map((e) => '<li>from ' + esc(nameOf(e.from)) + ': ' + esc(lineText(e)) + '</li>').join('') || '<li class="muted">Only the start.</li>';
  $('st-specbody').innerHTML = '<p>State <code>' + esc(id) + '</code>' + (n.actor ? ', session <code>' + esc(n.actor) + '</code>' : '') + '.</p>' +
    (n.needs.length ? '<p>Needs: ' + n.needs.map((g) => '<code>' + esc(g.name) + '</code> (' + esc(g.conditions.join(', and ')) + ')').join('; ') + '</p>' : '') +
    (n.input.length ? '<p>Input: ' + n.input.map((i) => '<code>' + esc(i.name) + '</code> ← ' + esc(i.from)).join('; ') + '</p>' : '');
}
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

function showEntry(step) { $('entry').textContent = step ? JSON.stringify(step.entry, null, 2) : 'No journal was given.'; }

// ---- Compare runs: A is the run being stepped, B the one picked. Strips have one cell per step, lettered by the
// state it entered, lined up from the start; the first cell where a run parts from A is outlined.
const sameStep = (x, y) => x && y && x.state === y.state && x.edge === y.edge;
const partsAt = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if (!sameStep(a[i], b[i])) return i; return -1; };
(function buildCompare() {
  $('runs').innerHTML = runs.map((r, i) => '<li data-run="' + i + '"><button type="button" class="pick" data-pick="' + i + '" title="' + esc(r.about) + '"><span class="nm">' + esc(r.name) + '</span><span class="oc">' + esc(r.outcome) + '</span></button>' +
    '<span><span class="tag"></span> <button type="button" class="open" data-open="' + i + '">Step through</button></span>' +
    '<span class="cells" aria-hidden="true">' + r.steps.map((s, j) => '<i class="tone-' + toneOf(s) + '" title="Step ' + (j + 1) + ': ' + esc(s.sentence || s.what) + '">' + esc(shortOf(s.state)) + '</i>').join('') + '</span></li>').join('');
  const seen = [...new Set(runs.flatMap((r) => r.steps.map((s) => s.state)))];
  $('letters').textContent = 'Cells, one per step, name the state entered: ' + graph.nodes.filter((n) => seen.includes(n.id)).map((n) => shortOf(n.id) + ' ' + nameOf(n.id)).join(', ') + '. The underline is the line taken: grey forward, blue back, red went wrong. The outlined cell is where a run first parts from A.';
})();
function showCompare() {
  const A = runs[ri], B = cmpB != null ? runs[cmpB] : null;
  for (const li of $('runs').children) {
    const i = Number(li.dataset.run), r = runs[i];
    li.classList.toggle('isA', i === ri);
    li.classList.toggle('isB', i === cmpB);
    li.querySelector('.tag').textContent = i === ri ? 'A' : i === cmpB ? 'B' : '';
    li.querySelector('.pick').setAttribute('aria-pressed', String(i === cmpB));
    li.querySelector('.open').hidden = i === ri;
    const k = i === ri ? -1 : partsAt(A?.steps || [], r.steps);
    [...li.querySelector('.cells').children].forEach((cell, j) => { cell.classList.toggle('div', j === k); cell.classList.toggle('at', i === ri && j === cur); });
  }
  $('cA-name').textContent = A ? A.name : 'No run';
  $('cA-out').textContent = A ? A.outcome : '';
  $('cB-name').textContent = B ? B.name : 'Pick a run below to compare with A.';
  $('cB-out').textContent = B ? B.outcome : '';
  if (!A || !B) { $('cDiff').textContent = 'A is the run you are stepping. Its current step is the filled cell.'; return; }
  const k = partsAt(A.steps, B.steps);
  if (k < 0) { $('cDiff').textContent = 'A and B took the same path, step for step.'; return; }
  const sa = A.steps[k], sb = B.steps[k];
  $('cDiff').innerHTML = (k ? 'Same path for the first ' + k + ' step' + (k === 1 ? '' : 's') + '. ' : '') + '<b>They part at step ' + (k + 1) + '.</b> ' +
    'A: ' + esc(sa ? sa.sentence : 'A has ended.') + ' B: ' + esc(sb ? sb.sentence : 'B has ended.') +
    (sa && cur !== k ? '<button type="button" data-goto="' + k + '">Show step ' + (k + 1) + ' of A</button>' : '');
}

// ---- Painting one step: every region updates in place.
function paint() {
  const step = steps[cur];
  $('pos').textContent = steps.length ? (cur + 1) + ' of ' + steps.length : 'no run';
  $('slider').value = cur + 1;
  $('slider').setAttribute('aria-valuetext', step ? 'Step ' + (cur + 1) + ' of ' + steps.length + ': ' + step.sentence : 'no run');
  for (const li of $('steps').querySelectorAll('li[data-i]')) {
    const i = Number(li.dataset.i);
    li.classList.toggle('cur', i === cur);
    li.classList.toggle('later', i > cur);
    li.querySelector('button').toggleAttribute('aria-current', i === cur);
  }
  keepInView();
  paintDrawing(step);
  showStory(step);
  showHolds(step);
  showState();
  showEntry(step);
  showCompare();
}
// Keep the current step's row in the list's own box when stepping moves it out (never scrolls the page).
function keepInView() {
  const list = $('steps'), row = list.querySelector('li.cur');
  if (!row || !list.clientHeight) return;
  const top = row.offsetTop, bottom = top + row.offsetHeight;
  if (top < list.scrollTop + 26) list.scrollTop = Math.max(0, top - 26);
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4;
}

function setTab(name) {
  tab = name;
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const t of ['step', 'state', 'entry', 'cmp']) $('tab-' + t).hidden = t !== name;
  paint();
}
function setView(name) {
  $('app').dataset.view = name;
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === name));
  keepInView();
}

// Show one run from step at. The tab, a picked state, the compared run, open disclosures and scroll positions stay.
function load(i, at = 0) {
  if (i === cmpB) cmpB = null;
  ri = i;
  const run = runs[i];
  steps = run?.steps ?? [];
  cur = Math.min(Math.max(0, at), Math.max(0, steps.length - 1));
  $('outcome').textContent = run?.outcome ?? '';
  $('counts').textContent = run?.counts ? '· ' + run.counts : '';
  $('outcomeline').title = run ? run.outcome + ' (' + run.counts + ')' : '';
  $('steps').innerHTML = (run?.chapters || []).map((ch) =>
    '<li class="ch" title="' + esc(ch.title + ': ' + ch.summary) + '">' + esc(ch.title) + '<span class="chs">' + esc(ch.summary) + '</span></li>' +
    steps.slice(ch.first, ch.last + 1).map((s, k) => {
      const j = ch.first + k;
      return '<li class="st tone-' + toneOf(s) + '" data-i="' + j + '"><button type="button" data-i="' + j + '" title="' + esc(s.sentence) + '"><span class="num">' + (j + 1) + '</span><span class="t">' + esc(s.sentence) + '</span><span class="to">→ ' + esc(nameOf(s.state)) + '</span></button></li>';
    }).join('')).join('') || '<li class="muted">No run.</li>';
  $('slider').max = Math.max(1, steps.length);
  $('run').value = String(i);
  paint();
}

const options = (list) => list.map(({ r, i }) => '<option value="' + i + '">' + esc(r.name) + '</option>').join('');
const indexed = runs.map((r, i) => ({ r, i }));
const real = indexed.filter((x) => !x.r.example), examples = indexed.filter((x) => x.r.example);
$('run').innerHTML = examples.length && real.length ? '<optgroup label="Real runs">' + options(real) + '</optgroup><optgroup label="Examples">' + options(examples) + '</optgroup>' : options(indexed);
$('run').hidden = !runs.length;
$('run').addEventListener('change', () => { stop(); load(Number($('run').value)); say(); });
$('steps').addEventListener('click', (ev) => { const t = ev.target.closest('button[data-i]'); if (t) { stop(); go(Number(t.dataset.i)); } });
$('slider').addEventListener('input', () => go(Number($('slider').value) - 1));
for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => setView(b.dataset.view));
$('changed').addEventListener('click', (ev) => {
  const j = ev.target.closest('[data-row]');
  if (!j) return;
  const box = $('holds-scroll'), tr = rows[Number(j.dataset.row)].tr;
  box.scrollTop = Math.max(0, tr.offsetTop - 30);
});
$('st-follow').addEventListener('click', () => { picked = null; paint(); });
$('tab-cmp').addEventListener('click', (ev) => {
  const pick = ev.target.closest('[data-pick]'), open = ev.target.closest('[data-open]'), goto = ev.target.closest('[data-goto]');
  if (open) { const was = ri; stop(); load(Number(open.dataset.open)); cmpB = was; paint(); say(); }
  else if (pick) { const i = Number(pick.dataset.pick); if (i !== ri) { cmpB = cmpB === i ? null : i; paint(); } }
  else if (goto) { stop(); go(Number(goto.dataset.goto)); }
});

const stop = () => { clearTimeout(timer); timer = null; $('play').textContent = 'Play'; };
// Say the step aloud to a screen reader when it changes, and only then.
const say = () => { const s = steps[cur]; $('said').textContent = s ? 'Step ' + (cur + 1) + ' of ' + steps.length + ': ' + s.sentence : ''; };
function go(i) { cur = Math.min(Math.max(0, i), Math.max(0, steps.length - 1)); paint(); say(); }
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
$('last').addEventListener('click', () => { stop(); go(steps.length - 1); });
// Arrows, Home and End step anywhere but in the run picker and the slider (which step on their own); Space plays
// unless a button has focus, where it presses the button.
document.addEventListener('keydown', (ev) => {
  if (ev.target.closest('select, input')) return;
  const keys = { ArrowRight: () => go(cur + 1), ArrowLeft: () => go(cur - 1), Home: () => go(0), End: () => go(steps.length - 1) };
  if (keys[ev.key]) { ev.preventDefault(); stop(); keys[ev.key](); }
  else if (ev.key === ' ' && !ev.target.closest('button, [role=button], summary')) { ev.preventDefault(); $('play').click(); }
});

load(0, Infinity); // the first run opens on its last step, so the whole path it walked shows at rest
try { draw(); } catch (err) { $('diagram').innerHTML = '<p class="muted">The graph could not be drawn (' + esc(err.message) + '). The steps and data still work.</p>'; }
</script>
`;
