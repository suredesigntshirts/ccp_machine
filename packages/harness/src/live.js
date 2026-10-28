// Live pages: mission control (a store's state.json) and the ledger (the one history's events.jsonl), each a page
// that reads its file itself, but only when a viewer asks. Node imports this module to render a page and to check
// it against its needs file; `harness page --live` also inlines its source in the page (each `export ` dropped), so
// the refresh button runs the same code. It has no imports and touches no Node API. Everything a page reads goes
// through project() or projectLog(), which copy only the fields the page's needs file declares.

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

/** Why the page cannot show this data (not the file it reads, or a schemaVersion outside the needs range), or null. */
export const schemaProblem = (data, needs, absentMeans) => FORMATS[needs.reads.file].problem(data, needs, absentMeans);

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
    `<tr><td><b>${esc(i.id)}</b>${i.title ? `<br><span class="m">${esc(i.title)}</span>` : ''}</td><td class="m">${esc(i.project ?? '')}</td><td class="m">${esc(i.tier)}</td><td>${track(needs, i)}<span class="m">${esc(leaf(i.state))}</span></td><td class="m">${esc(i.runs ?? 0)}${i.retries ? ` (${esc(i.retries)} retry)` : ''}</td><td class="m">${i.url ? `<a href="${esc(i.url)}">link</a>` : ''}</td></tr>`;
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

function logProblem(rows, needs, absentMeans) {
  const { file } = needs.reads;
  const page = esc(needs.page);
  const none = 'Nothing from it is shown, so nothing here can be taken as complete.';
  if (!Array.isArray(rows) || !rows.length) return `This ${file} has no rows, so ${page} shows nothing from it.`;
  const bad = rows.findIndex((r) => !r || r.unreadable || !r.event || !r.provenance || !r.provenance.from);
  if (bad >= 0) return `Line ${bad + 1} of this ${file} is ${rows[bad] && rows[bad].unreadable ? 'not JSON' : 'not a history row (no event or provenance, spec/history.schema.json)'}. ${none}`;
  const { min, max } = needs.reads.schemaVersion;
  const off = rows.findIndex((r) => { const v = rowSchema(r, absentMeans); return !(typeof v === 'number' && v >= min && v <= max); });
  return off < 0 ? null : `This history's ${file} has schemaVersion ${esc(rowSchema(rows[off], absentMeans))} at line ${off + 1}; ${page} reads ${min} to ${max}. ${none}`;
}

/** The history as the page sees it: each row's type and only the fields `needs.events` declares for it ("*": every row). */
export function projectLog(rows, needs) {
  return rows.map((r) => {
    const out = { event: { type: r.event.type } };
    for (const p of logFields(needs, r.event.type)) {
      const v = at(r, p);
      if (v === undefined) continue;
      const keys = p.split('.');
      keys.slice(0, -1).reduce((o, k) => (o[k] ??= {}), out)[keys.at(-1)] = v;
    }
    return out;
  });
}

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
/** The page's data, rendered by its view (mission control or the ledger). */
export const renderData = (view, needs) => (needs.page === 'ledger' ? renderLedger(view, needs) : renderView(view, needs));

/**
 * The ledger: who did the work on each item, as which role and on which model (spawns, starts, runs), the usage
 * samples, and, in a corner, each source's rows and the placeholders among the fields the page reads, which are
 * counted and never shown as values. Every number carries data-count, so a test can hold it to the history's rows.
 */
export function renderLedger(rows, needs) {
  const of = (type) => rows.filter((r) => r.event.type === type);
  const text = (v) => (v == null || isLegacy(v) ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const tally = (list) => {
    const n = new Map();
    for (const v of list.filter((v) => v !== '')) n.set(v, (n.get(v) ?? 0) + 1);
    return [...n].map(([k, c]) => `${esc(k)}${c > 1 ? ` ×${c}` : ''}`).join(', ');
  };
  const legacies = (v) => (isLegacy(v) ? 1 : v && typeof v === 'object' ? Object.values(v).reduce((n, x) => n + legacies(x), 0) : 0);
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
    `<td><b data-count="runs">${i.runs.length}</b> ${i.runs.map((r) => `${pr(r.event.pr)} <span class="m">${esc(who(r.actor))}</span>`).join(', ')}</td></tr>`;
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

/** The data age line: when the page last read its file and when the data last changed. */
export function ageText(meta, now) {
  const of = meta.of ?? 'store';
  if (!meta.readAt) return `Not read from the ${of} yet.`;
  const read = Date.parse(now) - Date.parse(meta.readAt);
  const size = meta.version == null ? '' : of === 'history' ? `: ${meta.version} rows` : `: store v${meta.version}`;
  return `Read from the ${of} ${minutes(read)} ago (${clock(meta.readAt)} UTC)${size}${meta.updatedAt ? `, last changed ${clock(meta.updatedAt)} UTC` : ''}.`;
}

/** The page shell: header with the data age and the refresh button, the data (or the banner), and the refresh trend. */
export function renderShell(view, problem, cfg, meta) {
  return `<div class="wrap">
<header><span class="eyebrow">Harness · ${esc(cfg.page)} · live</span><h1>${esc(cfg.title)}</h1>
<div class="age"><span id="data-age" class="m">${esc(ageText(meta, meta.readAt))}</span>
<button id="refresh" type="button">Refresh</button><span id="refresh-msg" class="m" role="status"></span></div></header>
<div id="view">${problem ? banner(problem, formatOf(cfg.needs).of) : renderData(view, cfg.needs)}</div>
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
      const problem = schemaProblem(data, cfg.needs, cfg.absentMeans);
      const view = problem ? null : f.project(data, cfg.needs);
      $('view').innerHTML = problem ? banner(problem, f.of) : renderData(view, cfg.needs);
      const ms = Math.round(performance.now() - t0);
      meta = { readAt: new Date().toISOString(), of: f.of, ...(view ? f.age(view) : { version: null, updatedAt: null }) };
      showAge();
      row = { ...row, ms, ...f.stamp(data, cfg.needs, cfg.absentMeans), bytes: r.size, ok: !problem };
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
