// Checks of the living spec. The JSON machines are the document; these tests keep it honest:
// every name it uses is bound, no state is a dead end, and the gates and budget behave as written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActor, initialTransition, transition } from 'xstate';
import { getShortestPaths } from 'xstate/graph';
import { readFileSync } from 'node:fs';
import { specs, machines, referencedNames } from '../src/machines.js';

const implemented = (machine) => ({
  actions: new Set(Object.keys(machine.implementations.actions)),
  guards: new Set(Object.keys(machine.implementations.guards)),
  actors: new Set(Object.keys(machine.implementations.actors))
});

// Two ways: every guard, action and actor a machine JSON names is implemented, and every implementation
// in src/machines.js is named by that machine's JSON. A spawned actor is named by its machine's spec id.
test('the spec and the bindings name the same guards, actions and actors', () => {
  const specIds = new Set(Object.values(specs).map((c) => c.id));
  for (const [name, config] of Object.entries(specs)) {
    assert.deepEqual(JSON.parse(JSON.stringify(config)), config, `${name} is not plain JSON`);
    const used = referencedNames(config);
    const bound = implemented(machines[name]);
    for (const kind of ['actions', 'guards', 'actors']) {
      for (const n of used[kind]) assert.ok(bound[kind].has(n), `${name}: ${kind} "${n}" is named in the JSON but not implemented`);
      for (const n of bound[kind])
        assert.ok(used[kind].has(n) || (kind === 'actors' && specIds.has(n)), `${name}: ${kind} "${n}" is implemented but no machine JSON names it`);
    }
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

// The parties: a worker reports runs, GitHub reports CI and merges, the person taps a card.
const worker = { actor: { kind: 'session', id: 'worker' }, source: { kind: 'cli', ref: 'harness send' } };
const github = { actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref: 'delivery-1' } };
const tap = { actor: { kind: 'person', id: 'person' }, source: { kind: 'tap', ref: 'cmsg_card' } };
const orchestrator = { actor: { kind: 'session', id: 'orchestrator' }, source: { kind: 'cli', ref: 'harness send' } };
// Triage and the criteria checks come from parties of their own: not the requester, the orchestrator or a worker.
const triager = { actor: { kind: 'session', id: 'triager' }, source: { kind: 'cli', ref: 'harness send' } };
const reviewer = { actor: { kind: 'session', id: 'reviewer' }, source: { kind: 'cli', ref: 'harness send' } };
const triaged = (tier, criteria = ['a works']) => ({ type: 'TRIAGED', tier, criteria, ...triager });
const met = (criterion = 'a works', by = reviewer) => ({ type: 'CRITERION_CHECKED', criterion, verdict: 'met', evidence: 'test a', ...by });

const itemEvents = (tier) => [
  { type: 'START' },
  triaged(tier),
  triaged(tier, []),
  met(),
  { type: 'RUN_SUCCEEDED', ...worker },
  { type: 'RUN_FAILED', ...worker },
  { type: 'CHECKS_PASSED', ...github },
  { type: 'CHECKS_FAILED', ...github },
  { type: 'DECISION_MADE', choice: 'approve' },
  { type: 'DECISION_MADE', choice: 'revise' },
  { type: 'DECISION_MADE', choice: 'reject' },
  { type: 'BLOCK' },
  { type: 'UNBLOCKED' },
  { type: 'MERGED', ...github },
  { type: 'MERGE_FAILED' },
  { type: 'CANCEL' }
];

// Graph states are the state value plus the retry count (bounded by the retriesLeft guard); the run
// counter grows without bound and would make the graph infinite.
const byValue = (s) => JSON.stringify([s.value, s.context.retries]);
const walkItem = (input, tier) =>
  getShortestPaths(machines.workItem, { input, events: itemEvents(tier), serializeState: byValue, limit: 5000 });

test('every work item state is reachable, and every tier triage can give finishes', () => {
  for (const tier of [0, 1, 2]) {
    const paths = walkItem({ id: `t${tier}`, orchestrator: 'orchestrator', requester: 'orchestrator' }, tier);
    const reached = new Set(paths.map((p) => JSON.stringify(p.state.value)));
    assert.ok(reached.has('"done"'), `tier ${tier} cannot reach done`);
    assert.ok(reached.has('"blocked"') && reached.has('"failed"') && reached.has('"cancelled"'));
    assert.ok(reached.has(JSON.stringify({ active: 'needsCriteria' })), 'no criteria is a state');
  }
  const tier2 = walkItem({ id: 'x', orchestrator: 'orchestrator' }, 2);
  assert.ok(tier2.some((p) => p.state.matches({ active: 'awaitingMergeDecision' })));
});

test('the tier comes from triage: an item does not leave triage until TRIAGED, and the filer cannot set it', () => {
  assert.equal(specs.workItem.context.tier, null, 'no tier until triage');
  const [s0] = initialTransition(machines.workItem, { id: 'a', orchestrator: 'orchestrator', requester: 'filer' });
  const [s1] = transition(machines.workItem, s0, { type: 'START' });
  assert.equal(s1.can({ type: 'RUN_SUCCEEDED', ...worker }), false, 'a run result does not leave triage');
  for (const [why, actor] of [['the requester', 'filer'], ['the orchestrator', 'orchestrator']])
    assert.equal(s1.can({ ...triaged(0), actor: { kind: 'session', id: actor } }), false, why);
  const [failed] = transition(machines.workItem, s1, { type: 'RUN_FAILED', ...worker });
  assert.equal(failed.can({ ...triaged(1), ...worker }), false, 'a worker on the item');
  for (const [why, over] of [['no tier', { tier: undefined }], ['tier 3', { tier: 3 }], ['tier as text', { tier: '0' }], ['criteria as text', { criteria: 'a works' }], ['an empty criterion', { criteria: [' '] }]])
    assert.equal(s1.can({ ...triaged(1), ...over }), false, why);
  const [s2] = transition(machines.workItem, s1, triaged(2, ['a works', 'b is refused']));
  assert.deepEqual([s2.value, s2.context.tier, s2.context.criteria], [{ active: 'awaitingPlanDecision' }, 2, ['a works', 'b is refused']]);

  // The harness refuses a request that sets the tier, the criteria or anything else the item holds.
  const [h0] = initialTransition(machines.harness);
  for (const over of [{ tier: 0 }, { criteria: ['x'] }, { checks: {} }, { workers: [] }, { requester: 'me' }, { expectationsMet: true }])
    assert.equal(h0.can({ type: 'REQUEST_RECEIVED', request: { id: 'a', ...over }, ...orchestrator }), false, JSON.stringify(over));
  assert.equal(h0.can({ type: 'REQUEST_RECEIVED', request: { title: 'no id' }, ...orchestrator }), false, 'no id');
  assert.equal(h0.can({ type: 'REQUEST_RECEIVED', request: { id: 'a', project: 'web', title: 'A', expect: 'a works' }, ...orchestrator }), true);
});

test('no criteria is a state: TRIAGED with none waits for the person, and nothing proceeds from it', () => {
  for (const criteria of [[], undefined]) {
    const [s0] = initialTransition(machines.workItem, { id: 'a', orchestrator: 'orchestrator' });
    const [s, effects] = step(machines.workItem, s0, [{ type: 'START' }, { ...triaged(0), criteria }]);
    assert.deepEqual(s.value, { active: 'needsCriteria' });
    assert.ok(s.hasTag('needs-human'));
    assert.ok(effects.includes('reportBlocked'));
    for (const e of [{ type: 'RUN_SUCCEEDED', ...worker }, triaged(0), met(), { type: 'CHECKS_PASSED', ...github }, { type: 'MERGED', ...github }, { type: 'DECISION_MADE', choice: 'approve' }])
      assert.equal(s.can(e), false, `${e.type} proceeds from needsCriteria`);
    assert.equal(transition(machines.workItem, s, { type: 'CANCEL' })[0].value, 'cancelled');
  }
});

// An item at its accept gate after a tier-1 triage, its plan approved and its build verified.
const atAccept = (checks = [], criteria = ['a works', 'b is refused']) => {
  const [s0] = initialTransition(machines.workItem, { id: 'a', orchestrator: 'orchestrator', requester: 'orchestrator' });
  return step(machines.workItem, s0, [
    { type: 'START' },
    triaged(1, criteria),
    { type: 'DECISION_MADE', choice: 'approve' },
    { type: 'RUN_SUCCEEDED', ...worker },
    ...checks,
    { type: 'CHECKS_PASSED', ...github }
  ])[0];
};

test('the accept gate: expectationsMet only when every criterion is met, with evidence, by someone who is not a worker', () => {
  const all = [met('a works'), met('b is refused')];
  const yes = atAccept(all);
  assert.deepEqual(yes.value, { active: 'awaitingAcceptance' });
  assert.equal(yes.context.expectationsMet, true);
  for (const [why, checks] of [
    ['nothing checked', []],
    ['one missing', [met('a works')]],
    ['one unmet', [met('a works'), { ...met('b is refused'), verdict: 'unmet' }]],
    ['one unclear', [met('a works'), { ...met('b is refused'), verdict: 'unclear' }]],
    ['met, then unmet', [...all, { ...met('b is refused'), verdict: 'unmet' }]]
  ])
    assert.equal(atAccept(checks).context.expectationsMet, false, why);

  // Refused outright: a worker or the orchestrator checking, an unknown criterion, met without evidence, an unknown verdict.
  const [s0] = initialTransition(machines.workItem, { id: 'a', orchestrator: 'orchestrator' });
  const [verifying] = step(machines.workItem, s0, [{ type: 'START' }, triaged(0), { type: 'RUN_SUCCEEDED', ...worker }]);
  assert.deepEqual(verifying.value, { active: 'verifying' });
  for (const [why, e] of [
    ['the worker', met('a works', worker)],
    ['the orchestrator', met('a works', orchestrator)],
    ['not a criterion', met('c')],
    ['met without evidence', { ...met(), evidence: '' }],
    ['a verdict that is not met, unmet or unclear', { ...met(), verdict: 'pass' }]
  ])
    assert.equal(verifying.can(e), false, why);
  assert.equal(verifying.can(met()), true);
  assert.equal(verifying.can({ ...met(), verdict: 'unclear', evidence: undefined }), true, 'unclear needs no evidence');

  // A reviewer who later reports a run is a worker by then, and its checks stop counting.
  const [s1] = step(machines.workItem, s0, [{ type: 'START' }, triaged(1), { type: 'DECISION_MADE', choice: 'approve' }, { type: 'RUN_SUCCEEDED', ...worker }, met('a works'), { type: 'CHECKS_FAILED', ...github }]);
  assert.deepEqual([s1.value, s1.context.checks], [{ active: 'building' }, {}], 'a new build clears the checks');

  // A check that arrives at the gate reopens the decision with the new answer.
  const late = transition(machines.workItem, atAccept([met('a works')]), met('b is refused'))[0];
  assert.deepEqual([late.value, late.context.expectationsMet, late.context.decisionId], [{ active: 'awaitingAcceptance' }, true, 'decision:a:accept:3']);
});

test('the stand-in cannot approve accept unless expectationsMet: the decision goes to the person', () => {
  for (const [why, expectationsMet, value] of [['met', true, 'decided'], ['not met', false, 'awaitingPerson'], ['unknown', null, 'awaitingPerson'], ['not given', undefined, 'awaitingPerson']]) {
    const s = decide({ ...spawned, tier: 1, decisionClass: 'accept', ...(expectationsMet !== undefined && { expectationsMet }) }, [answered()]);
    assert.equal(s.value, value, why);
  }
  assert.equal(decide({ ...spawned, tier: 1, decisionClass: 'plan' }, [answered()]).value, 'decided', 'a plan decision has no criteria to meet');
  assert.equal(decide({ ...spawned, tier: null, decisionClass: 'plan' }, [answered()]).value, 'awaitingPerson', 'an unknown tier is not below 2');
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
  const [s0] = initialTransition(machines.workItem, { id: 'a', orchestrator: 'orchestrator' });
  const [s, effects] = step(machines.workItem, s0, [
    { type: 'START' },
    triaged(0),
    { type: 'RUN_SUCCEEDED', ...worker },
    { type: 'CHECKS_PASSED', ...github },
    { type: 'MERGED', ...github }
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
const answer = (over) => ({ choice: 'approve', confidence: 0.95, ...over });
const standIn = { actor: { kind: 'session', id: 'stand-in' }, source: { kind: 'cli', ref: 'harness answer' } };
const answered = (over) => ({ type: 'STAND_IN_ANSWERED', answer: answer(over), ...standIn });
// What the work item hands a decision at spawn: the ladder's rung, the orchestrator and the item's workers.
const spawned = { autonomy: 'act', orchestrator: 'orchestrator', workers: ['worker'] };

test('the stand-in decides alone only where autonomy is earned, confidence is high and tier is below 2', () => {
  const alone = decide({ ...spawned, tier: 1 }, [answered()]);
  assert.equal(alone.value, 'decided');
  assert.equal(alone.context.decidedBy, 'stand-in');

  for (const [why, input, ans] of [
    ['shadow mode', { ...spawned, tier: 1, autonomy: 'shadow' }, answered()],
    ['recommend', { ...spawned, tier: 1, autonomy: 'recommend' }, answered()],
    ['no autonomy given at spawn', { tier: 1 }, answered()],
    ['below the machine\'s threshold', { ...spawned, tier: 1 }, answered({ confidence: 0.85 })],
    ['tier 2', { ...spawned, tier: 2 }, answered()]
  ]) {
    const s = decide(input, [ans]);
    assert.equal(s.value, 'awaitingPerson', why);
    assert.ok(s.hasTag('needs-human'), why);
  }

  const person = decide({ ...spawned, tier: 2 }, [answered(), { type: 'PERSON_DECIDED', choice: 'revise', ...tap }]);
  assert.deepEqual([person.value, person.context.choice, person.context.decidedBy], ['decided', 'revise', 'person']);
});

test('autonomy and threshold come from the machine: an answer that claims either, or lacks a confidence, is refused', () => {
  assert.deepEqual([specs.decision.context.autonomy, specs.decision.context.threshold], ['recommend', 0.9], 'the spec holds both');
  const [s0] = initialTransition(machines.decision, { ...spawned, tier: 1 });
  for (const [why, over] of [
    ['autonomy', { autonomy: 'act' }],
    ['threshold', { threshold: 0.5 }],
    ['no confidence', { confidence: undefined }],
    ['confidence over 1', { confidence: 2 }],
    ['confidence as a string', { confidence: '0.95' }],
    ['no choice', { choice: undefined }]
  ]) {
    const event = answered(over);
    if (over.confidence === undefined && 'confidence' in over) delete event.answer.confidence;
    if (over.choice === undefined && 'choice' in over) delete event.answer.choice;
    assert.equal(s0.can(event), false, why);
  }
  assert.equal(s0.can(answered({ reason: 'small' })), true, 'choice, confidence and a reason');
});

test('only the stand-in answers: not the orchestrator, not a worker on the item, not a non-session', () => {
  const [s0] = initialTransition(machines.decision, { ...spawned, tier: 1 });
  assert.equal(s0.can({ ...answered(), ...orchestrator }), false, 'the orchestrator');
  assert.equal(s0.can({ ...answered(), ...worker }), false, 'the item\'s worker');
  assert.equal(s0.can({ ...answered(), ...tap }), false, 'a person is not the stand-in');
  assert.equal(s0.can({ type: 'STAND_IN_ANSWERED', answer: answer() }), false, 'no actor');
  assert.equal(s0.can(answered()), true);

  // The work item records each run's worker and hands both ids to the decision it opens.
  const root = createActor(machines.harness, { systemId: 'harness' }).start();
  root.send({ type: 'ORCHESTRATOR_STARTED', ...orchestrator });
  root.send({ type: 'REQUEST_RECEIVED', request: { id: 'b' }, ...orchestrator });
  const item = root.system.get('item:b');
  item.send({ type: 'RUN_FAILED', actor: { kind: 'session', id: 'first-triager' }, source: worker.source });
  item.send(triaged(1));
  const d = item.getSnapshot().children['decision:b:plan:1'].getSnapshot();
  assert.deepEqual([d.context.orchestrator, d.context.workers, d.context.autonomy, d.context.threshold], ['orchestrator', ['first-triager'], 'recommend', 0.9]);
  assert.equal(d.can({ ...answered(), actor: { kind: 'session', id: 'first-triager' } }), false);
});

test('every run a worker reports, failed or succeeded, records the worker, so none of them can answer', () => {
  const root = createActor(machines.harness, { systemId: 'harness' }).start();
  root.send({ type: 'ORCHESTRATOR_STARTED', ...orchestrator });
  root.send({ type: 'REQUEST_RECEIVED', request: { id: 'f' }, ...orchestrator });
  const item = root.system.get('item:f');
  const as = (id) => ({ actor: { kind: 'session', id }, source: worker.source });
  item.send(triaged(2));
  item.send({ type: 'DECISION_MADE', choice: 'approve' });
  item.send({ type: 'RUN_FAILED', ...as('wA') });
  item.send({ type: 'RUN_SUCCEEDED', ...as('wB') });
  item.send({ type: 'CHECKS_PASSED', ...github });
  const d = item.getSnapshot().children['decision:f:accept:2'].getSnapshot();
  assert.deepEqual(d.context.workers, ['wA', 'wB']);
  assert.equal(d.can({ ...answered(), ...as('wA') }), false, 'the worker whose run failed');
  assert.equal(d.can({ ...answered(), ...as('wB') }), false);
  assert.equal(d.can(answered()), true);
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

test('budget: a 7-day window that resets mid-day keeps counting today\'s spend from 0', () => {
  const [s0] = initialTransition(machines.budget);
  let [s] = transition(machines.budget, s0, { type: 'DAY_STARTED', sevenDay: 0.9, fiveHour: 0, sevenDayResetsAt: 100 });
  const sample = (sevenDay, sevenDayResetsAt) => ([s] = transition(machines.budget, s, { type: 'USAGE_SAMPLED', sevenDay, fiveHour: 0.1, sevenDayResetsAt }));
  sample(0.94, 100);
  assert.equal(s.value, 'normal');
  sample(0.02, 200); // reset: 0.04 before it, 0.02 after
  assert.equal(s.value, 'normal');
  assert.ok(Math.abs(s.context.spentToday - 0.06) < 1e-9);
  sample(0.05, 200);
  assert.equal(s.value, 'wrappingUp', '0.09 of a 0.1 slice is past the soft limit');
  sample(0.07, 200);
  assert.equal(s.value, 'paused', 'the slice is spent, though the 7-day reading is only 7%');
});

test('budget: a stale usage reading drains new work until a fresh one arrives', () => {
  const [s0] = initialTransition(machines.budget);
  let [s] = transition(machines.budget, s0, { type: 'DAY_STARTED', sevenDay: 0.1, fiveHour: 0, at: '2026-10-26T10:00:00Z' });
  const tick = (now) => ([s] = transition(machines.budget, s, { type: 'TICK', now }));
  tick('2026-10-26T11:59:00Z');
  assert.equal(s.value, 'normal', 'under two hours old');
  tick('2026-10-26T12:01:00Z');
  assert.equal(s.value, 'wrappingUp', 'over two hours old: drain');
  [s] = transition(machines.budget, s, { type: 'USAGE_SAMPLED', sevenDay: 0.11, fiveHour: 0.1, at: '2026-10-26T12:02:00Z' });
  assert.equal(s.value, 'normal', 'a fresh reading lifts it');
  const [never] = transition(machines.budget, initialTransition(machines.budget)[0], { type: 'TICK', now: '2026-10-26T12:00:00Z' });
  assert.equal(never.value, 'wrappingUp', 'no reading at all also drains');
});

test('budget: an old reading is judged by the work since it, not by its age', () => {
  const day = (sevenDay) => transition(machines.budget, initialTransition(machines.budget)[0], { type: 'DAY_STARTED', sevenDay, fiveHour: 0, at: '2026-10-26T10:00:00Z' })[0];
  const tick = (s, now, costSince) => transition(machines.budget, s, { type: 'TICK', now, ...(costSince != null && { costSince }) })[0];
  // Idle: nothing filed since the reading, so a 5-hour-old reading still bounds spend.
  assert.equal(tick(day(0.1), '2026-10-26T15:00:00Z', 0).value, 'normal', 'an idle harness keeps accepting');
  // Busy: $50 since the reading projects 0.1 of a 0.1 slice, past the 0.8 soft limit.
  assert.equal(tick(day(0.1), '2026-10-26T15:00:00Z', 50).value, 'wrappingUp', 'a busy harness drains');
  assert.equal(tick(day(0.1), '2026-10-26T15:00:00Z', 10).value, 'normal', 'a little work stays under the limit');
  // The backstop: a day-old reading drains even when idle.
  assert.equal(tick(day(0.1), '2026-10-27T10:01:00Z', 0).value, 'wrappingUp', 'over 24 hours drains');
});

test('the harness keeps at most wipLimit items in flight and pauses starts on a budget stop', () => {
  const root = createActor(machines.harness, { systemId: 'harness', input: { wipLimit: 2 } }).start();
  for (const id of ['a', 'b', 'c']) root.send({ type: 'REQUEST_RECEIVED', request: { id, project: 'web' } });
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
  root.send({ type: 'ORCHESTRATOR_STARTED', ...orchestrator });
  root.send({ type: 'REQUEST_RECEIVED', request: { id: 'p' }, ...orchestrator });
  const item = root.system.get('item:p');
  item.send(triaged(2)); // triage done -> plan decision opened
  const decisionId = 'decision:p:plan:1';
  const decision = item.getSnapshot().children[decisionId];
  decision.send(answered());
  assert.ok(root.getSnapshot().hasTag('needs-human'));
  assert.deepEqual(root.getSnapshot().context.inbox, [decisionId]);

  decision.send({ type: 'PERSON_DECIDED', choice: 'approve', ...tap });
  assert.ok(!root.getSnapshot().hasTag('needs-human'));
  assert.deepEqual(item.getSnapshot().value, { active: 'building' });
});

test('the whole system persists to JSON and resumes, children included', () => {
  const root = createActor(machines.harness, { systemId: 'harness' }).start();
  root.send({ type: 'ORCHESTRATOR_STARTED', ...orchestrator });
  root.send({ type: 'REQUEST_RECEIVED', request: { id: 'q' }, ...orchestrator });
  root.system.get('item:q').send(triaged(1));
  const stored = JSON.parse(JSON.stringify(root.getPersistedSnapshot()));
  root.stop();
  const again = createActor(machines.harness, { systemId: 'harness', snapshot: stored }).start();
  assert.deepEqual(again.system.get('item:q').getSnapshot().value, { active: 'awaitingPlanDecision' });
  assert.ok(again.system.get('item:q').getSnapshot().children['decision:q:plan:1']);
});

test('SPEC.md is rendered from the JSON, with every state description and tag, and is current', async () => {
  const { renderSpec } = await import('../spec/render.js');
  const text = renderSpec();
  const visit = (node, path) => {
    if (node.description) assert.ok(text.includes(node.description), `${path}: description missing from SPEC.md`);
    for (const t of node.tags ?? []) assert.ok(text.includes(t), `${path}: tag ${t} missing from SPEC.md`);
    for (const [ev, on] of Object.entries(node.on ?? {}))
      for (const t of [on].flat()) if (t.description) assert.ok(text.includes(t.description), `${path} ${ev}: transition description missing from SPEC.md`);
    for (const [k, child] of Object.entries(node.states ?? {})) visit(child, `${path}.${k}`);
  };
  for (const [name, config] of Object.entries(specs)) visit(config, name);
  assert.equal(readFileSync(new URL('../spec/SPEC.md', import.meta.url), 'utf8'), text, 'run npm run spec:render');
});
