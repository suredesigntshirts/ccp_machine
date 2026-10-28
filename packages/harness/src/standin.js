// One call for a stand-in answer: find the pending askStandIn of the item's live decision (one waiting on the stand-in), send STAND_IN_ANSWERED to its
// decision, ack the ask and log the precedent. The host used to do these three steps by hand. The answer's id
// names the ask (standin-<effect id>), so a re-asked decision's fresh answer is new and a retried call is not.
import { apply, ack, status } from './runtime.js';
import { logPrecedents } from './decision-log.js';

/**
 * @param {{choice: string, reason: string, confidence: number}} answer by is the sender, {actor, source}.
 *   The decision machine holds the choices a stand-in may give (its options), autonomy and threshold, and refuses
 *   an answer with another choice or without a confidence.
 * @returns {{subject: string, id: string, duplicate: boolean, acked: string[], effects: string[], note?: string}}
 */
export function standinAnswer(store, item, { choice, reason, confidence, by }) {
  if (!reason) throw new Error('standin needs --reason: why the stand-in may decide this');
  // The ask of a decision the item holds now (a store from before #84 can still hold asks of stopped ones), else one
  // whose answer is already recorded, so a retried call is reported as the duplicate it is.
  const live = (status(store)?.items.find((i) => i.id === item)?.decisions ?? []).map((d) => d.id);
  const asks = store.pending().filter((e) => e.name === 'askStandIn' && String(e.subject).startsWith(`decision:${item}:`));
  const answered = new Set(store.events().map((e) => e.id));
  const ask = asks.findLast((e) => live.includes(e.subject)) ?? asks.find((e) => answered.has(`standin-${e.id}`));
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
