// Renders a ledger as one self-contained HTML page: the overview first, then every session and every
// turn, each turn opening into its API requests, tools and subagents. No scripts are needed to read it.
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (n) => (n == null ? '—' : `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`);
const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const dur = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const time = (iso) => (iso ? iso.slice(11, 16) : '');
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const resets = (epoch) => (epoch ? new Date(epoch * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '');

const CSS = `
:root{--bg:#f4f6f7;--surface:#fff;--fg:#17222b;--muted:#5d6a75;--line:#d6dde2;--accent:#1f6f8b;--accent-soft:#e2eff4;--warn:#a8620b;--warn-soft:#fbefdc;--bad:#b23b3b;--bad-soft:#f8e3e3;--ok:#2e7d4f;--ok-soft:#e1f2e7;
--sans:"Instrument Sans","Segoe UI",system-ui,sans-serif;--mono:"JetBrains Mono",ui-monospace,Menlo,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f161c;--surface:#16212a;--fg:#e3eaef;--muted:#98a6b1;--line:#2a3843;--accent:#6bb8d4;--accent-soft:#17323e;--warn:#e6a556;--warn-soft:#3a2a14;--bad:#ec8a8a;--bad-soft:#3b1d1d;--ok:#74c895;--ok-soft:#173326;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0f161c;--surface:#16212a;--fg:#e3eaef;--muted:#98a6b1;--line:#2a3843;--accent:#6bb8d4;--accent-soft:#17323e;--warn:#e6a556;--warn-soft:#3a2a14;--bad:#ec8a8a;--bad-soft:#3b1d1d;--ok:#74c895;--ok-soft:#173326;color-scheme:dark}
*{box-sizing:border-box}body{background:var(--bg);color:var(--fg);font:14px/1.55 var(--sans);margin:0;padding-block:24px 56px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.wrap{max-width:1000px;margin:0 auto;display:grid;gap:28px}h1,h2{margin:0;line-height:1.2;text-wrap:balance}h1{font-size:1.7rem}h2{font-size:1.15rem}
.eyebrow{font:500 .7rem/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 14px;display:grid;gap:6px;min-width:0}
.tile b{font-size:1.35rem;font-variant-numeric:tabular-nums}.tile small{color:var(--muted)}
.bar{height:7px;border-radius:4px;background:var(--accent-soft);position:relative;overflow:hidden}.bar span{position:absolute;inset:0 auto 0 0;background:var(--accent)}.bar i{position:absolute;top:0;bottom:0;width:2px;background:var(--warn)}
.pill{display:inline-block;font:500 .7rem/1 var(--mono);padding:4px 7px;border-radius:999px;background:var(--ok-soft);color:var(--ok)}.pill.wrappingUp{background:var(--warn-soft);color:var(--warn)}.pill.paused,.pill.unknown{background:var(--bad-soft);color:var(--bad)}
.tablewrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:.86rem;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font:500 .68rem/1.2 var(--mono);letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}tr:last-child td{border-bottom:0}td.n,th.n{text-align:right}
details.turn{background:var(--surface);border:1px solid var(--line);border-radius:10px}details.turn>summary{cursor:pointer;list-style:none;display:grid;grid-template-columns:3.2em 3.4em minmax(0,1fr) 5em 5em 4.6em;gap:10px;padding:9px 12px;align-items:baseline;font-variant-numeric:tabular-nums}
details.turn>summary::-webkit-details-marker{display:none}details.turn[open]>summary{border-bottom:1px solid var(--line)}summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.m{font-family:var(--mono);font-size:.8rem;color:var(--muted)}.n{text-align:right}
.inner{padding:12px;display:grid;gap:12px}.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{font:500 .72rem/1 var(--mono);padding:5px 7px;border-radius:6px;background:var(--accent-soft);color:var(--accent)}
.turns{display:grid;gap:6px}.session{display:grid;gap:10px}.heat{background:var(--warn-soft)}
@media (max-width:640px){details.turn>summary{grid-template-columns:3em minmax(0,1fr) 4.6em}details.turn>summary .hide{display:none}}
`;

function budgetTiles(budget) {
  if (!budget || budget.mode === 'unknown')
    return `<div class="tile"><span class="eyebrow">Usage windows</span><b><span class="pill unknown">no samples</span></b><small>Add rate-limit samples with <code>ledger usage</code>.</small></div>`;
  const l = budget.latest;
  const slice = Math.min(1, budget.shareOfSlice);
  return `
  <div class="tile"><span class="eyebrow">Budget today</span><b><span class="pill ${esc(budget.mode)}">${esc(budget.mode)}</span></b><small>${esc(budget.reason)}</small></div>
  <div class="tile"><span class="eyebrow">Today's slice</span><b>${pct(budget.shareOfSlice)}</b><div class="bar"><span style="width:${slice * 100}%"></span><i style="left:${budget.config.softAt * 100}%"></i></div><small>${pct(budget.spentToday)} of the 7-day window spent; slice is ${pct(budget.config.dailyShare)}</small></div>
  <div class="tile"><span class="eyebrow">5-hour window</span><b>${pct(l.fiveHour)}</b><div class="bar"><span style="width:${(l.fiveHour ?? 0) * 100}%"></span><i style="left:${budget.config.fiveHourStopAt * 100}%"></i></div><small>resets ${esc(resets(l.fiveHourResetsAt))}</small></div>
  <div class="tile"><span class="eyebrow">7-day window</span><b>${pct(l.sevenDay)}</b><div class="bar"><span style="width:${(l.sevenDay ?? 0) * 100}%"></span></div><small>resets ${esc(resets(l.sevenDayResetsAt))}</small></div>`;
}

const anchor = (s, t) => `turn-${s.sessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}-${t.index}`;

function turnBlock(s, t, maxCost) {
  const tools = Object.entries(t.tools).sort((a, b) => b[1] - a[1]);
  const hot = maxCost > 0 && t.all.cost >= maxCost * 0.5 ? ' heat' : '';
  const requests = t.requests
    .map(
      (r) => `<tr><td class="m">${esc(time(r.at))}</td><td class="m">${esc(r.model)}</td><td class="n">${tok(r.input)}</td><td class="n">${tok(r.cacheRead)}</td><td class="n">${tok(r.cacheWrite5m + r.cacheWrite1h)}</td><td class="n">${tok(r.output)}</td><td class="n">${usd(r.cost)}</td></tr>`
    )
    .join('');
  const subs = t.subagents
    .map(
      (a) => `<tr><td>${esc(a.description || a.agentId)}</td><td class="m">${esc(a.models.join(', '))}</td><td class="n">${a.requests}</td><td class="n">${a.tools}</td><td class="n">${dur(a.durationMs)}</td><td class="n">${tok(a.output)}</td><td class="n">${usd(a.cost)}</td></tr>`
    )
    .join('');
  return `<details class="turn" id="${anchor(s, t)}">
  <summary class="${hot}"><span class="m">#${t.index}</span><span class="m hide">${esc(time(t.start))}</span><span class="label" title="${esc(t.label)}">${esc(t.label)}</span><span class="n hide">${dur(t.durationMs)}</span><span class="n hide">${tok(t.all.output)} out</span><span class="n">${usd(t.all.cost)}</span></summary>
  <div class="inner">
    <div class="m">${esc(t.origin)} · ${esc(t.start)} → ${esc(time(t.end))} · ${t.own.requests} requests${t.subagents.length ? ` + ${t.subagents.length} subagents` : ''}${t.own.unpriced ? ` · ${t.own.unpriced} unpriced` : ''}</div>
    ${tools.length ? `<div class="chips">${tools.map(([n, c]) => `<span class="chip">${esc(n)} × ${c}</span>`).join('')}</div>` : ''}
    ${subs ? `<div class="tablewrap"><table><thead><tr><th>Subagent</th><th>Model</th><th class="n">Requests</th><th class="n">Tools</th><th class="n">Time</th><th class="n">Output</th><th class="n">Cost</th></tr></thead><tbody>${subs}</tbody></table></div>` : ''}
    ${requests ? `<details><summary class="m">${t.own.requests} API requests</summary><div class="tablewrap"><table><thead><tr><th>At</th><th>Model</th><th class="n">Input</th><th class="n">Cache read</th><th class="n">Cache write</th><th class="n">Output</th><th class="n">Cost</th></tr></thead><tbody>${requests}</tbody></table></div></details>` : ''}
  </div>
</details>`;
}

/**
 * @param {object} ledger from buildLedger()
 * @param {{title?: string, budget?: object, standalone?: boolean}} opts standalone wraps a full HTML
 *   document; without it the output is a page body for hosts that add their own (Artifacts).
 */
export function renderReport(ledger, opts = {}) {
  const title = opts.title ?? 'Session ledger';
  const sessions = ledger.sessions;
  const all = sessions.flatMap((s) => s.turns.map((t) => ({ ...t, session: s })));
  const cost = sessions.reduce((a, s) => a + s.totals.cost, 0);
  const out = sessions.reduce((a, s) => a + s.totals.output, 0);
  const read = sessions.reduce((a, s) => a + s.totals.cacheRead, 0);
  const subCount = all.reduce((a, t) => a + t.subagents.length, 0);
  const top = [...all].sort((a, b) => b.all.cost - a.all.cost).slice(0, 5);
  const maxCost = top[0]?.all.cost ?? 0;
  const body = `<title>${esc(title)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>${CSS}</style>
<div class="wrap">
  <header style="display:grid;gap:10px">
    <span class="eyebrow">Generated ${esc(ledger.generatedAt.replace('T', ' ').slice(0, 16))} UTC by @ccp/ledger</span>
    <h1>${esc(title)}</h1>
    <div class="tiles">
      <div class="tile"><span class="eyebrow">Cost (list price)</span><b>${usd(cost)}</b><small>${sessions.length} sessions · ${all.length} turns · ${subCount} subagents</small></div>
      <div class="tile"><span class="eyebrow">Output tokens</span><b>${tok(out)}</b><small>${tok(read)} read from cache</small></div>
      ${budgetTiles(opts.budget)}
    </div>
  </header>
  <section style="display:grid;gap:10px">
    <h2>Where the cost went</h2>
    <div class="tablewrap"><table><thead><tr><th>Turn</th><th>Started by</th><th class="n">Time</th><th class="n">Share</th><th class="n">Cost</th></tr></thead><tbody>
    ${top.map((t) => `<tr><td class="m"><a href="#${anchor(t.session, t)}">${esc(t.session.sessionId.slice(0, 8))} #${t.index}</a></td><td>${esc(t.label)}</td><td class="n">${dur(t.durationMs)}</td><td class="n">${cost ? pct(t.all.cost / cost) : '—'}</td><td class="n">${usd(t.all.cost)}</td></tr>`).join('')}
    </tbody></table></div>
  </section>
  ${sessions
    .map(
      (s) => `<section class="session">
    <div style="display:grid;gap:4px"><span class="eyebrow">Session</span><h2 class="m" style="font-size:1rem">${esc(s.sessionId)}</h2>
    <span class="m">${esc(s.start)} → ${esc(s.end)} · ${esc(s.models.join(', '))} · ${usd(s.totals.cost)} at list price${s.reportedCost != null ? ` · ${usd(s.reportedCost)} reported by the CLI` : ''}</span></div>
    <div class="turns">${s.turns.map((t) => turnBlock(s, t, maxCost)).join('\n')}</div>
  </section>`
    )
    .join('\n')}
</div>`;
  return opts.standalone
    ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>${body}</body></html>\n`
    : `${body}\n`;
}
