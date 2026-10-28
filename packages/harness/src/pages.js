// The page needs contract. Each page has pages/<page>/needs.json: the one store file it reads, the fields of it,
// the schemaVersion range it understands, and the spec states and events it names. checkPage() holds a store and
// the spec to that declaration and names the page and the missing piece; renderLivePage() builds the page that
// reads only what the declaration lists. The store layout (schemaVersion) and the refresh rules are the spec's
// (harness.machine.json meta.store and meta.pages).
import { readFileSync, readdirSync } from 'node:fs';
import { specs as SPECS } from './machines.js';
import { CSS, wrapPage } from './page.js';
import { rowsOf } from './intake.js';
import { project, schemaProblem, renderShell, renderView, viewKeys } from './live.js';
import { checkLogNeeds } from './history.js';

const ROOT = new URL('../pages/', import.meta.url);
export const PAGES = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
export const loadNeeds = (page) => JSON.parse(readFileSync(new URL(`${page}/needs.json`, ROOT), 'utf8'));
export const STORE_LAYOUT = SPECS.harness.meta.store;
export const PAGE_RULES = SPECS.harness.meta.pages;
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

/**
 * Everything that breaks `page`'s declared needs, each line starting with the page's name: a spec machine,
 * state or event it names that the spec does not have; a view state or event missing from its spec lists; and,
 * given a store's state.json, a schemaVersion outside its range, a declared field no row of its kind has, and a
 * read of a field it does not declare. A view that reads the one history (reads.file events.jsonl) declares event
 * types and fields instead, and is held to history.schema.json and, given rows, to that history (checkLogNeeds).
 */
export function checkPage(page, { state, history, specs = SPECS, needs = loadNeeds(page) } = {}) {
  if (needs.reads.file === 'events.jsonl')
    return [...(needs.page === page ? [] : [`${page}: pages/${page}/needs.json names page "${needs.page}"`]), ...checkLogNeeds(needs, history)];
  const out = [];
  const say = (msg) => out.push(`${page}: ${msg}`);
  const file = `pages/${page}/needs.json`;
  if (needs.page !== page) say(`${file} names page "${needs.page}"`);
  for (const [kind, id] of Object.entries(needs.kinds)) if (!specs[id]) say(`kind ${kind} is spec machine "${id}", which the spec does not have`);
  for (const [machine, refs] of Object.entries(needs.spec)) {
    const config = specs[machine];
    if (!config) { say(`names spec machine "${machine}", which the spec does not have`); continue; }
    for (const s of refs.states ?? []) if (!stateNode(config, s)) say(`names ${machine} state "${s}", which spec/${machine}.machine.json does not have`);
    for (const e of refs.events ?? []) if (!hasEvent(config, e)) say(`names ${machine} event ${e}, which spec/${machine}.machine.json does not take`);
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
  renderView(strictView(project(state, needs), needs, reads), needs);
  for (const r of reads) say(`reads ${r}, which ${file} does not declare`);
  return out;
}

const json = (x) => JSON.stringify(x).replace(/</g, '\\u003c');
const LIVE_CSS = `${CSS}
.age{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}.age button{font:inherit;font-weight:600;color:#fff;background:var(--accent);border:0;border-radius:8px;padding:6px 14px;cursor:pointer}.age button:disabled{opacity:.6}
.banner{border-radius:10px;padding:14px 16px;border:2px solid var(--bad);background:var(--bad-soft);color:var(--bad)}
.bar{display:inline-block;height:8px;border-radius:3px;background:var(--accent);min-width:2px}.slow{color:var(--bad)}`;

/**
 * Mission control as a live page: the store as it was at render (only the declared fields), the data age, and a
 * Refresh button that reads `<path>/<needs.reads.file>` through the Artifact files capability of `project`, renders
 * it and records the timing in the db collection the spec names. Publish with capabilities
 * {files: {project}, db: {}}.
 */
export function renderLivePage(state, { page = 'mission-control', project: projectId = null, path = '', title, standalone = false, now = new Date().toISOString() } = {}) {
  const needs = loadNeeds(page);
  const cfg = {
    page,
    title: title ?? needs.title,
    needs,
    project: projectId,
    path: `${path ? `${path.replace(/\/+$/, '')}/` : ''}${needs.reads.file}`,
    absentMeans: STORE_LAYOUT.absentMeans,
    slowMs: PAGE_RULES.refreshSlowMs,
    collection: PAGE_RULES.refreshCollection
  };
  const problem = schemaProblem(state, needs, STORE_LAYOUT.absentMeans);
  const view = problem ? null : project(state, needs);
  const meta = { readAt: now, version: view?.store.version ?? null, updatedAt: view?.store.updatedAt ?? null };
  const body = `${renderShell(view, problem, cfg, meta)}\n<script>${LIVE_SRC}\nclient(${json(cfg)}, ${json(meta)});</script>`;
  return wrapPage(cfg.title, body, { standalone, css: LIVE_CSS });
}

/** Recorded refreshes (ArtifactData rows of the refresh collection) slower than the spec's threshold. */
export function slowRefreshes(rows, slowMs = PAGE_RULES.refreshSlowMs) {
  return rowsOf(rows).filter((r) => typeof r.ms === 'number' && r.ms > slowMs);
}

export const slowRefreshText = (r, slowMs = PAGE_RULES.refreshSlowMs) =>
  `refresh of ${r.page ?? 'a page'} at ${r.at ?? '?'} took ${r.ms} ms, over ${slowMs} ms${r.storeVersion != null ? ` (store v${r.storeVersion})` : ''}`;
