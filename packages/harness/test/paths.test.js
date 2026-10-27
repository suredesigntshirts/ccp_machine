// Generated paths: for each of the four machines, xstate/graph walks the machine definition to every
// state (shortest paths), and each path's events are replayed through runtime.apply() on a scratch store.
// After every step the stored actor must be in the state the machine reaches on the same events (pure
// transition(); the graph keeps one snapshot per state value, so its own snapshots can carry another
// path's context). From each path's end, every
// fixture event is tried once more: the runtime must take exactly what the machine takes and refuse the
// rest, writing nothing. Event payloads the guards need come from path-fixtures.json, not from hand-written paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialTransition, transition } from 'xstate';
import { getShortestPaths } from 'xstate/graph';
import { machines } from '../src/machines.js';
import { init, apply } from '../src/runtime.js';
import { openStore } from '../src/store.js';

const fixtures = JSON.parse(readFileSync(new URL('./path-fixtures.json', import.meta.url), 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'harness-paths-'));
let n = 0;

// Where each machine lives in a running harness: the address apply() sends to, the events that bring it
// into being (a work item is queued with WIP 0 so the path's own START moves it), and its stored snapshot.
const child = (snap, ...ids) => ids.reduce((s, id) => s?.children?.[id]?.snapshot, snap);
const homes = {
  harness: { to: undefined, setup: () => [], read: (snap) => snap },
  budget: { to: 'budget', setup: () => [], read: (snap) => child(snap, 'budget') },
  workItem: {
    to: 'item:w',
    setup: (input) => [[{ type: 'REQUEST_RECEIVED', request: input }]],
    read: (snap) => child(snap, 'w')
  },
  decision: {
    to: 'item:w/decision:w:plan:1',
    setup: (input) => [
      [{ type: 'REQUEST_RECEIVED', request: { id: 'w', tier: input.tier } }],
      [{ type: 'START' }, 'item:w'],
      [{ type: 'RUN_SUCCEEDED' }, 'item:w']
    ],
    read: (snap) => child(snap, 'w', 'decision:w:plan:1')
  }
};

// Item ids are unique, so each REQUEST_RECEIVED the walk offers names a new item.
let k = 0;
const offer = (events) => () => events.map((e) => (e.type === 'REQUEST_RECEIVED' ? { ...e, request: { ...e.request, id: `${e.request.id}-${++k}` } } : e));

// Graph states are the state value, plus the retry count for a work item (bounded by retriesLeft).
const serializeState = (name) => (s) => JSON.stringify(name === 'workItem' ? [s.value, s.context.retries] : s.value);

function freshStore(name, input) {
  const store = openStore(join(scratch, `s${n++}`));
  init(store, { wipLimit: 0 }, '2026-10-26T00:00:00Z');
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

for (const name of ['harness', 'budget', 'workItem', 'decision']) {
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
          const r = apply(store, event, { to: home.to });
          assert.ok(!r.refused, `${where(i)}: ${r.why}`);
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
          const r = apply(forked, event, { to: home.to });
          const label = `${where(steps.length - 1)} then ${event.type}`;
          if (machine.status === 'active' && machine.can(event)) {
            assert.ok(!r.refused, `${label}: the machine takes it, the runtime refused (${r.why})`);
            assertSame(name, forked, transition(machines[name], machine, event)[0], label);
          } else {
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
