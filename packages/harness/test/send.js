// Tests drive the harness the way the scripted host does: each event from the party that sends it for
// real (src/sim.js scripted), unless the test names one. test/envelope.test.js checks the wrong parties.
import { apply as applyEvent } from '../src/runtime.js';
import { scripted } from '../src/sim.js';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const apply = (store, event, opts) => applyEvent(store, event?.actor || event?.source ? event : { ...event, ...scripted(event?.type) }, opts);

/** The orchestrator starts, as every host does after init. */
export const start = (store, now) => apply(store, { type: 'ORCHESTRATOR_STARTED' }, { id: 'orchestrator-started', ...(now && { now }) });

/** Earn `act` for a class: 20 of the person's decisions agreeing with the stand-in's lean, logged before `at`. */
export const earn = (store, decisionClass, at = '2026-01-01T00:00:00Z') =>
  appendFileSync(join(store.dir, 'decisions.jsonl'), Array.from({ length: 20 }, (_, i) => JSON.stringify({ effectId: `earned-${decisionClass}-${i}`, at, decisionClass, choice: 'approve', decidedBy: 'person', standIn: { choice: 'approve' } }) + '\n').join(''));
