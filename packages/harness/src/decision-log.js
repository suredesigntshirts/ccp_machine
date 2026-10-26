// The decision log: every logPrecedent effect becomes one row of decisions.jsonl in the store, so the
// stand-in can learn from past choices and the person can see how often it agreed with them. A class
// earns `act` autonomy after enough decisions with enough agreement; until then the stand-in recommends.
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ack } from './runtime.js';
import { esc, time, pct, wrapPage, CSS } from './page.js';

export const EARN_ACT = { decisions: 20, agreement: 0.9 };

const logFile = (store) => join(store.dir, 'decisions.jsonl');

export function readDecisionLog(store) {
  const f = logFile(store);
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

function row(e) {
  const d = e.detail ?? {};
  // The decision's id is decision:<item>:<class>:<n>; early effects carried no detail, so the id is the fallback.
  const parts = (e.subject ?? '').split(':');
  return {
    effectId: e.id,
    at: e.at,
    item: parts.length >= 4 ? parts.slice(1, -2).join(':') : null,
    decision: e.subject,
    decisionClass: d.decisionClass ?? (parts.length >= 4 ? parts.at(-2) : null),
    tier: d.tier ?? null,
    question: d.question ?? null,
    choice: d.choice ?? null,
    decidedBy: d.decidedBy ?? null,
    standIn: d.standIn ?? null
  };
}

/**
 * Append every logPrecedent effect not yet in the log (acknowledged ones too, so history backfills),
 * then acknowledge the pending ones. Running it twice adds nothing.
 * @returns {{added: number, acked: number}}
 */
export function logPrecedents(store) {
  const have = new Set(readDecisionLog(store).map((r) => r.effectId));
  const rows = store.outbox().filter((e) => e.name === 'logPrecedent' && !have.has(e.id)).map(row);
  if (rows.length) appendFileSync(logFile(store), rows.map((r) => JSON.stringify(r) + '\n').join(''));
  const pending = store.pending().filter((e) => e.name === 'logPrecedent').map((e) => e.id);
  if (pending.length) ack(store, pending, { note: 'appended to decisions.jsonl' });
  return { added: rows.length, acked: pending.length };
}

/** Per decision class: how many, how often the stand-in's lean matched the final choice, and whether it has earned `act`. */
export function classStats(rows, earn = EARN_ACT) {
  const by = new Map();
  for (const r of rows) {
    const s = by.get(r.decisionClass) ?? { decisionClass: r.decisionClass, decisions: 0, byPerson: 0, leaned: 0, agreed: 0 };
    s.decisions++;
    if (r.decidedBy === 'person') s.byPerson++;
    if (r.standIn?.choice) {
      s.leaned++;
      if (r.standIn.choice === r.choice) s.agreed++;
    }
    by.set(r.decisionClass, s);
  }
  return [...by.values()].map((s) => {
    const agreement = s.leaned ? s.agreed / s.leaned : null;
    return { ...s, agreement, earnedAct: s.decisions >= earn.decisions && agreement != null && agreement >= earn.agreement };
  });
}

export function renderDecisionLog(rows, { title = 'Decision log', back } = {}) {
  const stats = classStats(rows);
  const table = (head, body) => `<div class="tablewrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
  const body = `<div class="wrap">
<header><span class="eyebrow">${back ? `<a href="${esc(back)}">Mission control</a> · ` : ''}${rows.length} decisions</span><h1>${esc(title)}</h1></header>
<section><h2>Stand-in by class</h2>${
    stats.length
      ? table(
          ['Class', 'Decisions', 'By person', 'Agreement', 'Autonomy'],
          stats
            .map(
              (s) =>
                `<tr><td><b>${esc(s.decisionClass)}</b></td><td>${s.decisions}</td><td>${s.byPerson}</td><td>${esc(pct(s.agreement))} <span class="m">(${s.agreed}/${s.leaned})</span></td><td><span class="pill ${s.earnedAct ? '' : 'draining'}">${
                  s.earnedAct ? 'act' : 'recommend'
                }</span> <span class="m">${s.earnedAct ? '' : `act needs ${EARN_ACT.decisions} decisions at ${pct(EARN_ACT.agreement)}`}</span></td></tr>`
            )
            .join('')
        )
      : '<div class="empty">No decisions logged yet.</div>'
  }</section>
<section><h2>Every decision</h2>${
    rows.length
      ? table(
          ['At', 'Item', 'Class', 'Choice', 'By', 'Stand-in lean'],
          [...rows]
            .reverse()
            .map(
              (r) =>
                `<tr><td class="m">${esc(time(r.at))}</td><td><a href="items/${esc(encodeURIComponent(r.item ?? ''))}.html">${esc(r.item)}</a></td><td>${esc(r.decisionClass)} <span class="m">t${esc(r.tier)}</span></td><td><b>${esc(r.choice)}</b></td><td class="m">${esc(r.decidedBy)}</td><td>${
                  r.standIn ? `${esc(r.standIn.choice)} ${esc(pct(r.standIn.confidence))} · ${esc(r.standIn.autonomy)}<br><span class="m">${esc(r.standIn.reason ?? '')}</span>` : '—'
                }</td></tr>`
            )
            .join('')
        )
      : '<div class="empty">No decisions logged yet.</div>'
  }</section>
</div>`;
  return wrapPage(title, body, { standalone: true, css: CSS });
}
