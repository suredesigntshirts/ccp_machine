import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { spawnSync } from 'node:child_process';
import { openStore, init, ack, status, readDecisionLog, logPrecedents, apply as applyEvent, doctor } from '../src/index.js';
import { apply, start, earn } from './send.js';

const bin = new URL('../bin/harness.js', import.meta.url).pathname;
// Each call runs as the session it names (--actor session:<id>), else the orchestrator's: the CLI takes the id from the platform.
const sessionOf = (args) => /^session:(.+)$/.exec(args[args.indexOf('--actor') + 1] ?? '')?.[1] ?? 'orchestrator-session';
const harness = (dir, ...args) => spawnSync(process.execPath, [bin, ...args, '--dir', dir], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionOf(args) } });
const pendingNames = (store) => store.pending().map((e) => e.name);

test('one command answers a pending plan or accept decision and acks its ask', () => {
  const dir = tempDir('harness-');
  const store = openStore(dir);
  init(store);
  start(store);
  // The stand-in has earned act on accept gates, so the machine's own rule is all that sends an accept to the person.
  earn(store, 'accept');
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'x', expect: 'a works' } });
  ack(store, store.pending().map((e) => e.id));
  apply(store, { type: 'RUN_FAILED' }, { to: 'item:x' }); // the worker's triage run fails: it is one of the item's workers
  ack(store, store.pending().map((e) => e.id));
  apply(store, { type: 'TRIAGED', tier: 1, criteria: ['a works'] }, { to: 'item:x' });
  assert.deepEqual(pendingNames(store), ['askStandIn']);

  assert.match(harness(dir, 'answer', 'x', '--approve').stderr, /--reason/);
  // The caller cannot set the gate's rules: --autonomy and --threshold are gone, and a confidence is required.
  for (const flag of ['--autonomy', '--threshold']) {
    const r = harness(dir, 'answer', 'x', '--approve', '--reason', 'standing authority', '--confidence', '0.95', flag, 'act', '--actor', 'session:stand-in');
    assert.equal(r.status, 2, flag);
    assert.match(r.stderr, new RegExp(`Unknown option '${flag}'`));
  }
  assert.match(harness(dir, 'answer', 'x', '--approve', '--reason', 'sure', '--actor', 'session:stand-in').stderr, /refused: STAND_IN_ANSWERED/, 'no confidence, no default');
  // Only the stand-in answers: not the orchestrator, not the worker that ran the item.
  for (const who of ['sim-orchestrator', 'sim-worker'])
    assert.match(harness(dir, 'answer', 'x', '--approve', '--reason', 'mine', '--confidence', '0.95', '--actor', `session:${who}`).stderr, /refused: STAND_IN_ANSWERED/, who);
  assert.ok(pendingNames(store).includes('askStandIn'), 'nothing refused was taken');

  const plan = harness(dir, 'answer', 'x', '--approve', '--reason', 'small and covered', '--confidence', '0.95', '--actor', 'session:stand-in');
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).subject, 'decision:x:plan:1');
  assert.ok(!pendingNames(store).includes('askStandIn'), 'the ask is acked');
  assert.deepEqual(store.events().at(-1).event.answer, { choice: 'approve', confidence: 0.95, reason: 'small and covered' }, 'the answer carries no rules');
  const [d] = status(store).items[0].decisions;
  assert.deepEqual([d.autonomy, d.state], ['recommend', 'awaitingPerson'], 'at the ladder\'s recommend the person decides');
  apply(store, { type: 'PERSON_DECIDED', choice: 'approve' }, { to: d.address });
  logPrecedents(store);
  assert.deepEqual([readDecisionLog(store).at(-1).choice, readDecisionLog(store).at(-1).autonomy], ['approve', 'recommend']);

  ack(store, store.pending().map((e) => e.id));
  apply(store, { type: 'RUN_SUCCEEDED', pr: 'https://github.com/o/r/pull/1' }, { to: 'item:x' });
  apply(store, { type: 'CHECKS_PASSED' }, { to: 'item:x' });
  // No criterion checked: at act and 0.95 the stand-in still cannot approve accept, so the person decides.
  const unchecked = harness(dir, 'answer', 'x', '--approve', '--reason', 'green', '--confidence', '0.95', '--actor', 'session:stand-in');
  assert.equal(unchecked.status, 0, unchecked.stderr);
  const accept = status(store).items[0].decisions.find((d) => d.decisionClass === 'accept');
  assert.deepEqual([accept.id, accept.autonomy, accept.state], ['decision:x:accept:2', 'act', 'awaitingPerson']);
  assert.ok(pendingNames(store).includes('postDecisionCard'));
  assert.match(harness(dir, 'answer', 'x', '--approve', '--reason', 'again', '--confidence', '0.95', '--actor', 'session:stand-in').stderr, /no pending stand-in question/);
  // A reviewer checks the criterion met: the gate reopens the decision, and now the stand-in may approve.
  assert.equal(harness(dir, 'send', '{"type":"CRITERION_CHECKED","criterion":"a works","verdict":"met","evidence":"test a"}', '--to', 'item:x', '--actor', 'session:sim-worker').status, 1, 'not the worker');
  const checked = harness(dir, 'send', '{"type":"CRITERION_CHECKED","criterion":"a works","verdict":"met","evidence":"test a"}', '--to', 'item:x', '--actor', 'session:reviewer');
  assert.equal(checked.status, 0, checked.stderr);
  const met = harness(dir, 'answer', 'x', '--approve', '--reason', 'every criterion met', '--confidence', '0.95', '--actor', 'session:stand-in');
  assert.equal(met.status, 0, met.stderr);
  assert.equal(JSON.parse(met.stdout).subject, 'decision:x:accept:3');
  assert.equal(status(store).items[0].state, 'active.merging', 'the stand-in approved accept alone, tier 1 merges');
});

// #63: a re-asked decision (REASK_UNDER_GRANT) has a second askStandIn; harness answer must answer that ask, not
// collide with the first answer's id, and an answer the store drops as a duplicate must ack nothing.
const viaCli = { actor: { kind: 'session', id: 'sim-orchestrator' }, source: { kind: 'cli', ref: 'harness send' } };
function reasked() {
  const dir = tempDir('harness-reask-');
  const store = openStore(dir);
  init(store, { wipLimit: 4 });
  start(store);
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'r' } });
  ack(store, store.pending().filter((e) => e.name === 'dispatchRun').map((e) => e.id));
  apply(store, { type: 'RUN_FAILED' }, { to: 'item:r' });
  apply(store, { type: 'TRIAGED', tier: 2, criteria: ['a works'] }, { to: 'item:r' });
  // The first answer, before any grant, goes to the person.
  const first = harness(dir, 'answer', 'r', '--approve', '--reason', 'looks right', '--confidence', '0.85', '--actor', 'session:stand-in');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(status(store).items[0].decisions[0].state, 'awaitingPerson');
  const granted = applyEvent(store, { type: 'PERSON_GRANTED', picks: ['kind:plan', 'kind:accept', 'kind:merge', 'one-way'], actor: { kind: 'person', id: 'sd' }, source: { kind: 'message', ref: 'cmsg_grant' }, relayedBy: 'sim-orchestrator' });
  assert.equal(granted.refused, undefined, granted.why);
  const r = applyEvent(store, { type: 'REASK_UNDER_GRANT', decision: 'decision:r:plan:1', ...viaCli }, { id: 'reask-r-plan-1' });
  assert.equal(r.refused, undefined, r.why);
  const ask = store.pending().find((e) => e.name === 'askStandIn');
  assert.equal(ask.id, 'reask-r-plan-1.0');
  return { dir, store, ask };
}

test('harness answer on a re-asked decision records the new answer and routes it, once', () => {
  const { dir, store, ask } = reasked();
  const call = ['answer', 'r', '--reject', '--reason', 'the plan misses the ledger', '--confidence', '0.95', '--actor', 'session:stand-in'];
  const out = harness(dir, ...call);
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout);
  assert.equal(r.duplicate, false, 'the second answer to one decision is not the first one replayed');
  assert.equal(r.id, `standin-${ask.id}`, 'the answer id names the ask it answers');
  assert.deepEqual(r.acked, [ask.id]);
  const last = store.events().at(-1);
  assert.deepEqual([last.id, last.event.type, last.event.answer.choice], [`standin-${ask.id}`, 'STAND_IN_ANSWERED', 'reject']);
  // Routed under the grant: decided, out of the inbox, on the granted list.
  assert.deepEqual(store.read().snapshot.context.granted.map((g) => [g.item, g.choice]), [['r', 'reject']]);
  assert.deepEqual(store.read().snapshot.context.inbox, []);
  assert.ok(!pendingNames(store).includes('askStandIn'), 'the re-ask is acked');
  // The same CLI call again writes nothing: its ask is answered.
  const v = store.read().version;
  const again = harness(dir, ...call);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /no pending stand-in question/);
  assert.equal(store.read().version, v);
});

test('an answer the store treats as a duplicate acks nothing and says so', () => {
  const { dir, store, ask } = reasked();
  // A call that recorded its answer and stopped before the ack: the retry is the duplicate.
  const by = { actor: { kind: 'session', id: 'stand-in' }, source: { kind: 'cli', ref: 'harness answer' } };
  const recorded = applyEvent(store, { type: 'STAND_IN_ANSWERED', answer: { choice: 'reject', confidence: 0.95, reason: 'first try' }, ...by }, { to: 'item:r/decision:r:plan:1', id: `standin-${ask.id}` });
  assert.equal(recorded.refused, undefined, recorded.why);
  const v = store.read().version;
  const out = harness(dir, 'answer', 'r', '--reject', '--reason', 'first try', '--confidence', '0.95', '--actor', 'session:stand-in');
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout);
  assert.equal(r.duplicate, true);
  assert.deepEqual(r.acked, [], 'nothing acked');
  assert.match(r.note, /duplicate/);
  assert.equal(store.read().version, v, 'nothing written');
  assert.ok(store.pending().some((e) => e.id === ask.id), 'the ask is left as it was');
});

test('harness doctor flags a decision in askingStandIn with no pending askStandIn effect', async () => {
  const { store, ask } = reasked();
  const stuck = (r) => r.problems.filter((p) => /askingStandIn/.test(p));
  assert.deepEqual(stuck(await doctor(store, { verify: false })), [], 'its ask is pending');
  // What #63 left behind: the ask acked while the answer was dropped.
  ack(store, [ask.id], { note: 'stand-in answered reject' });
  const r = await doctor(store, { verify: false });
  assert.equal(r.ok, false);
  assert.deepEqual(stuck(r), ['item:r/decision:r:plan:1 is in askingStandIn with no pending askStandIn effect (meta.waitsOn)']);
});
