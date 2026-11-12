import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Host } from '../src/host.js';
import { failing } from '../src/spec.js';
import { itemSpec } from '../src/item.js';

const at = '2026-10-28T18:00:00.000Z';
const sha = (c) => c.repeat(40);
const ISSUE = { url: 'sandbox:issues/1', expect: ['multiply works'] };
const BRIEFS = { builder: 'briefs/builder.md', verifier: 'briefs/verifier.md' };
const pr = (headSha) => ({ pr: { branch: 'item/1', headSha, url: 'file:///repo#item/1' } });
const verdict = (result, at) => ({ result, sha: at, report: 'reports/r.md' });

// Every state is entered only with what it needs, so its needs hold for as long as the item stays there.
const assertNeedsHold = (host) => {
  const needs = Object.values(host.snapshot.getMeta()).flatMap((m) => m.needs ?? []);
  assert.deepEqual(failing(itemSpec, needs, { context: host.snapshot.context }), [], `needs of ${host.snapshot.value}`);
};
const accept = (host, input) => {
  const result = host.accept({ at, source: 'test', ...input });
  if (result.ok) assertNeedsHold(host);
  return result;
};
const started = () => {
  const host = new Host(itemSpec);
  assert.ok(accept(host, { event: { type: 'xstate.init', input: { issue: ISSUE } } }).ok);
  return host;
};
const openRun = (host, actor) => host.pending.find((p) => p.type === 'run' && p.actor === actor);
/** Complete the open run of actor with output; the result of accepting it. */
const finish = (host, actor, output) => {
  const r = openRun(host, actor);
  assert.ok(r, `a ${actor} run is open in ${host.snapshot.value}`);
  return accept(host, { event: { type: `xstate.done.actor.${r.id}`, output }, run: r.run });
};
const toVerifying = (head = sha('a')) => {
  const host = started();
  finish(host, 'brief', BRIEFS);
  finish(host, 'build', pr(head));
  return host;
};

test('the happy path: issue, briefs, PR, verdict on its head, approval, merge', () => {
  const host = toVerifying();
  finish(host, 'verify', verdict('PASS', sha('a')));
  assert.equal(host.snapshot.value, 'awaitingMerge');
  assert.deepEqual(openRun(host, 'ask').input.choices, ['approve', 'reject']);
  finish(host, 'ask', { choice: 'approve', by: 'stand-in' });
  assert.equal(openRun(host, 'merge').input.sha, sha('a'));
  finish(host, 'merge', { sha: sha('c') });
  assert.ok(host.done);
  assert.deepEqual(host.snapshot.output, { issue: ISSUE, ...pr(sha('a')), verdict: verdict('PASS', sha('a')), merge: { sha: sha('c') } });
  assert.deepEqual(host.pending, []);
});

test('the first build starts with a timer, and finishing it cancels the timer', () => {
  const host = started();
  const { effects } = finish(host, 'brief', BRIEFS);
  assert.deepEqual(effects.map((e) => e.type), ['timer', 'run']);
  assert.equal(effects[0].due, '2026-10-28T19:00:00.000Z');
  assert.deepEqual(finish(host, 'build', pr(sha('a'))).effects.map((e) => e.type), ['cancel', 'run']);
});

test('a FAIL sends the item back to building with the verdict, once', () => {
  const host = toVerifying();
  finish(host, 'verify', verdict('FAIL', sha('a')));
  assert.equal(host.snapshot.value, 'building');
  assert.equal(openRun(host, 'build').input.verdict.result, 'FAIL');
  finish(host, 'build', pr(sha('b')));
  finish(host, 'verify', verdict('FAIL', sha('b')));
  assert.equal(host.snapshot.value, 'replanning');
});

test('replanning takes a written five whys back to briefing with a fresh count, or drops the item', () => {
  const host = toVerifying();
  finish(host, 'verify', verdict('PASS', sha('f'))); // a verdict on another commit than the head
  assert.equal(host.snapshot.value, 'replanning');
  finish(host, 'ask', { choice: 'replan', by: 'person' }); // no why: not a replan
  assert.equal(host.snapshot.value, 'dropped');

  const again = toVerifying();
  finish(again, 'verify', verdict('PASS', sha('f')));
  finish(again, 'ask', { choice: 'replan', by: 'person', why: 'notes/why.md' });
  assert.equal(again.snapshot.value, 'briefing');
  assert.deepEqual(openRun(again, 'brief').input, { issue: ISSUE, why: 'notes/why.md' });
  assert.equal(again.snapshot.context.builds, 0);
});

test('a push while verifying restarts verification on the new head, and the old run is no longer heard', () => {
  const host = toVerifying();
  const old = openRun(host, 'verify');
  const { effects } = accept(host, { event: { type: 'pr.pushed', headSha: sha('b') }, source: 'github' });
  assert.deepEqual(effects.map((e) => e.type), ['stop', 'run']);
  assert.equal(openRun(host, 'verify').input.pr.headSha, sha('b'));
  const stale = accept(host, { event: { type: 'xstate.done.actor.verify', output: verdict('PASS', sha('a')) }, run: old.run });
  assert.match(stale.reason, /not in flight/);
});

test('a push while awaiting the merge decision withdraws the card and verifies again', () => {
  const host = toVerifying();
  finish(host, 'verify', verdict('PASS', sha('a')));
  const card = openRun(host, 'ask');
  accept(host, { event: { type: 'pr.pushed', headSha: sha('b') }, source: 'github' });
  assert.equal(host.snapshot.value, 'verifying');
  assert.match(accept(host, { event: { type: 'xstate.done.actor.ask', output: { choice: 'approve', by: 'person' } }, run: card.run }).reason, /not in flight/);
});

test('a build that outlives its timer goes to replanning, and its run is stopped', () => {
  const host = started();
  const { effects } = finish(host, 'brief', BRIEFS);
  const timer = effects.find((e) => e.type === 'timer');
  const fired = accept(host, { event: timer.event, source: 'timer' });
  assert.equal(host.snapshot.value, 'replanning');
  assert.deepEqual(fired.effects.map((e) => e.type), ['stop', 'run']);
  assert.equal(openRun(host, 'ask').input.failure, 'the build outlived buildTimeout');
  assert.match(accept(host, { event: timer.event, source: 'timer' }).reason, /no timer/);
});

test('inputs the machine would not take are refused and leave no trace', () => {
  const host = started();
  const refused = (input) => {
    const before = host.journal.length;
    const { ok, reason } = accept(host, input);
    assert.equal(ok, false);
    assert.equal(host.journal.length, before);
    return reason;
  };
  assert.match(refused({ event: { type: 'xstate.init', input: { issue: ISSUE } } }), /has started/);
  assert.match(refused({ event: { type: 'merged' } }), /not an event this machine takes/);
  assert.match(refused({ event: { type: 'pr.pushed', headSha: 'abc' } }), /does not match/);
  assert.match(refused({ event: { type: 'pr.pushed', headSha: sha('a') } }), /not taken in "briefing"/);
  assert.match(refused({ event: { type: 'xstate.done.actor.brief', output: BRIEFS }, run: '9.brief' }), /not in flight/);
  assert.match(refused({ event: { type: 'xstate.done.actor.brief', output: { builder: 'b' } }, run: '0.brief' }), /verifier is missing/);
  assert.match(new Host(itemSpec).accept({ event: { type: 'xstate.init', input: { issue: { url: 'u', expect: [] } } }, at }).reason, /fewer than 1/);
});

test('replaying the journal rebuilds the same item, and refuses one the spec no longer explains', () => {
  const host = toVerifying();
  const again = Host.replay(itemSpec, host.journal);
  assert.deepEqual(again.snapshot.context, host.snapshot.context);
  assert.deepEqual(again.pending, host.pending);
  const changed = structuredClone(itemSpec);
  changed.states.building.invoke.onDone.actions.pop(); // builds no longer counts
  assert.throws(() => Host.replay(changed, host.journal), /entry 2 replays to .*: the spec changed/);
});
