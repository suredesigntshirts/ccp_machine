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

// Who did a step: whoever the answer names, else the role of the run it finished, else where it came from. A
// session that crashed is named as that session, though the harness reported it.
const ROLES = { brief: 'the harness', build: 'the builder', verify: 'the verifier', ask: 'the stand-in', merge: 'the harness' };
const CRASHED = { build: 'the builder session', verify: 'the verifier session' };
const SOURCES = { host: 'the harness', person: 'the person', github: 'GitHub', timer: 'the time limit' };
const roleOf = (s) => s.run?.split('.')[1];
const actorOf = (s) => {
  const named = s.entry.event.output?.by;
  if (named) return named === 'person' ? 'the person' : `the ${named}`;
  if (s.entry.event.error != null && CRASHED[roleOf(s)]) return CRASHED[roleOf(s)];
  const role = s.run && s.source !== 'host' ? ROLES[roleOf(s)] : null;
  return role || SOURCES[s.source] || String(s.source).replace(/^claude:/, 'the ');
};
const byOf = (s) => actorOf(s) + (/^claude:[0-9a-f]{8}-/.test(s.source) ? ` (session ${s.source.slice(7, 15)})` : '');

const BUILD_PHASE = new Set(['building', 'verifying', 'awaitingMerge', 'merging']);

// Why a run went to replanning, in a few words, from the step that took it there. A session that ends without a
// result has crashed; a question that errored failed; a verdict is PASS or FAIL.
const causeOf = (s) => {
  const out = s.entry.event.output ?? {};
  switch (s.what) {
    case 'brief failed': return 'briefing failed';
    case 'build failed': return `build ${s.build} crashed`;
    case 'verify done': return out.result === 'PASS' ? 'a PASS on an old commit' : `build ${s.build} failed verification with no builds left`;
    case 'verify failed': return `the verifier session crashed on build ${s.build}`;
    case 'ask done': return `the stand-in rejected build ${s.build}`;
    case 'ask failed': return 'the approval question failed';
    case 'merge failed': return 'the merge failed';
    default: return s.what.startsWith('after ') ? `build ${s.build} hit its time limit` : 'it stalled';
  }
};

/**
 * Sentences and chapters for one run's steps, in the layout's names. Adds sentence, by, build (the build in progress,
 * numbered through the whole run) and chapter to each step, and returns the chapters: Briefing, Build 1,
 * Replanning, Build 2 and so on, each with a summary and, for a replan, its cause.
 */
const tell = (steps, { names = {}, limit = null, delays = {} } = {}) => {
  const name = (id) => names[id] || id;
  const chapters = [];
  let build = 0; // builds started so far in this run
  steps.forEach((s, i) => {
    const prev = steps[i - 1];
    const ev = s.entry.event, out = ev.output ?? {}, c = s.context, b = prev?.context ?? {};
    const err = ev.error != null ? String(ev.error) : '';
    const actor = actorOf(s);
    s.build = build;
    // The step's sentence. The state it leads to is shown beside it, so the sentence does not say it again, and
    // a reason comes straight after the verb, before anything a narrow row cuts off.
    const say = (() => {
      switch (s.what) {
        case 'start': return `${cap(actor)} opened the item for ${c.issue?.title ? quoted(c.issue.title) : `the issue ${c.issue?.url ?? ''}`}.`;
        case 'brief done': return `${cap(actor)} wrote the builder's and the verifier's briefs${c.why ? ', using the five whys' : ''}.`;
        case 'brief failed': return stop(`Briefing failed: ${err}`);
        case 'build done': return `The builder made commit ${sha7(out.pr?.headSha)} in build ${build}.`;
        case 'build failed': return stop(`Build ${build} crashed: ${err}`);
        case 'verify done': {
          const v = sha7(out.sha), head = sha7(c.pr?.headSha);
          if (s.state === 'awaitingMerge') return `The verifier passed commit ${v}, the PR head.`;
          if (s.state === 'building') return `The verifier failed commit ${v}; ${limit ? plural(limit - c.builds, 'build') + ' left before a replan, so ' : ''}the builder builds again with the verdict.`;
          if (out.result === 'PASS') return `The verifier passed commit ${v}, but the PR head is now ${head}, so the PASS does not count.`;
          return `The verifier failed commit ${v}, and no builds are left before a replan.`;
        }
        case 'verify failed': return stop(`The verifier session crashed on build ${build}: ${err}`);
        case 'pr.pushed': return s.from === 'verifying'
          ? `A new push moved the PR head from ${sha7(b.pr?.headSha)} to ${sha7(ev.headSha)}, so verification starts again.`
          : `A new push moved the PR head from ${sha7(b.pr?.headSha)} to ${sha7(ev.headSha)} after it passed, so the PASS no longer covers the head.`;
        case 'ask done':
          if (s.from === 'awaitingMerge') return out.choice === 'approve'
            ? `${cap(actor)} approved merging commit ${sha7(c.verdict?.sha)}.`
            : stop(`${cap(actor)} rejected the merge${out.why ? ': ' + quoted(out.why) : ''}`);
          if (s.state === 'briefing') return stop(`${cap(actor)} replanned${out.why ? ', with five whys: ' + quoted(out.why) : ''}`) + ' Builds start again from 0.';
          return stop(`${cap(actor)} dropped the item${out.why ? ': ' + quoted(out.why) : ''}`);
        case 'ask failed': return s.from === 'replanning'
          ? (/answer/i.test(err) ? 'Nobody answered the replanning question, so the item was dropped.' : stop(`The replanning question failed: ${err}`) + ' The item was dropped.')
          : stop(`The approval question failed: ${err}`);
        case 'merge done': return `${cap(actor)} merged the PR as ${sha7(out.sha)}, which contains the verified commit ${sha7(c.verdict?.sha)}.`;
        case 'merge failed': return stop(`The merge failed: ${err}`);
        default:
          if (s.what.startsWith('after ')) {
            const key = s.what.slice(6), ran = prev ? Date.parse(s.at) - Date.parse(prev.at) : null;
            const lim = delays[key] != null ? `its ${duration(delays[key])} time limit` : 'its time limit';
            return `Build ${build} ran ${ran != null ? duration(ran) + ' and hit ' : 'past '}${lim}.`;
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
      const title = phase === 'briefing' ? (chapters.some((ch) => ch.phase === 'briefing') ? 'Briefing again' : 'Briefing')
        : phase === 'build' ? `Build ${build}`
        : phase === 'replanning' ? 'Replanning' : name(phase);
      const ch = { phase, build, title, first: i, last: i, marks: [] };
      if (phase === 'replanning' && prev) { ch.cause = causeOf(prev); ch.marks.push(`after ${ch.cause}`); }
      chapters.push(ch);
    } else last.last = i;
    const ch = chapters.at(-1);
    s.chapter = chapters.length - 1;
    // What the chapter came to, in a few words: its commit, verdicts and decisions in order.
    const mark = (() => {
      switch (s.what) {
        case 'brief done': return 'briefs written';
        case 'brief failed': return 'briefing failed';
        case 'build done': return `commit ${sha7(out.pr?.headSha)}`;
        case 'build failed': return 'crashed';
        case 'verify done': return out.result === 'PASS' && out.sha !== c.pr?.headSha ? 'PASS on an old commit' : out.result;
        case 'verify failed': return 'verifier crashed';
        case 'pr.pushed': return `pushed ${sha7(ev.headSha)}`;
        case 'ask done': return s.from === 'replanning' ? (s.state === 'briefing' ? `replanned by ${actor}` : `dropped by ${actor}`) : `${CHOSEN[out.choice] ?? out.choice}`;
        case 'ask failed': return s.from === 'replanning' ? 'no answer, dropped' : 'approval question failed';
        case 'merge done': return 'merged';
        case 'merge failed': return 'merge failed';
        default: return s.what.startsWith('after ') ? 'hit its time limit' : null;
      }
    })();
    if (mark) ch.marks.push(mark);
    if (s.state === 'building' && s.from !== 'building') build += 1; // the build the next steps belong to
  });
  return chapters.map(({ phase, marks, ...rest }) => ({ ...rest, kind: phase, summary: marks.join(' · ') }));
};

// How a run ended, as a sentence that says why (and why it was replanned, if it was), and its counts as a second,
// shorter line. Also returns end (merged, dropped or open) and the cause of each replan, for Compare.
const outcomeOf = (steps, chapters, { names = {} } = {}) => {
  if (!steps.length) return { outcome: '', counts: '', end: 'open', replans: [] };
  const last = steps.at(-1), c = last.context, out = last.entry.event.output ?? {};
  const builds = steps.filter((s) => s.state === 'building' && s.from !== 'building').length;
  const replans = chapters.filter((ch) => ch.kind === 'replanning' && steps[ch.last].state === 'briefing').map((ch) => ch.cause);
  const counts = [plural(builds, 'build'), replans.length ? plural(replans.length, 'replan') : 'no replans', plural(steps.length, 'step')].join(' · ');
  const stalled = steps.findLast((s) => s.state === 'replanning' && s.from !== 'replanning');
  const why = replans.length ? `, after ${plural(replans.length, 'replan')} (${replans.join('; ')})` : '';
  let outcome, end;
  if (last.state === 'done') {
    end = 'merged';
    outcome = `Merged as ${sha7(c.merge?.sha)} from ${sha7(c.verdict?.sha)} in build ${last.build}${why}.`;
  } else if (last.state === 'dropped') {
    end = 'dropped';
    const cause = stalled ? ` after ${causeOf(stalled)}` : '';
    outcome = last.what === 'ask failed'
      ? `Dropped${cause}: nobody answered the replanning question.`
      : `Dropped by ${actorOf(last)}${cause}${out.why ? ': ' + quoted(out.why) : '.'}`;
  } else {
    end = 'open';
    outcome = `Not finished: the item is in ${names[last.state] || last.state}.`;
  }
  return { outcome, counts, end, replans };
};

/** The inspector page, as HTML for an Artifact. runs: [{ name, about, entries, example? }], each a journal to play; the page picks between them. */
export const itemInspector = (spec, runs = [], layout = null) => {
  const graph = graphOf(spec);
  const words = { names: layout?.names ?? {}, limit: buildLimitOf(spec), delays: spec.meta?.delays ?? {} };
  const shown = runs.map(({ name, about, entries, example }) => {
    const steps = stepsOf(spec, graph, entries);
    const chapters = tell(steps, words);
    return { name, about: about ?? '', example: !!example, ...outcomeOf(steps, chapters, words), chapters, steps };
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
   scrolls inside its own box; the page itself never scrolls. A box whose text varies by run (the outcome line,
   the key) is sized once, for its longest case, so it never cuts text and never changes size. A box that shows the
   step's response brings it into view: the steps list, the changed rows of What the item holds, and on a phone
   the ring in the drawing.
   Four hues, one meaning each, on every part of the page, the drawing included, and each always with a second cue:
     blue  = back, to try again   (dashed lines, dashed strip cells, step bars)
     red   = went wrong           (lines to replanning and dropping, FAIL, crashed, dropped; the words say it too)
     green = passed or merged     (PASS, merged, the ✓; the words say it too)
     amber = changed at this step (the + and ~ marks and their tint; the mark says how)
   Everything else is grey: going forward, who acted, "now" (weight and a glow) and A against B (solid and dotted
   badges, ≠ marks). Dots mean "only in run B", in the line's own colour. */
:root{
  --bg:#f2f4f3; --panel:#ffffff; --raised:#e6eae8; --pick:#c9d0cd; --fg:#1b201f; --muted:#59625f; --line:#d4dad7; --node:#ffffff; --nodeline:#89928f;
  --fwd:#7d8784; --back:#2c66ad; --backbg:#dde8f6; --bad:#b0352f; --badbg:#f7dedb; --ok:#1d6b35; --okbg:#d7eedd; --hi:#7a4f00; --hibg:#f9e7bd; --del:#59625f;
  --body:"IBM Plex Sans",system-ui,sans-serif; --mono:"IBM Plex Mono",ui-monospace,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#111413; --panel:#191d1c; --raised:#2a302e; --pick:#434c49; --fg:#e4e8e6; --muted:#a3aca9; --line:#2d3432; --node:#1d2221; --nodeline:#6c7773;
  --fwd:#7f8a86; --back:#80b2f0; --backbg:#1c2b3e; --bad:#f08e88; --badbg:#3d2120; --ok:#86d69d; --okbg:#1b3a25; --hi:#f1c76f; --hibg:#3f3216; --del:#a3aca9; color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#111413; --panel:#191d1c; --raised:#2a302e; --pick:#434c49; --fg:#e4e8e6; --muted:#a3aca9; --line:#2d3432; --node:#1d2221; --nodeline:#6c7773;
  --fwd:#7f8a86; --back:#80b2f0; --backbg:#1c2b3e; --bad:#f08e88; --badbg:#3d2120; --ok:#86d69d; --okbg:#1b3a25; --hi:#f1c76f; --hibg:#3f3216; --del:#a3aca9; color-scheme:dark}
*{box-sizing:border-box}
html,body{height:100%}
body{background:var(--bg);color:var(--fg);font:14px/1.45 var(--body);margin:0;overflow:hidden}
.app{height:100vh;height:100dvh;display:grid;gap:12px;padding:12px max(16px,env(safe-area-inset-right,0px)) 12px max(16px,env(safe-area-inset-left,0px));
  grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-rows:auto 212px minmax(0,1fr) 44px 244px;
  grid-template-areas:"top top" "draw story" "draw detail" "trans detail" "side detail"}
@media (min-width:1600px){.app{grid-template-columns:minmax(0,1.3fr) minmax(0,1.05fr) minmax(0,.9fr);grid-template-rows:auto 212px minmax(0,1fr) 44px;
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
button.small{padding:1px 8px;font-size:12px}

/* Top: which run, and how it ended. The outcome line is sized once for the longest run's sentence. */
.top{display:flex;flex-direction:column;justify-content:center;gap:3px;min-width:0}
.l1{display:flex;align-items:center;gap:10px;min-width:0;height:30px}
h1{font-size:1.1rem;margin:0 8px 0 0;font-weight:600;white-space:nowrap}
#run{width:min(380px,100%);flex:0 1 auto;min-width:0}
.how{margin-left:auto;flex:none}
.how summary{cursor:pointer;color:var(--muted);font-size:13px;list-style:none;padding:4px 8px;border:1px solid var(--line);border-radius:6px}
.how summary::-webkit-details-marker{display:none}
.how .shorthow{display:none}
.how .pop{position:fixed;left:max(16px,env(safe-area-inset-left,0px));top:58px;width:min(480px,calc(50vw - 28px));max-height:calc(100vh - 140px);overflow:auto;z-index:5;background:var(--panel);border:1px solid var(--nodeline);border-radius:8px;padding:10px 14px;box-shadow:0 8px 24px rgba(0,0,0,.3);font-size:13px}
.how .pop p{margin:0 0 8px}
.outcome{margin:0;font-size:14px;overflow:auto}
.outcome strong{font-weight:600}

/* The drawing, fitted to its box, and the one key, which wraps and is as tall as its entries need. */
.diagram{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:6px 8px 0}
.diagram svg{display:block;width:100%;height:100%}
.n rect{fill:var(--node);stroke:var(--nodeline);stroke-width:1.4}
.n rect.halo{fill:none;stroke:none}
.n text{fill:var(--fg);font:600 12.5px var(--body)}
.n text.s{fill:var(--muted);font:400 10.5px var(--mono)}
.n text.cnt{fill:var(--fg);font:600 11px var(--mono)}
.n{cursor:pointer}
.n.touched rect.box{fill:var(--raised)}
.n.sel rect.box{fill:var(--pick);stroke:var(--fg);stroke-width:1.6}
.n.on rect.box{stroke:var(--fg);stroke-width:2.6}
.n.on rect.halo{stroke:var(--fg);stroke-width:7;opacity:.22}
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
.e.now path{stroke-width:5;filter:drop-shadow(0 0 3px var(--fg))}
.e.now text{font-weight:600}
.e.bonly path{opacity:1;stroke-width:3.2;stroke-dasharray:.5 6;stroke-linecap:round}
.e.bonly text{font-weight:600}
.key{flex:none;display:flex;flex-wrap:wrap;align-content:flex-start;gap:2px 14px;padding:4px 12px 6px;color:var(--muted);font-size:12px}
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
   and five cells that say which commit and which answers stand, each marked when this step changed it. */
.story{padding:11px 14px 10px;gap:5px}
.story .meta{height:17px;font:600 11.5px var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.story .sent{margin:0;font-size:15px;line-height:21px;height:63px;overflow:auto}
.story .byline{height:19px;font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.story .byline b{color:var(--fg);font-weight:600}
.commits{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px 10px;margin:auto 0 0;padding-top:7px;border-top:1px solid var(--line)}
.commits > div{min-width:0}
.commits dt{font:600 10.5px/14px var(--body);text-transform:uppercase;letter-spacing:.05em;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.commits dd .mk{font-size:11.5px;line-height:15px;width:1.2em}
.commits dd{margin:0;font:12.5px/17px var(--body);height:34px;overflow:hidden;overflow-wrap:anywhere;border-radius:3px}
.commits dd code{font-size:12px}
.commits dd.add{background:var(--hibg)} .commits dd.chg{background:var(--hibg)}
.commits .none{color:var(--muted)}
.w-bad{color:var(--bad);font-weight:600} .w-ok{color:var(--ok);font-weight:600}
.endmk{font-weight:600} .endmk.merged{color:var(--ok)} .endmk.dropped{color:var(--bad)} .endmk.open{color:var(--muted)}

/* The run's steps, in chapters; the list scrolls inside its box and keeps the current row in view. A focused row
   shows its whole sentence over the rows below it. */
.side .head,.detail .tabs{flex:none;height:38px;display:flex;align-items:center;gap:4px;padding:0 12px;border-bottom:1px solid var(--line)}
#steps{flex:1;min-height:0;overflow:auto;margin:0;padding:4px 8px 10px;list-style:none;position:relative}
#steps li.ch{padding:9px 6px 3px;font:600 11px var(--body);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#steps li.ch .chs{font:400 11.5px var(--mono);text-transform:none;letter-spacing:0;margin-left:6px}
#steps li.st{position:relative}
#steps button{width:100%;height:30px;display:grid;grid-template-columns:2.2em minmax(0,1fr) auto;align-items:center;gap:6px;text-align:left;border:0;border-left:4px solid var(--c);border-radius:5px;background:transparent;padding:0 8px 0 6px}
#steps button:focus-visible::after{content:attr(data-full);position:absolute;left:34px;right:4px;top:31px;z-index:3;background:var(--panel);color:var(--fg);border:1px solid var(--nodeline);border-radius:6px;padding:5px 8px;font:13px/1.4 var(--body);white-space:normal;box-shadow:0 4px 14px rgba(0,0,0,.25)}
#steps .num{font:600 11px var(--mono);color:var(--muted)}
#steps .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}
#steps .to{font:11.5px var(--mono);color:var(--muted);white-space:nowrap}
#steps li.later .t{color:var(--muted)}
#steps li.cur button{background:var(--raised);box-shadow:inset 0 0 0 1px var(--fg)}
#steps li.cur .t{font-weight:600}
.tone-start,.tone-fwd{--c:var(--fwd)} .tone-back{--c:var(--back)} .tone-fail{--c:var(--bad)}

/* The detail: tabs whose panels each scroll inside the same box. Runs (all runs, and A against B) is the fourth. */
.detail .tabs{padding:0 8px;overflow:hidden}
.detail .tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;background:none;height:37px;padding:0 9px;color:var(--muted);white-space:nowrap}
.detail .tabs button[aria-selected="true"]{border-bottom-color:var(--fg);color:var(--fg);font-weight:600}
.detail .tabs [data-tab="cmp"]{margin-left:auto}
.toruns{display:none;flex:none}
.tab{flex:1;min-height:0;display:flex;flex-direction:column}
.tab[hidden]{display:none}
.tabhead{flex:none;padding:8px 14px;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--muted);min-height:36px}
.scroll{flex:1;min-height:0;overflow:auto;padding:6px 14px 14px}
ins{text-decoration:none;border-radius:3px;padding:0 3px}
s{color:var(--del)}
.mk{display:inline-block;width:1.3em;text-align:center;font:600 13px var(--mono);border-radius:3px}
.mk.add,tr.add td.m{color:var(--hi);background:var(--hibg)} .mk.chg,tr.chg td.m{color:var(--hi);background:var(--hibg)} .mk.del,tr.del td.m{color:var(--del);background:var(--raised)}
/* "This step:" holds one chip per field the step touched, in two lines at most; what does not fit is counted. */
#tab-step .tabhead{padding:6px 14px;height:64px}
.changed-here{display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center;height:50px;overflow:hidden;align-content:flex-start}
.changed-here b{color:var(--fg);font-weight:600;line-height:23px}
.changed-here button{height:23px;padding:0 7px 0 3px;font-size:12.5px;border-color:var(--line);display:inline-flex;align-items:center;gap:4px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.changed-here button.more{padding:0 8px;font-weight:600}
.changed-here .mk{font-size:12px;line-height:17px}
table.holds{width:100%;border-collapse:collapse;font-size:13px;position:relative}
#holds-scroll{position:relative}
table.holds th,table.holds td{text-align:left;vertical-align:top;padding:3px 6px}
table.holds tr.grp th{font:600 11px var(--body);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding-top:12px}
table.holds tr.grp .ny{display:none;text-transform:none;letter-spacing:0;font-weight:400;margin-left:8px}
table.holds tr.grp.touched th,table.holds tr.solo.touched td.k{color:var(--fg)}
table.holds tr.part td.k{padding-left:18px}
table.holds tr.solo td{padding-top:12px}
table.holds tr.solo td.k{font:600 11px/1.9 var(--body);text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}
table.holds td.m{width:1.6em;text-align:center;font:600 13px var(--mono);border-radius:3px}
table.holds td.k{color:var(--muted);width:10.5em}
table.holds td.v{font:12.5px/1.5 var(--mono);overflow-wrap:anywhere}
table.holds tr.add ins{background:var(--hibg);color:var(--hi)}
table.holds tr.chg ins{background:var(--hibg);color:var(--hi)}
table.holds tr.empty td.v{color:var(--muted)}
.state h3{margin:6px 0 0;font-size:1.1rem}
.state h4{margin:14px 0 4px;font:600 11px var(--body);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.state ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;font-size:13.5px}
.state .tk{font-weight:600}
.state details{margin-top:16px;font-size:12.5px;color:var(--muted)}
.state summary{cursor:pointer}
#st-follow{margin-left:8px}
.jsum{margin:0 0 8px;font-size:13px;color:var(--fg)}
pre{margin:0;background:var(--raised);border-radius:6px;padding:8px;font:12px/1.45 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}

/* Compare runs: A is the run being stepped, B the one picked. Their chapters line up side by side. */
.cmppick{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;color:var(--fg)}
.cmppick select{min-width:0;flex:1 1 auto;max-width:340px}
.cmppick button{flex:none;white-space:nowrap}
.cmpsum{margin:4px 0 10px;font-size:13.5px}
.badge{display:inline-block;width:1.4em;text-align:center;font:600 11px/1.6 var(--mono);border:1.5px solid var(--fg);border-radius:4px;margin-right:4px}
.badge.b{border-style:dotted}
table.chap{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}
table.chap th,table.chap td{text-align:left;vertical-align:top;padding:5px 6px;border-top:1px solid var(--line);overflow-wrap:anywhere}
table.chap thead th{border-top:0;font-weight:600}
table.chap col.m{width:1.8em}
table.chap td.m{text-align:center;padding-left:0;padding-right:0}
table.chap tr.oc td{color:var(--muted);font-size:12.5px}
table.chap tr.differs td.m{color:var(--fg);background:var(--raised);font:600 13px var(--mono)}
table.chap .ct{display:block;font:600 11px var(--body);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
table.chap .cs{font:12px/1.45 var(--mono)}
table.chap td.here{background:var(--raised)}
table.chap td button{margin-top:4px}

/* All runs: one row per run with its outcome and its strip, one cell per step in chapters. Picking a name steps
   through that run; Compare makes it B. The two sub-views keep their own scroll. */
.subtabs{display:flex;gap:4px;align-items:center;flex-wrap:nowrap}
.subtabs button{height:26px;padding:0 10px;font-size:12.5px;border-color:var(--line);white-space:nowrap}
.subtabs button[aria-pressed="true"]{background:var(--fg);color:var(--panel);border-color:var(--fg)}
.subview{flex:1;min-height:0;display:flex;flex-direction:column}
.subview[hidden]{display:none}
.runkey{margin:4px 0 8px;font-size:12px;color:var(--muted);line-height:1.6}
.runkey summary{cursor:pointer;font-size:12.5px}
.runkey ul{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:3px 12px}
.runkey li{white-space:nowrap}
.runkey i{vertical-align:1px;margin-right:4px}
ol.runlist{list-style:none;margin:0;padding:0}
ol.runlist li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;padding:9px 4px 10px;border-top:1px solid var(--line);align-items:start}
ol.runlist li.isA{background:var(--raised);border-radius:6px}
ol.runlist .tag .badge{margin:0 6px 0 0}
ol.runlist button.nm{border:0;background:none;padding:0;font:600 13.5px var(--body);text-align:left;text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--nodeline)}
ol.runlist li.isA button.nm{text-decoration:none;cursor:default}
ol.runlist .oc{font-size:12.5px;margin-top:1px}
ol.runlist .ct{color:var(--muted);font-size:12px}
ol.runlist .cmpb{white-space:nowrap}
ol.runlist li.isA .cmpb{visibility:hidden}
.strip{display:flex;flex-wrap:wrap;gap:4px 7px;margin-top:5px;grid-column:1 / 3}
.seg{display:flex;flex-direction:column;gap:4px;min-width:0}
.seg .cells{display:flex;gap:2px}
.seg .sl{font:10.5px/13px var(--body);color:var(--muted);white-space:nowrap}
i.c{font-style:normal;flex:none;width:23px;height:19px;display:inline-flex;align-items:center;justify-content:center;font:600 10.5px var(--mono);border-radius:3px;background:var(--raised);color:var(--fg);border:1px solid var(--line);cursor:pointer}
i.c.tone-back{background:var(--backbg);border:1px dashed var(--back)}
i.c.tone-fail{background:var(--badbg);border-color:var(--bad)}
i.c.ok{background:var(--okbg);border-color:var(--ok)}
i.c.parts{outline:2px solid var(--fg);outline-offset:1px}
i.c.at{background:var(--fg);color:var(--panel);border-color:var(--fg)}

/* Phone: the story stays on top, the transport is a bar fixed to the bottom, and one region at a time fills
   the middle: the detail, the steps or the drawing. Empty groups of the item fold to one line. */
@media (max-width:760px){
  .app{grid-template-columns:minmax(0,1fr);grid-template-rows:auto 246px 34px minmax(0,1fr) 46px;gap:8px;
    padding:8px max(16px,env(safe-area-inset-right,0px)) max(8px,env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px));
    grid-template-areas:"top" "story" "views" "view" "trans"}
  .drawcard,.side,.detail{grid-area:view}
  .app:not([data-shows="draw"]) .drawcard,.app:not([data-shows="side"]) .side,.app:not([data-shows="detail"]) .detail{display:none}
  .views{grid-area:views;display:flex;gap:4px}
  .views button{flex:1;padding:0;height:32px}
  .views button[aria-pressed="true"]{background:var(--fg);color:var(--panel);border-color:var(--fg)}
  h1{display:none}
  .toruns{display:inline-block;padding:4px 8px}
  .how .long{display:none} .how .shorthow{display:inline}
  .how summary{padding:4px 6px}
  .how .pop{left:16px;right:16px;width:auto;top:auto;bottom:62px;max-height:min(380px,calc(100dvh - 440px))}
  .outcome{font-size:12.5px;line-height:16px}
  .story .sent{font-size:14px;line-height:19px;height:57px}
  .commits{grid-template-columns:repeat(2,minmax(0,1fr))}
  .commits dd{height:17px;white-space:nowrap;text-overflow:ellipsis}
  .diagram{overflow:auto;display:block;padding:6px}
  .key{font-size:11.5px;gap:0 10px;padding:3px 8px 4px;line-height:1.5} .key .hint{display:none}
  .diagram svg{width:600px;height:533px}
  #speed,.transport .lbl{display:none}
  #prev,#next{width:42px} #play{width:60px} #pos{width:8.5ch}
  .detail .tabs button{padding:0 6px;font-size:12.5px}
  table.holds td.k{width:6.5em}
  table.holds tr.folded{display:none}
  table.holds tr.grp.fold .ny{display:inline}
}
@media (max-width:360px){#first,#last{display:none}}
</style>

<div class="app" id="app" data-shows="detail">
  <header class="top">
    <div class="l1">
      <h1>Work item inspector</h1>
      <label for="run" class="sr">Run</label><select id="run"></select>
      <button type="button" class="toruns" id="toRuns" title="Every run, its outcome and its path">All runs</button>
      <details class="how" id="how"><summary><span class="long">How this page works</span><span class="shorthow">How it works</span></summary><div class="pop">
        <p>Pick a run and step through it. The drawing rings the state the item is in and thickens the lines it has taken; the box beside it says what happened at this step, and the detail shows everything the item holds, with what this step added, changed or cleared marked. Click a state in the drawing to see what it needs and passes on.</p>
        <p><b>Runs</b> lists every run with how it ended and its path as a strip of cells, so odd ones stand out; pick one to step through it, or compare it with the one you are stepping, chapter by chapter.</p>
        <p><b>The harness</b> is the program that runs the item: it writes the briefs, starts the builder and verifier sessions, asks the questions and merges the PR. <b>The stand-in</b> answers the merge question for the person.</p>
        <p>Each run is rebuilt from its journal, the record of what came in from outside: session results, answers, pushes and time limits. The page replays it with the harness's own rules, so every step shown is one the harness accepted.</p>
        <p>Keys: ← and → step, Home and End jump, Space plays, Escape closes this.</p>
      </div></details>
    </div>
    <p class="outcome" id="outcomeline"><strong id="outcome"></strong> <span class="muted" id="counts"></span></p>
  </header>

  <section class="card drawcard" aria-label="Drawing of the machine">
    <div class="diagram" id="diagram"><p class="muted">Drawing the machine…</p></div>
    <div class="key" aria-label="What the drawing means">
      <span><svg width="24" height="8" aria-hidden="true"><line x1="0" y1="4" x2="24" y2="4" stroke="var(--fwd)" stroke-width="1.6"/></svg>forward</span>
      <span><svg width="24" height="8" aria-hidden="true"><line x1="0" y1="4" x2="24" y2="4" stroke="var(--back)" stroke-width="1.6" stroke-dasharray="5 3"/></svg>back, to try again</span>
      <span><svg width="24" height="8" aria-hidden="true"><line x1="0" y1="4" x2="24" y2="4" stroke="var(--bad)" stroke-width="1.6"/></svg>went wrong: <span class="w-bad">FAIL</span>, crashed, dropped</span>
      <span>passed: <span class="w-ok">PASS</span>, <span class="w-ok">✓ merged</span></span>
      <span><span class="mk add">+</span><span class="mk chg">~</span> changed at this step</span>
      <span><svg width="24" height="8" aria-hidden="true"><line x1="0" y1="4" x2="24" y2="4" stroke="var(--fg)" stroke-width="3"/></svg>taken so far</span>
      <span><svg width="24" height="12" aria-hidden="true"><line x1="2" y1="6" x2="22" y2="6" stroke="var(--fg)" stroke-width="5" style="filter:drop-shadow(0 0 2px var(--fg))"/></svg>this step</span>
      <span><svg width="24" height="14" aria-hidden="true"><rect x="3" y="3" width="18" height="8" rx="3" fill="none" stroke="var(--fg)" stroke-width="2"/><rect x="1" y="1" width="22" height="12" rx="4" fill="none" stroke="var(--fg)" stroke-opacity=".25" stroke-width="2"/></svg>where it is now</span>
      <span><svg width="24" height="14" aria-hidden="true"><rect x="2" y="2" width="20" height="10" rx="3" fill="var(--pick)" stroke="var(--fg)" stroke-width="1.4"/></svg>state you picked</span>
      <span>×2 entered 2 times</span>
      <span class="hint">Click a state to see what it needs and passes on.</span>
      <span class="onlyb"><svg width="24" height="8" aria-hidden="true"><line x1="1" y1="4" x2="23" y2="4" stroke="var(--bad)" stroke-width="3" stroke-dasharray=".5 6" stroke-linecap="round"/></svg>dotted: only in run B, in its line's colour</span>
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
    <dl class="commits" aria-label="Which commit, and which answers stand">
      <div><dt id="d-head">PR head</dt><dd id="c-head"></dd></div>
      <div><dt id="d-verdict">Last verdict</dt><dd id="c-verdict"></dd></div>
      <div><dt id="d-appr">Merge approval</dt><dd id="c-appr"></dd></div>
      <div><dt id="d-replan">Replan answer</dt><dd id="c-replan"></dd></div>
      <div><dt id="d-merge">Merged</dt><dd id="c-merge"></dd></div>
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
      <button type="button" role="tab" data-tab="step" aria-selected="true" aria-controls="tab-step">Item holds</button>
      <button type="button" role="tab" data-tab="state" aria-selected="false" aria-controls="tab-state">State</button>
      <button type="button" role="tab" data-tab="entry" aria-selected="false" aria-controls="tab-entry">Journal</button>
      <button type="button" role="tab" data-tab="cmp" aria-selected="false" aria-controls="tab-cmp">Runs</button>
    </div>
    <div class="tab" id="tab-step" role="tabpanel" aria-label="What the item holds">
      <div class="tabhead"><div class="changed-here" id="changed"></div></div>
      <div class="scroll" id="holds-scroll"><table class="holds"><tbody id="holds"></tbody></table></div>
    </div>
    <div class="tab state" id="tab-state" role="tabpanel" aria-label="This state" hidden>
      <div class="tabhead"><span id="st-head"></span><button type="button" class="small" id="st-follow" hidden>Follow the step</button></div>
      <div class="scroll" id="state-scroll">
        <h3 id="st-name"></h3><div class="muted" id="st-note"></div>
        <h4>Needs before it can enter</h4><ul id="st-needs"></ul>
        <div id="st-passes-box"><h4>Passes on to its session</h4><ul id="st-passes"></ul></div>
        <h4>Ways out</h4><ul id="st-out"></ul>
        <h4>Ways in</h4><ul id="st-in"></ul>
        <details id="st-spec"><summary>Names in the spec</summary><div id="st-specbody"></div></details>
      </div>
    </div>
    <div class="tab" id="tab-entry" role="tabpanel" aria-label="Journal line" hidden>
      <div class="tabhead">The line in the run's journal that this step replays. The journal keeps only what came in from outside; the rest of the page is rebuilt from it.</div>
      <div class="scroll" id="entry-scroll"><p class="jsum" id="jsum"></p><pre id="entry"></pre></div>
    </div>
    <div class="tab" id="tab-cmp" role="tabpanel" aria-label="All runs, and compare two" hidden>
      <div class="tabhead subtabs" role="group" aria-label="Show"><button type="button" data-sub="runs" aria-pressed="true" id="subRuns">All runs</button><button type="button" data-sub="ab" aria-pressed="false" id="subAB">Compare A and B</button></div>
      <div class="scroll" id="runs-scroll">
        <details class="runkey" id="runkeyd"><summary>What the cells mean</summary><div id="runkey"></div></details>
        <ol class="runlist" id="runlist"></ol>
      </div>
      <div class="subview" id="ab-view" hidden>
      <div class="tabhead cmppick"><label for="cmpB"><span class="badge b">B</span></label><select id="cmpB"></select><button type="button" class="small" id="cmpSwap" title="Make B the run you step through, and A the one you compare with">Step through B</button></div>
      <div class="scroll" id="cmp-scroll">
        <p class="cmpsum" id="cSum"></p>
        <table class="chap"><colgroup><col class="m"><col><col></colgroup>
          <thead><tr><th></th><th><span class="badge">A</span><span id="cA-name"></span></th><th><span class="badge b">B</span><span id="cB-name"></span></th></tr>
          <tr class="oc"><td class="m"></td><td id="cA-out"></td><td id="cB-out"></td></tr></thead>
          <tbody id="chapRows"></tbody>
        </table>
      </div>
      </div>
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
let sub = 'runs';    // in the Runs tab: all runs, or A and B side by side
let drawn = null;
let timer = null;

// ---- Words
const nameOf = (id) => layout.names?.[id] || id;
const lineText = (e) => (placedOf(e)?.label?.text || edgeLabel(e)).replace(/\n/g, ' / ');
const toneOf = (s) => (!s.edge ? 'start' : placedOf(edgeById[s.edge])?.kind || 'fwd');
const when = (at) => at.slice(0, 16).replace('T', ' ') + ' UTC';
const isSha = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const isPath = (v) => typeof v === 'string' && /^(file:\/\/)?\//.test(v);
const short = (v) => (isSha(v) ? v.slice(0, 7) : isPath(v) ? '…/' + v.replace(/^file:\/\//, '').split('/').slice(-2).join('/') : v);
const tidy = (v) => (Array.isArray(v) ? v.map(tidy) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tidy(x)])) : short(v));
const code = (v) => '<code title="' + esc(v) + '">' + esc(short(v)) + '</code>';
const DONE_WORD = { approve: 'approved', reject: 'rejected', replan: 'replanned', drop: 'dropped' };
const whoWord = (by) => (by === 'person' ? 'the person' : 'the ' + by);
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const endStop = (t) => (/[.!?]$/.test(t) ? t : t + '.');
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
// Words that carry one of the page's hues: green for passed or merged, red for what went wrong. The word itself is
// always there, so the hue is never the only cue.
const TONED = /\b(PASS(?! on an old commit)|merged|FAIL|verifier crashed|crashed|briefing failed|merge failed|approval question failed|rejected|dropped|no answer|hit its time limit)\b/g;
const toned = (t) => esc(t).replace(TONED, (w) => '<span class="' + (w === 'PASS' || w === 'merged' ? 'w-ok' : 'w-bad') + '">' + w + '</span>');
// A run's outcome sentence, led by a mark for how it ended: ✓ merged (green), ✕ dropped (red), ○ not finished (grey).
const END = { merged: '✓', dropped: '✕', open: '○' };
const endHtml = (r) => { const m = /^(Merged|Dropped|Not finished)(.*)$/s.exec(r.outcome || ''); return m ? '<span class="endmk ' + r.end + '">' + END[r.end] + ' ' + m[1] + '</span>' + esc(m[2]) : esc(r.outcome || ''); };
const plain = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.textContent; };

// ---- What the item holds: one row per field (or part of a field), always all of them, in the same order.
const FIELDS = layout.fields || {};
const contextKeys = [...new Set(runs.flatMap((r) => r.steps.flatMap((s) => Object.keys(s.context))))];
const fieldOrder = [...Object.keys(FIELDS).filter((k) => contextKeys.includes(k)), ...contextKeys.filter((k) => !(k in FIELDS))];
const fieldLabel = (path) => { const [f, p] = path.split('.'); return p ? FIELDS[f]?.parts?.[p] || path : FIELDS[f]?.label || f; };
function valueHtml(field, part, v) {
  if (v == null || v === '') return '';
  if (Array.isArray(v)) return v.map((x) => esc(short(x))).join('<br>');
  if (typeof v === 'object') { const ks = Object.keys(v); return ks.length === 1 ? valueHtml(field, ks[0], v[ks[0]]) : esc(JSON.stringify(tidy(v))); }
  if (field === 'decision' && part === 'choice') return esc(DONE_WORD[v] || v);
  if (field === 'decision' && part === 'by') return esc(whoWord(v));
  if (isSha(v) || isPath(v)) return code(v);
  return esc(String(v).replace(/\b[0-9a-f]{8,39}\b/g, (h) => h.slice(0, 7)));
}
const rows = [];
const fields = []; // one per field: its label, its rows, and its group header row if it has parts
(function buildHolds() {
  const body = $('holds');
  for (const f of fieldOrder) {
    const parts = FIELDS[f]?.parts;
    const field = { key: f, label: FIELDS[f]?.label || f, rows: [], head: null };
    fields.push(field);
    if (parts) {
      const tr = document.createElement('tr');
      tr.className = 'grp';
      tr.innerHTML = '<td class="m"></td><th colspan="2">' + esc(field.label) + '<span class="ny">none yet</span></th>';
      body.appendChild(tr);
      field.head = tr;
    }
    for (const [p, label] of parts ? Object.entries(parts) : [[null, field.label]]) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td class="m"></td><td class="k">' + esc(label) + '</td><td class="v"></td>';
      body.appendChild(tr);
      const row = { field: f, part: p, tr, m: tr.cells[0], v: tr.cells[2], owner: field, label };
      rows.push(row);
      field.rows.push(row);
    }
  }
})();
const MARK = { add: ['+', 'added'], chg: ['~', 'changed'], del: ['−', 'cleared'] };
const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
// One chip per field the step touched, naming the change: "Five whys added", "PR head: 1111111 → 2222222".
function chipOf(field) {
  const hit = field.rows.filter((r) => MARK[r.kind]);
  if (!hit.length) return null;
  const kinds = new Set(hit.map((r) => r.kind));
  const kind = kinds.size === 1 ? hit[0].kind : 'chg';
  const one = hit.length === 1 ? hit[0] : null;
  let text;
  if (kind === 'chg' && one) text = (one.part ? one.label : field.label) + ': ' + clip(plain(one.a), 18) + ' → ' + clip(plain(one.b), 18);
  else if (kind === 'add') { const first = clip(plain(hit[0].b), 22); text = field.label + ' added' + (first && !/^…\//.test(first) ? ': ' + first : ''); }
  else if (kind === 'del') text = field.label + ' cleared';
  else text = field.label + ' changed';
  return { kind, text, row: hit[0] };
}
function showHolds(step) {
  const before = cur ? steps[cur - 1].context : {};
  const now = step ? step.context : {};
  const get = (ctx, r) => (r.part ? ctx[r.field]?.[r.part] : ctx[r.field]);
  for (const r of rows) {
    const a = get(before, r), b = get(now, r);
    const same = JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    r.kind = same ? (b == null ? 'empty' : 'same') : a == null ? 'add' : b == null ? 'del' : 'chg';
    r.a = valueHtml(r.field, r.part, a); r.b = valueHtml(r.field, r.part, b);
    r.m.textContent = MARK[r.kind]?.[0] || '';
    r.m.title = MARK[r.kind]?.[1] || '';
    r.v.innerHTML = r.kind === 'chg' ? '<s>' + r.a + '</s> <ins>' + r.b + '</ins>'
      : r.kind === 'add' ? '<ins>' + r.b + '</ins>'
      : r.kind === 'del' ? '<s>' + r.a + '</s> <span class="muted">cleared</span>'
      : r.kind === 'empty' ? '—' : r.b;
  }
  const chips = [];
  for (const f of fields) {
    const fold = f.head && f.rows.every((r) => r.kind === 'empty');
    const touched = f.rows.some((r) => MARK[r.kind]);
    for (const r of f.rows) r.tr.className = (r.part ? 'part ' : 'solo ') + r.kind + (MARK[r.kind] ? ' touched' : '') + (fold ? ' folded' : '');
    if (f.head) f.head.className = 'grp' + (touched ? ' touched' : '') + (fold ? ' fold' : '');
    const chip = chipOf(f);
    if (chip) chips.push(chip);
  }
  const box = $('changed');
  box.innerHTML = !step ? '' : chips.length ? '<b>This step:</b>' : '<b>This step changed nothing the item holds.</b>';
  chips.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.row = String(rows.indexOf(c.row));
    b.title = 'Show this row';
    b.innerHTML = '<span class="mk ' + c.kind + '" aria-label="' + MARK[c.kind][1] + '">' + MARK[c.kind][0] + '</span>' + esc(c.text);
    box.appendChild(b);
  });
  // Never cut a chip off silently: take chips off the end until the rest fit, then say how many are left.
  const all = [...box.querySelectorAll('button')];
  if (box.scrollHeight > box.clientHeight + 1) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'more';
    box.appendChild(more);
    let hidden = 0;
    while (box.scrollHeight > box.clientHeight + 1 && hidden < all.length) {
      all[all.length - 1 - hidden].remove();
      hidden++;
      more.textContent = '+' + hidden + ' more';
      more.dataset.row = all[all.length - hidden].dataset.row;
      more.title = 'Also: ' + all.slice(all.length - hidden).map((x) => x.textContent.slice(1)).join('; ');
    }
  }
}
// After a step, if none of the rows it changed is in view in the holds box, scroll the box just enough to show the
// first one (with its group's heading). If one is already in view, the reader's scroll is left alone.
function followChange() {
  const box = $('holds-scroll');
  if (tab !== 'step' || !box.clientHeight) return;
  const changed = rows.filter((r) => MARK[r.kind]);
  if (!changed.length) return;
  const bb = box.getBoundingClientRect();
  const seen = changed.some((r) => { const rr = r.tr.getBoundingClientRect(); return rr.bottom > bb.top + 4 && rr.top < bb.bottom - 4; });
  if (seen) return;
  const r = changed[0], top = (r.owner.head || r.tr).getBoundingClientRect().top, bottom = r.tr.getBoundingClientRect().bottom;
  if (top < bb.top) box.scrollTop += top - bb.top - 6;
  else box.scrollTop += Math.min(bottom - bb.bottom + 10, top - bb.top - 6);
}
function jumpToRow(i) {
  const box = $('holds-scroll'), r = rows[i];
  if (!r) return;
  const top = (r.owner.head || r.tr).getBoundingClientRect().top - box.getBoundingClientRect().top;
  box.scrollTop += top - 6;
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
    if (label) {
      const text = svgEl('text', { x: label.x, y: label.y, 'text-anchor': label.anchor || 'start' }, group);
      String(label.text).split('\n').forEach((line, i) => { svgEl('tspan', { x: label.x, dy: i ? 12 : 0 }, text).textContent = line; });
    }
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
  // In Compare, what run B walked that A never does is dotted, in its own line colour.
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
  followRing(step);
}
// When the drawing is wider than its box (on a phone), pan it just enough to keep the ring in view.
function followRing(step) {
  const box = $('diagram'), node = step && drawn?.nodes[step.state];
  if (!node || !box.clientHeight || box.scrollWidth <= box.clientWidth && box.scrollHeight <= box.clientHeight) return;
  const b = box.getBoundingClientRect(), r = node.getBoundingClientRect(), m = 14;
  if (r.left < b.left + m) box.scrollLeft += r.left - b.left - m;
  else if (r.right > b.right - m) box.scrollLeft += r.right - b.right + m;
  if (r.top < b.top + m) box.scrollTop += r.top - b.top - m;
  else if (r.bottom > b.bottom - m) box.scrollTop += r.bottom - b.bottom + m;
}

// ---- The story's five cells: which commit, and which answers stand, at this step.
// The merge approval belongs to one verdict, so a new verdict, a push or a replan clears it; the replan answer is
// the last answer to the replanning question.
function standing(upto) {
  let appr = null, replan = null;
  for (const s of upto) {
    const out = s.entry.event.output || {};
    if (s.what === 'verify done' || s.what === 'pr.pushed' || (s.from === 'replanning' && s.state === 'briefing')) appr = null;
    if (s.from === 'awaitingMerge' && s.what === 'ask done') appr = esc(DONE_WORD[out.choice] || out.choice) + ' by ' + esc(whoWord(out.by));
    if (s.from === 'awaitingMerge' && s.what === 'ask failed') appr = 'question failed';
    if (s.from === 'replanning') replan = s.what === 'ask failed' ? 'no answer' : esc(DONE_WORD[out.choice] || out.choice) + ' by ' + esc(whoWord(out.by));
  }
  return { appr, replan };
}
const NONE = (t) => '<span class="none">' + t + '</span>';
function cellsAt(i) {
  const step = steps[i];
  if (!step) return null;
  const c = step.context, head = c.pr?.headSha, v = c.verdict;
  const ended = step.done || i === steps.length - 1 && step.state === 'dropped';
  const { appr, replan } = standing(steps.slice(0, i + 1));
  return {
    head: head ? code(head) : NONE(ended ? 'no PR' : 'none yet'),
    verdict: v?.sha
      ? '<span class="' + (v.result === 'FAIL' ? 'w-bad' : !head || v.sha === head ? 'w-ok' : '') + '">' + esc(v.result) + '</span> ' + (!head || v.sha === head ? 'on the PR head' : 'on ' + code(v.sha) + ' (older)')
      : NONE(ended ? 'none' : 'none yet'),
    appr: appr || NONE(ended ? 'never asked' : 'not asked yet'),
    replan: replan || NONE('not asked'),
    merge: c.merge?.sha ? code(c.merge.sha) + ' from ' + code(v?.sha) : step.state === 'dropped' ? '<span class="w-bad">✕ no, dropped</span>' : NONE('not yet')
  };
}
function showStory(step) {
  const ids = { head: 'c-head', verdict: 'c-verdict', appr: 'c-appr', replan: 'c-replan', merge: 'c-merge' };
    const LABEL = { head: 'PR head', verdict: 'Last verdict', appr: 'Merge approval', replan: 'Replan answer', merge: 'Merged' };
  if (!step) {
    $('s-pos').textContent = 'No run'; $('s-ch').textContent = ''; $('s-when').textContent = '';
    $('s-sent').textContent = 'This page was made from the spec alone, with no run to play. Click a state to see what it needs and passes on.';
    $('s-by').textContent = '—'; $('s-to').textContent = '—';
    for (const k of Object.keys(ids)) $(ids[k]).innerHTML = NONE('none');
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
  const now = cellsAt(cur), was = cur ? cellsAt(cur - 1) : null;
  for (const k of Object.keys(ids)) {
    const dd = $(ids[k]);
    const t = plain(now[k]), w = was ? plain(was[k]) : null;
    const changed = w !== null && t !== w;
    const kind = !changed ? '' : /^(none|not|never|no PR)/.test(w) ? 'add' : 'chg';
    dd.innerHTML = (kind ? '<span class="mk ' + kind + '" aria-label="' + MARK[kind][1] + ' at this step">' + MARK[kind][0] + '</span> ' : '') + now[k];
    dd.className = kind;
    dd.title = LABEL[k] + ': ' + t + (changed ? ' (was: ' + w + ')' : '');
  }
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
// What a line does to what the item holds, in the verbs the item's diff uses.
const writeText = (w) => {
  const label = fieldLabel(w.field);
  if (w.from === 'null') return 'clears ' + label;
  if (w.from === '0') return 'resets ' + label + ' to 0';
  if (w.from === '+ 1') return 'adds 1 to ' + label;
  return 'sets ' + label;
};
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
    (e.writes.length ? '<div class="muted">' + cap(e.writes.map((w) => esc(writeText(w))).join(', ')) + '</div>' : '') + '</li>').join('') || '<li class="muted">None: the item ends here.</li>';
  if (shownState === id) return; // the rest describes the state, not the step
  shownState = id;
  $('st-name').textContent = nameOf(id);
  $('st-note').textContent = n.final ? 'The item ends here.' : layout.notes?.[id] ? endStop(cap(layout.notes[id])) : '';
  $('st-needs').innerHTML = n.needs.length ? n.needs.map((g) => '<li>' + esc(needText(g)) + '</li>').join('') : '<li class="muted">Nothing.</li>';
  $('st-passes-box').hidden = !n.actor;
  $('st-passes').innerHTML = n.input.map((i) => '<li>' + esc(passesText(i)) + '</li>').join('');
  const ins = graph.edges.filter((e) => e.to === id);
  $('st-in').innerHTML = (id === graph.initial ? '<li>at the start</li>' : '') + ins.map((e) => '<li>from ' + esc(nameOf(e.from)) + ': ' + esc(lineText(e)) + '</li>').join('') || '<li class="muted">Only the start.</li>';
  $('st-specbody').innerHTML = '<p>State <code>' + esc(id) + '</code>' + (n.actor ? ', session <code>' + esc(n.actor) + '</code>' : '') + '.</p>' +
    (n.needs.length ? '<p>Needs: ' + n.needs.map((g) => '<code>' + esc(g.name) + '</code> (' + esc(g.conditions.join(', and ')) + ')').join('; ') + '</p>' : '') +
    (n.input.length ? '<p>Input: ' + n.input.map((i) => '<code>' + esc(i.name) + '</code> ← ' + esc(i.from)).join('; ') + '</p>' : '');
}

// The journal line as it is, with 40-character shas cut to the 7 the rest of the page uses, and one line above it
// saying what it is in words.
function showEntry(step) {
  $('jsum').textContent = step ? 'Step ' + (cur + 1) + ', from ' + step.by + ': ' + step.sentence : '';
  $('entry').textContent = step ? JSON.stringify(step.entry, null, 2).replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, '$1…') : 'No journal was given.';
}

// ---- Compare runs: A's and B's chapters side by side, opened by one sentence on how they differ.
const endWords = (r) => (r.end === 'merged' ? 'merged' : r.end === 'dropped' ? 'were dropped' : 'are unfinished');
const endWord1 = (r) => (r.end === 'merged' ? 'merged' : r.end === 'dropped' ? 'was dropped' : 'is unfinished');
const replanWords = (r) => (r.replans.length ? ' after ' + plural(r.replans.length, 'replan') : r.end === 'merged' ? ' with no replan' : '');
function diffSentence(A, B) {
  const parts = [];
  if (A.end === B.end && A.replans.length === B.replans.length) parts.push('Both ' + endWords(A) + replanWords(A) + '.');
  else parts.push('A ' + endWord1(A) + replanWords(A) + '; B ' + endWord1(B) + replanWords(B) + '.');
  const ca = A.replans.join(' and '), cb = B.replans.join(' and ');
  if (ca !== cb) {
    if (ca && cb) parts.push('A replanned because ' + ca + '; B because ' + cb + '.');
    else if (ca) parts.push('A replanned because ' + ca + '; B never replanned.');
    else parts.push('B replanned because ' + cb + '; A never replanned.');
  }
  const k = firstDiff(A, B);
  if (k >= 0) {
    const a = A.chapters[k], b = B.chapters[k];
    parts.push('They first differ in ' + (a?.title === b?.title ? a.title : 'chapter ' + (k + 1)) + ': A ' + (a ? (a.title !== b?.title ? a.title + ', ' : '') + (a.summary || 'nothing') : 'has ended') + '; B ' + (b ? (b.title !== a?.title ? b.title + ', ' : '') + (b.summary || 'nothing') : 'has ended') + '.');
  } else parts.push('They went through the same chapters.');
  return parts.join(' ');
}
const sameChapter = (a, b) => a && b && a.title === b.title && a.summary === b.summary;
function firstDiff(A, B) { for (let k = 0; k < Math.max(A.chapters.length, B.chapters.length); k++) if (!sameChapter(A.chapters[k], B.chapters[k])) return k; return -1; }
function showCompare() {
  const A = runs[ri], B = cmpB != null ? runs[cmpB] : null;
  const sel = $('cmpB');
  sel.innerHTML = '<option value="">Pick a run to compare with A…</option>' + runs.map((r, i) => i === ri ? '' : '<option value="' + i + '">' + esc(r.name) + '</option>').join('');
  sel.value = cmpB == null ? '' : String(cmpB);
  $('cmpSwap').disabled = !B;
  $('cA-name').textContent = A ? A.name : 'No run';
  $('cB-name').textContent = B ? B.name : '—';
  $('cA-out').innerHTML = A ? endHtml(A) + ' (' + esc(A.counts) + ')' : '';
  $('cB-out').innerHTML = B ? endHtml(B) + ' (' + esc(B.counts) + ')' : '';
  $('cSum').innerHTML = !A ? '' : B ? toned(diffSentence(A, B)) : esc('Pick a run as B, here or with Compare in All runs. Its chapters line up beside A\'s, and the drawing dots the lines only B took.');
  const n = Math.max(A?.chapters.length || 0, B?.chapters.length || 0);
  const cell = (ch, here) => (ch ? '<td' + (here ? ' class="here"' : '') + '><span class="ct">' + esc(ch.title) + '</span><span class="cs">' + toned(ch.summary) + '</span>' : '<td><span class="muted">—</span>');
  const curCh = steps[cur]?.chapter;
  let html = '';
  for (let k = 0; k < n; k++) {
    const a = A?.chapters[k], b = B?.chapters[k];
    const differs = B && !sameChapter(a, b);
    html += '<tr class="' + (differs ? 'differs' : '') + '"><td class="m"' + (differs ? ' title="A and B differ here"' : '') + '>' + (differs ? '≠' : '') + '</td>' +
      cell(a, k === curCh) + (differs && a ? '<br><button type="button" class="small" data-goto="' + a.first + '">Show in A</button>' : '') + '</td>' +
      (B ? cell(b, false) + '</td>' : '<td></td>') + '</tr>';
  }
  $('chapRows').innerHTML = html;
}

// ---- All runs: one row per run, built once and updated in place. Each strip has one cell per step, grouped by
// chapter and lettered by the state the step entered; its colour is the line the step took.
const CODE = (() => {
  const out = {}, used = new Set();
  for (const n of graph.nodes) {
    if (n.final) { out[n.id] = n.id === 'done' || /^merged/i.test(nameOf(n.id)) ? '✓' : '✕'; continue; }
    const w = nameOf(n.id).replace(/[^A-Za-z]/g, '');
    let c = w.slice(0, 2);
    for (let k = 2; used.has(c) && k < w.length; k++) c = w[0] + w[k];
    used.add(c);
    out[n.id] = c;
  }
  return out;
})();
const sameStep = (x, y) => x && y && x.state === y.state && x.edge === y.edge;
const partsAt = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if (!sameStep(a[i], b[i])) return i; return -1; };
const cellHtml = (s, i, j) => '<i class="c tone-' + toneOf(s) + (s.state === 'done' ? ' ok' : '') + '" data-run="' + i + '" data-step="' + j + '" title="Step ' + (j + 1) + ', ' + esc(nameOf(s.state)) + ': ' + esc(s.sentence || s.what) + '">' + esc(CODE[s.state] || '?') + '</i>';
(function buildRuns() {
  const seen = new Set(runs.flatMap((r) => r.steps.map((s) => s.state)));
  const sample = (cls, t) => '<i class="c ' + cls + '" aria-hidden="true">' + t + '</i>';
  $('runkey').innerHTML = 'One cell per step, under its chapter, lettered by the state the step entered:<ul>' +
    graph.nodes.filter((n) => seen.has(n.id)).map((n) => '<li>' + sample('', esc(CODE[n.id])) + esc(nameOf(n.id)) + '</li>').join('') + '</ul><ul>' +
    '<li>' + sample('', 'Bu') + 'went forward</li><li>' + sample('tone-back', 'Bu') + 'dashed blue: back, to try again</li><li>' + sample('tone-fail', 'Re') + 'red: went wrong</li><li>' + sample('ok', '✓') + 'green: merged</li>' +
    '<li>' + sample('at', 'Ve') + 'A\'s step now</li><li>' + sample('parts', 'Bu') + 'where a run first parts from A</li></ul>Click a cell to open that run at that step.';
  $('runkeyd').open = innerWidth > 760;
  $('runlist').innerHTML = runs.map((r, i) => '<li data-run="' + i + '">' +
    '<div><span class="tag"></span><button type="button" class="nm" data-pick="' + i + '" title="' + esc(r.about || 'Step through this run') + '">' + esc(r.name) + '</button>' +
    '<div class="oc">' + endHtml(r) + '</div><div class="ct">' + esc(r.counts) + '</div></div>' +
    '<button type="button" class="small cmpb" data-asb="' + i + '" aria-pressed="false" title="Compare this run with A, chapter by chapter">Compare</button>' +
    '<div class="strip">' + r.chapters.map((ch) => '<span class="seg" title="' + esc(ch.title + ': ' + ch.summary) + '"><span class="cells">' +
      r.steps.slice(ch.first, ch.last + 1).map((s, k) => cellHtml(s, i, ch.first + k)).join('') + '</span><span class="sl">' + esc(ch.title) + '</span></span>').join('') + '</div></li>').join('') ||
    '<li class="muted">No runs.</li>';
})();
function showRuns() {
  const A = runs[ri];
  for (const li of $('runlist').querySelectorAll('li[data-run]')) {
    const i = Number(li.dataset.run), r = runs[i];
    li.classList.toggle('isA', i === ri);
    li.classList.toggle('isB', i === cmpB);
    li.querySelector('.tag').innerHTML = i === ri ? '<span class="badge" title="A: the run you are stepping through">A</span>' : i === cmpB ? '<span class="badge b" title="B: the run you compare with">B</span>' : '';
    const nm = li.querySelector('.nm');
    nm.setAttribute('aria-current', String(i === ri));
    const cb = li.querySelector('.cmpb');
    cb.setAttribute('aria-pressed', String(i === cmpB));
    cb.textContent = i === cmpB ? 'Is B' : 'Compare';
    cb.disabled = i === ri;
    const k = i === ri ? -1 : partsAt(A?.steps || [], r.steps);
    li.querySelectorAll('i.c').forEach((cell, j) => { cell.classList.toggle('parts', j === k); cell.classList.toggle('at', i === ri && j === cur); });
  }
}
function setSub(name) {
  sub = name;
  $('subRuns').setAttribute('aria-pressed', String(name === 'runs'));
  $('subAB').setAttribute('aria-pressed', String(name === 'ab'));
  $('runs-scroll').hidden = name !== 'runs';
  $('ab-view').hidden = name !== 'ab';
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
  followChange();
  showState();
  showEntry(step);
  showCompare();
  showRuns();
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
  $('app').dataset.shows = name;
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === name));
  keepInView();
  followChange();
  followRing(steps[cur]);
}

// Show one run from step at. The tab, a picked state, the compared run, open disclosures and scroll positions stay.
function load(i, at = 0) {
  if (i === cmpB) cmpB = null;
  ri = i;
  const run = runs[i];
  steps = run?.steps ?? [];
  cur = Math.min(Math.max(0, at), Math.max(0, steps.length - 1));
  setOutcome(run);
  $('steps').innerHTML = (run?.chapters || []).map((ch) =>
    '<li class="ch" title="' + esc(ch.title + ': ' + ch.summary) + '">' + esc(ch.title) + '<span class="chs">' + toned(ch.summary) + '</span></li>' +
    steps.slice(ch.first, ch.last + 1).map((s, k) => {
      const j = ch.first + k;
      return '<li class="st tone-' + toneOf(s) + '" data-i="' + j + '"><button type="button" data-i="' + j + '" title="' + esc(s.sentence) + '" data-full="' + esc(s.sentence) + '"><span class="num">' + (j + 1) + '</span><span class="t">' + esc(s.sentence) + '</span><span class="to">→ ' + esc(nameOf(s.state)) + '</span></button></li>';
    }).join('')).join('') || '<li class="muted">No run.</li>';
  $('slider').max = Math.max(1, steps.length);
  $('run').value = String(i);
  paint();
}
function setOutcome(run) {
  $('outcome').innerHTML = run ? endHtml(run) : '';
  $('counts').textContent = run?.counts ? '· ' + run.counts : '';
}
// The outcome line is as tall as the longest run's outcome needs at this width, so it never cuts a sentence and
// never changes height between runs.
function sizeOutcome() {
  const line = $('outcomeline');
  line.style.height = 'auto';
  let most = 0;
  for (const r of runs) { setOutcome(r); most = Math.max(most, line.scrollHeight); }
  line.style.height = most + 'px';
  setOutcome(runs[ri]);
}

const options = (list) => list.map(({ r, i }) => '<option value="' + i + '">' + esc(r.name) + '</option>').join('');
const indexed = runs.map((r, i) => ({ r, i }));
const real = indexed.filter((x) => !x.r.example), examples = indexed.filter((x) => x.r.example);
$('run').innerHTML = examples.length && real.length ? '<optgroup label="Real runs">' + options(real) + '</optgroup><optgroup label="Examples">' + options(examples) + '</optgroup>' : options(indexed);
$('run').hidden = !runs.length;
// After a run is picked, focus moves to Step ▶, so the arrow keys step at once.
$('run').addEventListener('change', () => { stop(); load(Number($('run').value)); say(); $('next').focus(); });
$('steps').addEventListener('click', (ev) => { const t = ev.target.closest('button[data-i]'); if (t) { stop(); go(Number(t.dataset.i)); } });
$('slider').addEventListener('input', () => go(Number($('slider').value) - 1));
for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => setView(b.dataset.view));
$('changed').addEventListener('click', (ev) => { const j = ev.target.closest('[data-row]'); if (j) jumpToRow(Number(j.dataset.row)); });
$('st-follow').addEventListener('click', () => { picked = null; paint(); document.querySelector('[data-tab="state"]').focus(); });
$('cmpB').addEventListener('change', () => { cmpB = $('cmpB').value === '' ? null : Number($('cmpB').value); paint(); $('cmpB').focus(); });
$('cmpSwap').addEventListener('click', () => { if (cmpB == null) return; const was = ri; stop(); load(cmpB); cmpB = was; paint(); say(); $('cmpSwap').focus(); });
$('chapRows').addEventListener('click', (ev) => { const g = ev.target.closest('[data-goto]'); if (!g) return; const k = Number(g.dataset.goto); stop(); go(k); $('chapRows').querySelector('[data-goto="' + k + '"]')?.focus(); });
$('subRuns').addEventListener('click', () => setSub('runs'));
$('subAB').addEventListener('click', () => setSub('ab'));
// From the list: a name steps through that run (focus stays on it, so the arrow keys step); a cell opens that run
// at that step; Compare makes the run B and shows A and B side by side.
$('runlist').addEventListener('click', (ev) => {
  const nm = ev.target.closest('[data-pick]'), cb = ev.target.closest('button[data-asb]'), cell = ev.target.closest('i.c[data-run]');
  if (nm) { const i = Number(nm.dataset.pick); if (i !== ri) { stop(); load(i); say(); } nm.focus(); }
  else if (cb && !cb.disabled) { cmpB = Number(cb.dataset.asb); setSub('ab'); paint(); $('subAB').focus(); }
  else if (cell) { const i = Number(cell.dataset.run), j = Number(cell.dataset.step); stop(); if (i === ri) go(j); else { load(i, j); say(); } }
});
// On a phone the Runs tab is behind the Detail view; this button reaches it in one tap from any view.
$('toRuns').addEventListener('click', () => { setTab('cmp'); setSub('runs'); setView('detail'); $('subRuns').focus(); });
// How this page works closes on Escape (focus back to its summary) and on a click outside it.
const how = $('how');
document.addEventListener('click', (ev) => { if (how.open && !how.contains(ev.target)) how.open = false; });

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
// Arrows, Home and End step anywhere but in the pickers and the slider (which step on their own); Space plays
// unless a button has focus, where it presses the button. Escape closes How this page works.
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && how.open) { how.open = false; how.querySelector('summary').focus(); return; }
  if (ev.target.closest('select, input')) return;
  const keys = { ArrowRight: () => go(cur + 1), ArrowLeft: () => go(cur - 1), Home: () => go(0), End: () => go(steps.length - 1) };
  if (keys[ev.key]) { ev.preventDefault(); stop(); keys[ev.key](); }
  else if (ev.key === ' ' && !ev.target.closest('button, [role=button], summary')) { ev.preventDefault(); $('play').click(); }
});

load(0, Infinity); // the first run opens on its last step, so the whole path it walked shows at rest
sizeOutcome();
document.fonts?.ready.then(sizeOutcome);
addEventListener('resize', () => { sizeOutcome(); followChange(); followRing(steps[cur]); });
try { draw(); } catch (err) { $('diagram').innerHTML = '<p class="muted">The graph could not be drawn (' + esc(err.message) + '). The steps and data still work.</p>'; }
</script>
`;
