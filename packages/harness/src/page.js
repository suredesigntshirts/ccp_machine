// Mission control: one page that answers, at a glance, what needs the person, what is in flight and
// where each item stands, and what the harness has asked the host to do. Rebuilt from the store on
// every change; no scripts are needed to read it.
import { lastMoved } from './stalled.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const time = (iso) => (iso ? iso.slice(5, 16).replace('T', ' ') : '');
const ago = (now, then) => {
  const m = Math.max(0, Math.round((Date.parse(now) - Date.parse(then)) / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
export const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

// The work item's path, in order; gate and awaiting states fold into the stage they guard.
const STAGES = [
  ['queued', ['queued']],
  ['triage', ['triaging']],
  ['plan', ['planGate', 'awaitingPlanDecision']],
  ['build', ['building']],
  ['verify', ['verifying']],
  ['accept', ['acceptGate', 'awaitingAcceptance']],
  ['merge', ['integrationGate', 'awaitingMergeDecision', 'merging']],
  ['done', ['done']]
];
export const leaf = (state) => state.split('.').pop();
const stageOf = (state) => STAGES.findIndex(([, leaves]) => leaves.includes(leaf(state)));

export const CSS = `
:root{--bg:#f4f6f7;--surface:#fff;--fg:#17222b;--muted:#5d6a75;--line:#d6dde2;--accent:#1f6f8b;--accent-soft:#e2eff4;--warn:#a8620b;--warn-soft:#fbefdc;--bad:#b23b3b;--bad-soft:#f8e3e3;--ok:#2e7d4f;--ok-soft:#e1f2e7;
--sans:"Instrument Sans","Segoe UI",system-ui,sans-serif;--mono:"JetBrains Mono",ui-monospace,Menlo,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f161c;--surface:#16212a;--fg:#e3eaef;--muted:#98a6b1;--line:#2a3843;--accent:#6bb8d4;--accent-soft:#17323e;--warn:#e6a556;--warn-soft:#3a2a14;--bad:#ec8a8a;--bad-soft:#3b1d1d;--ok:#74c895;--ok-soft:#173326;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0f161c;--surface:#16212a;--fg:#e3eaef;--muted:#98a6b1;--line:#2a3843;--accent:#6bb8d4;--accent-soft:#17323e;--warn:#e6a556;--warn-soft:#3a2a14;--bad:#ec8a8a;--bad-soft:#3b1d1d;--ok:#74c895;--ok-soft:#173326;color-scheme:dark}
*{box-sizing:border-box}body{background:var(--bg);color:var(--fg);font:14px/1.55 var(--sans);margin:0;padding-block:24px 56px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.wrap{max-width:1000px;margin:0 auto;display:grid;gap:28px}.wrap>*,.card>*{min-width:0}h1,h2{margin:0;line-height:1.2;text-wrap:balance}h1{font-size:1.7rem}h2{font-size:1.15rem}section{display:grid;gap:10px}
.eyebrow{font:500 .7rem/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}.m{font-family:var(--mono);font-size:.8rem;color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 14px;display:grid;gap:6px;min-width:0}.tile b{font-size:1.35rem;font-variant-numeric:tabular-nums}.tile small{color:var(--muted)}
.tile.ask{border-color:var(--warn);background:var(--warn-soft)}
.pill{display:inline-block;font:500 .7rem/1 var(--mono);padding:4px 7px;border-radius:999px;background:var(--ok-soft);color:var(--ok)}.pill.wrappingUp,.pill.draining{background:var(--warn-soft);color:var(--warn)}.pill.paused,.pill.halted,.pill.failed,.pill.blocked{background:var(--bad-soft);color:var(--bad)}
.card{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--warn);border-radius:10px;padding:12px 14px;display:grid;gap:6px}
.empty{color:var(--muted);background:var(--surface);border:1px dashed var(--line);border-radius:10px;padding:12px 14px}
.tablewrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:.86rem;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font:500 .68rem/1.2 var(--mono);letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}tr:last-child td{border-bottom:0}
.rb{border-left-color:var(--accent)}.rb label{display:grid;gap:4px;font-size:.85rem;color:var(--muted)}.rb input,.rb textarea,.rb select{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;width:100%;min-width:0}.rb button{font:inherit;font-weight:600;color:#fff;background:var(--accent);border:0;border-radius:8px;padding:8px 16px;cursor:pointer}.rb button:disabled{opacity:.6}
.track{display:flex;gap:3px;min-width:220px}.track span{flex:1;height:8px;border-radius:3px;background:var(--line)}.track span.past{background:var(--accent)}.track span.now{background:var(--warn)}.track.ok span{background:var(--ok)}
a{color:var(--accent);overflow-wrap:anywhere}code{font-family:var(--mono);font-size:.8rem;overflow-wrap:anywhere}
`;

export function track(item) {
  if (item.state === 'done') return `<div class="track ok" title="done">${STAGES.map(() => '<span></span>').join('')}</div>`;
  const at = stageOf(item.state);
  return `<div class="track" title="${esc(item.state)}">${STAGES.map((_, i) => `<span class="${i < at ? 'past' : i === at ? 'now' : ''}"></span>`).join('')}</div>`;
}

function decisionCard(item, d) {
  const s = d.standIn;
  const lean = s?.choice ? `Stand-in leans <b>${esc(s.choice)}</b>${s.confidence != null ? ` (${pct(s.confidence)} sure)` : ''}${s.reason ? `: ${esc(s.reason)}` : ''}.` : 'No stand-in answer yet.';
  return `<div class="card"><span class="eyebrow">${esc(d.decisionClass)} gate · tier ${esc(d.tier)}</span>
  <b>${esc(item.title ?? d.question)}</b>${item.url ? ` <a href="${esc(item.url)}">${esc(item.url)}</a>` : ''}
  <div>${lean}</div>
  <div class="m">Answer: <code>harness send '{"type":"PERSON_DECIDED","choice":"approve"}' --to ${esc(d.address)}</code></div></div>`;
}

/**
 * @param {object} st from status()
 * @param {{events?: object[], pending?: object[], title?: string, standalone?: boolean, itemLinks?: boolean}} opts
 *   itemLinks: link each item to items/<id>.html (written next to the page by `harness page`)
 *   metrics: {id: text} per item (attentionText); finished items show it as an Attention column
 *   requestBox: add the "Ask for work" form, which saves to the Artifact db (publish with capabilities {db: {}})
 */
export function renderPage(st, { events = [], pending = [], title = 'Mission control', standalone = false, itemLinks = false, metrics = {}, requestBox = false } = {}) {
  const live = st.items.filter((i) => !i.done);
  const finished = st.items.filter((i) => i.done);
  const asks = live.flatMap((i) => i.decisions.filter((d) => d.state === 'awaitingPerson').map((d) => decisionCard(i, d)));
  const scheduler = st.state.scheduler;
  const budget = st.budget;
  const links = (i) => {
    const pr = prOf(events, i.id);
    return [pr && `<a href="${esc(pr)}">PR</a>`, i.url && i.url !== pr && `<a href="${esc(i.url)}">issue</a>`].filter(Boolean).join(' · ');
  };
  const rows = (items, withAttention = false) =>
    items
      .map(
        (i) => `<tr><td><b>${itemLinks ? `<a href="${esc(itemHref(i.id))}">${esc(i.id)}</a>` : esc(i.id)}</b>${i.title ? `<br><span class="m">${esc(i.title)}</span>` : ''}</td><td class="m">${esc(i.project ?? '')}</td><td class="m">${esc(i.tier)}</td><td>${track(i)}<span class="m">${esc(leaf(i.state))}</span></td><td class="m">${esc(i.runs ?? 0)}${i.retries ? ` (${i.retries} retry)` : ''}${!i.done && lastMoved(events, i.id) ? `<br>moved ${esc(ago(st.updatedAt, lastMoved(events, i.id)))} ago` : ''}</td>${withAttention ? `<td class="m">${esc(metrics[i.id] ?? "")}</td>` : ''}<td class="m">${links(i)}</td></tr>`
      )
      .join('');
  const head = '<thead><tr><th>Item</th><th>Project</th><th>Tier</th><th>Stage</th><th>Runs</th><th></th></tr></thead>';
  const finishedHead = '<thead><tr><th>Item</th><th>Project</th><th>Tier</th><th>Stage</th><th>Runs</th><th>Attention</th><th></th></tr></thead>';

  const body = `<div class="wrap">
<header><span class="eyebrow">Harness · v${esc(st.version)} · updated ${esc(time(st.updatedAt))} UTC</span><h1>${esc(title)}</h1>${itemLinks ? '<a class="m" href="decisions.html">Decision log</a>' : ''}</header>
<div class="tiles">
  <div class="tile${asks.length ? ' ask' : ''}"><span class="eyebrow">Needs you</span><b>${asks.length}</b><small>${asks.length ? 'decisions waiting below' : 'nothing to decide'}</small></div>
  <div class="tile"><span class="eyebrow">In flight</span><b>${st.context.inFlight.length} / ${st.context.wipLimit}</b><small>${st.context.queued.length} queued</small></div>
  <div class="tile"><span class="eyebrow">Finished</span><b>${finished.length}</b><small>${finished.filter((i) => i.state === 'done').length} merged</small></div>
  <div class="tile"><span class="eyebrow">Scheduler</span><b><span class="pill ${esc(scheduler)}">${esc(scheduler)}</span></b><small>budget ${esc(budget?.mode ?? 'unknown')}${budget?.sevenDay != null ? ` · 7-day ${pct(budget.sevenDay)}` : ''} · ${budget?.sampledAt ? `reading ${esc(ago(st.updatedAt, budget.sampledAt))} old` : 'no reading yet'}</small></div>
  <div class="tile"><span class="eyebrow">Host to-do</span><b>${pending.length}</b><small>effects not yet acknowledged</small></div>
</div>
${requestBox ? REQUEST_BOX : ''}
<section><h2>Needs you${itemLinks ? ' <a class="m" href="decisions.html">decision log</a>' : ''}</h2>${asks.join('') || '<div class="empty">Nothing is waiting on you.</div>'}</section>
<section><h2>In flight</h2>${live.length ? `<div class="tablewrap"><table>${head}<tbody>${rows(live)}</tbody></table></div>` : '<div class="empty">Nothing in flight.</div>'}</section>
${finished.length ? `<section><h2>Finished</h2><div class="tablewrap"><table>${finishedHead}<tbody>${rows(finished, true)}</tbody></table></div></section>` : ''}
<section><h2>Host to-do</h2>${
    pending.length
      ? `<div class="tablewrap"><table><thead><tr><th>Effect</th><th>For</th><th>Params</th><th>Queued</th></tr></thead><tbody>${pending
          .map((e) => `<tr><td><b>${esc(e.name)}</b><br><span class="m">${esc(e.id)}</span></td><td class="m">${esc(e.subject ?? e.actor)}</td><td class="m">${esc(e.params ? JSON.stringify(e.params) : '')}</td><td class="m">${esc(time(e.at))}</td></tr>`)
          .join('')}</tbody></table></div>`
      : '<div class="empty">The host has done everything asked of it.</div>'
  }</section>
<section><h2>Recent events</h2>${
    events.length
      ? `<div class="tablewrap"><table><thead><tr><th>At</th><th>Event</th><th>To</th><th>v</th></tr></thead><tbody>${events
          .slice(-20)
          .reverse()
          .map((e) => `<tr><td class="m">${esc(time(e.at))}</td><td><b>${esc(e.event.type)}</b>${e.event.choice ? ` ${esc(e.event.choice)}` : ''}${e.event.request?.id ? ` ${esc(e.event.request.id)}` : ''}</td><td class="m">${esc(e.to)}</td><td class="m">${esc(e.version)}</td></tr>`)
          .join('')}</tbody></table></div>`
      : '<div class="empty">No events yet.</div>'
  }</section>
</div>`;
  return wrapPage(title, body, { standalone });
}

// The form saves to the `requests` collection; `harness intake` files new rows and the host marks them
// taken. Without the db capability (a local file, a signed-out viewer) the form stays hidden.
const REQUEST_BOX = `<section id="rb"><h2>Ask for work</h2>
<p class="empty" id="rb-off">To ask for work here, open this page on claude.ai while signed in. Or ask in the project chat.</p>
<form class="card rb" id="rb-form" hidden>
<label>What to do<input name="title" required maxlength="200" placeholder="Fix the Safari export button"></label>
<label>Project<input name="project" maxlength="100" placeholder="packages/harness"></label>
<label>What done looks like<textarea name="done" rows="2" maxlength="1000" placeholder="Export works in Safari 18, with a test"></textarea></label>
<label>Tier<select name="tier"><option value="0">0: just do it</option><option value="1" selected>1: the stand-in checks the plan</option><option value="2">2: ask me at the plan and the merge</option></select></label>
<div><button type="submit">Send</button> <span class="m" id="rb-msg" role="status"></span></div>
</form>
<div class="tablewrap" id="rb-list" hidden><table><thead><tr><th>Asked</th><th>Tier</th><th>Status</th></tr></thead><tbody></tbody></table></div>
</section>
<script>(async () => {
  const db = await window.claude?.use?.('db');
  if (!db) return;
  const $ = (id) => document.getElementById(id);
  const form = $('rb-form'), msg = $('rb-msg'), list = $('rb-list');
  $('rb-off').hidden = true; form.hidden = false;
  const col = db.collection('requests');
  const cell = (text, href) => { const td = document.createElement('td'); if (href) { const a = document.createElement('a'); a.href = href; a.textContent = text; td.append(a); } else td.textContent = text; return td; };
  col.orderBy('at', 'desc').limit(10).onSnapshot((snap) => {
    const body = list.querySelector('tbody'); body.replaceChildren();
    for (const d of snap.docs) { const r = d.data() || {}; const tr = document.createElement('tr');
      tr.append(cell(String(r.title || '')), cell(String(r.tier ?? '')), cell(r.status === 'taken' ? 'filed as ' + r.item : 'waiting for the next tick', r.status === 'taken' && /^items\\/[\\w%.-]+\\.html$/.test(r.href || '') ? r.href : null));
      body.append(tr); }
    list.hidden = snap.empty;
  }, () => { list.hidden = true; });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault(); const f = new FormData(form); const btn = form.querySelector('button'); btn.disabled = true; msg.textContent = 'Sending…';
    try {
      await col.add({ title: String(f.get('title')).trim(), project: String(f.get('project')).trim(), done: String(f.get('done')).trim(), tier: Number(f.get('tier')), status: 'new', at: new Date().toISOString() });
      form.reset(); msg.textContent = 'Sent. The harness files it on its next tick.';
    } catch (e) { msg.textContent = e?.code === 'permission_denied' || e?.code === 'not_granted' ? 'You can view this page but not add to it.' : 'Not sent: ' + (e?.message || 'try again'); }
    btn.disabled = false;
  });
})();</script>`;

/** The item's PR: the newest event to it that carries `pr` (the build's RUN_SUCCEEDED, CI, MERGED). */
export function prOf(events, id) {
  for (let k = events.length - 1; k >= 0; k--) {
    const e = events[k];
    if (/^https?:\/\//.test(e.event?.pr ?? '') && e.to?.replace(/^item:/, '').split('/')[0] === id) return String(e.event.pr);
  }
  return null;
}

export const itemHref = (id) => `items/${encodeURIComponent(id)}.html`;

/** Wrap a page body. A standalone page carries its own doctype, as supporting HTML files must. */
export function wrapPage(title, body, { standalone = false, css = CSS } = {}) {
  const meta = `<title>${esc(title)}</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<style>${css}</style>`;
  return standalone
    ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${meta}</head><body>${body}</body></html>`
    : `${meta}\n${body}`;
}
