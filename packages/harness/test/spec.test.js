// Checks of the living spec. The JSON machines are the document; these tests keep it honest:
// every name it uses is bound, no state is a dead end, and the gates and budget behave as written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActor, initialTransition, transition } from 'xstate';
import { getShortestPaths } from 'xstate/graph';
import { specs, machines, referencedNames } from '../src/machines.js';

const implemented = (machine) => ({
  actions: new Set(Object.keys(machine.implementations.actions)),
  guards: new Set(Object.keys(machine.implementations.guards)),
  actors: new Set(Object.keys(machine.implementations.actors))
});

test('the spec is plain data and every name it uses has a binding', () => {
  for (const [name, config] of Object.entries(specs)) {
    assert.deepEqual(JSON.parse(JSON.stringify(config)), config, `${name} is not plain JSON`);
    const used = referencedNames(config);
    const bound = implemented(machines[name]);
    for (const kind of ['actions', 'guards', 'actors'])
      for (const n of used[kind]) assert.ok(bound[kind].has(n), `${name}: ${kind} "${n}" is not bound`);
  }
});

test('every state that waits on the person or a gate can be left', () => {
  const visit = (node, path, name) => {
    const waits = (node.tags ?? []).some((t) => t === 'needs-human' || t === 'gated');
    if (waits) assert.ok(Object.keys(node.on ?? {}).length > 0, `${name}:${path} has no way out`);
    for (const [k, child] of Object.entries(node.states ?? {})) visit(child, `${path}.${k}`, name);
  };
  for (const [name, config] of Object.entries(specs)) visit(config, name, name);
});

const itemEvents = [
  { type: 'START' },
  { type: 'RUN_SUCCEEDED' },
  { type: 'RUN_FAILED' },
  { type: 'CHECKS_PASSED' },
  { type: 'CHECKS_FAILED' },
  { type: 'DECISION_MADE', choice: 'approve' },
  { type: 'DECISION_MADE', choice: 'revise' },
  { type: 'DECISION_MADE', choice: 'reject' },
  { type: 'BLOCK' },
  { type: 'UNBLOCKED' },
  { type: 'MERGED' },
  { type: 'MERGE_FAILED' },
  { type: 'CANCEL' }
];

// Graph states are the state value plus the retry count (bounded by the retriesLeft guard); the run
// counter grows without bound and would make the graph infinite.
const byValue = (s) => JSON.stringify([s.value, s.context.retries]);
const walkItem = (input) =>
  getShortestPaths(machines.workItem, { input, events: itemEvents, serializeState: byValue, limit: 5000 });

test('every work item state is reachable, and every tier can finish', () => {
  for (const tier of [0, 1, 2]) {
    const paths = walkItem({ id: `t${tier}`, tier });
    const reached = new Set(paths.map((p) => JSON.stringify(p.state.value)));
    assert.ok(reached.has('"done"'), `tier ${tier} cannot reach done`);
    assert.ok(reached.has('"blocked"') && reached.has('"failed"') && reached.has('"cancelled"'));
  }
  const tier2 = walkItem({ id: 'x', tier: 2 });
  assert.ok(tier2.some((p) => p.state.matches({ active: 'awaitingMergeDecision' })));
});

const step = (machine, snapshot, events) => {
  let s = snapshot;
  const effects = [];
  for (const e of events) {
    const [next, actions] = transition(machine, s, e);
    s = next;
    effects.push(...actions.map((a) => a.type + (a.params?.step ? `:${a.params.step}` : '')));
  }
  return [s, effects];
};

test('a tier-0 item runs to merge with no decision, emitting its effects as data', () => {
  const [s0] = initialTransition(machines.workItem, { id: 'a', tier: 0 });
  const [s, effects] = step(machines.workItem, s0, [
    { type: 'START' },
    { type: 'RUN_SUCCEEDED' },
    { type: 'RUN_SUCCEEDED' },
    { type: 'CHECKS_PASSED' },
    { type: 'MERGED' }
  ]);
  assert.equal(s.value, 'done');
  assert.ok(!effects.includes('openDecision'));
  for (const e of ['dispatchRun:triage', 'dispatchRun:build', 'dispatchRun:verify', 'mergePullRequest', 'reportFinished'])
    assert.ok(effects.includes(e), e);
});

const decide = (input, events) => {
  const a = createActor(machines.decision, { input }).start();
  for (const e of events) a.send(e);
  return a.getSnapshot();
};
const answer = (over) => ({ choice: 'approve', confidence: 0.95, threshold: 0.9, autonomy: 'act', ...over });

test('the stand-in decides alone only where autonomy is earned, confidence is high and tier is below 2', () => {
  const alone = decide({ tier: 1 }, [{ type: 'STAND_IN_ANSWERED', answer: answer() }]);
  assert.equal(alone.value, 'decided');
  assert.equal(alone.context.decidedBy, 'stand-in');

  for (const [why, input, ans] of [
    ['shadow mode', { tier: 1 }, answer({ autonomy: 'shadow' })],
    ['low confidence', { tier: 1 }, answer({ confidence: 0.6 })],
    ['tier 2', { tier: 2 }, answer()]
  ]) {
    const s = decide(input, [{ type: 'STAND_IN_ANSWERED', answer: ans }]);
    assert.equal(s.value, 'awaitingPerson', why);
    assert.ok(s.hasTag('needs-human'), why);
  }

  const person = decide({ tier: 2 }, [
    { type: 'STAND_IN_ANSWERED', answer: answer() },
    { type: 'PERSON_DECIDED', choice: 'revise' }
  ]);
  assert.deepEqual([person.value, person.context.choice, person.context.decidedBy], ['decided', 'revise', 'person']);
});

test('budget: 10% of the 7-day window per day, wrap up at 80% of it, stop at 100% or a full 5-hour window', () => {
  const [s0] = initialTransition(machines.budget);
  const [s1] = transition(machines.budget, s0, { type: 'DAY_STARTED', sevenDay: 0.3, fiveHour: 0 });
  const at = (sevenDay, fiveHour = 0.1) => transition(machines.budget, s1, { type: 'USAGE_SAMPLED', sevenDay, fiveHour })[0].value;
  assert.equal(at(0.35), 'normal');
  assert.equal(at(0.385), 'wrappingUp');
  assert.equal(at(0.4), 'paused');
  assert.equal(at(0.31, 0.96), 'paused');
});

test('the harness keeps at most wipLimit items in flight and pauses starts on a budget stop', () => {
  const root = createActor(machines.harness, { systemId: 'harness', input: { wipLimit: 2 } }).start();
  for (const id of ['a', 'b', 'c']) root.send({ type: 'REQUEST_RECEIVED', request: { id, project: 'web', tier: 1 } });
  let ctx = root.getSnapshot().context;
  assert.deepEqual([ctx.inFlight, ctx.queued], [['a', 'b'], ['c']]);
  assert.equal(root.system.get('item:a').getSnapshot().value.active, 'triaging');
  assert.equal(root.system.get('item:c').getSnapshot().value.active, 'queued');

  root.send({ type: 'BUDGET_MODE', mode: 'paused' });
  root.send({ type: 'ITEM_FINISHED', id: 'a' });
  ctx = root.getSnapshot().context;
  assert.deepEqual([ctx.inFlight, ctx.queued], [['b'], ['c']], 'nothing starts while halted');

  root.send({ type: 'BUDGET_MODE', mode: 'normal' });
  assert.deepEqual(root.getSnapshot().context.inFlight, ['b', 'c']);
});

test('an escalated decision shows in the person\'s inbox and leaves it when decided', () => {
  const root = createActor(machines.harness, { systemId: 'harness' }).start();
  root.send({ type: 'REQUEST_RECEIVED', request: { id: 'p', tier: 2 } });
  const item = root.system.get('item:p');
  item.send({ type: 'RUN_SUCCEEDED' }); // triage done -> plan decision opened
  const decisionId = 'decision:p:plan:1';
  const decision = item.getSnapshot().children[decisionId];
  decision.send({ type: 'STAND_IN_ANSWERED', answer: answer() });
  assert.ok(root.getSnapshot().hasTag('needs-human'));
  assert.deepEqual(root.getSnapshot().context.inbox, [decisionId]);

  decision.send({ type: 'PERSON_DECIDED', choice: 'approve' });
  assert.ok(!root.getSnapshot().hasTag('needs-human'));
  assert.deepEqual(item.getSnapshot().value, { active: 'building' });
});

test('the whole system persists to JSON and resumes, children included', () => {
  const root = createActor(machines.harness, { systemId: 'harness' }).start();
  root.send({ type: 'REQUEST_RECEIVED', request: { id: 'q', tier: 1 } });
  root.system.get('item:q').send({ type: 'RUN_SUCCEEDED' });
  const stored = JSON.parse(JSON.stringify(root.getPersistedSnapshot()));
  root.stop();
  const again = createActor(machines.harness, { systemId: 'harness', snapshot: stored }).start();
  assert.deepEqual(again.system.get('item:q').getSnapshot().value, { active: 'awaitingPlanDecision' });
  assert.ok(again.system.get('item:q').getSnapshot().children['decision:q:plan:1']);
});
