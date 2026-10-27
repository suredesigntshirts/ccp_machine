// The envelope: every event names who sent it (actor) and where it came from (source), the log keeps both
// with the harness version that applied it, and the machines' guards decide who may send what. Each case
// here is refused with nothing written: no version, event row or effect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, init, apply, ack, status, replay } from '../src/index.js';

const orchestrator = { actor: { kind: 'session', id: 'orch-1' }, source: { kind: 'cli', ref: 'harness send' } };
const worker = { actor: { kind: 'session', id: 'worker-1' }, source: { kind: 'cli', ref: 'harness send' } };
const github = { actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref: 'delivery-42' } };
const tap = { actor: { kind: 'person', id: 'person' }, source: { kind: 'tap', ref: 'cmsg_card1' } };
const fromCli = (actor) => ({ actor, source: { kind: 'cli', ref: 'harness send' } });
const triager = fromCli({ kind: 'session', id: 'triager-1' });
const reviewer = fromCli({ kind: 'session', id: 'reviewer-1' });

function fresh() {
  const store = openStore(tempDir('harness-envelope-'));
  init(store, {}, '2026-10-27T09:00:00Z');
  return store;
}
const counts = (store) => [store.read().version, store.events().length, store.outbox().length];
const state = (store, id) => status(store).items.find((i) => i.id === id)?.state;

/** Apply and require a refusal that writes nothing. */
function refused(store, event, opts, why) {
  const before = counts(store);
  const r = apply(store, event, opts);
  assert.equal(r.refused, true, `${event.type} from ${event.actor?.kind}/${event.source?.kind}: taken`);
  if (why) assert.match(r.why, why);
  assert.deepEqual(counts(store), before, `${event.type}: a refusal writes nothing`);
}

/** An item a moved to `to`: 'triaging', 'plan' (triaged tier 2, decision open, card posted), or triaged tier 0 and at 'building', 'verifying' or 'merging'. */
function itemAt(to) {
  const store = fresh();
  apply(store, { type: 'ORCHESTRATOR_STARTED', ...orchestrator }, { id: 'orchestrator-orch-1' });
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'a' }, ...orchestrator });
  if (to === 'triaging') return store;
  apply(store, { type: 'TRIAGED', tier: to === 'plan' ? 2 : 0, criteria: ['a works'], ...triager }, { to: 'item:a' });
  if (to === 'building') return store;
  if (to === 'plan') {
    apply(store, { type: 'STAND_IN_FAILED', ...orchestrator }, { to: 'item:a/decision:a:plan:1' });
    ack(store, [store.pending().find((e) => e.name === 'postDecisionCard').id], { card: tap.source.ref, by: orchestrator });
    return store;
  }
  apply(store, { type: 'RUN_SUCCEEDED', pr: 'https://github.com/o/r/pull/7', ...worker }, { to: 'item:a' });
  if (to === 'verifying') return store;
  apply(store, { type: 'CHECKS_PASSED', ...github }, { to: 'item:a' });
  return store;
}

test('an event without an actor or a source is refused, with nothing written', () => {
  const store = fresh();
  const request = { type: 'REQUEST_RECEIVED', request: { id: 'a' } };
  refused(store, request, {}, /without an actor/);
  refused(store, { ...request, actor: orchestrator.actor }, {}, /without a source/);
  refused(store, { ...request, source: orchestrator.source }, {}, /without an actor/);
  refused(store, { ...request, actor: { kind: 'robot', id: 'x' }, source: orchestrator.source }, {}, /actor/);
  refused(store, { ...request, actor: { kind: 'session', id: '' }, source: orchestrator.source }, {}, /actor/);
  refused(store, { ...request, actor: orchestrator.actor, source: { kind: 'email', ref: 'x' } }, {}, /source/);
  assert.equal(apply(store, { ...request, ...orchestrator }).refused, undefined);
});

test('the log records actor, source and the harness version that applied the event', () => {
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'a' }, ...orchestrator }, { id: 'req-a', now: '2026-10-27T09:01:00Z' });
  const [row] = store.events();
  assert.deepEqual(Object.keys(row), ['id', 'version', 'at', 'to', 'actor', 'source', 'harness', 'event']);
  assert.deepEqual([row.actor, row.source], [orchestrator.actor, orchestrator.source]);
  assert.deepEqual(row.event, { type: 'REQUEST_RECEIVED', request: { id: 'a' } }, 'the envelope is not repeated in the event');
  assert.equal(row.harness.version, '0.1.0');
  assert.ok(row.harness.commit === null || /^[0-9a-f]{40}$/.test(row.harness.commit), row.harness.commit);
});

test('replay re-applies each row with its envelope; a row from before the envelope is refused and noted', () => {
  const store = itemAt('verifying');
  const good = replay(store);
  assert.deepEqual([good.ok, good.notes], [true, []]);
  // A fixture row as the store wrote it before M1: no actor, no source.
  store.appendEvents([{ id: 'old-1', version: 6, at: '2026-10-26T12:00:00Z', to: 'item:a', event: { type: 'CHECKS_PASSED' } }]);
  assert.deepEqual(replay(store).notes, ['old-1: refused: CHECKS_PASSED without an actor']);
});

test('PERSON_DECIDED is taken only from a person through a tap with the posted card\'s message id', () => {
  const store = itemAt('plan');
  const to = { to: 'item:a/decision:a:plan:1' };
  const decide = { type: 'PERSON_DECIDED', choice: 'approve' };
  refused(store, { ...decide, ...orchestrator }, to, /refused: PERSON_DECIDED in awaitingPerson/);
  refused(store, { ...decide, ...fromCli(tap.actor) }, to, /refused/);
  refused(store, { ...decide, actor: { kind: 'timer', id: 'tick' }, source: tap.source }, to, /refused/);
  refused(store, { ...decide, actor: tap.actor, source: { kind: 'tap', ref: '' } }, to, /refused/);
  refused(store, { ...decide, actor: tap.actor, source: { kind: 'tap', ref: 'cmsg_another' } }, to, /refused: PERSON_DECIDED in awaitingPerson/);
  assert.equal(apply(store, { ...decide, ...tap }, to).refused, undefined);
  assert.equal(state(store, 'a'), 'active.building');
});

test('a run result is taken only from an actor other than the orchestrator', () => {
  const store = itemAt('building');
  refused(store, { type: 'RUN_SUCCEEDED', ...orchestrator }, { to: 'item:a' }, /refused: RUN_SUCCEEDED in active.building/);
  refused(store, { type: 'RUN_FAILED', ...orchestrator }, { to: 'item:a' }, /refused: RUN_FAILED/);
  // A new orchestrator takes over: its own reports are refused now, in items already in flight too.
  const next = { actor: { kind: 'session', id: 'orch-2' }, source: orchestrator.source };
  assert.equal(apply(store, { type: 'ORCHESTRATOR_STARTED', ...next }).refused, undefined);
  refused(store, { type: 'RUN_SUCCEEDED', ...next }, { to: 'item:a' }, /refused/);
  assert.equal(apply(store, { type: 'RUN_FAILED', ...worker }, { to: 'item:a' }).refused, undefined);
  assert.equal(apply(store, { type: 'RUN_SUCCEEDED', ...worker }, { to: 'item:a' }).refused, undefined);
  assert.equal(state(store, 'a'), 'active.verifying');
});

test('TRIAGED is taken only from a triager: not the requester, the orchestrator or a worker, and no run leaves triage', () => {
  const store = fresh();
  apply(store, { type: 'ORCHESTRATOR_STARTED', ...orchestrator }, { id: 'orchestrator-orch-1' });
  const filer = fromCli({ kind: 'session', id: 'filer-1' });
  refused(store, { type: 'REQUEST_RECEIVED', request: { id: 'a', tier: 0 }, ...filer }, {}, /refused: REQUEST_RECEIVED in /);
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'a' }, ...filer });
  const triage = { type: 'TRIAGED', tier: 1, criteria: ['a works'] };
  refused(store, { type: 'RUN_SUCCEEDED', ...worker }, { to: 'item:a' }, /refused: RUN_SUCCEEDED in active.triaging/);
  refused(store, { ...triage, ...filer }, { to: 'item:a' }, /refused: TRIAGED in active.triaging/);
  refused(store, { ...triage, ...orchestrator }, { to: 'item:a' }, /refused: TRIAGED/);
  assert.equal(apply(store, { type: 'RUN_FAILED', ...worker }, { to: 'item:a' }).refused, undefined);
  refused(store, { ...triage, ...worker }, { to: 'item:a' }, /refused: TRIAGED/);
  refused(store, { ...triage, tier: 5, ...triager }, { to: 'item:a' }, /refused: TRIAGED/);
  assert.equal(apply(store, { ...triage, ...triager }, { to: 'item:a' }).refused, undefined);
  assert.equal(state(store, 'a'), 'active.awaitingPlanDecision');
  assert.deepEqual([status(store).items[0].tier, status(store).items[0].criteria], [1, ['a works']]);
});

test('CRITERION_CHECKED is taken only from someone who is neither the orchestrator nor a worker', () => {
  const store = itemAt('verifying');
  const check = { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'test a' };
  refused(store, { ...check, ...worker }, { to: 'item:a' }, /refused: CRITERION_CHECKED in active.verifying/);
  refused(store, { ...check, ...orchestrator }, { to: 'item:a' }, /refused: CRITERION_CHECKED/);
  refused(store, { ...check, criterion: 'b works', ...reviewer }, { to: 'item:a' }, /refused: CRITERION_CHECKED/);
  assert.equal(apply(store, { ...check, ...reviewer }, { to: 'item:a' }).refused, undefined);
  assert.deepEqual(status(store).items[0].checks, { 'a works': { verdict: 'met', evidence: 'test a', by: 'reviewer-1' } });
});

test('a run result is refused while no orchestrator is known, and only a session can start one', () => {
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'a' }, ...orchestrator });
  refused(store, { type: 'RUN_SUCCEEDED', ...worker }, { to: 'item:a' }, /refused/);
  refused(store, { type: 'ORCHESTRATOR_STARTED', ...tap }, {}, /refused: ORCHESTRATOR_STARTED/);
  refused(store, { type: 'ORCHESTRATOR_STARTED', orchestrator: 'worker-1', ...orchestrator }, { to: 'item:a' }, /refused/);
  refused(store, { type: 'TRIAGED', tier: 0, criteria: ['a works'], ...triager }, { to: 'item:a' }, /refused/);
  apply(store, { type: 'ORCHESTRATOR_STARTED', ...orchestrator });
  assert.equal(apply(store, { type: 'TRIAGED', tier: 0, criteria: ['a works'], ...triager }, { to: 'item:a' }).refused, undefined, 'a queued or running item learns the orchestrator');
  assert.equal(apply(store, { type: 'RUN_SUCCEEDED', ...worker }, { to: 'item:a' }).refused, undefined);
});

test('CI and merge results are taken only from a GitHub wake with a delivery id', () => {
  for (const type of ['CHECKS_PASSED', 'CHECKS_FAILED']) {
    const store = itemAt('verifying');
    refused(store, { type, ...orchestrator }, { to: 'item:a' }, new RegExp(`refused: ${type} in active.verifying`));
    refused(store, { type, ...fromCli(github.actor) }, { to: 'item:a' });
    refused(store, { type, actor: github.actor, source: { kind: 'github-wake', ref: '' } }, { to: 'item:a' });
    refused(store, { type, actor: tap.actor, source: github.source }, { to: 'item:a' });
    assert.equal(apply(store, { type, ...github }, { to: 'item:a' }).refused, undefined, type);
  }
  const store = itemAt('merging');
  refused(store, { type: 'MERGED', ...orchestrator }, { to: 'item:a' }, /refused: MERGED in active.merging/);
  refused(store, { type: 'MERGED', actor: github.actor, source: { kind: 'github-wake', ref: '' } }, { to: 'item:a' });
  assert.equal(apply(store, { type: 'MERGED', ...github }, { to: 'item:a' }).refused, undefined);
  assert.equal(state(store, 'a'), 'done');
});

test('events the machines send each other are refused from outside', () => {
  const store = itemAt('plan');
  refused(store, { type: 'DECISION_MADE', choice: 'approve', ...orchestrator }, { to: 'item:a' }, /refused: DECISION_MADE in active.awaitingPlanDecision/);
  refused(store, { type: 'DECISION_MADE', choice: 'approve', ...tap }, { to: 'item:a' });
  refused(store, { type: 'BUDGET_MODE', mode: 'normal', ...orchestrator }, {}, /refused: BUDGET_MODE/);
});

test('harness send needs --actor and --source for a guarded event, and never makes up a person', () => {
  const store = itemAt('plan');
  const bin = new URL('../bin/harness.js', import.meta.url).pathname;
  const run = (...args) => spawnSync(process.execPath, [bin, ...args, '--dir', store.dir], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'orch-1' } });
  const to = ['--to', 'item:a/decision:a:plan:1'];
  const bare = run('send', '{"type":"PERSON_DECIDED","choice":"approve"}', ...to);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /PERSON_DECIDED needs --actor .* --source/);
  assert.equal(store.events().length, 5, 'nothing written');
  const ok = run('send', '{"type":"PERSON_DECIDED","choice":"approve"}', ...to, '--actor', 'person:person', '--source', 'tap:cmsg_card1');
  assert.equal(ok.status, 0, ok.stderr);
  const row = store.events().at(-1);
  assert.deepEqual([row.actor, row.source], [tap.actor, tap.source]);
  // An unguarded event takes the session it runs in, from the CLI.
  run('send', '{"type":"BLOCK","reason":"waiting"}', '--to', 'item:a');
  assert.deepEqual([store.events().at(-1).actor, store.events().at(-1).source.kind], [{ kind: 'session', id: 'orch-1' }, 'cli']);
});

test('harness send refuses to speak for GitHub: --source github-wake and --actor github are from-github\'s alone', () => {
  const store = itemAt('verifying');
  const bin = new URL('../bin/harness.js', import.meta.url).pathname;
  const run = (...args) => spawnSync(process.execPath, [bin, ...args, '--dir', store.dir], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'orch-1' } });
  const before = counts(store);
  for (const flags of [
    ['--actor', 'github:github', '--source', 'github-wake:delivery-1'],
    ['--actor', 'session:worker-1', '--source', 'github-wake:o/r#7@abc'],
    ['--actor', 'github:github', '--source', 'cli:x']
  ]) {
    const r = run('send', '{"type":"CHECKS_PASSED"}', '--to', 'item:a', ...flags);
    assert.equal(r.status, 1, flags.join(' '));
    assert.match(r.stderr, /^harness: .*only harness from-github .*GitHub/m, flags.join(' '));
    assert.equal(r.stdout, '');
  }
  assert.deepEqual(counts(store), before, 'nothing written');
  assert.match(state(store, 'a'), /verifying/);
});

test('mission control\'s Answer hint is a command harness send takes', async () => {
  const { renderPage } = await import('../src/index.js');
  const store = itemAt('plan');
  const html = renderPage(status(store), { events: store.events(), pending: store.pending() });
  const code = /Answer[^<]*<code>(harness send [^<]+)<\/code>/.exec(html)?.[1];
  assert.ok(code, 'the hint is on the page');
  const unescaped = code.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  // Fill the placeholders the person fills, then run it as written.
  const filled = unescaped.replace(/<[^>]+>/g, (p) => (/card|message/.test(p) ? 'cmsg_card1' : 'person'));
  const [, json, rest] = /^harness send '([^']+)' (.+)$/.exec(filled);
  const bin = new URL('../bin/harness.js', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [bin, 'send', json, ...rest.split(/\s+/), '--dir', store.dir], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'orch-1' } });
  assert.equal(r.status, 0, `${filled}\n${r.stderr}`);
  const row = store.events().at(-1);
  assert.deepEqual([row.event.type, row.actor.kind, row.source], ['PERSON_DECIDED', 'person', { kind: 'tap', ref: 'cmsg_card1' }]);
});

test('pages:check and sim write to a temp folder by default, never the Library', () => {
  for (const f of ['pages-check.mjs', 'sim.mjs'])
    assert.doesNotMatch(readFileSync(new URL(`../scripts/${f}`, import.meta.url), 'utf8'), /\/mnt\/project-files/, f);
  // The child's temp folder is one of ours, so its scratch stores go when this test file ends.
  const tmp = tempDir('harness-sim-');
  const r = spawnSync(process.execPath, [new URL('../scripts/sim.mjs', import.meta.url).pathname, '--items', '3'], { encoding: 'utf8', env: { ...process.env, TMPDIR: tmp } });
  assert.equal(r.status, 0, r.stderr);
  const page = /busy page: (.+)/.exec(r.stdout)?.[1];
  assert.ok(page?.startsWith(tmp), page);
});
