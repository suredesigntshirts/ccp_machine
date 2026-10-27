// The attention metric: what each item cost the person and the machine. The harness exists to cut the
// person's attention, so every later change should move these numbers.
import { itemRecords, itemTurns } from './item-page.js';

/**
 * One item's cost.
 * - touches: decision cards posted for it, plus events the host marked `person: true` (a message of
 *   the person's that the item needed);
 * - standIn: decisions the stand-in made alone; reversed: the person's decisions that went against its lean;
 * - turns, tokens and cost: from the session ledgers of the sessions named on its events (null without one);
 * - wallMs: request to merge (or to now while it runs).
 */
export function attention(item, { events = [], outbox = [], acks = [], decisions = [], sessions = {} } = {}, now = new Date().toISOString()) {
  const mine = itemRecords(item.id, { events, outbox, acks });
  const cards = mine.effects.filter((e) => e.name === 'postDecisionCard').length;
  const personMessages = mine.events.filter((e) => e.event.person === true).length;
  const rows = decisions.filter((d) => d.item === item.id);
  const turns = itemTurns(item, mine.events, sessions, now);
  const sum = (k) => turns.reduce((n, t) => n + (t.all?.[k] ?? 0), 0);
  const first = mine.events[0]?.at;
  const end = item.done ? mine.events.at(-1)?.at : now;
  return {
    id: item.id,
    touches: cards + personMessages,
    cards,
    personMessages,
    standIn: rows.filter((d) => d.decidedBy === 'stand-in').length,
    reversed: rows.filter((d) => d.decidedBy === 'person' && d.standIn?.choice && d.choice && d.standIn.choice !== d.choice).length,
    turns: turns.length || null,
    tokens: turns.length ? sum('input') + sum('output') + sum('cacheRead') + sum('cacheWrite') : null,
    cost: turns.length ? sum('cost') : null,
    wallMs: first && end ? Date.parse(end) - Date.parse(first) : null
  };
}

const minutes = (ms) => (ms < 36e5 ? `${Math.round(ms / 6e4)}m` : `${(ms / 36e5).toFixed(1)}h`);

/** A short cell for mission control: touches first, since that is the number to move. */
export function attentionText(m) {
  if (!m) return '';
  const parts = [`${m.touches} touch${m.touches === 1 ? '' : 'es'}`, `${m.standIn} stand-in${m.reversed ? `, ${m.reversed} reversed` : ''}`];
  parts.push(m.turns == null ? 'turns n/a' : `${m.turns} turn${m.turns === 1 ? '' : 's'}, ${m.cost != null ? `$${m.cost.toFixed(2)}` : 'n/a'}`);
  if (m.wallMs != null) parts.push(minutes(m.wallMs));
  return parts.join(' · ');
}

/** Touches per item merged on `day` and on the day before, for the digest's trend line. */
export function touchesTrend(items, records, day) {
  const mergedOn = new Map(records.events.filter((e) => e.event.type === 'MERGED').map((e) => [e.to.replace(/^item:/, '').split('/')[0], e.at.slice(0, 10)]));
  const prev = new Date(Date.parse(`${day}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
  const on = (d) => {
    const done = items.filter((i) => i.done && mergedOn.get(i.id) === d);
    const touches = done.reduce((n, i) => n + attention(i, records).touches, 0);
    return { day: d, items: done.length, perItem: done.length ? touches / done.length : null };
  };
  return { today: on(day), before: on(prev) };
}
