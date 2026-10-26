// The retrospective: once a week (or every 20 finished items) the harness reviews itself. It compares
// this window's items with the window before, finds where the time went (Theory of Constraints: fix the
// one constraint), turns the top 3 into issue drafts with the metric each should move, and checks the
// expectations the last retro set.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { status } from './runtime.js';
import { readDecisionLog } from './decision-log.js';
import { attention } from './attention.js';
import { calibration } from './calibration.js';
import { runScenarios } from './scenario.js';
import { itemRecords } from './item-page.js';

const DAY = 864e5;
const STALL_MS = 36e5;
export const RETRO_EVERY = { days: 7, items: 20 };

// A wait is named after what ended it: time before a CI result is time spent on CI.
const WAIT = {
  RUN_SUCCEEDED: 'worker runs', RUN_FAILED: 'worker runs', STAND_IN_ANSWERED: 'stand-in', STAND_IN_FAILED: 'stand-in',
  PERSON_DECIDED: 'the person', CHECKS_PASSED: 'CI', CHECKS_FAILED: 'CI', MERGED: 'merging', MERGE_FAILED: 'merging', UNBLOCKED: 'blocked'
};

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Metrics for the items that finished between from and to (ISO). */
export function windowMetrics(st, records, from, to) {
  const finishedAt = new Map(
    records.events.filter((e) => ['MERGED', 'CANCEL'].includes(e.event.type) || e.event.choice === 'reject').map((e) => [e.to.replace(/^item:/, '').split('/')[0], e.at])
  );
  const items = st.items.filter((i) => i.done && finishedAt.get(i.id) >= from && finishedAt.get(i.id) < to);
  const waits = {};
  let stalls = 0;
  const per = items.map((i) => {
    const evs = itemRecords(i.id, records).events;
    evs.slice(1).forEach((e, k) => {
      const gap = Date.parse(e.at) - Date.parse(evs[k].at);
      const name = WAIT[e.event.type] ?? 'other';
      waits[name] = (waits[name] ?? 0) + gap;
      if (gap > STALL_MS) stalls++;
    });
    // The machine resets its retry count on each success, so failures are counted from the events.
    const retries = evs.filter((e) => ['RUN_FAILED', 'CHECKS_FAILED', 'MERGE_FAILED'].includes(e.event.type)).length;
    return { item: i, a: attention(i, records, to), retries };
  });
  const costs = per.map((p) => p.a.cost).filter((c) => c != null);
  const rows = (records.decisions ?? []).filter((d) => d.at >= from && d.at < to);
  return {
    from,
    to,
    items: items.length,
    touchesPerItem: avg(per.map((p) => p.a.touches)),
    costPerItem: avg(costs),
    medianWallMin: (() => {
      const m = median(per.map((p) => p.a.wallMs).filter((x) => x != null));
      return m == null ? null : m / 6e4;
    })(),
    retriesPerItem: avg(per.map((p) => p.retries)),
    stalls,
    reversals: rows.filter((d) => d.decidedBy === 'person' && d.standIn?.choice && d.choice && d.standIn.choice !== d.choice).length,
    waits
  };
}

// Lower is better for every metric the retro compares.
const COMPARED = [
  ['touchesPerItem', 'person touches per item'],
  ['costPerItem', 'cost per item ($)'],
  ['medianWallMin', 'median wall time (min)'],
  ['retriesPerItem', 'retries per item'],
  ['stalls', 'stalls over 60m'],
  ['reversals', 'stand-in reversals']
];

/** Build the retro for `day` (YYYY-MM-DD, UTC): the review text and its machine-readable record. */
export function retro(store, { day = new Date().toISOString().slice(0, 10), windowDays = RETRO_EVERY.days, previous = null, scenarios = runScenarios } = {}) {
  const st = status(store);
  const records = { events: store.events(), outbox: store.outbox(), acks: store.acks(), decisions: readDecisionLog(store) };
  const end = new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString();
  const mid = new Date(Date.parse(end) - windowDays * DAY).toISOString();
  const start = new Date(Date.parse(mid) - windowDays * DAY).toISOString();
  const now = windowMetrics(st, records, mid, end);
  const before = windowMetrics(st, records, start, mid);
  const better = [];
  const worse = [];
  for (const [k, label] of COMPARED) {
    if (now[k] == null || before[k] == null || before.items === 0 || now[k] === before[k]) continue;
    (now[k] < before[k] ? better : worse).push({ metric: k, label, before: before[k], now: now[k] });
  }
  const total = Object.values(now.waits).reduce((a, b) => a + b, 0);
  const bottlenecks = Object.entries(now.waits)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([wait, ms]) => ({
      wait,
      share: total ? ms / total : 0,
      hours: ms / 36e5,
      title: `Cut the time items wait on ${wait}`,
      metric: `waits.${wait}`,
      expected: `its share of finished items' wall time drops below ${Math.round((total ? (ms / total) * 0.8 : 0) * 100)}% by the next retro`,
      target: total ? (ms / total) * 0.8 : 0
    }));
  const calib = calibration(records.decisions, { now: end });
  const scen = scenarios();
  const failedScenarios = scen.filter((r) => !r.ok).map((r) => r.name);
  const checks = (previous?.bottlenecks ?? []).map((b) => {
    const share = total ? (now.waits[b.wait] ?? 0) / total : 0;
    return { ...b, shareNow: share, met: share < b.target };
  });
  const record = { day, windowDays, now, before, better, worse, bottlenecks, checks, calibration: calib.map((c) => ({ decisionClass: c.decisionClass, trust: c.trust, tested: c.tested })), failedScenarios };
  return { record, text: renderRetro(record) };
}

const fmt = (x) => (x == null ? 'n/a' : Number.isInteger(x) ? String(x) : x.toFixed(2));
const pct = (x) => `${Math.round(x * 100)}%`;

export function renderRetro(r) {
  const list = (rows, empty) => (rows.length ? rows.join('\n') : `- ${empty}`);
  const delta = (d) => `- ${d.label}: ${fmt(d.before)} → ${fmt(d.now)}`;
  return `# Harness retro, ${r.day}

${r.now.items} items finished in the last ${r.windowDays} days (${r.before.items} the ${r.windowDays} before).

## Better
${list(r.better.map(delta), r.before.items ? 'nothing measurably better' : 'no earlier window to compare with')}

## Worse
${list(r.worse.map(delta), r.before.items ? 'nothing measurably worse' : 'no earlier window to compare with')}

## Top bottlenecks (fix the first one next)
${list(
  r.bottlenecks.map((b, i) => `${i + 1}. **${b.title}**: ${pct(b.share)} of finished items' wall time (${b.hours.toFixed(1)}h). Expect: ${b.expected}.`),
  'no finished items to measure'
)}

## Last retro's expectations
${list(r.checks.map((c) => `- ${c.met ? 'met' : 'not met'}: ${c.title} (${pct(c.target)} target, now ${pct(c.shareNow)})`), 'none set')}

## Also
- Stand-in by class: ${r.calibration.map((c) => `${c.decisionClass} ${c.trust} (${c.tested} tested)`).join(', ') || 'no decisions'}.
- Scenarios failing: ${r.failedScenarios.join(', ') || 'none'}.
- Now: touches/item ${fmt(r.now.touchesPerItem)}, cost/item ${fmt(r.now.costPerItem)}, median wall ${fmt(r.now.medianWallMin)} min, retries/item ${fmt(r.now.retriesPerItem)}, stalls ${r.now.stalls}, reversals ${r.now.reversals}.
`;
}

/** The newest earlier retro record in dir, or null. */
export function lastRetro(dir, beforeDay) {
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).filter((n) => /^\d{4}-\d\d-\d\d\.json$/.test(n) && n.slice(0, 10) < beforeDay).sort().at(-1);
  return f ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : null;
}

/** Due when the last retro is 7 days old, or 20 items have finished since it. */
export function retroDue(store, dir, day = new Date().toISOString().slice(0, 10)) {
  const last = lastRetro(dir, day);
  if (!last) return { due: true, why: 'no retro yet' };
  const days = (Date.parse(day) - Date.parse(last.day)) / DAY;
  const since = store.events().filter((e) => e.event.type === 'MERGED' && e.at.slice(0, 10) > last.day).length;
  if (days >= RETRO_EVERY.days) return { due: true, why: `${days} days since ${last.day}` };
  if (since >= RETRO_EVERY.items) return { due: true, why: `${since} items merged since ${last.day}` };
  return { due: false, why: `${days} days and ${since} merges since ${last.day}` };
}

export function writeRetro(store, dir, opts = {}) {
  const day = opts.day ?? new Date().toISOString().slice(0, 10);
  const { record, text } = retro(store, { ...opts, day, previous: lastRetro(dir, day) });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${day}.md`), text);
  writeFileSync(join(dir, `${day}.json`), JSON.stringify(record, null, 1));
  return { file: join(dir, `${day}.md`), record, text };
}
