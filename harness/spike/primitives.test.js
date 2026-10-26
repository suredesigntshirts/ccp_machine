// Discovery spike: checks the XState v5 behaviours the harness design leans on, against the
// installed package rather than the docs. Each test names the design claim it backs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  createActor,
  assign,
  emit,
  fromPromise,
  sendTo,
  initialTransition,
  transition
} from 'xstate';
import { getShortestPaths, getSimplePaths } from 'xstate/graph';

// A toy "task" lifecycle: the shape a harness work item might take.
const taskMachine = setup({
  types: {
    context: {},
    input: {}
  },
  actions: {
    postToThread: (_, params) => params,
    openPullRequest: (_, params) => params
  },
  guards: {
    withinBudget: ({ context }) => context.tokensUsed < context.budget
  }
}).createMachine({
  id: 'task',
  initial: 'queued',
  context: ({ input }) => ({
    id: input.id,
    budget: input.budget,
    tokensUsed: 0
  }),
  states: {
    queued: { on: { assign: 'working' } },
    working: {
      on: {
        progress: {
          actions: assign({
            tokensUsed: ({ context, event }) => context.tokensUsed + event.tokens
          })
        },
        finish: [
          {
            guard: 'withinBudget',
            target: 'review',
            actions: { type: 'openPullRequest', params: ({ context }) => ({ task: context.id }) }
          },
          { target: 'blocked' }
        ],
        block: 'blocked'
      }
    },
    blocked: {
      entry: { type: 'postToThread', params: ({ context }) => ({ task: context.id, ask: 'unblock' }) },
      on: { unblock: 'working' }
    },
    review: { on: { approve: 'done', requestChanges: 'working' } },
    done: { type: 'final' }
  }
});

test('pure transition() returns side effects as data, so a wake-driven host can run them', () => {
  const [s0] = initialTransition(taskMachine, { id: 't1', budget: 100 });
  const [s1] = transition(taskMachine, s0, { type: 'assign' });
  const [s2] = transition(taskMachine, s1, { type: 'progress', tokens: 40 });
  const [s3, actions] = transition(taskMachine, s2, { type: 'finish' });
  assert.equal(s3.value, 'review');
  assert.deepEqual(
    actions.map((a) => [a.type, a.params]),
    [['openPullRequest', { task: 't1' }]]
  );
});

test('a snapshot survives JSON and resumes in a new actor (load, send, persist, stop per wake)', () => {
  const a = createActor(taskMachine, { input: { id: 't2', budget: 10 } }).start();
  a.send({ type: 'assign' });
  a.send({ type: 'progress', tokens: 50 });
  const stored = JSON.parse(JSON.stringify(a.getPersistedSnapshot()));
  a.stop();

  const effects = [];
  const b = createActor(
    taskMachine.provide({ actions: { postToThread: (_, p) => effects.push(p) } }),
    { snapshot: stored, input: { id: 't2', budget: 10 } }
  ).start();
  b.send({ type: 'finish' }); // over budget -> blocked, entry action runs once
  assert.equal(b.getSnapshot().value, 'blocked');
  assert.deepEqual(effects, [{ task: 't2', ask: 'unblock' }]);
});

test('deep persistence restores spawned agents, and system.get finds them by systemId', () => {
  const agent = setup({}).createMachine({
    initial: 'idle',
    states: { idle: { on: { work: 'busy' } }, busy: { on: { rest: 'idle' } } }
  });
  const orchestrator = setup({ actors: { agent } }).createMachine({
    context: { agents: [] },
    on: {
      hire: {
        actions: assign({
          agents: ({ context, spawn, event }) => [
            ...context.agents,
            spawn('agent', { id: event.name, systemId: event.name })
          ]
        })
      },
      dispatch: {
        actions: sendTo(({ system, event }) => system.get(event.name), { type: 'work' })
      }
    }
  });

  const root = createActor(orchestrator).start();
  for (const name of ['agent-1', 'agent-2', 'agent-3']) root.send({ type: 'hire', name });
  root.send({ type: 'dispatch', name: 'agent-2' });
  const stored = JSON.parse(JSON.stringify(root.getPersistedSnapshot()));
  root.stop();

  const restored = createActor(orchestrator, { snapshot: stored }).start();
  const states = restored.getSnapshot().context.agents.map((ref) => ref.getSnapshot().value);
  assert.deepEqual(states, ['idle', 'busy', 'idle']);
  assert.ok(restored.system.get('agent-3'), 'restored child is registered by systemId');
});

test('the inspect API yields an event ledger for every actor in the system', () => {
  const ledger = [];
  const a = createActor(taskMachine, {
    input: { id: 't3', budget: 100 },
    inspect: (ev) => {
      if (ev.type === '@xstate.event') ledger.push(ev.event.type);
    }
  }).start();
  a.send({ type: 'assign' });
  a.send({ type: 'progress', tokens: 5 });
  assert.deepEqual(ledger.slice(-2), ['assign', 'progress']);
});

test('emit() pushes notifications to outside listeners without a transition', () => {
  const m = setup({}).createMachine({
    on: { spend: { actions: emit(({ event }) => ({ type: 'cost', tokens: event.tokens })) } }
  });
  const seen = [];
  const a = createActor(m);
  a.on('cost', (e) => seen.push(e.tokens));
  a.start();
  a.send({ type: 'spend', tokens: 1200 });
  assert.deepEqual(seen, [1200]);
});

test('invoked promise actors model one unit of agent work with done and error paths', async () => {
  const m = setup({
    actors: { runAgent: fromPromise(async ({ input }) => ({ pr: `#${input.n}` })) }
  }).createMachine({
    initial: 'running',
    context: { result: null },
    states: {
      running: {
        invoke: {
          src: 'runAgent',
          input: { n: 7 },
          onDone: { target: 'done', actions: assign({ result: ({ event }) => event.output }) },
          onError: 'failed'
        }
      },
      done: { type: 'final' },
      failed: {}
    }
  });
  const a = createActor(m).start();
  await new Promise((r) => a.subscribe((s) => s.status === 'done' && r()));
  assert.deepEqual(a.getSnapshot().context.result, { pr: '#7' });
});

test('xstate/graph walks the model, so the spec itself can be checked for reachability', () => {
  const opts = {
    input: { id: 'g', budget: 100 },
    events: [
      { type: 'assign' },
      { type: 'finish' },
      { type: 'block' },
      { type: 'unblock' },
      { type: 'approve' },
      { type: 'requestChanges' }
    ]
  };
  const shortest = getShortestPaths(taskMachine, opts);
  const reached = new Set(shortest.map((p) => p.state.value));
  for (const s of ['queued', 'working', 'blocked', 'review', 'done']) assert.ok(reached.has(s), s);
  assert.ok(getSimplePaths(taskMachine, opts).length >= shortest.length);
});
