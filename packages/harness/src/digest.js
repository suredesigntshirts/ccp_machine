// The daily digest: a short Markdown note of what finished, what is in flight, what waits on the
// person and where the budget stands. `harness digest` sends DIGEST_DUE once per UTC day, writes the
// note into the store and acknowledges the publishDigest effect; the host posts the note's text.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply, ack, status } from './runtime.js';
import { readDecisionLog } from './decision-log.js';

const pct = (x) => (x == null ? 'unknown' : `${Math.round(x * 100)}%`);
const leaf = (state) => state.split('.').pop();

/**
 * @param {object} st from status()
 * @param {{events?: object[], decisions?: object[], day: string}} opts day is YYYY-MM-DD (UTC)
 */
export function renderDigest(st, { events = [], decisions = [], day }) {
  const onDay = (at) => at?.slice(0, 10) === day;
  const mergedToday = new Set(events.filter((e) => e.event.type === 'MERGED' && onDay(e.at)).map((e) => e.to.replace(/^item:/, '').split('/')[0]));
  const finished = st.items.filter((i) => i.done && mergedToday.has(i.id));
  const live = st.items.filter((i) => !i.done);
  const waiting = live.flatMap((i) => i.decisions.filter((d) => d.state === 'awaitingPerson').map((d) => `${i.id}: ${d.decisionClass} gate`));
  const today = decisions.filter((d) => onDay(d.at));
  const byPerson = today.filter((d) => d.decidedBy === 'person').length;
  const list = (rows, empty) => (rows.length ? rows.map((r) => `- ${r}`).join('\n') : `- ${empty}`);
  const b = st.budget;
  return `# Harness digest, ${day}

**Finished today (${finished.length})**
${list(finished.map((i) => `${i.id}: ${i.title ?? ''}${i.url ? ` (${i.url})` : ''}`), 'nothing')}

**In flight (${live.length} of ${st.context.wipLimit})**
${list(live.map((i) => `${i.id}: ${leaf(i.state)}`), 'nothing')}

**Waiting on you (${waiting.length})**
${list(waiting, 'nothing')}

**Decisions today:** ${today.length}, ${byPerson} by you, ${today.length - byPerson} by the stand-in.

**Budget:** ${b ? `${b.mode}, 7-day window at ${pct(b.sevenDay)}, 5-hour at ${pct(b.fiveHour)}` : 'no usage samples yet'}; scheduler ${st.state.scheduler}.
`;
}

/** Send today's DIGEST_DUE (once per day), write the digest and ack its publishDigest effects. */
export function writeDigest(store, { day = new Date().toISOString().slice(0, 10) } = {}) {
  apply(store, { type: 'DIGEST_DUE', day }, { id: `digest-${day}` });
  const text = renderDigest(status(store), { events: store.events(), decisions: readDecisionLog(store), day });
  const dir = join(store.dir, 'digests');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${day}.md`);
  writeFileSync(file, text);
  const pending = store.pending().filter((e) => e.name === 'publishDigest').map((e) => e.id);
  if (pending.length) ack(store, pending, { note: `wrote ${file}` });
  return { file, acked: pending.length, text };
}
