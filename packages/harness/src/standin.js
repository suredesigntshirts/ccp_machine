// One call for a stand-in answer: find the item's pending askStandIn, send STAND_IN_ANSWERED to its
// decision, ack the ask and log the precedent. The host used to do these three steps by hand. The answer's id
// names the ask (standin-<effect id>), so a re-asked decision's fresh answer is new and a retried call is not.
import { apply, ack } from './runtime.js';
import { logPrecedents } from './decision-log.js';

/**
 * @param {{choice: 'approve'|'reject', reason: string, confidence: number}} answer by is the sender, {actor, source}.
 *   The decision machine holds autonomy and threshold and refuses an answer without a confidence.
 * @returns {{subject: string, id: string, duplicate: boolean, acked: string[], effects: string[], note?: string}}
 */
export function standinAnswer(store, item, { choice, reason, confidence, by }) {
  if (!['approve', 'reject'].includes(choice)) throw new Error('standin needs --approve or --reject');
  if (!reason) throw new Error('standin needs --reason: why the stand-in may decide this');
  const ask = store.pending().find((e) => e.name === 'askStandIn' && String(e.subject).startsWith(`decision:${item}:`));
  if (!ask) throw new Error(`${item} has no pending stand-in question`);
  const to = `item:${item}/${ask.subject}`;
  const event = { type: 'STAND_IN_ANSWERED', answer: { choice, confidence, reason }, ...by };
  const id = `standin-${ask.id}`;
  const r = apply(store, event, { to, id });
  if (r.refused) throw new Error(r.why);
  // A duplicate was recorded by an earlier call: this one wrote nothing, so it acks nothing.
  if (r.duplicate) return { subject: ask.subject, id, duplicate: true, acked: [], effects: [], note: `duplicate: ${id} is already in the store; nothing recorded, ${ask.id} not acked` };
  ack(store, [ask.id], { note: `stand-in answered ${choice}` });
  logPrecedents(store);
  return { subject: ask.subject, id, duplicate: false, acked: [ask.id], effects: r.effects.map((e) => e.name) };
}
