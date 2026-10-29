// The page needs contract. Each page has pages/<page>/needs.json: the file it reads (and any it reads beside it,
// reads.with: flow replay's steps.jsonl), the fields of each,
// the schemaVersion range it understands, and the spec states and events it names. checkPage() holds a store and
// the spec to that declaration and names the page and the missing piece; renderLivePage() builds the page that
// reads only what the declaration lists. The store layout (schemaVersion) and the refresh rules are the spec's
// (harness.machine.json meta.store and meta.pages).
import { readFileSync, readdirSync } from 'node:fs';
import { specs as SPECS } from './machines.js';
import { CSS, wrapPage } from './page.js';
import { rowsOf } from './intake.js';
import { schemaProblem, renderShell, renderView, renderData, viewKeys, formatOf } from './live.js';
import { checkLogNeeds, HISTORY } from './history.js';

const ROOT = new URL('../pages/', import.meta.url);
export const PAGES = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
export const loadNeeds = (page) => JSON.parse(readFileSync(new URL(`${page}/needs.json`, ROOT), 'utf8'));
export const STORE_LAYOUT = SPECS.harness.meta.store;
export const PAGE_RULES = SPECS.harness.meta.pages;
// What a file a page reads means when it carries no schemaVersion: the store's layout, or the history's.
const absentMeansOf = (needs) => (needs.reads.file === 'events.jsonl' ? HISTORY : STORE_LAYOUT).absentMeans;
// The page script: live.js as it is, each export made a plain declaration.
const LIVE_SRC = readFileSync(new URL('./live.js', import.meta.url), 'utf8').replace(/^export /gm, '');

const stateNode = (config, path) => path.split('.').reduce((n, k) => n?.states?.[k], config);
const hasEvent = (node, type) => Boolean(node?.on?.[type]) || Object.values(node?.states ?? {}).some((s) => hasEvent(s, type));
const get = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

// Each kind's rows in a store: store (the root), harness (its snapshot), and each child snapshot by machine id.
function rowsByKind(state, needs) {
  const children = Object.values(state?.snapshot?.children ?? {});
  const of = (list, id) => list.filter((c) => c?.src === id).map((c) => c.snapshot);
  const items = of(children, needs.kinds.item);
  return {
    store: state ? [state] : [],
    harness: state?.snapshot ? [state.snapshot] : [],
    item: items,
    decision: items.flatMap((s) => of(Object.values(s?.children ?? {}), needs.kinds.decision)),
    budget: of(children, needs.kinds.budget),
    audit: of(children, needs.kinds.audit)
  };
}

// The states and events the page's view uses, by machine: each must be in the needs file's spec lists.
function viewRefs(view) {
  return {
    states: [
      ...view.stages.flatMap(([, states]) => states).map((s) => ['workItem', s]),
      ...view.finished.map((s) => ['workItem', s]),
      ['workItem', view.merged],
      ['workItem', view.needsCriteria],
      ['decision', view.awaitingPerson.decision],
      ['audit', view.awaitingPerson.audit],
      ...[...view.scheduler.warn, ...view.scheduler.bad].map((s) => ['harness', s])
    ],
    events: [['decision', view.events.decide], ['audit', view.events.audit], ['workItem', view.events.cancel]]
  };
}

// Wrap a projected view so a read of a key the needs file does not declare is recorded (and still returns undefined).
function strictView(view, needs, reads) {
  const allowed = viewKeys(needs);
  const wrap = (obj, kind) =>
    new Proxy(obj, {
      get(target, key, recv) {
        if (typeof key === 'string' && !allowed[kind].has(key) && !(key in Object.prototype) && !(key in target)) reads.add(`${kind}.${key}`);
        return Reflect.get(target, key, recv);
      }
    });
  return wrap(
    {
      store: wrap(view.store, 'store'),
      harness: wrap(view.harness, 'harness'),
      items: view.items.map((i) => wrap({ ...i, decisions: i.decisions.map((d) => wrap(d, 'decision')) }, 'item')),
      budget: view.budget && wrap(view.budget, 'budget'),
      audits: view.audits.map((a) => wrap(a, 'audit'))
    },
    'view'
  );
}

// Wrap projected history rows so a read of a field the needs file does not declare for the row's type, or for the
// file it reads beside the history (a row's step), is recorded. An array is passed through to its elements.
function strictLog(rows, needs, reads) {
  const [name, beside = []] = Object.entries(needs.reads.with ?? {})[0] ?? [];
  const prefixes = (list) => list.flatMap((f) => f.split('.').map((_, i, a) => a.slice(0, i + 1).join('.')));
  return rows.map((r) => {
    const fields = [...(needs.events['*'] ?? []), ...(needs.events[r.event.type] ?? []), ...beside.map((f) => `step.${f}`)];
    const allowed = new Set(['event', 'event.type', ...(name ? ['step'] : []), ...prefixes(fields)]);
    const say = (p) => reads.add(p.startsWith('step.') ? `${name} field ${p.slice(5)}` : `${r.event.type} field ${p}`);
    const wrap = (obj, path) =>
      new Proxy(obj, {
        get(target, key, recv) {
          const v = Reflect.get(target, key, recv);
          if (typeof key !== 'string' || key in Object.prototype) return v;
          if (Array.isArray(target)) return /^\d+$/.test(key) && v && typeof v === 'object' ? wrap(v, path) : v;
          const p = path ? `${path}.${key}` : key;
          if (!allowed.has(p)) say(p);
          return v && typeof v === 'object' && allowed.has(p) && !fields.includes(p) ? wrap(v, p) : v;
        }
      });
    return wrap(r, '');
  });
}

/**
 * Everything that breaks `page`'s declared needs, each line starting with the page's name: a spec machine,
 * state or event it names that the spec does not have; a view state or event missing from its spec lists; and,
 * given a store's state.json, a schemaVersion outside its range, a declared field no row of its kind has, and a
 * read of a field it does not declare. A view that reads the one history (reads.file events.jsonl) declares event
 * types and fields instead, and is held to history.schema.json and, given rows, to that history (checkLogNeeds),
 * and its renderer reads nothing else; one that names spec machines (the ledger) names one that takes each type.
 * One that reads a file beside the history (reads.with) is held to its fields the same way, given that file (also).
 */
export function checkPage(page, { state, history, also = {}, specs = SPECS, needs = loadNeeds(page) } = {}) {
  const out = [];
  const say = (msg) => out.push(`${page}: ${msg}`);
  const file = `pages/${page}/needs.json`;
  if (needs.page !== page) say(`${file} names page "${needs.page}"`);
  for (const [kind, id] of Object.entries(needs.kinds ?? {})) if (!specs[id]) say(`kind ${kind} is spec machine "${id}", which the spec does not have`);
  for (const [machine, refs] of Object.entries(needs.spec ?? {})) {
    const config = specs[machine];
    if (!config) { say(`names spec machine "${machine}", which the spec does not have`); continue; }
    for (const s of refs.states ?? []) if (!stateNode(config, s)) say(`names ${machine} state "${s}", which spec/${machine}.machine.json does not have`);
    for (const e of refs.events ?? []) if (!hasEvent(config, e)) say(`names ${machine} event ${e}, which spec/${machine}.machine.json does not take`);
  }
  if (needs.reads.file === 'events.jsonl') {
    out.push(...checkLogNeeds(needs, history, HISTORY, also));
    const named = needs.spec && Object.values(needs.spec).flatMap((m) => m.events ?? []);
    if (named) for (const type of Object.keys(needs.events)) if (type !== '*' && !named.includes(type)) say(`its view reads ${type}, which ${file} spec does not name under a machine that takes it`);
    if (!history) return out;
    const problem = schemaProblem(history, needs, absentMeansOf(needs), also);
    if (problem) { say(problem); return out; }
    const reads = new Set();
    renderData(strictLog(formatOf(needs).project(history, needs, also), needs, reads), needs);
    for (const r of reads) say(`reads ${r}, which ${file} does not declare`);
    return out;
  }
  const refs = viewRefs(needs.view);
  for (const [m, s] of refs.states) if (!needs.spec[m]?.states?.includes(s)) say(`its view uses ${m} state "${s}", which ${file} spec.${m}.states does not list`);
  for (const [m, e] of refs.events) if (!needs.spec[m]?.events?.includes(e)) say(`its view uses ${m} event ${e}, which ${file} spec.${m}.events does not list`);
  if (state === undefined || state === null) return out;

  const problem = schemaProblem(state, needs, STORE_LAYOUT.absentMeans);
  if (problem) { say(problem.replace(/<[^>]+>/g, '')); return out; }
  const rows = rowsByKind(state, needs);
  for (const [kind, paths] of Object.entries(needs.fields)) {
    if (!rows[kind]?.length) { say(`needs ${kind} rows${needs.kinds[kind] ? ` (spec machine ${needs.kinds[kind]})` : ''}, and this store has none`); continue; }
    for (const p of paths) if (!rows[kind].some((r) => get(r, p) !== undefined)) say(`needs ${kind} field ${p}, which no ${kind} in this store has`);
  }
  const reads = new Set();
  renderView(strictView(formatOf(needs).project(state, needs), needs, reads), needs);
  for (const r of reads) say(`reads ${r}, which ${file} does not declare`);
  return out;
}

const json = (x) => JSON.stringify(x).replace(/</g, '\\u003c');
const LIVE_CSS = `${CSS}
.age{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}.age button{font:inherit;font-weight:600;color:#fff;background:var(--accent);border:0;border-radius:8px;padding:6px 14px;cursor:pointer}.age button:disabled{opacity:.6}
.banner{border-radius:10px;padding:14px 16px;border:2px solid var(--bad);background:var(--bad-soft);color:var(--bad)}
.stepper{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.stepper button{font:inherit;color:var(--accent);background:var(--accent-soft);border:1px solid var(--line);border-radius:8px;padding:4px 10px;cursor:pointer}h3{margin:0;font-size:1rem}.step[hidden]{display:none}
.step{overflow-wrap:anywhere}.step ul{margin:4px 0;padding-left:18px}.step h4{margin:8px 0 0;font-size:.9rem}.step code{white-space:pre-wrap;word-break:break-word}.refused{color:var(--bad)}button[aria-pressed=true]{font-weight:700}
.bar{display:inline-block;height:8px;border-radius:3px;background:var(--accent);min-width:2px}.slow{color:var(--bad)}
tr.usage>td{padding-top:0}tr.usage summary{cursor:pointer;color:var(--accent);font-weight:600}[data-usage-body]{display:grid;gap:10px;padding-top:8px;position:sticky;left:10px;max-width:calc(100vw - 58px)}tr.sub td{color:var(--muted);font-size:.8rem}
.timeline{display:grid;gap:4px}.lane{display:grid;grid-template-columns:minmax(72px,22%) 1fr;gap:8px;align-items:center}.lane-label{font-size:.8rem;overflow-wrap:anywhere}.lane-track{position:relative;height:14px;background:var(--bg);border-radius:3px}
.lane-track span{position:absolute;top:2px;height:10px;border-radius:2px;min-width:2px}.seg{background:var(--accent)}.seg.r-verifier{background:var(--ok)}.seg.r-stand-in{background:var(--warn)}.seg.r-triager,.seg.r-unknown{background:var(--muted)}.seg.r-lead{background:var(--fg)}.seg.shared{opacity:.45}
.lane-track .wait{top:6px;height:0;border-top:2px dashed var(--muted);border-radius:0;overflow:visible}.wait i{position:absolute;top:-1px;left:50%;transform:translateX(-50%);font:500 .6rem/1 var(--mono);font-style:normal;color:var(--muted);white-space:nowrap}.axis{display:flex;justify-content:space-between;gap:8px}`;

/**
 * A live page: its data as it was at render (a store's state.json for mission control, a history's rows for the
 * ledger, flow replay and design log, with flow replay's steps beside them in `also`; only the declared fields), the
 * data age, and a Refresh button that reads `<path>/<needs.reads.file>` (and each file of reads.with beside it)
 * through the Artifact files capability of `project`, renders it and records the timing in the db collection the
 * spec names. Publish with capabilities {files: {project}, db: {}}.
 */
export function renderLivePage(data, { page = 'mission-control', also = {}, project: projectId = null, path = '', title, standalone = false, now = new Date().toISOString() } = {}) {
  const needs = loadNeeds(page);
  const format = formatOf(needs);
  const dir = path ? `${path.replace(/\/+$/, '')}/` : '';
  const cfg = {
    page,
    title: title ?? needs.title,
    needs,
    project: projectId,
    path: `${dir}${needs.reads.file}`,
    also: Object.fromEntries(Object.keys(needs.reads.with ?? {}).map((name) => [name, `${dir}${name}`])),
    onDemand: Object.fromEntries(Object.keys(needs.reads.onDemand ?? {}).map((name) => [name, `${dir}${name}`])),
    absentMeans: absentMeansOf(needs),
    slowMs: PAGE_RULES.refreshSlowMs,
    collection: PAGE_RULES.refreshCollection
  };
  const problem = schemaProblem(data, needs, cfg.absentMeans, also);
  const view = problem ? null : format.project(data, needs, also);
  const meta = { readAt: now, of: format.of, ...(view ? format.age(view) : { version: null, updatedAt: null }) };
  const body = `${renderShell(view, problem, cfg, meta)}\n<script>${LIVE_SRC}\nclient(${json(cfg)}, ${json(meta)});</script>`;
  return wrapPage(cfg.title, body, { standalone, css: LIVE_CSS });
}

/** Recorded refreshes (ArtifactData rows of the refresh collection) slower than the spec's threshold. */
export function slowRefreshes(rows, slowMs = PAGE_RULES.refreshSlowMs) {
  return rowsOf(rows).filter((r) => typeof r.ms === 'number' && r.ms > slowMs);
}

export const slowRefreshText = (r, slowMs = PAGE_RULES.refreshSlowMs) =>
  `refresh of ${r.page ?? 'a page'} at ${r.at ?? '?'} took ${r.ms} ms, over ${slowMs} ms${r.storeVersion != null ? ` (store v${r.storeVersion})` : ''}`;
