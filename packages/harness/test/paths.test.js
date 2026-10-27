// Generated paths: for each of the five machines, xstate/graph walks the machine definition to every
// state (shortest paths), and each path's events are replayed through runtime.apply() on a scratch store.
// After every step the stored actor must be in the state the machine reaches on the same events (pure
// transition(); the graph keeps one snapshot per state value, so its own snapshots can carry another
// path's context). From each path's end, every
// fixture event is tried once more: the runtime must take exactly what the machine takes and refuse the
// rest, writing nothing. Event payloads the guards need, actor and source included, come from path-fixtures.json,
// not from hand-written paths; the fixtures also hold each guarded event from the wrong party, which both refuse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { initialTransition, transition } from 'xstate';
import { getShortestPaths } from 'xstate/graph';
import { machines } from '../src/machines.js';
import { init, apply } from '../src/runtime.js';
import { openStore } from '../src/store.js';
import { earn } from './send.js';

const fixtures = JSON.parse(readFileSync(new URL('./path-fixtures.json', import.meta.url), 'utf8'));
const scratch = tempDir('harness-paths-');
let n = 0;

// Where each machine lives in a running harness: the address apply() sends to, the events that bring it
// into being (a work item is queued with WIP 0 so the path's own START moves it), and its stored snapshot.
const child = (snap, ...ids) => ids.reduce((s, id) => s?.children?.[id]?.snapshot, snap);
const orchestrator = { actor: { kind: 'session', id: 'orchestrator' }, source: { kind: 'cli', ref: 'harness send' } };
const started = [{ type: 'ORCHESTRATOR_STARTED', ...orchestrator }];
const as = (id) => ({ actor: { kind: 'session', id }, source: { kind: 'cli', ref: 'harness send' } });
const item = (e) => [e, 'item:w'];
// The host's ack of a card effect: the card's message id, which the person's tap names.
const posted = { type: 'CARD_POSTED', card: 'cmsg_card', effect: 'e1.0', ...as('orchestrator') };
// The decision under test, by its input: a plan decision (decision:w:plan:1) or an accept one (decision:w:accept:2).
let decisionAt = 'item:w/decision:w:plan:1';
const homes = {
  harness: { to: undefined, setup: () => [], read: (snap) => snap },
  budget: { to: 'budget', setup: () => [], read: (snap) => child(snap, 'budget') },
  workItem: {
    to: 'item:w',
    // The request names the item only; the input's orchestrator and requester are the ones the harness records.
    setup: (input) => [started, [{ type: 'REQUEST_RECEIVED', request: { id: input.id }, ...orchestrator }]],
    read: (snap) => child(snap, 'w')
  },
  decision: {
    get to() { return decisionAt; },
    // The worker's failed triage run makes it one of the item's workers; a triager sets the tier. An accept
    // decision follows the plan (the person approves), a build and CI, with the criterion met by a reviewer or not.
    setup: (input) => [
      started,
      [{ type: 'REQUEST_RECEIVED', request: { id: 'w' }, ...orchestrator }],
      item({ type: 'START', ...orchestrator }),
      item({ type: 'RUN_FAILED', ...as('worker') }),
      item({ type: 'TRIAGED', tier: input.tier, criteria: ['a works'], ...as('triager') }),
      ...(input.decisionClass !== 'accept' ? [] : [
        [{ type: 'STAND_IN_FAILED', ...orchestrator }, 'item:w/decision:w:plan:1'],
        [posted, 'item:w/decision:w:plan:1'],
        [{ type: 'PERSON_DECIDED', choice: 'approve', actor: { kind: 'person', id: 'person' }, source: { kind: 'tap', ref: 'cmsg_card' }, relayedBy: 'host' }, 'item:w/decision:w:plan:1'],
        item({ type: 'RUN_SUCCEEDED', ...as('worker') }),
        ...(input.expectationsMet ? [item({ type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'test a', ...as('reviewer') })] : []),
        item({ type: 'CHECKS_PASSED', actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref: 'delivery-1' } })
      ])
    ],
    read: (snap) => child(snap, 'w', decisionAt.split('/')[1])
  },
  // The day's audit, opened by the harness when a session picks it.
  audit: {
    to: 'audit:2026-10-26',
    setup: (input) => [started, [{ type: 'AUDIT_PICKED', day: input.day, picks: input.picks, ...orchestrator }]],
    read: (snap) => child(snap, 'audit:2026-10-26')
  }
};

// Item ids are unique, so each REQUEST_RECEIVED the walk offers names a new item; each valid AUDIT_PICKED a new day.
let k = 0;
const newDay = () => new Date(Date.UTC(2030, 0, 1) + ++k * 864e5).toISOString().slice(0, 10);
const offer = (events) => () =>
  events.map((e) =>
    e.type === 'REQUEST_RECEIVED' ? { ...e, request: { ...e.request, id: `${e.request.id}-${++k}` } }
    : e.type === 'AUDIT_PICKED' && /^\d{4}-\d{2}-\d{2}$/.test(e.day) ? { ...e, day: newDay() }
    : e
  );

// Graph states are the state value, plus the retry count for a work item (bounded by retriesLeft) and, for
// a decision or an audit, whether its card is posted (a tap is taken only after).
const serializeState = (name) => (s) =>
  JSON.stringify(name === 'workItem' ? [s.value, s.context.retries] : ['decision', 'audit'].includes(name) ? [s.value, s.context.card != null] : s.value);

// DECISION_MADE comes only from the item's own decision, so a step that makes one is delivered there:
// the stand-in fails, the host posts the card and the person taps it. With no decision open it goes to the item, which refuses it.
function deliver(store, name, event) {
  const to = homes[name].to;
  if (event.type !== 'DECISION_MADE' || event.actor) return [apply(store, event, { to })];
  const decision = child(store.read().snapshot, 'w')?.context.decisionId;
  if (!decision) return [apply(store, { ...event, ...orchestrator }, { to })];
  return [
    apply(store, { type: 'STAND_IN_FAILED', ...orchestrator }, { to: `${to}/${decision}` }),
    apply(store, posted, { to: `${to}/${decision}` }),
    apply(store, { type: 'PERSON_DECIDED', choice: event.choice, actor: { kind: 'person', id: 'person' }, source: { kind: 'tap', ref: 'cmsg_card' }, relayedBy: 'host' }, { to: `${to}/${decision}` })
  ];
}

function freshStore(name, input) {
  const store = openStore(join(scratch, `s${n++}`));
  if (name === 'decision') decisionAt = `item:w/${input.id}`;
  init(store, { wipLimit: 0 }, '2026-10-26T00:00:00Z');
  // The decision takes its autonomy from the ladder when it opens: an input at act needs a log that earned it.
  if (name === 'decision' && input.autonomy === 'act') earn(store, input.decisionClass);
  for (const [event, to] of homes[name].setup(input)) assert.ok(!apply(store, event, { to }).refused, `${name} setup ${event.type}`);
  return store;
}
const fork = (store) => {
  const dir = join(scratch, `s${n++}`);
  cpSync(store.dir, dir, { recursive: true });
  return openStore(dir);
};
const counts = (store) => [store.read().version, store.events().length, store.outbox().length];

// The runtime's actor must match the machine's snapshot. A child that reached its final state may have
// been collected by its parent (a decided decision is withdrawn), so a missing child matches a done one.
function assertSame(name, store, expected, where) {
  const got = homes[name].read(store.read().snapshot);
  if (!got) return assert.equal(expected.status, 'done', `${where}: the actor is gone but the machine is ${expected.status}`);
  assert.deepEqual(got.value, expected.value, where);
}

for (const name of ['harness', 'budget', 'workItem', 'decision', 'audit']) {
  test(`generated paths through the ${name} machine replay through apply()`, () => {
    const { inputs, events } = fixtures[name];
    const home = homes[name];
    let paths = 0;
    let edges = 0;
    const offered = offer(events);
    for (const input of inputs) {
      const graph = getShortestPaths(machines[name], { input, events: offered, serializeState: serializeState(name), limit: 5000 });
      const reached = new Set();
      for (const path of graph) {
        paths++;
        const store = freshStore(name, input);
        const steps = path.steps.slice(1); // the first step is the machine's own init
        const where = (i) => `${name} ${JSON.stringify(input)} via ${steps.slice(0, i + 1).map((s) => s.event.type).join(' > ')}`;
        let [machine] = initialTransition(machines[name], input);
        assertSame(name, store, machine, `${name} ${JSON.stringify(input)} at init`);
        steps.forEach(({ event }, i) => {
          [machine] = transition(machines[name], machine, event);
          for (const r of deliver(store, name, event)) assert.ok(!r.refused, `${where(i)}: ${r.why}`);
          assertSame(name, store, machine, where(i));
        });
        reached.add(serializeState(name)(machine));
        // Every event once more from the end: taken where the machine takes it, otherwise refused.
        // A finished actor takes nothing; a finished decision is gone from its item, so it has no address.
        if (!homes[name].read(store.read().snapshot)) continue;
        for (const event of offered()) {
          edges++;
          const forked = fork(store);
          const before = counts(forked);
          const rs = deliver(forked, name, event);
          const r = rs.at(-1);
          const label = `${where(steps.length - 1)} then ${event.type} from ${event.actor?.kind ?? 'inside'}`;
          if (machine.status === 'active' && machine.can(event)) {
            for (const x of rs) assert.ok(!x.refused, `${label}: the machine takes it, the runtime refused (${x.why})`);
            assertSame(name, forked, transition(machines[name], machine, event)[0], label);
          } else {
            assert.equal(rs.length, 1, `${label}: delivered once`);
            assert.equal(r.refused, true, `${label}: the machine refuses it, the runtime took it`);
            assert.match(r.why, new RegExp(`^refused: ${event.type} in `));
            assert.deepEqual(counts(forked), before, `${label}: a refusal writes nothing`);
            assertSame(name, forked, machine, label);
          }
        }
      }
      // The replayed paths reach every state the graph found.
      assert.deepEqual([...reached].sort(), [...new Set(graph.map((p) => serializeState(name)(p.state)))].sort(), `${name} ${JSON.stringify(input)}: states not reached`);
    }
    assert.ok(paths > 0 && edges > 0);
    console.log(`# ${name}: ${paths} paths, ${edges} extra steps`);
  });
}

test('remove the scratch stores', () => rmSync(scratch, { recursive: true, force: true }));
