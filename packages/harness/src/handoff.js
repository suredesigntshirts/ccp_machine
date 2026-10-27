// The hand-off note: the store holds the machines, but a fresh orchestrator thread also needs what the
// last one knew about them — which PR each item is on, which cards wait on the person, what the host owes.
// `harness handoff` writes it as handoff.md in the store at the end of each wake; a new thread reads it first.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { status } from './runtime.js';
import { doctor } from './doctor.js';
import { prOf } from './page.js';
import { lastMoved } from './stalled.js';

// Notes the host keeps by hand (cards posted outside the machines, conventions), carried into the note.
export const NOTES = 'handoff-notes.md';

/** The note for the store as it stands, as Markdown. */
export function handoffNote(store, { now = new Date().toISOString() } = {}) {
  const st = status(store);
  const events = store.events();
  const acks = new Map(store.acks().map((a) => [a.effectId, a]));
  const pending = store.pending();
  const open = st.items.filter((i) => !i.done);
  const live = open.filter((i) => !/queued/.test(i.state));
  const queued = open.filter((i) => /queued/.test(i.state));
  const plan = (id) => (existsSync(join(store.dir, 'plans', `${id}.md`)) ? `, plan \`plans/${id}.md\`` : '');
  const item = (i) => `- **${i.id}** (tier ${i.tier}) ${i.state}${prOf(events, i.id) ? `, PR ${prOf(events, i.id)}` : ''}${plan(i.id)}; moved ${lastMoved(events, i.id) ?? 'never'}${i.title ? `. ${i.title}` : ''}`;
  // A card's ack note holds its message id; it is found from the decision's postDecisionCard effect.
  const cards = live.flatMap((i) =>
    i.decisions
      .filter((d) => d.state === 'awaitingPerson')
      .map((d) => {
        const effect = store.outbox().findLast((e) => e.name === 'postDecisionCard' && `${i.address}/${e.subject}` === d.address);
        const note = effect && acks.get(effect.id)?.note;
        return `- ${d.address}: ${d.question ?? d.decisionClass}${note ? ` (card: ${note})` : effect ? ' (card not posted yet)' : ''}`;
      })
  );
  const doc = doctor(store);
  const b = st.budget;
  const notesFile = join(store.dir, NOTES);
  const notes = existsSync(notesFile) ? readFileSync(notesFile, 'utf8').trim() : '';
  const list = (rows, empty) => (rows.length ? rows.join('\n') : `- ${empty}`);
  const next = [
    ...(doc.ok ? [] : ['Fix the store first: `harness doctor` reports problems.']),
    ...(pending.length ? [`Carry out the ${pending.length} pending effect(s) below, then ack each.`] : []),
    ...live.filter((i) => /verifying|merging/.test(i.state)).map((i) => `Check CI on ${prOf(events, i.id) ?? i.id} and merge or fix it.`),
    ...(queued.length ? [`${queued.length} item(s) queued: they start as slots free.`] : [])
  ].slice(0, 3);
  return `# Harness hand-off

Written ${now} from store v${st.version}. A new orchestrator thread reads this before its first wake, then
runs \`harness doctor\` and carries on from "Next".

## Next
${list(next.map((n, k) => `${k + 1}. ${n}`), 'nothing in flight: take the next backlog issue')}

## In flight (${live.length} of WIP ${st.context.wipLimit})
${list(live.map(item), 'nothing')}

## Queued (${queued.length})
${list(queued.map(item), 'nothing')}

## Waiting on the person
${list(cards, 'no decision cards')}

## Host to-do (pending effects)
${list(pending.map((e) => `- \`${e.id}\` ${e.name} ${e.subject ?? ''}${e.params?.step ? ` (${e.params.step})` : ''}`), 'none')}

## Budget
- ${b ? `${b.mode}, scheduler ${st.state.scheduler}; 7-day ${b.sevenDay ?? '?'} at ${b.sampledAt ?? 'no reading'}${b.estimated ? ' (estimated)' : ''}` : 'no budget actor'}

## Doctor
${list([...doc.problems.map((p) => `- problem: ${p}`), ...doc.warnings.map((w) => `- warning: ${w}`)], 'ok')}

## Host notes (${NOTES})
${notes || '- none'}
`;
}

export function writeHandoff(store, opts) {
  const file = join(store.dir, 'handoff.md');
  writeFileSync(file, handoffNote(store, opts));
  return file;
}
