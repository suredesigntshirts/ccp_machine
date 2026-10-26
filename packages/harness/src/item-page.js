// One page per work item that answers "did it do what I expected?": what was asked, how it ended,
// who decided each gate and why, what the host did, and the item's events in order. Built from the
// store alone, so it can be rebuilt for any item at any time.
import { esc, time, pct, leaf, track, CSS, wrapPage } from './page.js';

/** The store rows that belong to one item: its events, effects and the acks of those effects. */
export function itemRecords(id, { events = [], outbox = [], acks = [] }) {
  const mine = (to) => to === `item:${id}` || to?.startsWith(`item:${id}/`);
  const itemEvents = events.filter((e) => mine(e.to) || (e.event.type === 'REQUEST_RECEIVED' && e.event.request?.id === id));
  const effects = outbox.filter((e) => e.subject === id || e.actor === id || e.subject?.startsWith(`decision:${id}:`));
  const ackOf = new Map(acks.map((a) => [a.effectId, a]));
  return { events: itemEvents, effects: effects.map((e) => ({ ...e, ack: ackOf.get(e.id) ?? null })) };
}

// The host may attach a PR link to any event it sends for the item (`pr` or `url`); the latest wins.
const prOf = (item, events) => [...events].reverse().map((e) => e.event.pr ?? e.event.url).find(Boolean) ?? item.url;

// A finished decision leaves the snapshot, so decided gates come from their logPrecedent effects;
// gates still open come from the item's live children.
function gates(item, effects) {
  const logged = effects.filter((e) => e.name === 'logPrecedent').map((e) => ({ id: e.subject, ...e.detail, state: 'decided' }));
  const seen = new Set(logged.map((d) => d.id));
  return [...logged, ...item.decisions.filter((d) => !seen.has(d.id))];
}

function verdict(item, events, decided) {
  const last = (types) => [...events].reverse().find((e) => types.includes(e.event.type));
  const ci = last(['CHECKS_PASSED', 'CHECKS_FAILED']);
  const accept = [...decided].reverse().find((d) => d.decisionClass === 'accept' && d.choice);
  const lines = [];
  if (item.state === 'done') lines.push(['ok', 'Merged.']);
  else if (['failed', 'cancelled'].includes(leaf(item.state))) lines.push(['bad', `Ended ${leaf(item.state)}.`]);
  else lines.push(['now', `Still running, at ${leaf(item.state)}.`]);
  if (ci) lines.push([ci.event.type === 'CHECKS_PASSED' ? 'ok' : 'bad', `CI ${ci.event.type === 'CHECKS_PASSED' ? 'passed' : 'failed'} ${time(ci.at)} UTC.`]);
  if (accept) lines.push([accept.choice === 'approve' ? 'ok' : 'bad', `Accepted by ${accept.decidedBy ?? 'unknown'}: ${accept.choice}${accept.standIn?.reason ? `, "${accept.standIn.reason}"` : ''}.`]);
  return lines;
}

/**
 * @param {object} item one entry of status().items
 * @param {{events?: object[], outbox?: object[], acks?: object[], back?: string}} records the whole store's rows
 */
export function renderItemPage(item, records = {}) {
  const { events, effects } = itemRecords(item.id, records);
  const request = events.find((e) => e.event.type === 'REQUEST_RECEIVED')?.event.request ?? {};
  const pr = prOf(item, events);
  const decided = gates(item, effects);
  const decisions = decided
    .map(
      (d) => `<tr><td><b>${esc(d.decisionClass)}</b><br><span class="m">${esc(d.id)}</span></td><td>${esc(d.choice ?? '—')}</td><td class="m">${esc(d.decidedBy ?? leaf(d.state))}</td><td>${
        d.standIn ? `${esc(d.standIn.choice)} ${esc(pct(d.standIn.confidence))} · ${esc(d.standIn.autonomy)}<br><span class="m">${esc(d.standIn.reason ?? '')}</span>` : '—'
      }</td></tr>`
    )
    .join('');
  const done = effects
    .map(
      (e) => `<tr><td><b>${esc(e.name)}</b>${e.params?.step ? ` ${esc(e.params.step)}` : ''}<br><span class="m">${esc(e.id)}</span></td><td>${
        e.ack ? `<span class="pill ${e.ack.outcome === 'failed' ? 'failed' : ''}">${esc(e.ack.outcome)}</span> ${esc(e.ack.note ?? '')}` : '<span class="pill draining">pending</span>'
      }</td><td class="m">${esc(time(e.ack?.at ?? e.at))}</td></tr>`
    )
    .join('');
  const timeline = events
    .map((e) => `<tr><td class="m">${esc(time(e.at))}</td><td><b>${esc(e.event.type)}</b>${e.event.choice ? ` ${esc(e.event.choice)}` : ''}</td><td class="m">${esc(e.to)}</td><td class="m">${esc(e.id)}</td></tr>`)
    .join('');
  const table = (head, rows, empty) =>
    rows ? `<div class="tablewrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">${empty}</div>`;

  const body = `<div class="wrap">
<header><span class="eyebrow">${records.back ? `<a href="${esc(records.back)}">Mission control</a> · ` : ''}${esc(item.project ?? '')} · tier ${esc(item.tier)}</span><h1>${esc(item.title ?? item.id)}</h1>${track(item)}</header>
<section><h2>What was asked</h2><div class="card ask-card"><b>${esc(request.expect ?? request.title ?? item.title ?? item.id)}</b>${
    request.url ? `<a href="${esc(request.url)}">${esc(request.url)}</a>` : ''
  }</div></section>
<section><h2>Did it do that?</h2><ul class="verdict">${verdict(item, events, decided)
    .map(([k, t]) => `<li class="${k}">${esc(t)}</li>`)
    .join('')}${pr ? `<li><a href="${esc(pr)}">${esc(pr)}</a></li>` : ''}</ul></section>
<section><h2>Decisions</h2>${table(['Gate', 'Choice', 'Decided by', 'Stand-in'], decisions, 'No gates yet.')}</section>
<section><h2>What the host did</h2>${table(['Effect', 'Outcome', 'At'], done, 'Nothing asked of the host yet.')}</section>
<section><h2>Timeline</h2>${table(['At', 'Event', 'To', 'Id'], timeline, 'No events.')}</section>
</div>`;
  return wrapPage(`${item.title ?? item.id}`, body, { standalone: true, css: CSS + ITEM_CSS });
}

const ITEM_CSS = `.ask-card{border-left-color:var(--accent)}.verdict{margin:0;padding:0;list-style:none;display:grid;gap:6px}
.verdict li{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:8px;padding:8px 12px;overflow-wrap:anywhere}
.verdict li.ok{border-left-color:var(--ok)}.verdict li.bad{border-left-color:var(--bad)}.verdict li.now{border-left-color:var(--warn)}`;
