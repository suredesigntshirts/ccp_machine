// Tests drive the harness the way the scripted host does: each event from the party that sends it for
// real (src/sim.js scripted), unless the test names one. test/envelope.test.js checks the wrong parties.
import { apply as applyEvent } from '../src/runtime.js';
import { scripted } from '../src/sim.js';

export const apply = (store, event, opts) => applyEvent(store, event?.actor || event?.source ? event : { ...event, ...scripted(event?.type) }, opts);

/** The orchestrator starts, as every host does after init. */
export const start = (store, now) => apply(store, { type: 'ORCHESTRATOR_STARTED' }, { id: 'orchestrator-started', ...(now && { now }) });
