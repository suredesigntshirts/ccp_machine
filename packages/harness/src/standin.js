// One call for a stand-in answer: find the item's pending askStandIn, send STAND_IN_ANSWERED to its
// decision, ack the ask and log the precedent. The host used to do these three steps by hand.
import { apply, ack } from './runtime.js';
import { acceptBlocked } from './expect-check.js';
import { logPrecedents, ladder, readDecisionLog } from './decision-log.js';

/**
 * @param {{choice: 'approve'|'reject', reason: string, confidence?: number, threshold?: number, autonomy?: string}} answer
 *   autonomy defaults to the ladder's rung for the decision class
 * @returns {{subject: string, id: string, duplicate: boolean, effects: string[]}}
 */
export function standinAnswer(store, item, { choice, reason, confidence = 0.9, threshold = 0.9, autonomy }) {
  if (!['approve', 'reject'].includes(choice)) throw new Error('standin needs --approve or --reject');
  if (!reason) throw new Error('standin needs --reason: why the stand-in may decide this');
  const ask = store.pending().find((e) => e.name === 'askStandIn' && String(e.subject).startsWith(`decision:${item}:`));
  if (!ask) throw new Error(`${item} has no pending stand-in question`);
  const to = `item:${item}/${ask.subject}`;
  // The rung is the ladder's unless the host passes standing authority from the person (--autonomy).
  const rung = autonomy ?? ladder(readDecisionLog(store), ask.subject.split(':')[2]).autonomy;
  const event = { type: 'STAND_IN_ANSWERED', answer: { choice, confidence, threshold, autonomy: rung, reason } };
  const blocked = acceptBlocked(store, event, to);
  if (blocked) throw new Error(blocked);
  const id = `standin-${ask.subject}`;
  const r = apply(store, event, { to, id });
  ack(store, [ask.id], { note: `stand-in answered ${choice}` });
  logPrecedents(store);
  return { subject: ask.subject, id, duplicate: r.duplicate, effects: r.effects.map((e) => e.name) };
}
