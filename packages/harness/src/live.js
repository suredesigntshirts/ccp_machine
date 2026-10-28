// Live mission control: a page that reads the store itself, but only when a viewer asks. Node imports this
// module to render the page and to check it against its needs file; `harness page --live` also inlines its
// source in the page (each `export ` dropped), so the refresh button runs the same code. It has no imports and
// touches no Node API. Everything it reads from the store goes through project(), which copies only the fields
// the page's needs file declares.

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

/** Why the page cannot show this store (not a store, or a schemaVersion outside the needs range), or null. */
export function schemaProblem(state, needs, absentMeans) {
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
    : `Your grant (card ${esc(g.card)}): ${g.kinds.length ? esc(g.kinds.join(', ')) : 'nothing'}, ${g.oneWay ? 'one-way doors included' : 'two-way doors only'}, until ${esc(clock(g.until).slice(5))} UTC.`;
  const card = (r) => `<div class="card"><span class="eyebrow">${esc(r.decisionClass)} · ${esc(r.door)} door · ${esc(clock(r.at))} UTC</span><b>${esc(r.item)}: ${esc(r.choice)}</b> <span class="m">${pct(r.confidence)} sure</span>
<div>${esc(r.reason)}</div>
<div class="m">To reverse it${r.door === 'one-way' ? ' (a merge also needs a revert)' : ''}: ask the lead to revise it, or cancel: <code>harness send '{"type":"${esc(ev.cancel)}"}' --to item:${esc(r.item)}</code></div></div>`;
  return `<section><h2>Decided under your grant</h2><p class="m">${line}</p>${rows.length ? [...rows].reverse().map(card).join('') : '<div class="empty">Nothing decided under a grant yet.</div>'}</section>`;
}

export const banner = (problem) => `<div class="banner bad" role="alert"><b>Wrong store layout.</b> ${problem}</div>`;

/** The data age line: when the page last read the store and when the store last changed. */
export function ageText(meta, now) {
  if (!meta.readAt) return 'Not read from the store yet.';
  const read = Date.parse(now) - Date.parse(meta.readAt);
  return `Read from the store ${minutes(read)} ago (${clock(meta.readAt)} UTC)${meta.version != null ? `: store v${meta.version}` : ''}${meta.updatedAt ? `, last changed ${clock(meta.updatedAt)} UTC` : ''}.`;
}

/** The page shell: header with the data age and the refresh button, the data (or the banner), and the refresh trend. */
export function renderShell(view, problem, cfg, meta) {
  return `<div class="wrap">
<header><span class="eyebrow">Harness · ${esc(cfg.page)} · live</span><h1>${esc(cfg.title)}</h1>
<div class="age"><span id="data-age" class="m">${esc(ageText(meta, meta.readAt))}</span>
<button id="refresh" type="button">Refresh</button><span id="refresh-msg" class="m" role="status"></span></div></header>
<div id="view">${problem ? banner(problem) : renderView(view, cfg.needs)}</div>
<section id="refreshes"><h2>Refreshes</h2><div id="trend" class="m">Each refresh is timed and recorded here when the page is open on claude.ai.</div></section>
</div>`;
}

/**
 * The page's own script: nothing runs until the viewer presses Refresh, which reads the store file through the
 * Artifact files capability, renders it, and records how long that took in the db collection. Opening the page
 * reads only the recorded timings.
 */
export function client(cfg, meta) {
  const $ = (id) => document.getElementById(id);
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
      $('trend').innerHTML = `<div class="tablewrap"><table><thead><tr><th>At (UTC)</th><th>ms</th><th></th><th>Store</th></tr></thead><tbody>${rows
        .map((r) => `<tr><td>${esc(clock(r.at))}</td><td>${esc(r.ms)}${r.ms > cfg.slowMs ? ' <b class="slow">slow</b>' : ''}${r.ok === false ? ' failed' : ''}</td><td><span class="bar" style="width:${Math.round(((r.ms || 0) / max) * 100)}%"></span></td><td>v${esc(r.storeVersion)}</td></tr>`)
        .join('')}</tbody></table></div><span>Slower than ${esc(cfg.slowMs)} ms is flagged by <code>harness doctor --refreshes</code>.</span>`;
    } catch (e) { $('trend').textContent = 'Recorded refreshes cannot be read: ' + ((e && e.message) || 'unknown error'); }
  };
  trend();
  $('refresh').addEventListener('click', async () => {
    const btn = $('refresh');
    const msg = $('refresh-msg');
    btn.disabled = true;
    msg.textContent = 'Reading the store…';
    const t0 = performance.now();
    let row = { page: cfg.page, at: new Date().toISOString(), ok: false };
    try {
      const files = await use('files');
      if (!files) throw { code: 'unavailable', message: 'this view cannot read project files (open it on claude.ai as a project member)' };
      const r = await files.read(cfg.path);
      const state = JSON.parse(new TextDecoder().decode(r.bytes));
      const problem = schemaProblem(state, cfg.needs, cfg.absentMeans);
      $('view').innerHTML = problem ? banner(problem) : renderView(project(state, cfg.needs), cfg.needs);
      const ms = Math.round(performance.now() - t0);
      meta = { readAt: new Date().toISOString(), version: state.version, updatedAt: state.updatedAt };
      showAge();
      row = { ...row, ms, storeVersion: state.version ?? null, schemaVersion: state.schemaVersion ?? cfg.absentMeans, bytes: r.size, ok: !problem };
      msg.textContent = problem ? `Read in ${ms} ms, but this page cannot show this store (see the banner).` : `Refreshed in ${ms} ms.`;
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
