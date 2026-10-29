// Live pages: mission control (a store's state.json) and the ledger, flow replay and design log (the one history's
// events.jsonl), each a page that reads its file itself, but only when a viewer asks. Node imports this module to
// render a page and to check it against its needs file; `harness page --live` also inlines its source in the page
// (each `export ` dropped), so the refresh button and flow replay's step buttons run the same code. It has no imports and touches no Node API. Everything a page reads goes
// through project() or projectLog(), which copy only the fields the page's needs file declares, of its file and of the
// file it reads beside it (reads.with: flow replay's steps.jsonl, which harness replay --steps writes, joined row by
// row; introspection's usage.jsonl, which scripts/history/usage.mjs writes, read as rows of its own: projectBeside).
// The ledger's Time and tokens sections read usage.jsonl (reads.onDemand) only when one is opened (client, usageSection).

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const valueText = (v) => (v == null ? '' : typeof v === 'string' ? v : Object.entries(v).map(([k, c]) => `${k}.${valueText(c)}`).join(', '));
const at = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
// The view key a declared path lands on: its last segment, and a child's `value` is its `state` (as text).
export const keyOf = (path) => (path === 'value' ? 'state' : path.split('.').at(-1));
const fieldsOf = (o, paths) => {
  const out = {};
  for (const p of paths) {
    const v = at(o, p);
    if (v !== undefined) out[keyOf(p)] = p === 'value' ? valueText(v) : v;
  }
  return out;
};
const minutes = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d`;
};
const clock = (iso) => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '');

/** The kinds a projected view holds, each with the view keys the page may read: the declared ones and the few project() adds. */
export function viewKeys(needs) {
  const keys = (kind, extra = []) => new Set([...(needs.fields[kind] ?? []).map(keyOf), ...extra]);
  return {
    view: new Set(['store', 'harness', 'items', 'budget', 'audits']),
    store: keys('store'),
    harness: new Set([...keys('harness')].filter((k) => k !== 'children')),
    item: new Set([...keys('item', ['address', 'done', 'decisions'])].filter((k) => k !== 'children')),
    decision: keys('decision', ['address']),
    budget: keys('budget'),
    audit: keys('audit', ['address'])
  };
}

/**
 * The store as the page sees it: only the fields `needs.fields` declares, from the store's root (store), the
 * harness snapshot (harness) and each child's snapshot, the children told apart by `needs.kinds` (spec machine ids).
 */
export function project(state, needs) {
  const f = needs.fields;
  const k = needs.kinds;
  const harness = fieldsOf(state.snapshot, f.harness);
  const children = Object.entries(harness.children ?? {});
  delete harness.children;
  const ofKind = (kind) => children.filter(([, c]) => c && c.src === k[kind]);
  const items = ofKind('item').map(([key, c]) => {
    const address = c.systemId ?? key;
    const item = fieldsOf(c.snapshot, f.item);
    const kids = Object.entries(item.children ?? {});
    delete item.children;
    return {
      ...item,
      address,
      done: item.status === 'done' || needs.view.finished.includes(item.state),
      decisions: kids.filter(([, d]) => d && d.src === k.decision).map(([id, d]) => ({ ...fieldsOf(d.snapshot, f.decision), address: `${address}/${id}` }))
    };
  });
  const budget = ofKind('budget')[0];
  return {
    store: fieldsOf(state, f.store),
    harness,
    items,
    budget: budget ? fieldsOf(budget[1].snapshot, f.budget) : null,
    audits: ofKind('audit').map(([key, c]) => ({ ...fieldsOf(c.snapshot, f.audit), address: c.systemId ?? key }))
  };
}

/** Why the page cannot show this data (not the file it reads, a schemaVersion outside the needs range, or a file it reads beside it missing or not of this data), or null. */
export const schemaProblem = (data, needs, absentMeans, also = {}) => FORMATS[needs.reads.file].problem(data, needs, absentMeans, also);

function storeProblem(state, needs, absentMeans) {
  const file = needs.reads.file;
  if (!state || typeof state !== 'object' || !state.snapshot) return `${file} is not a harness store, so ${needs.page} shows nothing from it.`;
  const v = state.schemaVersion ?? absentMeans;
  const { min, max } = needs.reads.schemaVersion;
  return typeof v === 'number' && v >= min && v <= max
    ? null
    : `This store's ${file} has schemaVersion ${esc(v)}; ${esc(needs.page)} reads ${min} to ${max}. Nothing from it is shown, so nothing here can be taken as complete.`;
}

const STAGE = (needs, state) => needs.view.stages.findIndex(([, states]) => states.includes(state));
const leaf = (state) => String(state ?? '').split('.').pop();

// The PASSes carried to a merge of main in an item's verdicts (spec workItem merging, carryVerdict), one line each, or
// only those `before` did not hold: the sha the verifier gave the PASS on, the head it carried to, the fact that carried it.
const carried = (verdicts, before = {}) =>
  Object.entries(verdicts && typeof verdicts === 'object' ? verdicts : {})
    .filter(([sha, v]) => v?.givenOn && !before?.[sha]?.givenOn)
    .map(([sha, v]) => `PASS on ${String(v.givenOn).slice(0, 7)} carried to ${sha.slice(0, 7)} by ${v.fact?.ref ?? 'a GitHub fact'}`);

function track(needs, item) {
  const stages = needs.view.stages;
  if (item.state === needs.view.merged) return `<div class="track ok" title="${esc(item.state)}">${stages.map(() => '<span></span>').join('')}</div>`;
  const now = STAGE(needs, item.state);
  return `<div class="track" title="${esc(item.state)}">${stages.map((_, i) => `<span class="${i < now ? 'past' : i === now ? 'now' : ''}"></span>`).join('')}</div>`;
}

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

/** The page's data, rendered: tiles, what needs the person, what is in flight and what has finished. */
export function renderView(view, needs) {
  const v = needs.view;
  const ev = v.events;
  const items = view.items;
  const live = items.filter((i) => !i.done);
  const finished = items.filter((i) => i.done);
  const link = (i) => (i.url ? ` <a href="${esc(i.url)}">${esc(i.url)}</a>` : '');
  const asks = [];
  for (const i of live) {
    if (i.state === v.needsCriteria)
      asks.push(`<div class="card"><span class="eyebrow">no criteria · tier ${esc(i.tier)}</span><b>${esc(i.title ?? i.id)}</b>${link(i)}
<div>Triage found nothing that would show this is done, so it cannot go on. Cancel it and ask again with what done looks like.</div>
<div class="m">To cancel: <code>harness send '{"type":"${esc(ev.cancel)}"}' --to ${esc(i.address)}</code></div></div>`);
    for (const d of i.decisions.filter((d) => d.state === v.awaitingPerson.decision)) {
      const s = d.standIn;
      const lean = s && s.choice ? `Stand-in leans <b>${esc(s.choice)}</b>${s.confidence != null ? ` (${pct(s.confidence)} sure)` : ''}${s.reason ? `: ${esc(s.reason)}` : ''}.` : 'No stand-in answer yet.';
      asks.push(`<div class="card"><span class="eyebrow">${esc(d.decisionClass)} gate · tier ${esc(d.tier)}</span><b>${esc(i.title ?? d.question)}</b>${link(i)}
<div>${lean}</div>
<div class="m">Answer on the card in the thread, or: <code>harness send '{"type":"${esc(ev.decide)}","choice":"approve"}' --to ${esc(d.address)} --actor person:&lt;you&gt; --source tap:${d.card ? esc(d.card) : '&lt;card-message-id&gt;'}</code></div></div>`);
    }
  }
  for (const a of view.audits.filter((a) => a.state === v.awaitingPerson.audit))
    asks.push(`<div class="card"><span class="eyebrow">stand-in audit · ${esc(a.day)}</span><b>Did the stand-in call these ${esc((a.picks ?? []).length)} right?</b>
<div class="m">Picks: ${(a.picks ?? []).map(esc).join(', ')}</div>
<div class="m">Answer on the card in the thread, or: <code>harness send '{"type":"${esc(ev.audit)}","option":0}' --to ${esc(a.address)} --actor person:&lt;you&gt; --source tap:${a.card ? esc(a.card) : '&lt;card-message-id&gt;'}</code></div></div>`);
  const h = view.harness;
  const scheduler = `scheduler.${h.scheduler}`;
  const tone = v.scheduler.bad.includes(scheduler) ? 'halted' : v.scheduler.warn.includes(scheduler) ? 'draining' : '';
  const b = view.budget;
  const row = (i) =>
    `<tr><td><b>${esc(i.id)}</b>${i.title ? `<br><span class="m">${esc(i.title)}</span>` : ''}</td><td class="m">${esc(i.project ?? '')}</td><td class="m">${esc(i.tier)}</td><td>${track(needs, i)}<span class="m">${esc(leaf(i.state))}</span>${carried(i.verdicts).map((l) => `<br><span class="m" data-carried>${esc(l)}</span>`).join('')}</td><td class="m">${esc(i.runs ?? 0)}${i.retries ? ` (${esc(i.retries)} retry)` : ''}</td><td class="m">${i.url ? `<a href="${esc(i.url)}">link</a>` : ''}</td></tr>`;
  const table = (rows) => `<div class="tablewrap"><table><thead><tr><th>Item</th><th>Project</th><th>Tier</th><th>Stage</th><th>Runs</th><th></th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>`;
  return `<div class="tiles">
<div class="tile${asks.length ? ' ask' : ''}"><span class="eyebrow">Needs you</span><b>${asks.length}</b><small>${asks.length ? 'waiting below' : 'nothing to decide'}</small></div>
<div class="tile"><span class="eyebrow">In flight</span><b>${esc((h.inFlight ?? []).length)} / ${esc(h.wipLimit)}</b><small>${esc((h.queued ?? []).length)} queued</small></div>
<div class="tile"><span class="eyebrow">Finished</span><b>${finished.length}</b><small>${finished.filter((i) => i.state === v.merged).length} merged</small></div>
<div class="tile"><span class="eyebrow">Scheduler</span><b><span class="pill ${tone}">${esc(h.scheduler)}</span></b><small>budget ${esc(b?.state ?? 'unknown')}${b?.sevenDay != null ? ` · 7-day ${pct(b.sevenDay)}` : ''}${b?.sampledAt ? ` · read ${esc(clock(b.sampledAt))} UTC` : ''}</small></div>
</div>
<section><h2>Needs you</h2>${asks.join('') || '<div class="empty">Nothing is waiting on you.</div>'}</section>
${granted(h, ev)}
<section><h2>In flight</h2>${live.length ? table(live) : '<div class="empty">Nothing in flight.</div>'}</section>
${finished.length ? `<section><h2>Finished</h2>${table(finished)}</section>` : ''}
<p class="m">Host to-do, recent events and item pages are on the full page (<code>harness page</code>).</p>`;
}

// The person's grant (kinds, the one-way box, until) and every decision made under it, newest first, each with its
// reason and how to reverse it: the harness's context.grant and context.granted.
function granted(h, ev) {
  const g = h.grant;
  const rows = h.granted ?? [];
  if (!g && !rows.length) return '';
  const line = !g ? 'No grant: the ladder alone decides.'
    : `Your grant (${g.message ? `message ${esc(g.message)}` : `card ${esc(g.card)}`}): ${g.kinds.length ? esc(g.kinds.join(', ')) : 'nothing'}, ${g.oneWay ? 'one-way doors included' : 'two-way doors only'}, ${g.until == null ? 'no end time' : `until ${esc(clock(g.until).slice(5))} UTC`}.`;
  const card = (r) => `<div class="card"><span class="eyebrow">${esc(r.decisionClass)} · ${esc(r.door)} door · ${esc(clock(r.at))} UTC</span><b>${esc(r.item)}: ${esc(r.choice)}</b> <span class="m">${pct(r.confidence)} sure</span>
<div>${esc(r.reason)}</div>
<div class="m">To reverse it${r.door === 'one-way' ? ' (a merge also needs a revert)' : ''}: ask the lead to revise it, or cancel: <code>harness send '{"type":"${esc(ev.cancel)}"}' --to item:${esc(r.item)}</code></div></div>`;
  return `<section><h2>Decided under your grant</h2><p class="m">${line}</p>${rows.length ? [...rows].reverse().map(card).join('') : '<div class="empty">Nothing decided under a grant yet.</div>'}</section>`;
}

export const banner = (problem, of = 'store') => `<div class="banner bad" role="alert"><b>Wrong ${esc(of)} layout.</b> ${problem}</div>`;

// The one history (spec/history.schema.json): one row per line. A line that is not JSON stays as {unreadable: line}.
export function parseLog(text) {
  return String(text ?? '').split('\n').map((l, i) => [l, i + 1]).filter(([l]) => l.trim()).map(([l, line]) => {
    try { return JSON.parse(l); } catch { return { unreadable: line }; }
  });
}
// A legacy placeholder ({legacy: why}); its keys are checked first, so a check reads no field a row does not have.
const isLegacy = (v) => v != null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).join() === 'legacy' && typeof v.legacy === 'string';
const logFields = (needs, type) => [...(needs.events['*'] ?? []), ...(needs.events[type] ?? [])];
const rowSchema = (r, absentMeans) => (r && r.schemaVersion !== undefined ? r.schemaVersion : absentMeans);

/**
 * A store's rows as a history (harness meta.store.history), or null when no row carries provenance: it is not one.
 * Each row with no provenance after the last row that has one is live, read with `provenance` (history.schema.json
 * live, for this history: src/history.js liveProvenance); the rows themselves are not changed. The one definition:
 * doctor reads a history through src/history.js historyRows, which is this, and the history pages, at render and on
 * Refresh, through logProblem and projectLog with their needs' `live` (src/pages.js loadNeeds).
 */
export function liveRows(rows, provenance) {
  const last = rows.findLastIndex((r) => r && r.provenance);
  if (last < 0) return null;
  return rows.map((r, i) => (i > last && r && typeof r === 'object' && !Array.isArray(r) && r.provenance === undefined ? { ...r, provenance } : r));
}

function logProblem(rows, needs, absentMeans, also = {}) {
  const { file } = needs.reads;
  const page = esc(needs.page);
  const none = 'Nothing from it is shown, so nothing here can be taken as complete.';
  if (!Array.isArray(rows) || !rows.length) return `This ${file} has no rows, so ${page} shows nothing from it.`;
  // A store that is not a history (no row carries provenance), or a row with none before a joined one, is refused below.
  rows = liveRows(rows, needs.live) || rows;
  const bad = rows.findIndex((r) => !r || r.unreadable || !r.event || !r.provenance || !r.provenance.from);
  if (bad >= 0) return `Line ${bad + 1} of this ${file} is ${rows[bad] && rows[bad].unreadable ? 'not JSON' : 'not a history row (no event or provenance, spec/history.schema.json)'}. ${none}`;
  const { min, max } = needs.reads.schemaVersion;
  const off = rows.findIndex((r) => { const v = rowSchema(r, absentMeans); return !(typeof v === 'number' && v >= min && v <= max); });
  if (off >= 0) return `This history's ${file} has schemaVersion ${esc(rowSchema(rows[off], absentMeans))} at line ${off + 1}; ${page} reads ${min} to ${max}. ${none}`;
  // Each file it reads beside the history: one joined row by row (needs.joins: steps.jsonl, one step per row, by version
  // and id), or one read as rows of its own (usage.jsonl, each with its kind).
  for (const name of Object.keys(needs.reads.with ?? {})) {
    const steps = also[name];
    const joined = Boolean(needs.joins && needs.joins[name]);
    const again = `Build it again beside the history: ${joined ? 'harness replay --steps' : 'scripts/history/usage.mjs'}. ${none}`;
    if (!Array.isArray(steps)) return `This page reads ${esc(name)} beside this ${file}, and there is none. ${again}`;
    if (!joined) { const p = usageRowsProblem(steps, name); if (p) return `${p} ${again}`; continue; }
    const bad = steps.findIndex((s) => !s || s.unreadable);
    if (bad >= 0) return `Line ${bad + 1} of this ${esc(name)} is not JSON. ${again}`;
    const by = new Map(steps.map((s) => [s.version, s]));
    const lone = rows.find((r) => !by.has(r.version) || by.get(r.version).id !== r.id);
    if (lone || steps.length !== rows.length)
      return `This ${esc(name)} is not this history's: ${lone ? `row ${esc(lone.version)} (${esc(lone.id)}) has no step of its own` : `it has ${steps.length} steps for ${rows.length} rows`}. ${again}`;
  }
  return null;
}

// Only the values at the given paths; a path goes through an array element by element.
function pick(o, paths) {
  if (Array.isArray(o)) return o.map((x) => pick(x, paths));
  if (o == null || typeof o !== 'object' || isLegacy(o)) return undefined;
  const by = new Map();
  for (const p of paths) {
    const [head, ...rest] = p.split('.');
    by.set(head, [...(by.get(head) ?? []), rest.join('.')]);
  }
  const out = {};
  for (const [k, subs] of by) {
    const v = subs.includes('') ? o[k] : pick(o[k], subs);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * The history as the page sees it (its live rows read as liveRows reads them): each row's type and only the fields `needs.events` declares for it ("*": every
 * row), and, for a page that reads a file beside the history (reads.with), the row's step from it (by version), with
 * only the fields declared for that file.
 */
export function projectLog(rows, needs, also = {}) {
  rows = liveRows(rows, needs.live) || rows;
  const [name, fields] = Object.entries(needs.reads.with ?? {}).find(([n]) => needs.joins && needs.joins[n]) ?? [];
  const steps = new Map((name && Array.isArray(also[name]) ? also[name] : []).map((s) => [s.version, s]));
  return rows.map((r) => {
    const out = pick(r, ['event.type', ...logFields(needs, r.event.type)]);
    if (name) out.step = steps.has(r.version) ? pick(steps.get(r.version), fields) : null;
    return out;
  });
}

/** Each file the page reads beside the history as rows of its own (reads.with, not joined): only its declared fields. */
export const projectBeside = (also, needs) =>
  Object.fromEntries(Object.entries(needs.reads.with ?? {}).filter(([n]) => !(needs.joins && needs.joins[n]) && Array.isArray(also[n])).map(([n, fields]) => [n, also[n].map((r) => pick(r, fields))]));

// How each file a page reads is parsed and projected, what its data age and timing row say, and which view renders it.
const FORMATS = {
  'state.json': {
    of: 'store',
    parse: (text) => JSON.parse(text),
    problem: storeProblem,
    project: (state, needs) => project(state, needs),
    age: (view) => ({ version: view.store.version ?? null, updatedAt: view.store.updatedAt ?? null }),
    stamp: (state, needs, absentMeans) => ({ storeVersion: (state && state.version) ?? null, schemaVersion: (state && state.schemaVersion) ?? absentMeans })
  },
  'events.jsonl': {
    of: 'history',
    parse: parseLog,
    problem: logProblem,
    project: projectLog,
    age: (rows) => ({ version: rows.length, updatedAt: rows.length ? rows[rows.length - 1].at ?? null : null }),
    stamp: (rows, needs, absentMeans) => {
      const versions = (Array.isArray(rows) ? rows : []).map((r) => rowSchema(r, absentMeans));
      const { min, max } = needs.reads.schemaVersion;
      return { storeVersion: versions.length, schemaVersion: versions.find((v) => !(v >= min && v <= max)) ?? Math.max(absentMeans, ...versions.filter((v) => typeof v === 'number')) };
    }
  }
};
export const formatOf = (needs) => FORMATS[needs.reads.file];
// The view that renders each page that reads the history; any other page is mission control's.
const VIEWS = { ledger: renderLedger, 'flow-replay': renderFlowReplay, 'design-log': renderDesignLog, introspection: renderIntrospection };
/** The page's data, rendered by its view; beside: the files it reads beside the history as rows of their own (projectBeside). */
export const renderData = (view, needs, beside = {}) => (VIEWS[needs.page] ?? renderView)(view, needs, beside);

// A history value as text, and the placeholders in a row: a placeholder is counted, never shown as a value.
const text = (v) => (v == null || isLegacy(v) ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const legacies = (v) => (isLegacy(v) ? 1 : v && typeof v === 'object' ? Object.values(v).reduce((n, x) => n + legacies(x), 0) : 0);
const PLACEHOLDER = '<i class="m">placeholder</i>';
const shownAs = (v) => (isLegacy(v) ? PLACEHOLDER : esc(text(v)));
// An actor (kind:id) or a source (kind:ref).
const party = (v) => (v == null ? '' : isLegacy(v) ? PLACEHOLDER : esc([v.kind, v.id ?? v.ref].filter((x) => x != null).join(':')));
const timeOrder = (a, b) => text(a.at).localeCompare(text(b.at)) || (a.version ?? 0) - (b.version ?? 0);
// A row's own placeholders: those in its step's values are the machines' context, not the row's.
const ownLegacies = (r) => { const { step: _, ...row } = r; return legacies(row); };

/**
 * The ledger: who did the work on each item, as which role and on which model (spawns, starts, runs), the usage
 * samples, and, in a corner, each source's rows and the placeholders among the fields the page reads, which are
 * counted and never shown as values. Every number carries data-count, so a test can hold it to the history's rows.
 */
export function renderLedger(rows, needs) {
  const of = (type) => rows.filter((r) => r.event.type === type);
  const tally = (list) => {
    const n = new Map();
    for (const v of list.filter((v) => v !== '')) n.set(v, (n.get(v) ?? 0) + 1);
    return [...n].map(([k, c]) => `${esc(k)}${c > 1 ? ` ×${c}` : ''}`).join(', ');
  };
  const count = (name, n) => `<b data-count="${name}">${n}</b>`;
  const items = new Map();
  for (const [type, key] of [['WORKER_SPAWNED', 'spawns'], ['WORKER_STARTED', 'starts'], ['RUN_SUCCEEDED', 'runs']])
    for (const r of of(type)) {
      const m = /^item:([^/]+)/.exec(typeof r.to === 'string' ? r.to : '');
      if (!m) continue;
      if (!items.has(m[1])) items.set(m[1], { spawns: [], starts: [], runs: [], last: '' });
      const i = items.get(m[1]);
      i[key].push(r);
      if (text(r.at) > i.last) i.last = text(r.at);
    }
  const eras = new Map();
  for (const r of rows) {
    const ref = text(r.provenance && r.provenance.from && r.provenance.from.ref) || '(no source)';
    if (!eras.has(ref)) eras.set(ref, { rows: 0, placeholders: 0, origins: [] });
    const e = eras.get(ref);
    e.rows++;
    e.placeholders += legacies(r);
    e.origins.push(text(r.provenance && r.provenance.origin));
  }
  const who = (a) => (a == null || isLegacy(a) ? '' : a.type || [a.kind, a.id].filter(Boolean).join(':'));
  const pr = (url) => { const t = text(url); const n = /\/pull\/(\d+)/.exec(t); return t ? `<a href="${esc(t)}">${n ? `#${n[1]}` : esc(t)}</a>` : ''; };
  const itemRow = ([id, i]) =>
    `<tr data-item="${esc(id)}"><td><b>${esc(id)}</b><br><span class="m">${esc(clock(i.last))}</span></td>` +
    `<td><b data-count="spawns">${i.spawns.length}</b> <span class="m">${tally(i.spawns.map((r) => text(r.event.role)))}</span></td>` +
    `<td class="m">${tally(i.spawns.map((r) => (r.event.model === null ? 'inherited' : text(r.event.model))))}</td>` +
    `<td><b data-count="starts">${i.starts.length}</b> <span class="m">${tally(i.starts.map((r) => text(r.event.agentType)))}</span></td>` +
    `<td><b data-count="runs">${i.runs.length}</b> ${i.runs.map((r) => `${pr(r.event.pr)} <span class="m">${esc(who(r.actor))}</span>`).join(', ')}</td></tr>` +
    // Time and tokens: read from the usage file (reads.onDemand) only when the viewer opens it (client, openUsage).
    (needs.reads.onDemand ? `<tr class="usage"><td colspan="5"><details data-usage="${esc(id)}"><summary>Time and tokens</summary><div data-usage-body></div></details></td></tr>` : '');
  const usage = of('USAGE_SAMPLED');
  const last = usage[usage.length - 1];
  const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 100)}%` : '—');
  return `<div class="tiles">
<div class="tile"><span class="eyebrow">Rows</span>${count('rows', rows.length)}<small>${eras.size} source${eras.size === 1 ? '' : 's'}</small></div>
<div class="tile"><span class="eyebrow">Spawns</span>${count('spawns', of('WORKER_SPAWNED').length)}<small>${tally(of('WORKER_SPAWNED').map((r) => text(r.event.role))) || 'none'}</small></div>
<div class="tile"><span class="eyebrow">Starts</span>${count('starts', of('WORKER_STARTED').length)}<small>agents bound to a spawn</small></div>
<div class="tile"><span class="eyebrow">Runs</span>${count('runs', of('RUN_SUCCEEDED').length)}<small>runs that opened a PR</small></div>
<div class="tile"><span class="eyebrow">Usage samples</span>${count('usage', usage.length)}<small>${last ? `7-day ${pct(last.event.sevenDay)} · 5-hour ${pct(last.event.fiveHour)} · ${esc(clock(text(last.at)))} UTC` : 'none in this history'}</small></div>
</div>
<section><h2>By item</h2>${items.size ? `<div class="tablewrap"><table><thead><tr><th>Item</th><th>Spawns</th><th>Models</th><th>Starts</th><th>Runs</th></tr></thead><tbody>${[...items].sort(([a], [b]) => a.localeCompare(b)).map(itemRow).join('')}</tbody></table></div>` : '<div class="empty">No spawns, starts or runs in this history.</div>'}</section>
<section><h2>Where the rows come from</h2><p class="m">A placeholder stands for a value no source recorded. Those among the fields this page reads are counted here and never shown as values.</p>
<div class="tablewrap"><table><thead><tr><th>Source</th><th>Origin</th><th>Rows</th><th>Placeholders</th></tr></thead><tbody>${[...eras].map(([ref, e]) => `<tr data-era="${esc(ref)}"><td class="m">${esc(ref)}</td><td class="m">${tally(e.origins)}</td><td><b data-count="rows">${e.rows}</b></td><td><b data-count="placeholders">${e.placeholders}</b></td></tr>`).join('')}</tbody></table></div></section>`;
}

// Time and tokens (usage.jsonl, history.schema.json usage): each agent of an item is one run of one or more segments
// (starts), and the lead's turns that wrote rows for it are listed with their own usage. A placeholder is no number:
// it adds nothing to a sum, and an active time with one is shown as at least the rest.
const num = (v) => (typeof v === 'number' ? v : 0);
const usageSum = (list) => ({ tokens: list.reduce((x, r) => x + num(r.input) + num(r.cacheRead) + num(r.cacheWrite) + num(r.output), 0), cost: list.reduce((x, r) => x + num(r.cost), 0) });
const ms = (a, b) => Date.parse(b) - Date.parse(a);
const isTime = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

// One agent's run from its segments: wall span (first start to last end), active time (the sum of the segments),
// the waiting gaps between them, tokens and cost.
function runOf(key, list) {
  list.sort((a, b) => a.segment - b.segment);
  const ends = list.map((s) => s.end).filter(isTime);
  const end = isTime(list.at(-1).end) ? list.at(-1).end : ends.sort().at(-1) ?? null;
  const gaps = list.slice(1).map((s, i) => ({ from: isTime(list[i].end) ? list[i].end : null, to: s.start }))
    .map((g) => ({ ...g, ms: g.from ? Math.max(0, ms(g.from, g.to)) : null }));
  const first = list[0];
  return { key, agentId: first.agentId, session: first.session, item: first.item, role: first.role, agentType: first.agentType, model: first.model, start: first.start, end, segments: list, gaps,
    wallMs: end ? ms(first.start, end) : null, activeMs: list.reduce((x, s) => x + num(s.activeMs), 0), activeKnown: list.every((s) => typeof s.activeMs === 'number'), ...usageSum(list) };
}

/** One item's runs (segments, wall span, active time, waiting gaps, tokens, cost), lead turns, total and the file's total. */
export function usageOf(rows, item) {
  const segs = rows.filter((r) => r.kind === 'segment');
  const leads = rows.filter((r) => r.kind === 'lead' && Array.isArray(r.items));
  const by = new Map();
  for (const s of segs.filter((s) => s.item === item)) {
    const key = `${s.session}/${s.agentId}`;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(s);
  }
  const runs = [...by].map(([key, list]) => runOf(key, list)).sort((a, b) => a.start.localeCompare(b.start));
  const lead = leads.filter((l) => l.items.includes(item)).sort((a, b) => a.start.localeCompare(b.start)).map((l) => ({ ...l, shared: l.items.filter((x) => x !== item), ...usageSum([l]) }));
  const own = lead.filter((l) => !l.shared.length);
  return { runs, lead, total: { ...usageSum([...runs.flatMap((r) => r.segments), ...own]), activeMs: runs.reduce((x, r) => x + r.activeMs, 0) + own.reduce((x, l) => x + num(l.activeMs), 0) }, all: usageSum([...segs, ...leads]) };
}

const span = (v) => {
  if (v == null) return '—';
  const s = Math.round(v / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`;
};
const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const usd = (n) => `$${n.toFixed(2)}`;
const breakdown = (r) => ['input', 'cacheRead', 'cacheWrite', 'output'].map((k) => `${k} ${typeof r[k] === 'number' ? r[k] : 'placeholder'}`).join(', ');

/** An item's Time and tokens section: a timeline (one bar per segment, a lane per run, waiting gaps) and a table. */
export function renderUsage(rows, item) {
  const u = usageOf(rows, item);
  if (!u.runs.length && !u.lead.length) return `<div class="empty">usage.jsonl has no run and no lead turn for ${esc(item)}.</div>`;
  const times = [...u.runs.flatMap((r) => r.segments.flatMap((s) => [s.start, s.end])), ...u.lead.flatMap((l) => [l.start, l.end])].filter(isTime).map(Date.parse);
  const [t0, t1] = [Math.min(...times), Math.max(...times)];
  const at = (iso) => ((Date.parse(iso) - t0) / Math.max(1, t1 - t0)) * 100;
  const bar = (cls, from, to, attrs, title) => `<span class="${cls}" ${attrs} style="left:${at(from).toFixed(2)}%;width:${Math.max(0, at(to) - at(from)).toFixed(2)}%" title="${esc(title)}"></span>`;
  const role = (v) => (isLegacy(v) ? 'unknown' : String(v).replace(/[^a-z0-9-]/gi, ''));
  const lane = (label, bars) => `<div class="lane"><span class="lane-label">${label}</span><div class="lane-track">${bars}</div></div>`;
  const laneOf = (r) => lane(`${shownAs(r.role)} <span class="m">${esc(r.agentId.slice(0, 7))}</span>`,
    r.segments.map((s) => bar(`seg r-${role(r.role)}`, s.start, isTime(s.end) ? s.end : s.start, `data-segment="${esc(r.key)}#${s.segment}"`, `${shownAs(r.role)} segment ${s.segment}: ${clock(s.start)} to ${isTime(s.end) ? clock(s.end) : 'end not recorded'}`)).join('') +
    r.gaps.filter((g) => g.from).map((g) => bar('wait', g.from, g.to, 'data-waiting', `waiting ${span(g.ms)}`).replace('></span>', '><i>waiting</i></span>')).join(''));
  const timeline = `<div class="timeline">${u.runs.map(laneOf).join('')}${u.lead.length ? lane('lead', u.lead.map((l) => bar(`seg r-lead${l.shared.length ? ' shared' : ''}`, l.start, l.end, `data-lead-bar="${esc(l.session)}#${esc(l.turn)}"`, `lead turn ${l.turn}: ${clock(l.start)} to ${clock(l.end)}`)).join('')) : ''}
<div class="axis m"><span>${esc(clock(new Date(t0).toISOString()))} UTC</span><span>${esc(clock(new Date(t1).toISOString()))} UTC</span></div></div>`;
  // A segment whose counts the ledger keeps on its last segment shows a placeholder, not 0.
  const cells = (start, wall, active, r) => `<td class="m">${esc(clock(start))}</td><td>${span(wall)}</td><td>${active}</td>` +
    (isLegacy(r.output) ? `<td colspan="2" class="m">${PLACEHOLDER}: on the last segment</td>` : `<td title="${esc(breakdown(r))}">${tok(r.tokens)}</td><td>${usd(r.cost)}</td>`);
  const runRow = (r) => {
    const waits = r.gaps.map((g) => (g.ms == null ? 'waiting, length not recorded' : `waiting ${span(g.ms)}`)).join(', ');
    const segRows = r.segments.length > 1 ? r.segments.map((s) => `<tr class="sub" data-seg="${esc(r.key)}#${s.segment}"><td class="m">segment ${s.segment}</td>${cells(s.start, isTime(s.end) ? ms(s.start, s.end) : null, typeof s.activeMs === 'number' ? span(s.activeMs) : PLACEHOLDER, { ...s, ...usageSum([s]) })}</tr>`).join('') : '';
    return `<tr data-run="${esc(r.key)}" data-tokens="${r.tokens}" data-cost="${r.cost}" data-wall-ms="${r.wallMs ?? ''}" data-active-ms="${r.activeMs}"><td><b>${shownAs(r.role)}</b> <span class="m">${shownAs(r.agentType)} · ${shownAs(r.model)} · ${esc(r.agentId)}</span>` +
      `${r.segments.length > 1 ? `<br><span class="m" data-waiting>${r.segments.length} segments, ${esc(waits)}</span>` : ''}</td>${cells(r.start, r.wallMs, `${r.activeKnown ? '' : '≥ '}${span(r.activeMs)}`, r)}</tr>${segRows}`;
  };
  const leadRow = (l) => `<tr data-lead="${esc(l.session)}#${esc(l.turn)}"${l.shared.length ? ` data-shared="${esc(l.shared.join(' '))}"` : ''}><td>turn ${esc(l.turn)} <span class="m">of ${esc(String(l.session).slice(0, 8))}</span>${l.shared.length ? `<br><span class="m">also wrote rows for ${esc(l.shared.join(', '))}: shown here and there, in neither total</span>` : ''}</td>${cells(l.start, ms(l.start, l.end), span(num(l.activeMs)), l)}</tr>`;
  const head = '<tr><th>Run</th><th>Start (UTC)</th><th>Duration</th><th>Active</th><th>Tokens</th><th>Cost</th></tr>';
  return `${timeline}
<div class="tablewrap"><table><thead>${head}</thead><tbody>${u.runs.map(runRow).join('')}
${u.lead.length ? `<tr><th colspan="6">Lead turns</th></tr>${u.lead.map(leadRow).join('')}` : ''}
<tr data-total-tokens="${u.total.tokens}" data-total-cost="${u.total.cost}"><td><b>Item total</b> <span class="m">runs and lead turns of this item alone</span></td><td></td><td></td><td>${span(u.total.activeMs)}</td><td><b>${tok(u.total.tokens)}</b></td><td><b>${usd(u.total.cost)}</b></td></tr></tbody></table></div>
<p class="m" data-page-tokens="${u.all.tokens}">Every item in usage.jsonl: ${tok(u.all.tokens)} tokens, ${usd(u.all.cost)}, each run and each lead turn counted once. Tokens are input, cache read, cache write and output.</p>`;
}

// The usage file's text as the section shows it: its rows, only the fields the needs file declares (reads.onDemand).
function usageSection(textIn, item, needs, name) {
  const rows = parseLog(textIn);
  const bad = usageRowsProblem(rows, name);
  if (bad) return `<div class="empty" data-usage-error>${bad} Nothing from it is shown.</div>`;
  return renderUsage(rows.map((r) => pick(r, needs.reads.onDemand[name])), item);
}
// Why usage rows cannot be shown (a line not JSON, or a row with no kind: history.schema.json usage), or null.
function usageRowsProblem(rows, name) {
  const bad = rows.findIndex((r) => !r || r.unreadable || typeof r.kind !== 'string');
  return bad < 0 ? null : `Line ${bad + 1} of ${esc(name)} is ${rows[bad] && rows[bad].unreadable ? 'not JSON' : 'not a usage row (history.schema.json usage)'}.`;
}

// Introspection (usage.jsonl beside the history, reads.with): where the time and money went. Every figure is a sum
// of usage rows, each agent's run (its segments) and each lead turn counted once; a placeholder adds nothing.
const COUNTS = ['requests', 'input', 'cacheRead', 'cacheWrite', 'output', 'cost'];
const sums = (list) => Object.fromEntries(COUNTS.map((k) => [k, list.reduce((x, r) => x + num(r[k]), 0)]));
const named = (v, none = 'unknown') => (v == null || isLegacy(v) ? none : String(v));
const LEAD = 'lead';
const NO_MODEL = 'lead turns (model not in usage.jsonl)';
const add = (o, k, v) => { o[k] = (o[k] ?? 0) + v; };

/**
 * The figures of the introspection page, from usage rows and history rows, each projected to the declared fields:
 * runs (one per agent, its segments joined), lead turns, the sessions they make up in tree order, totals, cost by
 * role, model and item (a lead turn shared by several items is listed under each and counted once, in `shared`),
 * overhead (needs.view.overheadRoles), landed PRs, the last hour and day before the newest end, and what is left out:
 * subagents tied to no item, sessions the history names with no ledger, and the placeholders among the fields read.
 */
export function costsOf(usage, rows, needs) {
  const segs = usage.filter((r) => r.kind === 'segment');
  const leads = usage.filter((r) => r.kind === 'lead' && Array.isArray(r.items)).map((l) => ({ ...l, role: LEAD, cost: num(l.cost) }))
    .sort((a, b) => a.start.localeCompare(b.start));
  const ledgers = usage.filter((r) => r.kind === 'session');
  const by = new Map();
  for (const s of segs) {
    const key = `${s.session}/${s.agentId}`;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(s);
  }
  const runs = [...by].map(([key, list]) => { const r = runOf(key, list); return { ...r, ...sums(list), role: named(r.role), model: named(r.model) }; })
    .sort((a, b) => a.start.localeCompare(b.start));
  const work = [...runs, ...leads];
  const total = { ...sums(work), activeMs: work.reduce((x, r) => x + num(r.activeMs), 0), runs: runs.length, leadTurns: leads.length,
    activeUnknown: segs.filter((s) => typeof s.activeMs !== 'number').length + leads.filter((l) => typeof l.activeMs !== 'number').length };
  const byRole = {};
  const byModel = {};
  for (const r of runs) { add(byRole, r.role, r.cost); add(byModel, r.model, r.cost); }
  for (const l of leads) { add(byRole, LEAD, l.cost); add(byModel, NO_MODEL, l.cost); }
  // The item each history row is sent to, and its PR: the merged one, else the last one a run reported.
  const itemOf = (to) => { const m = /^item:([^/]+)/.exec(typeof to === 'string' ? to : ''); return m ? m[1] : null; };
  const merged = new Map();
  const reported = new Map();
  for (const r of rows) {
    const type = r.event.type;
    if (type !== 'MERGED' && type !== 'RUN_SUCCEEDED') continue;
    const item = itemOf(r.to);
    const pr = text(r.event.pr);
    if (item && pr) (type === 'MERGED' ? merged : reported).set(item, pr);
  }
  const landed = new Set(merged.values()).size;
  const names = [...new Set([...runs.map((r) => r.item), ...leads.flatMap((l) => l.items)])].sort();
  const items = names.map((item) => {
    const mine = runs.filter((r) => r.item === item);
    const lead = leads.filter((l) => l.items.includes(item)).map((l) => ({ ...l, shared: l.items.filter((x) => x !== item) }));
    const own = lead.filter((l) => !l.shared.length);
    const roles = {};
    for (const r of mine) add(roles, r.role, r.cost);
    for (const l of own) add(roles, LEAD, l.cost);
    return { item, runs: mine, lead, byRole: roles, pr: merged.get(item) ?? reported.get(item) ?? null, merged: merged.has(item),
      cost: [...mine, ...own].reduce((x, r) => x + r.cost, 0), activeMs: [...mine, ...own].reduce((x, r) => x + num(r.activeMs), 0) };
  }).sort((a, b) => b.cost - a.cost || a.item.localeCompare(b.item));
  const sharedTurns = leads.filter((l) => l.items.length > 1);
  const shared = { turns: sharedTurns, cost: sharedTurns.reduce((x, l) => x + l.cost, 0) };
  const roles = (needs.view && needs.view.overheadRoles) || [];
  const overheadCost = runs.filter((r) => roles.includes(r.role)).reduce((x, r) => x + r.cost, 0);
  // The lead's sessions in tree order: each with its turns and the agents it spawned.
  const ids = [...new Set([...ledgers.map((l) => l.session), ...work.map((r) => r.session)])];
  const sessions = ids.map((session) => {
    const turns = leads.filter((l) => l.session === session);
    const agents = runs.filter((r) => r.session === session);
    const times = [...turns.flatMap((l) => [l.start, l.end]), ...agents.flatMap((r) => [r.start, r.end])].filter(isTime).sort();
    const own = { ...sums(turns), activeMs: turns.reduce((x, l) => x + num(l.activeMs), 0) };
    return { session, turns, agents, own, items: [...new Set(turns.flatMap((l) => l.items))].sort(), start: times[0] ?? null, end: times.at(-1) ?? null,
      withChildren: own.cost + agents.reduce((x, r) => x + r.cost, 0), childSums: sums(agents.flatMap((r) => r.segments)) };
  }).filter((s) => s.turns.length || s.agents.length).sort((a, b) => a.start.localeCompare(b.start));
  // The last hour and day: work that ended in them, before the newest end in the file (a run's cost is at its end).
  const endOf = (r) => (isTime(r.end) ? r.end : null);
  const newest = work.map(endOf).filter(Boolean).sort().at(-1) ?? null;
  const within = (h) => (newest ? work.filter((r) => endOf(r) && ms(endOf(r), newest) < h * 3600000).reduce((x, r) => x + r.cost, 0) : 0);
  const unbound = ledgers.flatMap((l) => (Array.isArray(l.unbound) ? l.unbound : []).map((u) => ({ ...u, session: l.session })));
  // Sessions the history names (a session or one of its agents sent a row) with no ledger read (no session row).
  const filed = new Set(ledgers.map((l) => l.session));
  const senders = new Set();
  for (const r of rows) {
    const a = r.actor;
    if (!a || isLegacy(a) || typeof a.id !== 'string') continue;
    if (a.kind === 'session') senders.add(a.id);
    if (a.kind === 'agent') senders.add(a.id.split('/')[0]);
  }
  const noLedger = [...senders].filter((s) => !filed.has(s)).sort();
  // The placeholders among the fields read, by file and field, with the first reason.
  const marks = new Map();
  const mark = (file, field, v) => {
    if (!isLegacy(v)) return;
    const k = `${file} ${field}`;
    if (!marks.has(k)) marks.set(k, { file, field, count: 0, why: v.legacy });
    marks.get(k).count++;
  };
  for (const r of usage) {
    for (const [k, v] of Object.entries(r)) if (k !== 'unbound') mark('usage.jsonl', k, v);
    for (const u of Array.isArray(r.unbound) ? r.unbound : []) for (const [k, v] of Object.entries(u)) mark('usage.jsonl', `unbound.${k}`, v);
  }
  for (const r of rows) {
    mark('events.jsonl', 'actor', r.actor);
    if (r.event.type === 'MERGED' || r.event.type === 'RUN_SUCCEEDED') { mark('events.jsonl', 'to', r.to); mark('events.jsonl', 'event.pr', r.event.pr); }
  }
  return {
    runs, leads, sessions, total, byRole, byModel, items, shared, landed, perPr: landed ? total.cost / landed : null,
    overhead: { roles, cost: overheadCost, share: total.cost ? overheadCost / total.cost : null },
    newest, lastHour: within(1), lastDay: within(24),
    unbound: { list: unbound, count: unbound.length, cost: unbound.reduce((x, u) => x + num(u.cost), 0) },
    noLedger, ledgers: ledgers.length, placeholders: [...marks.values()]
  };
}

const and = (list) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);
const roleClass = (role) => `r-${String(role).replace(/[^a-z0-9-]/gi, '')}`;
const short = (id) => esc(String(id).slice(0, 8));

/**
 * The introspection page: headline figures, cost by role, model and item (select an item for its runs and lead
 * turns), a timeline of runs in tree order (expand and collapse; look()), every run, and coverage: what the numbers
 * cannot see. Every figure is computed from the two files (costsOf); each one that leaves something out says so.
 */
export function renderIntrospection(rows, needs, beside = {}) {
  const usage = beside['usage.jsonl'] || [];
  const c = costsOf(usage, rows, needs);
  const t = c.total;
  const left = [
    c.unbound.count && `${c.unbound.count} subagent${c.unbound.count === 1 ? '' : 's'} tied to no item (${usd(c.unbound.cost)})`,
    c.noLedger.length && `${c.noLedger.length} session${c.noLedger.length === 1 ? '' : 's'} with no ledger`,
    'lead turns that wrote no row for an item'
  ].filter(Boolean);
  const leaves = `Leaves out ${and(left)}: see Coverage.`;
  const roles = c.overhead.roles;
  const tile = (label, value, small, key) => `<div class="tile" data-figure="${key}"><span class="eyebrow">${label}</span><b>${value}</b><small>${small}</small></div>`;
  const tiles = `<div class="tiles">
${tile('Cost, list price', usd(t.cost), `${t.runs} runs and ${t.leadTurns} lead turns, each once. ${leaves}`, 'cost')}
${tile('Per landed PR', c.perPr == null ? '—' : usd(c.perPr), c.landed ? `all of that cost over ${c.landed} merged PR${c.landed === 1 ? '' : 's'}, unmerged items' work included` : 'no PR merged in this history', 'per-pr')}
${tile('Overhead', pct(c.overhead.share), `${usd(c.overhead.cost)} of runs as ${roles.length ? and(roles) : 'no role'} (the overhead roles its needs file declares)`, 'overhead')}
${tile('Active time', span(t.activeMs), `runs' segments and lead turns${t.activeUnknown ? `; leaves out ${t.activeUnknown} whose active time is a placeholder` : ''}`, 'active')}
${tile('Last hour', usd(c.lastHour), c.newest ? `work that ended in the hour to ${esc(clock(c.newest))} UTC, the newest end in usage.jsonl` : 'no end time in usage.jsonl', 'last-hour')}
${tile('Last day', usd(c.lastDay), c.newest ? `work that ended in the 24 hours to ${esc(clock(c.newest))} UTC` : 'no end time in usage.jsonl', 'last-day')}
</div>`;
  const max = (o) => Math.max(1e-9, ...Object.values(o));
  const bars = (o, attr) => {
    const list = Object.entries(o).sort((a, b) => b[1] - a[1]);
    if (!list.length) return '<div class="empty">No cost in usage.jsonl.</div>';
    const top = max(o);
    return `<div class="hbars">${list.map(([k, v]) => `<div class="hbar" ${attr}="${esc(k)}"><span class="hl">${esc(k)}</span><span class="ht"><span class="seg ${roleClass(k)}" style="width:${((v / top) * 100).toFixed(2)}%"></span></span><span class="hv">${usd(v)}</span></div>`).join('')}</div>`;
  };
  const byRole = `<section><h2>Cost by role</h2><p class="m">Each run's cost under its spawn's role, each lead turn's under lead, each once. A role no spawn recorded is unknown. ${leaves}</p>${bars(c.byRole, 'data-role')}</section>`;
  const byModel = `<section><h2>Cost by model</h2><p class="m">Each run's cost under the models its ledger lists. usage.jsonl records no model for a lead turn, so lead turns are a bar of their own. ${leaves}</p>${bars(c.byModel, 'data-model')}</section>`;
  // Cost by item: a bar split by role, and a selectable row that shows the item's runs and lead turns.
  const pr = (i) => { const n = i.pr && /\/pull\/(\d+)/.exec(i.pr); return i.pr ? `<a href="${esc(i.pr)}">${n ? `#${n[1]}` : esc(i.pr)}</a>${i.merged ? '' : ' <span class="m">not merged</span>'}` : ''; };
  const top = Math.max(1e-9, ...c.items.map((i) => i.cost), c.shared.cost);
  const split = (o, whole) => `<span class="ht stack" style="width:${((whole / top) * 100).toFixed(2)}%">${Object.entries(o).sort((a, b) => b[1] - a[1]).map(([r, v]) => `<span class="seg ${roleClass(r)}" title="${esc(r)} ${usd(v)}" style="width:${whole ? ((v / whole) * 100).toFixed(2) : 0}%"></span>`).join('')}</span>`;
  const legend = `<div class="legend m">${[...new Set(Object.keys(c.byRole))].map((r) => `<span><i class="sw seg ${roleClass(r)}"></i>${esc(r)}</span>`).join('')}</div>`;
  const itemRow = (i) => `<tr data-item="${esc(i.item)}"><td><button type="button" data-pick="${esc(i.item)}" aria-pressed="false">${esc(i.item)}</button></td><td>${pr(i)}</td><td class="wide">${split(i.byRole, i.cost)}</td><td>${usd(i.cost)}</td><td>${span(i.activeMs)}</td><td>${i.runs.length}</td><td>${i.lead.length}</td></tr>`;
  const sharedRow = c.shared.turns.length ? `<tr data-item=""><td><b>Shared lead turns</b></td><td></td><td class="wide">${split({ [LEAD]: c.shared.cost }, c.shared.cost)}</td><td>${usd(c.shared.cost)}</td><td>${span(c.shared.turns.reduce((x, l) => x + num(l.activeMs), 0))}</td><td></td><td>${c.shared.turns.length}</td></tr>` : '';
  const detailRow = (label, r, note = '') => `<tr><td>${label}${note}</td><td class="m">${esc(clock(r.start))}</td><td>${span(num(r.activeMs))}</td><td>${num(r.requests)}</td><td>${usd(r.cost)}</td></tr>`;
  const detail = (i) => `<div class="card pick" data-detail="${esc(i.item)}" hidden><span class="eyebrow">item ${esc(i.item)}</span><b>${usd(i.cost)}</b> <span class="m">its runs and the lead turns that wrote only for it</span>
<div class="tablewrap"><table><thead><tr><th>Run or turn</th><th>Start (UTC)</th><th>Active</th><th>Requests</th><th>Cost</th></tr></thead><tbody>
${i.runs.map((r) => detailRow(`<b>${esc(r.role)}</b> <span class="m">${esc(r.model)} · ${esc(r.agentId)}${r.segments.length > 1 ? ` · ${r.segments.length} segments` : ''}</span>`, r)).join('')}
${i.lead.map((l) => detailRow(`lead turn ${esc(l.turn)} <span class="m">of ${short(l.session)}</span>`, l, l.shared.length ? `<br><span class="m" data-shared="${esc(l.shared.join(' '))}">also wrote for ${esc(l.shared.join(', '))}: counted once, under Shared lead turns, not in this item's cost</span>` : '')).join('')}
</tbody></table></div></div>`;
  const byItem = `<section data-costs-items><h2>Cost by item</h2><p class="m">Each item's runs and the lead turns that wrote rows for it alone, the bar split by role. A lead turn that wrote for several items is listed under each and counted once, on the Shared lead turns row. Select an item to see its runs and lead turns. ${leaves}</p>${legend}
<div class="tablewrap"><table><thead><tr><th>Item</th><th>PR</th><th>By role</th><th>Cost</th><th>Active</th><th>Runs</th><th>Lead turns</th></tr></thead><tbody>${c.items.map(itemRow).join('')}${sharedRow}</tbody></table></div>
${c.items.map(detail).join('')}</section>`;
  // The timeline: each lead session, then the agents it spawned; a pale bar is wall time, solid marks are turns or
  // segments, a dashed line a wait between segments. A session row starts collapsed and says what it hides.
  const times = [...c.sessions.flatMap((s) => [s.start, s.end]), ...c.runs.flatMap((r) => r.segments.flatMap((g) => [g.start, g.end]))].filter(isTime).map(Date.parse);
  const [t0, t1] = times.length ? [Math.min(...times), Math.max(...times)] : [0, 1];
  const x = (iso) => ((Date.parse(iso) - t0) / Math.max(1, t1 - t0)) * 100;
  const mark = (cls, from, to, attrs, title) => `<span class="${cls}" ${attrs} style="left:${x(from).toFixed(3)}%;width:${Math.max(0, x(to) - x(from)).toFixed(3)}%" title="${esc(title)}"></span>`;
  const wall = (from, to) => (isTime(from) && isTime(to) ? mark('wall', from, to, 'data-wall', `wall ${clock(from)} to ${clock(to)} UTC`) : '');
  const sessionLane = (s) => {
    const hides = `${s.agents.length} run${s.agents.length === 1 ? '' : 's'}, ${usd(s.withChildren - s.own.cost)}`;
    const marks = s.turns.map((l) => mark(`seg ${roleClass(LEAD)}`, l.start, l.end, `data-turn="${esc(s.session)}#${esc(l.turn)}"`, `lead turn ${l.turn}: ${clock(l.start)} to ${clock(l.end)} UTC, ${usd(l.cost)}`)).join('');
    const toggle = s.agents.length ? `<button type="button" data-toggle="${esc(s.session)}" aria-expanded="false" aria-label="Expand ${short(s.session)}">▸</button>` : '<span class="tg"></span>';
    return `<div class="lane" data-session="${esc(s.session)}"><span class="lane-label">${toggle} <b>lead</b> <span class="m">${short(s.session)}</span>${s.agents.length ? ` <span class="m hides" data-hides="${esc(s.session)}" data-hidden-cost="${(s.withChildren - s.own.cost).toFixed(6)}">+ ${hides}</span>` : ''}</span><div class="lane-track">${wall(s.start, s.end)}${marks}</div></div>` +
      s.agents.map((r) => `<div class="lane child" data-parent="${esc(s.session)}" hidden><span class="lane-label"><b>${esc(r.role)}</b> <span class="m">${esc(r.item)} · ${esc(r.agentId.slice(0, 7))}</span></span><div class="lane-track">${wall(r.start, r.end)}` +
        r.segments.map((g) => mark(`seg ${roleClass(r.role)}`, g.start, isTime(g.end) ? g.end : g.start, `data-segment="${esc(r.key)}#${esc(g.segment)}"`, `${r.role} segment ${g.segment}: ${clock(g.start)} to ${isTime(g.end) ? `${clock(g.end)} UTC` : 'end not recorded'}`)).join('') +
        r.gaps.filter((g) => g.from).map((g) => mark('wait', g.from, g.to, 'data-waiting', `waiting ${span(g.ms)}`)).join('') + '</div></div>').join('');
  };
  const timeline = `<section data-timeline><h2>Timeline</h2><p class="m">Runs in tree order: each lead session, then the agents it spawned. Pale bar: wall time. Solid marks: lead turns and agent segments. Dashed: an agent paused, waiting to be resumed. ▸ expands a session; a collapsed one shows the count and cost of the runs it hides. Times are UTC.</p>
<div class="stepper"><button type="button" data-all="open">Expand all</button><button type="button" data-all="shut">Collapse all</button></div>
${c.sessions.length ? `<div class="scrollbox"><div class="timeline wide-tl">${c.sessions.map(sessionLane).join('')}<div class="axis m"><span>${esc(clock(new Date(t0).toISOString()))} UTC</span><span>${esc(clock(new Date(t1).toISOString()))} UTC</span></div></div></div>` : '<div class="empty">No run and no lead turn in usage.jsonl.</div>'}</section>`;
  // Every run, in the same tree order: own counts, and cost with children for a session.
  const itemLink = (item) => { const i = c.items.find((x) => x.item === item); return i && i.pr ? `<a href="${esc(i.pr)}">${esc(item)}</a>` : esc(item); };
  const cells = (n) => ['requests', 'input', 'cacheRead', 'cacheWrite', 'output'].map((k) => `<td>${tok(n[k])}</td>`).join('');
  const runRow = (s) => `<tr data-run="${esc(s.session)}"><td><b>lead</b> <span class="m">${short(s.session)}</span></td><td>lead</td><td>${s.items.map(itemLink).join(', ')}</td><td class="m">not recorded</td><td class="m">${esc(clock(s.start))}</td><td>${s.start && s.end ? span(ms(s.start, s.end)) : '—'}</td><td>${span(s.own.activeMs)}</td>${cells(s.own)}<td>${usd(s.own.cost)}</td><td>${usd(s.withChildren)}</td></tr>` +
    s.agents.map((r) => `<tr class="sub" data-run="${esc(r.key)}"><td>↳ ${esc(named(r.agentType, ''))} <span class="m">${esc(r.agentId.slice(0, 7))}${r.segments.length > 1 ? ` · ${r.segments.length} segments` : ''}</span></td><td>${esc(r.role)}</td><td>${itemLink(r.item)}</td><td class="m">${esc(r.model)}</td><td class="m">${esc(clock(r.start))}</td><td>${span(r.wallMs)}</td><td>${r.activeKnown ? '' : '≥ '}${span(r.activeMs)}</td>${cells(r)}<td>${usd(r.cost)}</td><td>${usd(r.cost)}</td></tr>`).join('');
  const every = `<section><h2>Every run</h2><p class="m">Each lead session and the agents it spawned, in tree order. A session's own counts are its lead turns that wrote rows for an item; with children adds its agents. Each item links to its PR when there is one. ${leaves}</p>
<div class="tablewrap tall"><table class="runs"><thead><tr><th>Run</th><th>Role</th><th>Item</th><th>Model</th><th>Start</th><th>Wall</th><th>Active</th><th>Requests</th><th>Input</th><th>Cache read</th><th>Cache write</th><th>Output</th><th>Own cost</th><th>With children</th></tr></thead><tbody>${c.sessions.map(runRow).join('')}</tbody></table></div></section>`;
  // Coverage: what the numbers cannot see.
  const unboundRows = c.unbound.list.map((u) => `<tr data-unbound="${esc(u.session)}/${esc(u.agentId)}"><td class="m">${short(u.session)}/${esc(String(u.agentId).slice(0, 7))}</td><td>${shownAs(u.agentType)}</td><td>${typeof u.cost === 'number' ? usd(u.cost) : PLACEHOLDER}</td><td class="m why">${esc(u.reason)}</td></tr>`).join('');
  const coverage = `<section data-coverage><h2>Coverage</h2><p class="m">What the numbers above cannot see. usage.jsonl holds ${c.ledgers} session ledger${c.ledgers === 1 ? '' : 's'}; a lead turn that wrote no row for an item is in none of its rows, so no figure here counts it.</p>
<h3>Subagents tied to no item: <b data-count="unbound">${c.unbound.count}</b>, ${usd(c.unbound.cost)}</h3><p class="m">No binding record and no WORKER_STARTED row names them, so they are in no total above.</p>
${c.unbound.count ? `<div class="tablewrap tall"><table><thead><tr><th>Agent</th><th>Type</th><th>Cost</th><th>Why no item</th></tr></thead><tbody>${unboundRows}</tbody></table></div>` : ''}
<h3>Sessions with no ledger: <b data-count="no-ledger">${c.noLedger.length}</b></h3><p class="m">Sessions the history names, as a sender or as the session of an agent that sent a row, with no ledger in usage.jsonl: their time and cost are not here at all.</p>
${c.noLedger.length ? `<p class="m ids">${c.noLedger.map(esc).join(', ')}</p>` : ''}
<h3>Placeholders: <b data-count="placeholders">${c.placeholders.reduce((x, p) => x + p.count, 0)}</b></h3><p class="m">Fields this page reads that no source recorded. A placeholder adds nothing to a sum; an agent's counts on an earlier segment are placeholders because its ledger counts them on its last.</p>
${c.placeholders.length ? `<div class="tablewrap"><table><thead><tr><th>File</th><th>Field</th><th>Rows</th><th>First reason</th></tr></thead><tbody>${c.placeholders.map((p) => `<tr data-placeholder="${esc(p.file)} ${esc(p.field)}"><td class="m">${esc(p.file)}</td><td><code>${esc(p.field)}</code></td><td>${p.count}</td><td class="m why">${esc(p.why)}</td></tr>`).join('')}</tbody></table></div>` : ''}</section>`;
  return `<div class="costs" data-costs>${tiles}<div class="grid2">${byRole}${byModel}</div>${byItem}${timeline}${every}${coverage}</div>`;
}

/**
 * The introspection page's controls, a click inside its data-costs section: a data-toggle button expands or collapses
 * one session's runs (a collapsed one shows what it hides), a data-all button all of them, and a data-pick button
 * selects an item (again: none) and shows its runs and lead turns.
 */
export function look(e) {
  const b = e.target && e.target.closest ? e.target.closest('[data-toggle], [data-all], [data-pick]') : null;
  const g = b && b.closest('[data-costs]');
  if (!g) return;
  const set = (id, open) => {
    for (const t of g.querySelectorAll('[data-toggle]')) if (t.dataset.toggle === id) { t.setAttribute('aria-expanded', String(open)); t.textContent = open ? '▾' : '▸'; }
    for (const r of g.querySelectorAll('[data-parent]')) if (r.dataset.parent === id) r.hidden = !open;
    for (const h of g.querySelectorAll('[data-hides]')) if (h.dataset.hides === id) h.hidden = open;
  };
  if ('toggle' in b.dataset) set(b.dataset.toggle, b.getAttribute('aria-expanded') !== 'true');
  if ('all' in b.dataset) for (const t of g.querySelectorAll('[data-toggle]')) set(t.dataset.toggle, b.dataset.all === 'open');
  if ('pick' in b.dataset) {
    const on = b.getAttribute('aria-pressed') !== 'true';
    for (const p of g.querySelectorAll('[data-pick]')) p.setAttribute('aria-pressed', String(on && p === b));
    for (const d of g.querySelectorAll('[data-detail]')) d.hidden = !(on && d.dataset.detail === b.dataset.pick);
  }
}

/**
 * The diagram boxes a row's step lights (pages/flow-replay/diagram.json): the boxes of the first sender rule its row
 * matches (by the actor's kind, the source's kind and the event type), the box of each actor whose state or context
 * it changed (by the kind of the address's last segment), and the store files it wrote (writes), each once.
 */
export function lights(r, d) {
  const list = (v) => (Array.isArray(v) ? v : []);
  const kind = (v) => (v && typeof v === 'object' && !isLegacy(v) ? v.kind : undefined);
  const fits = (want, v) => !want || want.includes(v);
  const rule = list(d.senders).find((x) => fits(x.actor, kind(r.actor)) && fits(x.source, kind(r.source)) && fits(x.event, r.event.type));
  const s = r.step;
  const applied = Boolean(s) && s.refused == null;
  const changed = applied ? [...list(s.actors), ...list(s.context)].map((c) => d.actors[String(c.address).split('/').pop().split(':')[0]]) : [];
  const effects = applied ? list(s.effects) : [];
  const when = { always: true, applied, effects: effects.length > 0, acks: effects.some((f) => list(f.acks).length > 0) };
  const writes = Object.entries(d.writes ?? {}).filter(([, w]) => when[w]).map(([box]) => box);
  return [...new Set([...(rule ? rule.boxes : []), ...changed, ...writes].filter(Boolean))];
}

// The point on box b's edge toward p: straight up, down or across where p is level with b, else toward b's centre.
function edgeTo(b, [px, py]) {
  if (px >= b.x && px <= b.x + b.w) return [px, py < b.y ? b.y : b.y + b.h];
  if (py >= b.y && py <= b.y + b.h) return [px < b.x ? b.x : b.x + b.w, py];
  const [cx, cy] = [b.x + b.w / 2, b.y + b.h / 2];
  const t = Math.min(b.w / 2 / Math.abs(px - cx), b.h / 2 / Math.abs(py - cy));
  return [cx + (px - cx) * t, cy + (py - cy) * t];
}
// An arrow's points: through its via points, else straight between the two boxes where they face each other.
function route(a, b, via) {
  if (via && via.length) return [edgeTo(a, via[0]), ...via, edgeTo(b, via[via.length - 1])];
  const mid = (lo, hi) => (lo + hi) / 2;
  const [x0, x1, y0, y1] = [Math.max(a.x, b.x), Math.min(a.x + a.w, b.x + b.w), Math.max(a.y, b.y), Math.min(a.y + a.h, b.y + b.h)];
  if (x0 <= x1) return [edgeTo(a, [mid(x0, x1), b.y + b.h / 2]), edgeTo(b, [mid(x0, x1), a.y + a.h / 2])];
  if (y0 <= y1) return [edgeTo(a, [b.x + b.w / 2, mid(y0, y1)]), edgeTo(b, [a.x + a.w / 2, mid(y0, y1)])];
  return [edgeTo(a, [b.x + b.w / 2, b.y + b.h / 2]), edgeTo(b, [a.x + a.w / 2, a.y + a.h / 2])];
}

// The architecture diagram (diagram.json) lit for one row: each zone, each arrow (lit when both its boxes are) and
// each box, a focusable group carrying what it is and its repo path, which step() shows.
function renderDiagram(d, on) {
  const lit = new Set(on);
  const by = new Map(d.boxes.map((b) => [b.id, b]));
  const [w, h] = d.viewBox;
  const head = (id) => `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z"/></marker>`;
  const zone = (z) => `<rect class="zone" x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="10"/><text class="zl" x="${z.x + z.w - 12}" y="${z.y + 16}" text-anchor="end">${esc(z.label)}</text>`;
  const arrow = (a) => `<g class="arrow${lit.has(a.from) && lit.has(a.to) ? ' on' : ''}" data-arrow="${esc(a.from)} ${esc(a.to)}"><title>${esc(a.label)}</title><polyline points="${route(by.get(a.from), by.get(a.to), a.via).map((p) => p.map(Math.round).join(',')).join(' ')}"/></g>`;
  const box = (b) => `<g class="box${lit.has(b.id) ? ' on' : ''}" data-box="${esc(b.id)}" data-label="${esc(b.label)}" data-what="${esc(b.what)}" data-path="${esc(b.path)}" tabindex="0" role="button" aria-label="${esc(`${b.label}: ${b.what}`)}">` +
    `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8"/><text x="${b.x + b.w / 2}" y="${b.y + b.h / 2}" text-anchor="middle" dominant-baseline="central">${esc(b.label)}</text></g>`;
  return `<div class="diagram"><svg viewBox="0 0 ${w} ${h}" role="group" aria-label="The harness: the person and GitHub, the lead's thread and its agents and hooks, the harness CLI and its actors, and the store">` +
    `<defs>${head('fr-ah')}${head('fr-ah-on')}</defs>${d.zones.map(zone).join('')}${d.arrows.filter((a) => by.has(a.from) && by.has(a.to)).map(arrow).join('')}${d.boxes.map(box).join('')}</svg></div>
<p class="m">Lit for the row shown: the box that sent it, the actors whose state or context it changed, the store files it wrote, and the arrows between them.</p>
<div class="about" data-about role="status">Click or focus a box to see what it is and where it lives in the repo.</div>`;
}

/**
 * Flow replay: every row in time order, stepped one at a time through the whole history or through one item's rows
 * (the to address; rows with no item address are a group of their own). Each step shows the row's type, time, sender
 * and provenance and, from its step (steps.jsonl), each actor whose state it changed, before and after, the context
 * fields it changed, the effects it queued with their detail and acks, and its route; a step that changed nothing
 * says so, and one replay could not apply says why. An object or array value is pretty-printed in a block. Above the
 * step, the architecture diagram (needs.diagram) lit for it (lights(), each card's data-lit). Every count carries data-count.
 */
export function renderFlowReplay(rows, needs) {
  const sorted = [...rows].sort(timeOrder);
  const groupOf = (r) => { const m = /^item:([^/]+)/.exec(typeof r.to === 'string' ? r.to : ''); return m ? `item:${m[1]}` : '(no item)'; };
  const groups = new Map();
  for (const r of sorted) {
    const g = groupOf(r);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const count = (name, n) => `<b data-count="${name}">${n}</b>`;
  const many = (v) => (Array.isArray(v) ? v : []);
  const tally = (list) => {
    const steps = list.map((r) => r.step).filter(Boolean);
    const applied = steps.filter((s) => s.refused == null);
    return { rows: list.length, placeholders: list.reduce((n, r) => n + ownLegacies(r), 0), steps: applied.length, refused: steps.length - applied.length, actors: applied.reduce((n, s) => n + many(s.actors).length, 0), effects: applied.reduce((n, s) => n + many(s.effects).length, 0) };
  };
  const value = (v) => {
    if (v == null) return '<i class="m">none</i>';
    const t = typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
    return t.includes('\n') ? `<pre class="json">${esc(t)}</pre>` : `<code>${esc(t)}</code>`;
  };
  const ack = (a) => `${esc(a.outcome)}${a.at ? ` ${esc(clock(a.at))}` : ''}${a.note ? ` (${esc(a.note)})` : ''}`;
  const changed = (s) => {
    if (!s) return '';
    if (s.refused != null) return `<div class="refused" data-refused>Replay cannot apply this row, so it changed nothing: ${esc(s.refused)}</div>`;
    const [actors, context, effects] = [many(s.actors), many(s.context), many(s.effects)];
    const parts = [
      actors.length && `<h4>Actors</h4><ul>${actors.map((a) => `<li data-actor="${esc(a.address)}"><b>${esc(a.address)}</b>: <span data-before>${value(a.before)}</span> → <span data-after>${value(a.after)}</span></li>`).join('')}</ul>`,
      context.length && `<h4>Context</h4><ul>${context.map((c) => `<li data-field="${esc(c.address)} ${esc(c.field)}">${esc(c.address)} <b>${esc(c.field)}</b>: <span data-before>${value(c.before)}</span> → <span data-after>${value(c.after)}</span>${c.field === 'verdicts' ? carried(c.after, c.before ?? {}).map((l) => `<br><b data-carried>${esc(l)}</b>`).join('') : ''}</li>`).join('')}</ul>`,
      effects.length && `<h4>Effects queued</h4><ul>${effects.map((f) => `<li data-effect="${esc(f.id)}"><b>${esc(f.name)}</b>${f.subject ? ` ${esc(f.subject)}` : ''} <span class="m">${esc(f.id)} · ${many(f.acks).length ? `acked ${many(f.acks).map(ack).join(', ')}` : 'no ack in this store'}</span>${f.detail != null ? value(f.detail) : ''}</li>`).join('')}</ul>`
    ].filter(Boolean);
    const route = `<div class="m">Route: ${many(s.route).length ? many(s.route).map(esc).join(' → ') : 'none'}</div>`;
    return `${parts.length ? parts.join('') : '<div class="m" data-unchanged>This step changed nothing: no actor\'s state, no context field, no effect.</div>'}${route}`;
  };
  const diagram = needs.diagram;
  const lit = (r) => (diagram ? lights(r, diagram) : []);
  const card = (r, i) =>
    `<div class="card step" data-version="${esc(r.version)}" data-group="${esc(groupOf(r))}" data-lit="${esc(lit(r).join(' '))}"${i ? ' hidden' : ''}><span class="eyebrow">row ${esc(r.version)} · to ${shownAs(r.to)}</span><b>${esc(r.event.type)}</b>` +
    `<div class="m">${shownAs(r.at)} · sent by ${party(r.actor)} via ${party(r.source)} · ${shownAs(at(r, 'provenance.origin'))} from ${shownAs(at(r, 'provenance.from.source'))} · id ${shownAs(r.id)}</div>${changed(r.step)}</div>`;
  const button = (step, label) => `<button type="button" data-step="${step}">${label}</button>`;
  const all = tally(sorted);
  const line = ([g, list]) => {
    const t = tally(list);
    return `<tr data-group="${esc(g)}"><td><button type="button" data-follow="${esc(g)}" aria-pressed="false">${esc(g)}</button></td>` +
      ['rows', 'steps', 'refused', 'actors', 'effects', 'placeholders'].map((k) => `<td>${count(k, t[k])}</td>`).join('') + '</tr>';
  };
  return `<div class="tiles">
<div class="tile"><span class="eyebrow">Rows</span>${count('rows', all.rows)}<small>in time order, in ${count('groups', groups.size)} groups: one per item, and one for rows with no item</small></div>
<div class="tile"><span class="eyebrow">Steps</span>${count('steps', all.steps)}<small>rows replay applied; ${count('refused', all.refused)} it could not apply</small></div>
<div class="tile"><span class="eyebrow">Changed actors</span>${count('actors', all.actors)}<small>state changes, each before and after</small></div>
<div class="tile"><span class="eyebrow">Effects</span>${count('effects', all.effects)}<small>queued, with the acks the store holds</small></div>
<div class="tile"><span class="eyebrow">Placeholders</span>${count('placeholders', all.placeholders)}<small>values no source recorded, never shown</small></div>
</div>
<section class="replay" data-steps=""${diagram ? ` data-repo="${esc(diagram.repo)}"` : ''}><h2>Step through</h2>
<div class="tablewrap"><table><thead><tr><th>Follow</th><th>Rows</th><th>Steps</th><th>Refused</th><th>Changed actors</th><th>Effects</th><th>Placeholders</th></tr></thead><tbody>
<tr data-group=""><td><button type="button" data-follow="" aria-pressed="true">whole history</button></td><td colspan="6" class="m">every row in time order, across items</td></tr>
${[...groups].map(line).join('\n')}</tbody></table></div>
<div class="stepper"><span data-following>Following the whole history</span>${button('first', 'First')}${button('prev', 'Previous')}<span class="m" data-pos>1 / ${sorted.length}</span>${button('next', 'Next')}${button('last', 'Last')}</div>
${diagram ? renderDiagram(diagram, sorted.length ? lit(sorted[0]) : []) : ''}
${sorted.map(card).join('')}</section>`;
}

/**
 * Flow replay's controls, a click or focus inside its data-steps section. A diagram box (click or focus) shows what it
 * is and its repo path. On a click, a data-follow button follows one group (or, empty, the whole history), keeping
 * the row shown when it is in that group, and a data-step button shows the first, previous, next or last row of what
 * is followed. One row is shown at a time, with its position, and the diagram is lit for it (its card's data-lit).
 */
export function step(e) {
  const b = e.target && e.target.closest ? e.target.closest('[data-step], [data-follow], [data-box]') : null;
  const g = b && b.closest('[data-steps]');
  if (!g) return;
  if (b.dataset.box) {
    for (const x of g.querySelectorAll('[data-box]')) x.classList.toggle('sel', x.dataset.box === b.dataset.box);
    const d = b.dataset;
    g.querySelector('[data-about]').innerHTML = `<b>${esc(d.label)}</b> ${esc(d.what)} <a href="${esc((g.dataset.repo || '') + d.path)}"><code>${esc(d.path)}</code></a>`;
    return;
  }
  if (e.type === 'focusin') return;
  if ('follow' in b.dataset) g.dataset.steps = b.dataset.follow;
  const follow = g.dataset.steps || '';
  const all = [...g.querySelectorAll('[data-version]')];
  const list = follow ? all.filter((r) => r.dataset.group === follow) : all;
  if (!list.length) return;
  const now = Math.max(0, list.findIndex((r) => !r.hidden));
  const to = { first: 0, prev: Math.max(0, now - 1), next: Math.min(list.length - 1, now + 1), last: list.length - 1 }[b.dataset.step] ?? now;
  all.forEach((r) => { r.hidden = r !== list[to]; });
  g.querySelector('[data-pos]').textContent = `${to + 1} / ${list.length}`;
  g.querySelector('[data-following]').textContent = follow ? `Following ${follow}` : 'Following the whole history';
  for (const f of g.querySelectorAll('[data-follow]')) f.setAttribute('aria-pressed', String(f.dataset.follow === follow));
  const on = new Set(String(list[to].dataset.lit || '').split(' ').filter(Boolean));
  for (const x of g.querySelectorAll('[data-box]')) x.classList.toggle('on', on.has(x.dataset.box));
  for (const x of g.querySelectorAll('[data-arrow]')) { const [from, into] = x.dataset.arrow.split(' '); x.classList.toggle('on', on.has(from) && on.has(into)); }
}

// The design log's page size: how many of its table's rows one page shows.
const LOG_PAGE = 50;
// A row's UTC day (YYYY-MM-DD), or '' when its time is not one.
const dayOf = (r) => { const t = Date.parse(text(r.at)); return Number.isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10); };
// Which of n rows page p shows (p held to the pages there are), and its position line.
const logPage = (n, p) => {
  const pages = Math.max(1, Math.ceil(n / LOG_PAGE));
  const page = Math.min(Math.max(1, p), pages);
  const from = (page - 1) * LOG_PAGE;
  const to = Math.min(n, from + LOG_PAGE);
  return { page, from, to, pos: `page ${page} of ${pages} · rows ${n ? from + 1 : 0} to ${to} of ${n}` };
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// One month grid per month with rows, weeks in rows from Monday, in UTC; a day with rows is a control with its count.
function calendar(perDay) {
  const months = [...new Set(Object.keys(perDay).map((d) => d.slice(0, 7)))].sort();
  return months.map((m, i) => {
    const [y, mo] = m.split('-').map(Number);
    const cells = Array((new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7).fill('');
    for (let d = 1; d <= new Date(Date.UTC(y, mo, 0)).getUTCDate(); d++) {
      const day = `${m}-${String(d).padStart(2, '0')}`;
      const n = perDay[day];
      cells.push(n ? `<button type="button" data-day="${day}" aria-pressed="false" aria-label="${day}: ${n} rows"><span>${d}</span><b data-count="day">${n}</b></button>` : `<span class="m">${d}</span>`);
    }
    while (cells.length % 7) cells.push('');
    const weeks = cells.map((c, j) => (j % 7 ? '' : `<tr>${cells.slice(j, j + 7).map((x) => `<td>${x}</td>`).join('')}</tr>`)).join('');
    return `<table class="cal" data-cal="${m}"${i === months.length - 1 ? '' : ' hidden'}><caption>${MONTHS[mo - 1]} ${y}</caption><thead><tr>${['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => `<th>${d}</th>`).join('')}</tr></thead><tbody>${weeks}</tbody></table>`;
  }).join('');
}

/**
 * The design log: the decisions and what they led to, newest first: requests, stand-in answers (choice and reason),
 * the person's decisions and grants, 50 a page, and every out-of-band step with who ordered it, the message, what was
 * done and the gates it skipped. A calendar shows each UTC day of these rows by month; choosing a day shows only its
 * rows and cards (turn). The tiles count the whole history, and every number carries data-count.
 */
export function renderDesignLog(rows, needs) {
  const count = (name, x) => `<b data-count="${name}">${x}</b>`;
  const list = (v) => (Array.isArray(v) ? v.map(esc).join(', ') : shownAs(v));
  const by = (r) => `${party(r.actor)} via ${party(r.source)}`;
  const row = {
    REQUEST_RECEIVED: (r) => ['request', `item:${shownAs(at(r, 'event.request.id'))}`, 'filed', ''],
    STAND_IN_ANSWERED: (r) => ['answer', shownAs(r.to), `<b>${shownAs(at(r, 'event.answer.choice'))}</b> ${shownAs(at(r, 'event.answer.reason'))}`, 'the stand-in'],
    PERSON_DECIDED: (r) => ['decision', shownAs(r.to), `<b>${shownAs(r.event.choice)}</b>`, by(r)],
    PERSON_GRANTED: (r) => ['grant', '', `granted ${list(r.event.picks)}`, by(r)]
  };
  const of = rows.filter((r) => row[r.event.type] || r.event.type === 'OUT_OF_BAND').sort(timeOrder).reverse();
  const n = (type) => of.filter((r) => r.event.type === type).length;
  const oob = of.filter((r) => r.event.type === 'OUT_OF_BAND');
  const rest = of.filter((r) => r.event.type !== 'OUT_OF_BAND');
  const first = logPage(rest.length, 1);
  const tr = (r, i) => {
    const [kind, where, what, who] = row[r.event.type](r);
    return `<tr data-kind="${kind}" data-version="${esc(r.version)}" data-on="${dayOf(r)}"${i < first.to ? '' : ' hidden'}><td class="m">${shownAs(r.at)}</td><td>${kind}</td><td class="m">${where}</td><td>${what}</td><td class="m">${who}</td></tr>`;
  };
  const card = (r) =>
    `<div class="card" data-oob="${esc(r.version)}" data-on="${dayOf(r)}"><span class="eyebrow">${shownAs(r.at)} · ${shownAs(r.to)}</span><b>${shownAs(r.event.what)}</b>` +
    `<div class="m">Ordered by ${party(r.event.orderedBy)}, message ${shownAs(r.event.message)}. Skipped: ${list(r.event.skipped)}.</div></div>`;
  const perDay = {};
  for (const r of of) if (dayOf(r)) perDay[dayOf(r)] = (perDay[dayOf(r)] ?? 0) + 1;
  const button = (attr, label, pressed) => `<button type="button" ${attr}${pressed == null ? '' : ` aria-pressed="${pressed}"`}>${label}</button>`;
  const tile = (name, label, x, small) => `<div class="tile"><span class="eyebrow">${label}</span>${count(name, x)}<small>${small}</small></div>`;
  return `<div class="tiles">
${tile('requests', 'Requests', n('REQUEST_RECEIVED'), 'items filed')}
${tile('answers', 'Stand-in answers', n('STAND_IN_ANSWERED'), 'with choice and reason')}
${tile('decisions', 'Your decisions', n('PERSON_DECIDED'), 'taps on decision cards')}
${tile('grants', 'Grants', n('PERSON_GRANTED'), 'what the stand-in may decide')}
${tile('outOfBand', 'Out of band', oob.length, 'work done outside the gates')}
${tile('placeholders', 'Placeholders', of.reduce((x, r) => x + legacies(r), 0), 'values no source recorded, never shown')}
</div>
<div class="log" data-log="" data-at="1">
<section><h2>By day</h2><p class="m">Each UTC day with how many of the rows below fall on it, decisions and out-of-band steps. Choose a day to show only its rows.</p>
<div class="stepper"><span data-showing>Showing all days</span>${button('data-day=""', 'All days', true)}${button('data-month="prev"', 'Earlier month')}${button('data-month="next"', 'Later month')}</div>
${Object.keys(perDay).length ? `<div class="tablewrap">${calendar(perDay)}</div>` : '<div class="empty">No row of this history has a time.</div>'}</section>
<section><h2>Out of band</h2>${oob.length ? oob.map(card).join('') : '<div class="empty">No out-of-band step in this history.</div>'}</section>
<section><h2>Decisions, newest first</h2>${rest.length ? `<div class="stepper">${button('data-page="first"', 'First')}${button('data-page="prev"', 'Previous')}<span class="m" data-pos>${first.pos}</span>${button('data-page="next"', 'Next')}${button('data-page="last"', 'Last')}</div><div class="tablewrap"><table><thead><tr><th>At (UTC)</th><th>Kind</th><th>Where</th><th>What</th><th>Who</th></tr></thead><tbody>${rest.map(tr).join('')}</tbody></table></div>` : '<div class="empty">No decision in this history.</div>'}</section>
</div>`;
}

/**
 * The design log's controls, a click inside its data-log section: a data-month button shows the earlier or later month
 * with rows; a data-day button shows only that day's rows and out-of-band cards (empty: all days) from page 1; a
 * data-page button shows the first, previous, next or last page of the rows shown, with its position.
 */
export function turn(e) {
  const b = e.target && e.target.closest ? e.target.closest('[data-page], [data-day], [data-month]') : null;
  const g = b && b.closest('[data-log]');
  if (!g) return;
  const d = b.dataset;
  const months = [...g.querySelectorAll('[data-cal]')];
  const now = Math.max(0, months.findIndex((m) => !m.hidden));
  if ('month' in d) {
    const to = Math.max(0, Math.min(months.length - 1, now + (d.month === 'next' ? 1 : -1)));
    months.forEach((m, i) => { m.hidden = i !== to; });
    return;
  }
  const day = 'day' in d ? d.day : g.dataset.log || '';
  const at = Number(g.dataset.at) || 1;
  const rows = [...g.querySelectorAll('tr[data-on]')];
  const mine = rows.filter((r) => !day || r.dataset.on === day);
  const w = logPage(mine.length, 'day' in d ? 1 : { first: 1, prev: at - 1, next: at + 1, last: Infinity }[d.page] ?? at);
  rows.forEach((r) => { r.hidden = true; });
  mine.slice(w.from, w.to).forEach((r) => { r.hidden = false; });
  for (const c of g.querySelectorAll('[data-oob]')) c.hidden = Boolean(day) && c.dataset.on !== day;
  for (const x of g.querySelectorAll('[data-day]')) x.setAttribute('aria-pressed', String(x.dataset.day === day));
  const pos = g.querySelector('[data-pos]');
  if (pos) pos.textContent = w.pos;
  g.querySelector('[data-showing]').textContent = day ? `Showing ${day} (UTC)` : 'Showing all days';
  g.dataset.log = day;
  g.dataset.at = String(w.page);
}

/** The data age line: when the page last read its file and when the data last changed. */
export function ageText(meta, now) {
  const of = meta.of ?? 'store';
  if (!meta.readAt) return `Not read from the ${of} yet.`;
  const read = Date.parse(now) - Date.parse(meta.readAt);
  const size = meta.version == null ? '' : of === 'history' ? `: ${meta.version} rows` : `: store v${meta.version}`;
  return `Read from the ${of} ${minutes(read)} ago (${clock(meta.readAt)} UTC)${size}${meta.updatedAt ? `, last changed ${clock(meta.updatedAt)} UTC` : ''}.`;
}

/** The page shell: header with the data age and the refresh button, the data (or the banner), and the refresh trend. */
export function renderShell(view, problem, cfg, meta, beside = {}) {
  return `<div class="wrap">
<header><span class="eyebrow">Harness · ${esc(cfg.page)} · live</span><h1>${esc(cfg.title)}</h1>
<div class="age"><span id="data-age" class="m">${esc(ageText(meta, meta.readAt))}</span>
<button id="refresh" type="button">Refresh</button><span id="refresh-msg" class="m" role="status"></span></div></header>
<div id="view">${problem ? banner(problem, formatOf(cfg.needs).of) : renderData(view, cfg.needs, beside)}</div>
<section id="refreshes"><h2>Refreshes</h2><div id="trend" class="m">Each refresh is timed and recorded here when the page is open on claude.ai.</div></section>
</div>`;
}

/**
 * The page's own script: nothing runs until the viewer presses Refresh, which reads the page's file through the
 * Artifact files capability, renders it, and records how long that took in the db collection. Opening the page
 * reads only the recorded timings.
 */
export function client(cfg, meta) {
  const $ = (id) => document.getElementById(id);
  const f = formatOf(cfg.needs);
  const use = (name) => (window.claude && window.claude.use ? window.claude.use(name) : Promise.resolve(null));
  const showAge = () => { $('data-age').textContent = ageText(meta, new Date().toISOString()); };
  showAge();
  document.addEventListener('visibilitychange', showAge);
  $('view').addEventListener('click', step);
  $('view').addEventListener('focusin', step);
  $('view').addEventListener('click', turn);
  $('view').addEventListener('click', look);
  // An item's Time and tokens section reads the usage file (reads.onDemand) when the viewer opens it, through the
  // files capability; outside claude.ai, from beside the page. A failed read says so there and touches nothing else.
  $('view').addEventListener('toggle', async (e) => {
    const d = e.target;
    if (!d || !d.matches || !d.matches('details[data-usage]') || !d.open || d.dataset.read) return;
    const [name, path] = Object.entries(cfg.onDemand || {})[0] || [];
    const body = d.querySelector('[data-usage-body]');
    body.textContent = `Reading ${name}…`;
    try {
      const files = await use('files').catch(() => null);
      const text = files ? new TextDecoder().decode((await files.read(path)).bytes)
        : await fetch(name).then((r) => { if (!r.ok) throw new Error(`${r.status} ${r.statusText}`.trim()); return r.text(); });
      body.innerHTML = usageSection(text, d.dataset.usage, cfg.needs, name);
      d.dataset.read = '1';
    } catch (err) {
      body.innerHTML = `<div class="empty" data-usage-error>${esc(name)} cannot be read (${esc((err && (err.message || err.code)) || err)}), so time and tokens are not shown. The rest of the page is as it was; close and open this section to try again.</div>`;
    }
  }, true);
  const trend = async () => {
    const db = await use('db').catch(() => null);
    if (!db) return;
    try {
      const snap = await db.collection(cfg.collection).orderBy('at', 'desc').limit(20).get();
      const rows = snap.docs.map((d) => d.data() || {}).filter((r) => r.page === cfg.page);
      if (!rows.length) { $('trend').textContent = 'No refresh recorded yet.'; return; }
      const max = Math.max(...rows.map((r) => r.ms || 0), cfg.slowMs);
      const size = (r) => `${f.of === 'history' ? `${esc(r.storeVersion)} rows` : `v${esc(r.storeVersion)}`}${r.bytes != null ? ` · ${esc(Math.round(r.bytes / 1024))} kB` : ''}`;
      $('trend').innerHTML = `<div class="tablewrap"><table><thead><tr><th>At (UTC)</th><th>ms</th><th></th><th>Data</th></tr></thead><tbody>${rows
        .map((r) => `<tr><td>${esc(clock(r.at))}</td><td>${esc(r.ms)}${r.ms > cfg.slowMs ? ' <b class="slow">slow</b>' : ''}${r.ok === false ? ' failed' : ''}</td><td><span class="bar" style="width:${Math.round(((r.ms || 0) / max) * 100)}%"></span></td><td>${size(r)}</td></tr>`)
        .join('')}</tbody></table></div><span>Slower than ${esc(cfg.slowMs)} ms is flagged by <code>harness doctor --refreshes</code>.</span>`;
    } catch (e) { $('trend').textContent = 'Recorded refreshes cannot be read: ' + ((e && e.message) || 'unknown error'); }
  };
  trend();
  $('refresh').addEventListener('click', async () => {
    const btn = $('refresh');
    const msg = $('refresh-msg');
    btn.disabled = true;
    msg.textContent = `Reading the ${f.of}…`;
    const t0 = performance.now();
    let row = { page: cfg.page, at: new Date().toISOString(), ok: false };
    try {
      const files = await use('files');
      if (!files) throw { code: 'unavailable', message: 'this view cannot read project files (open it on claude.ai as a project member)' };
      const r = await files.read(cfg.path);
      const data = f.parse(new TextDecoder().decode(r.bytes));
      // The files it reads beside its own (reads.with), each a JSONL file as the history is.
      const also = {};
      let bytes = r.size;
      for (const [name, path] of Object.entries(cfg.also || {})) {
        const x = await files.read(path);
        also[name] = parseLog(new TextDecoder().decode(x.bytes));
        bytes += x.size;
      }
      const problem = schemaProblem(data, cfg.needs, cfg.absentMeans, also);
      const view = problem ? null : f.project(data, cfg.needs, also);
      $('view').innerHTML = problem ? banner(problem, f.of) : renderData(view, cfg.needs, projectBeside(also, cfg.needs));
      const ms = Math.round(performance.now() - t0);
      meta = { readAt: new Date().toISOString(), of: f.of, ...(view ? f.age(view) : { version: null, updatedAt: null }) };
      showAge();
      row = { ...row, ms, ...f.stamp(data, cfg.needs, cfg.absentMeans), bytes, ok: !problem };
      msg.textContent = problem ? `Read in ${ms} ms, but this page cannot show this ${f.of} (see the banner).` : `Refreshed in ${ms} ms.`;
    } catch (e) {
      row = { ...row, ms: Math.round(performance.now() - t0), error: String((e && e.code) || (e && e.message) || e) };
      msg.textContent = `Not refreshed: ${(e && e.message) || (e && e.code) || e}. The data below is from ${meta.readAt ? clock(meta.readAt) + ' UTC' : 'the render'}.`;
    }
    btn.disabled = false;
    const db = await use('db').catch(() => null);
    if (!db) { msg.textContent += ' (timing not recorded: no db here)'; return; }
    try { await db.collection(cfg.collection).add(row); } catch (e) { msg.textContent += ' (timing not recorded: ' + ((e && e.code) || 'error') + ')'; }
    trend();
  });
}
