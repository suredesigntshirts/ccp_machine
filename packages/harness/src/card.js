// A decision card: turns a postDecisionCard effect into the arguments of a request_decision card, so
// the orchestrator posts it unchanged to the effect's detail.address, then acks the effect with the card's message id
// (harness ack <effect> --card <cmsg id>), which the decision records (CARD_POSTED). The options are the
// decision's options in order; a tap on option i comes back as PERSON_DECIDED with choices[i], sent to
// `address` as the person from a tap whose ref is that message id (--actor person:<id> --source tap:<cmsg id>);
// the decision refuses anything else.
import { specs } from './machines.js';
import { cardAddress } from './runtime.js';

const LABELS = {
  approve: ['Approve', { plan: 'The item goes on to build.', accept: 'The item goes on to merge.', merge: 'The PR is merged.' }],
  revise: ['Revise', { plan: 'The item goes back to triage for a new plan.', accept: 'The item goes back to build.', merge: 'The item goes back to build.' }],
  reject: ['Drop it', { plan: 'The item is cancelled.', accept: 'The item is cancelled.', merge: 'The item is cancelled and the PR stays open.' }]
};
const CHOICES = specs.decision.context.options.map((c) => [c, ...LABELS[c]]);

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * @param {object} effect a postDecisionCard effect from the outbox
 * @param {{itemUrl?: string}} [opts] a link to the item's page or PR for the context line
 * @returns {{address: string, choices: string[], question: string, options: {label: string, consequence: string}[], recommended: number, reason?: string, context: string}}
 */
export function cardFor(effect, { itemUrl } = {}) {
  if (effect?.name !== 'postDecisionCard') throw new Error(`${effect?.id ?? 'effect'} is not a postDecisionCard effect`);
  const d = effect.detail ?? {};
  const { item, decisionClass: gate } = d;
  const lean = d.standIn?.choice;
  const recommended = Math.max(0, CHOICES.findIndex(([c]) => c === lean));
  const context = [
    `Tier ${d.tier ?? '?'} ${gate} gate for "${d.title ?? item}"${d.project ? ` in ${d.project}` : ''}, a ${d.door ?? 'one-way'} door.`,
    lean ? `The stand-in leans ${lean}${d.standIn.confidence != null ? ` (${Math.round(d.standIn.confidence * 100)}% sure)` : ''}${d.standIn.reason ? `: ${d.standIn.reason}` : ''}.` : 'The stand-in gave no lean.',
    itemUrl ?? d.url ?? ''
  ]
    .filter(Boolean)
    .join(' ');
  return {
    address: d.address,
    choices: CHOICES.map(([c]) => c),
    question: cut(`${gate === 'plan' ? 'Approve the plan for' : gate === 'accept' ? 'Accept the work on' : 'Merge'} ${d.title ?? item}?`, 90),
    options: CHOICES.map(([, label, by]) => ({ label, consequence: by[gate] ?? by.plan })),
    recommended,
    ...(d.standIn?.reason ? { reason: cut(d.standIn.reason, 200) } : {}),
    context: cut(context, 1200)
  };
}

const CLASSES = specs.decision.meta.classes;
const hour = (iso) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

/**
 * The grant checklist for a postGrantCard effect: one tick per option the machine generated, in its order (decision
 * kinds with their doors, the one-way-door box, the end times; the person ticks any kinds, the box or not, and one
 * end time). The ticks come back as one tap, PERSON_GRANTED {picks: [ids]}, sent to `address` as the person from a
 * tap whose ref is the card's message id; the grant actor refuses anything else.
 * @returns {{address: string, question: string, checks: {id: string, label: string, pick: 'any'|'one'}[], context: string, tap: string}}
 */
export function checklistFor(effect) {
  if (effect?.name !== 'postGrantCard') throw new Error(`${effect?.id ?? 'effect'} is not a postGrantCard effect`);
  const options = effect.detail?.options ?? [];
  const label = (o) =>
    o.startsWith('kind:') ? `${o.slice(5)} decisions (${CLASSES[o.slice(5)]?.door ?? 'one-way'} door)`
    : o === 'one-way' ? 'Also one-way doors I tick above'
    : `Until ${hour(o.slice(6))}`;
  return {
    address: cardAddress(effect),
    question: 'What may the stand-in decide for you, and until when?',
    checks: options.map((id) => ({ id, label: label(id), pick: id.startsWith('until:') ? 'one' : 'any' })),
    context: cut(
      `Ticked kinds are decided by the stand-in alone while the grant lasts, when it is sure and gives a reason; everything else comes to you. ${Object.entries(CLASSES).map(([k, c]) => `${k}: ${c.door} door, ${c.description}`).join(' ')} A one-way door needs its kind and the one-way box. Tapping this replaces your current grant; ticking no kind ends it. Every decision made under it is listed on mission control and in the daily audit.`,
      1200
    ),
    tap: `harness send '{"type":"PERSON_GRANTED","picks":[<ticked ids>]}' --to ${cardAddress(effect)} --actor person:<you> --source tap:<card message id>`
  };
}
