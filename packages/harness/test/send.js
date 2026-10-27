// Tests drive the harness the way the scripted host does: each event from the party that sends it for
// real (src/sim.js scripted), unless the test names one. test/envelope.test.js checks the wrong parties.
import { apply as applyEvent } from '../src/runtime.js';
import { scripted } from '../src/sim.js';

export const apply = (store, event, opts) => applyEvent(store, event?.actor || event?.source ? event : { ...event, ...scripted(event?.type) }, opts);

/** The orchestrator starts, as every host does after init. */
export const start = (store, now) => apply(store, { type: 'ORCHESTRATOR_STARTED' }, { id: 'orchestrator-started', ...(now && { now }) });

/** Decided decisions as the store records them: logPrecedent effects in the outbox, acknowledged. */
export const logged = (store, rows) => {
  store.appendOutbox(rows.map((r) => ({ id: r.effectId, eventId: `fixture-${r.effectId}`, at: r.at, name: 'logPrecedent', subject: r.decision ?? `decision:${r.item ?? 'fixture'}:${r.decisionClass}:1`, detail: { decisionClass: r.decisionClass, tier: r.tier, question: r.question, choice: r.choice, decidedBy: r.decidedBy, standIn: r.standIn } })));
  store.appendAcks(rows.map((r) => ({ effectId: r.effectId, outcome: 'done', note: 'fixture', at: r.at })));
};

/** Earn `act` for a class: 20 of the person's decisions agreeing with the stand-in's lean, recorded before `at`. */
export const earn = (store, decisionClass, at = '2026-01-01T00:00:00Z') =>
  logged(store, Array.from({ length: 20 }, (_, i) => ({ effectId: `earned-${decisionClass}-${i}`, at, decisionClass, choice: 'approve', decidedBy: 'person', standIn: { choice: 'approve' } })));
