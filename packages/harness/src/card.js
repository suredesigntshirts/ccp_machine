// A decision card: turns a postDecisionCard effect into the arguments of a request_decision card, so
// the orchestrator posts it unchanged. The options map to the gate's choices in order; a tap on option
// i comes back as PERSON_DECIDED with choices[i], sent to `address` with the card's message id as --id.
const CHOICES = [
  ['approve', 'Approve', { plan: 'The item goes on to build.', accept: 'The item goes on to merge.', merge: 'The PR is merged.' }],
  ['revise', 'Revise', { plan: 'The item goes back to triage for a new plan.', accept: 'The item goes back to build.', merge: 'The item goes back to build.' }],
  ['reject', 'Drop it', { plan: 'The item is cancelled.', accept: 'The item is cancelled.', merge: 'The item is cancelled and the PR stays open.' }]
];

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * @param {object} effect a postDecisionCard effect from the outbox
 * @param {{itemUrl?: string}} [opts] a link to the item's page or PR for the context line
 * @returns {{address: string, choices: string[], question: string, options: {label: string, consequence: string}[], recommended: number, reason?: string, context: string}}
 */
export function cardFor(effect, { itemUrl } = {}) {
  if (effect?.name !== 'postDecisionCard') throw new Error(`${effect?.id ?? 'effect'} is not a postDecisionCard effect`);
  const d = effect.detail ?? {};
  const [, ...rest] = effect.subject.split(':');
  const item = rest.slice(0, -2).join(':');
  const gate = d.decisionClass ?? rest.at(-2);
  const lean = d.standIn?.choice;
  const recommended = Math.max(0, CHOICES.findIndex(([c]) => c === lean));
  const context = [
    `Tier ${d.tier ?? '?'} ${gate} gate for "${d.title ?? item}"${d.project ? ` in ${d.project}` : ''}.`,
    lean ? `The stand-in leans ${lean}${d.standIn.confidence != null ? ` (${Math.round(d.standIn.confidence * 100)}% sure)` : ''}${d.standIn.reason ? `: ${d.standIn.reason}` : ''}.` : 'The stand-in gave no lean.',
    itemUrl ?? d.url ?? ''
  ]
    .filter(Boolean)
    .join(' ');
  return {
    address: `item:${item}/${effect.subject}`,
    choices: CHOICES.map(([c]) => c),
    question: cut(`${gate === 'plan' ? 'Approve the plan for' : gate === 'accept' ? 'Accept the work on' : 'Merge'} ${d.title ?? item}?`, 90),
    options: CHOICES.map(([, label, by]) => ({ label, consequence: by[gate] ?? by.plan })),
    recommended,
    ...(d.standIn?.reason ? { reason: cut(d.standIn.reason, 200) } : {}),
    context: cut(context, 1200)
  };
}
