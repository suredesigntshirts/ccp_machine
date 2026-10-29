// A page that shows an item to a person: every state, what it needs, the work it starts, what it hands on,
// and (given a journal) the run step by step with the data at each step. Everything on it is read from the
// spec and the journal, so the page cannot drift from what runs.
import { Host } from './host.js';

const esc = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const code = (text) => `<code>${esc(text)}</code>`;
const asList = (transitions) => [transitions ?? []].flat().map((t) => (typeof t === 'string' ? { target: t } : t));

// ---- Reading the spec

// Every way out of a state: { when, target, guard, description, writes }.
const exitsOf = (state) => {
  const exits = [];
  const add = (when, transitions) => asList(transitions).forEach((t) => exits.push({ when, ...t }));
  if (state.invoke) {
    add(`${state.invoke.id} done`, state.invoke.onDone);
    add(`${state.invoke.id} failed`, state.invoke.onError);
  }
  for (const [delay, t] of Object.entries(state.after ?? {})) add(`after ${delay}`, t);
  for (const [event, t] of Object.entries(state.on ?? {})) add(event, t);
  return exits.map((exit) => ({ ...exit, writes: writesOf(exit.actions ?? []) }));
};

// What a transition's actions write: [{ field, from }].
const writesOf = (actions) =>
  actions.flatMap(({ type, params }) =>
    type === 'inc' ? [{ field: params, from: '+ 1' }] : Object.entries(params).map(([field, from]) => ({ field, from: sourceText(from) }))
  );

const sourceText = (source) => (typeof source === 'string' ? source : JSON.stringify(source.value));

const conditionText = (condition) => {
  if (typeof condition === 'string') return `${condition} is present`;
  if ('is' in condition) return `${condition.path} is ${JSON.stringify(condition.is)}`;
  if ('same' in condition) return `${condition.path} equals ${condition.same}`;
  return `${condition.path} is below ${condition.below}`;
};

// Each context field, the states that write it and the states that read it.
const fieldsOf = (spec) =>
  Object.keys(spec.context).map((field) => {
    const writers = [];
    const readers = [];
    for (const [name, state] of Object.entries(spec.states)) {
      if (exitsOf(state).some((exit) => exit.writes.some((w) => w.field.split('.')[0] === field))) writers.push(name);
      const inputs = Object.values(state.invoke?.input ?? {}).filter((s) => typeof s === 'string');
      const needs = (state.meta?.needs ?? []).flatMap((g) => spec.meta.guards[g]).map((c) => (typeof c === 'string' ? c : c.path));
      if ([...inputs, ...needs].some((path) => path.split('.')[1] === field)) readers.push(name);
    }
    return { field, writers, readers };
  });

const diagramOf = (spec) => {
  const lines = ['stateDiagram-v2', `  [*] --> ${spec.initial}`];
  for (const [name, state] of Object.entries(spec.states)) {
    if (state.type === 'final') lines.push(`  ${name} --> [*]`);
    for (const exit of exitsOf(state)) {
      if (!exit.target) continue;
      // A described transition is labelled by why it is taken; the description's parenthesis (which need decides
      // it) is for the state sheets below.
      const why = exit.description?.replace(/\s*\(.*\)$/, '').replace(/:/g, ',');
      lines.push(`  ${name} --> ${exit.target}: ${exit.when}${why ? `, ${why}` : ''}${exit.guard ? ` [${exit.guard}]` : ''}`);
    }
  }
  return lines.join('\n');
};

// ---- Reading the journal

// Each entry with the state and context it led to, and which context fields it changed.
const stepsOf = (spec, entries) =>
  entries.map((entry, i) => {
    const before = i ? Host.replay(spec, entries.slice(0, i)).snapshot.context : {};
    const { snapshot } = Host.replay(spec, entries.slice(0, i + 1));
    const changed = Object.keys(snapshot.context).filter((k) => JSON.stringify(snapshot.context[k]) !== JSON.stringify(before[k]));
    return { entry, state: snapshot.value, context: snapshot.context, changed };
  });

// ---- Rendering

const stateCard = (spec, name, state) => {
  const needs = (state.meta?.needs ?? []).map((g) => `<li>${code(g)}: ${spec.meta.guards[g].map((c) => esc(conditionText(c))).join(', ')}</li>`);
  const inputs = Object.entries(state.invoke?.input ?? {}).map(([k, s]) => `<li>${code(k)} ← ${code(sourceText(s))}</li>`);
  const exits = exitsOf(state).map(
    (exit) => `<tr>
      <td>${esc(exit.when)}${exit.guard ? ` <span class="guard">${esc(exit.guard)}</span>` : ''}</td>
      <td>${exit.target ? `<a href="#state-${exit.target}">${esc(exit.target)}</a>` : 'stays'}</td>
      <td>${exit.writes.map((w) => `${code(w.field)} ← ${code(w.from)}`).join('<br>') || '<span class="muted">nothing</span>'}</td>
      <td class="muted">${esc(exit.description ?? '')}</td>
    </tr>`
  );
  const kind = state.type === 'final' ? 'final' : state.invoke ? `starts ${code(state.invoke.src)}` : '';
  return `<section class="state" id="state-${name}">
    <header><h3>${esc(name)}</h3><span class="kind">${kind}</span></header>
    <div class="cols">
      <div><h4>Needs to enter</h4>${needs.length ? `<ul>${needs.join('')}</ul>` : '<p class="muted">nothing</p>'}</div>
      ${state.invoke ? `<div><h4>Hands the work</h4><ul>${inputs.join('')}</ul></div>` : ''}
    </div>
    ${exits.length ? `<div class="scroll"><table><thead><tr><th>When</th><th>Goes to</th><th>Writes</th><th>Why</th></tr></thead><tbody>${exits.join('')}</tbody></table></div>` : ''}
  </section>`;
};

const stepRow = ({ entry, state, context, changed }) => {
  const what = entry.event.type.replace('xstate.done.actor.', '').replace('xstate.error.actor.', 'failed: ').replace('xstate.init', 'start');
  const data = changed.map((k) => `<details><summary>${code(k)}</summary><pre>${esc(JSON.stringify(context[k], null, 2))}</pre></details>`).join('');
  return `<li class="step">
    <div class="when"><span class="seq">#${entry.seq}</span><time>${esc(entry.at.slice(11, 19))}</time></div>
    <div class="body">
      <p><strong>${esc(what)}</strong> from ${code(entry.source)} → <a href="#state-${esc(state)}">${esc(state)}</a></p>
      ${data || '<p class="muted">no data changed</p>'}
    </div>
  </li>`;
};

/** The page, as HTML for an Artifact: the spec, and the run when entries are given. */
export const itemPage = (spec, entries = []) => {
  const steps = stepsOf(spec, entries);
  const fields = fieldsOf(spec)
    .map((f) => `<tr><td>${code(f.field)}</td><td>${f.writers.map(esc).join(', ') || '<span class="muted">the start</span>'}</td><td>${f.readers.map(esc).join(', ')}</td></tr>`)
    .join('');
  return `<title>Work Item Machine</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Public+Sans:wght@400;600&family=JetBrains+Mono:wght@400&display=swap">
<style>
/* Layout: one reading column; the diagram first, then each state as a spec sheet, then the run as a timeline. */
:root {
  --bg: #f5f6f4; --surface: #ffffff; --ink: #1d2421; --muted: #5d6a64; --line: #d6dcd8; --accent: #1f6f5c; --accent-soft: #e2efea;
  --display: "Fraunces", Georgia, serif; --body: "Public Sans", system-ui, sans-serif; --mono: "JetBrains Mono", ui-monospace, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #141917; --surface: #1c2320; --ink: #e4ebe7; --muted: #94a39c; --line: #2f3a35; --accent: #6cc4a8; --accent-soft: #1f342d; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #141917; --surface: #1c2320; --ink: #e4ebe7; --muted: #94a39c; --line: #2f3a35; --accent: #6cc4a8; --accent-soft: #1f342d; color-scheme: dark }
body { background: var(--bg); color: var(--ink); font: 15px/1.55 var(--body); }
main { max-width: 920px; margin: 0 auto; padding-block: 32px 64px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: grid; gap: 40px; }
h1, h2, h3 { font-family: var(--display); font-weight: 600; text-wrap: balance; margin: 0; }
h1 { font-size: 2rem; } h2 { font-size: 1.4rem; margin-bottom: 4px; } h3 { font-size: 1.1rem; }
h4 { margin: 0 0 4px; font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
p { margin: 0; max-width: 65ch; }
.lede { color: var(--muted); margin-top: 8px; }
code, pre, time, .seq { font-family: var(--mono); font-size: .82rem; }
code { background: var(--accent-soft); padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }
a { color: var(--accent); }
.muted { color: var(--muted); }
.diagram { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 16px; overflow-x: auto; }
.states { display: grid; gap: 16px; }
.state { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 16px; display: grid; gap: 12px; min-width: 0; scroll-margin-top: 16px; }
.state header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; }
.kind { color: var(--muted); font-size: .85rem; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
ul { margin: 0; padding-left: 18px; display: grid; gap: 2px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: .88rem; }
th, td { text-align: left; vertical-align: top; padding: 6px 10px 6px 0; border-top: 1px solid var(--line); }
th { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 600; border-top: 0; }
.guard { font-family: var(--mono); font-size: .75rem; color: var(--accent); border: 1px solid var(--accent); border-radius: 999px; padding: 0 6px; white-space: nowrap; }
.run { list-style: none; padding: 0; display: grid; gap: 0; }
.step { display: grid; grid-template-columns: 96px 1fr; gap: 12px; padding: 12px 0; border-top: 1px solid var(--line); }
.step .when { display: grid; color: var(--muted); }
.step .seq { color: var(--accent); }
.step .body { display: grid; gap: 4px; min-width: 0; }
details summary { cursor: pointer; }
details pre { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 8px; overflow-x: auto; margin: 4px 0 0; }
@media (max-width: 520px) { .step { grid-template-columns: 1fr; gap: 4px; } .step .when { display: flex; gap: 8px; } }
</style>
<main>
  <header>
    <h1>Work item machine</h1>
    <p class="lede">${esc(spec.description)} Read from <code>item.machine.json</code>${entries.length ? ' and the item\'s journal' : ''}, so it always matches what runs.</p>
  </header>

  <section>
    <h2>The states</h2>
    <p class="muted">Each arrow says what happened; a pill names the extra guard the transition takes. Every arrow also needs what its target state needs.</p>
    <div class="diagram"><pre class="mermaid">${esc(diagramOf(spec))}</pre></div>
  </section>

  <section>
    <h2>The data passed between them</h2>
    <p class="muted">The item's context. A state hands these on; the next state needs them.</p>
    <div class="scroll"><table><thead><tr><th>Field</th><th>Written in</th><th>Read in</th></tr></thead><tbody>${fields}</tbody></table></div>
  </section>

  <section class="states">
    <h2>Each state</h2>
    ${Object.entries(spec.states).map(([name, state]) => stateCard(spec, name, state)).join('')}
  </section>

  ${steps.length ? `<section>
    <h2>A run, step by step</h2>
    <p class="muted">Every input the item took, in order, with the state it led to and the data it changed. Open a field to see its value.</p>
    <ol class="run">${steps.map(stepRow).join('')}</ol>
  </section>` : ''}
</main>
`;
};
