// #36: worker spawns and merges pass through the machine. The workItem machine records each spawn (role, brief
// sha256, agent type, model, definition, harness version) and binds the started agent to it; a builder is not
// spawned before the verifier's brief is fixed, a verifier only with that brief; an agent sends item events only
// for the role it was spawned for; and MERGED is taken only for a head the item's verifier passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openStore, init } from '../src/index.js';
import { specs } from '../src/machines.js';
import { apply, start, decide } from './send.js';
import { tempDir } from './tmp.js';

const LEAD = 'sim-orchestrator'; // the session start() makes the orchestrator
const cli = { kind: 'cli', ref: 'harness send' };
const as = (kind, id) => ({ actor: { kind, id }, source: cli });
const lead = as('session', LEAD);
const github = (ref = 'o/r#1:merged@' + 'f'.repeat(40)) => ({ actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref } });
const H = (c) => c.repeat(64); // a sha256
const SHA = (c) => c.repeat(40); // a head sha
const BRIEF = H('b');

const ctx = (store, id = 'a') => store.read().snapshot.children[id].snapshot.context;
const stateOf = (store, id = 'a') => JSON.stringify(store.read().snapshot.children[id].snapshot.value);
const counts = (store) => [store.read().version, store.events().length];
const refused = (store, event, to = 'item:a', label = event.type) => {
  const before = counts(store);
  const r = apply(store, event, { to });
  assert.equal(r.refused, true, `${label}: expected a refusal`);
  assert.deepEqual(counts(store), before, `${label}: nothing written`);
  return r;
};
const taken = (store, event, to = 'item:a', label = event.type) => {
  const r = apply(store, event, { to });
  assert.ok(!r.refused, `${label}: ${r.why}`);
  return r;
};

const spawned = (role, { brief = BRIEF, agentType = `harness:${role}`, tool = `toolu_${role}` } = {}) => ({
  type: 'WORKER_SPAWNED', role, briefSha256: brief, agentType, model: 'opus', toolUseId: tool,
  definition: { agentType, sha256: H('d') }, harness: { version: '0.7.0', commit: null }, ...lead
});
const started = (aid, agentType) => ({ type: 'WORKER_STARTED', agent: `${LEAD}/${aid}`, agentType, ...lead });
const agent = (aid) => as('agent', `${LEAD}/${aid}`);

// An item at tier `tier` past triage (triaged by a session), with the lead as orchestrator: building at tier 0.
function building(tier = 0) {
  const store = openStore(tempDir('harness-gates-'));
  init(store);
  start(store);
  taken(store, { type: 'REQUEST_RECEIVED', request: { id: 'a' }, ...lead }, undefined);
  taken(store, { type: 'TRIAGED', tier, criteria: ['a works'], ...as('session', 'triager') });
  return store;
}
// Spawn and start one agent for `role`; returns its actor.
function worker(store, role, aid = role, opts) {
  taken(store, spawned(role, opts), 'item:a', `spawn ${role}`);
  taken(store, started(aid, opts?.agentType ?? `harness:${role}`), 'item:a', `start ${role}`);
  return agent(aid);
}
const verdict = (v, sha, by, text = `${v}\n\nall expectations hold\n\nBrief-Sha256: ${BRIEF}`) => ({ type: 'VERDICT_GIVEN', verdict: v, sha, review: 1, text, ...by });

test('the spec holds the gates: new events, guards and context, shown in SPEC.md with the host invariants', () => {
  const w = specs.workItem;
  assert.deepEqual([w.context.verifierBrief, w.context.spawns, w.context.verdicts], [null, [], {}]);
  const md = readFileSync(new URL('../spec/SPEC.md', import.meta.url), 'utf8');
  for (const g of ['noVerifierBrief', 'briefDiffers', 'unspawnedAgent', 'unverifiedHead', 'agentTypeIsNot', 'noSpawnToBind', 'verdictOverreaches'])
    assert.match(md, new RegExp('when `' + g + '`'), `SPEC.md lists the ${g} refusal`);
  for (const k of ['hookSawCall', 'roleLine', 'storeReachable', 'pinnedHead', 'reviewOnHead', 'mergeBound', 'setsHarnessAgent'])
    assert.match(md, new RegExp('^- `' + k + '`: ', 'm'), `SPEC.md names the host invariant ${k}`);
});

test('a builder spawn is refused until the verifier brief is fixed; then it is taken and recorded, and SubagentStart binds its agent', () => {
  const store = building();
  assert.match(stateOf(store), /building/);
  const r = refused(store, spawned('builder'), 'item:a', 'builder before the verifier brief');
  assert.match(r.why, /noVerifierBrief/, 'the refusal names the guard');
  refused(store, { type: 'VERIFIER_BRIEF_FIXED', sha256: 'not-a-hash', ...lead }, 'item:a', 'a malformed hash');
  refused(store, { type: 'VERIFIER_BRIEF_FIXED', sha256: BRIEF, ...agent('x') }, 'item:a', 'a subagent fixes the brief');
  taken(store, { type: 'VERIFIER_BRIEF_FIXED', sha256: BRIEF, ...lead });
  refused(store, { type: 'VERIFIER_BRIEF_FIXED', sha256: H('c'), ...lead }, 'item:a', 'a second brief replaces the first');
  assert.equal(ctx(store).verifierBrief, BRIEF);

  refused(store, spawned('builder', { agentType: 'general-purpose' }), 'item:a', 'a builder with another agent type');
  refused(store, spawned('verifier'), 'item:a', 'a verifier while building');
  refused(store, spawned('builder', { brief: 'short' }), 'item:a', 'a brief that is no sha256');
  refused(store, { ...spawned('builder'), ...agent('x') }, 'item:a', 'a subagent spawns');
  taken(store, spawned('builder', { brief: H('1') }));
  const [s] = ctx(store).spawns;
  assert.deepEqual({ ...s, at: undefined }, { role: 'builder', briefSha256: H('1'), agentType: 'harness:builder', model: 'opus', toolUseId: 'toolu_builder', definition: { agentType: 'harness:builder', sha256: H('d') }, harness: { version: '0.7.0', commit: null }, by: LEAD, at: undefined, agent: null });

  refused(store, { ...started('b1', 'harness:builder'), ...as('session', 'other') }, 'item:a', 'another session binds');
  refused(store, { ...started('b1', 'harness:verifier') }, 'item:a', 'no spawn of that agent type');
  taken(store, started('b1', 'harness:builder'));
  assert.equal(ctx(store).spawns[0].agent, `${LEAD}/b1`, 'the agent actor is recorded on the spawn');
  refused(store, started('b2', 'harness:builder'), 'item:a', 'no unbound spawn left');
});

test('an agent sends item events only for the role it was spawned for: a roleless agent sends none', () => {
  const store = building(1);
  // tier 1 waits at the plan gate; fresh item for triage below.
  const t = openStore(tempDir('harness-gates-'));
  init(t);
  start(t);
  taken(t, { type: 'REQUEST_RECEIVED', request: { id: 'a' }, ...lead }, undefined);
  refused(t, { type: 'TRIAGED', tier: 0, criteria: ['a works'], ...agent('roleless') }, 'item:a', 'a roleless agent triages');
  refused(t, spawned('builder'), 'item:a', 'a builder while triaging');
  const triager = worker(t, 'triager', 't1', { agentType: 'general-purpose' });
  taken(t, { type: 'TRIAGED', tier: 0, criteria: ['a works'], ...triager }, 'item:a', 'the spawned triager triages');

  taken(store, { type: 'STAND_IN_ANSWERED', answer: { choice: 'approve', confidence: 0.9 }, ...as('session', 'stand-in') }, `item:a/${ctx(store).decisionId}`);
  assert.ok(!decide(store, `item:a/${ctx(store).decisionId}`, 'approve').refused);
  taken(store, { type: 'VERIFIER_BRIEF_FIXED', sha256: BRIEF, ...lead });
  refused(store, { type: 'RUN_SUCCEEDED', ...agent('roleless') }, 'item:a', 'a roleless agent reports a run');
  refused(store, { type: 'RUN_FAILED', ...agent('roleless') }, 'item:a', 'a roleless agent reports a failed run');
  const builder = worker(store, 'builder', 'b1');
  taken(store, { type: 'RUN_SUCCEEDED', pr: 'https://github.com/o/r/pull/1', ...builder }, 'item:a', 'the spawned builder reports');
  refused(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'x', ...agent('roleless') }, 'item:a', 'a roleless agent checks');
  const r = refused(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'x', ...builder }, 'item:a', 'the builder checks');
  assert.match(r.why, /checkedByParty|unspawnedAgent/);
  const verifier = worker(store, 'verifier', 'v1');
  taken(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'test a', ...verifier }, 'item:a', 'the spawned verifier checks');
  // Sessions are not spawns: a reviewer session still checks.
  assert.deepEqual(ctx(store).checkers, [`${LEAD}/v1`]);
});

test('a verifier spawn takes only the fixed brief; its verdict comes from it alone, ending with that brief hash', () => {
  const store = building();
  taken(store, { type: 'VERIFIER_BRIEF_FIXED', sha256: BRIEF, ...lead });
  const builder = worker(store, 'builder', 'b1');
  taken(store, { type: 'RUN_SUCCEEDED', pr: 'https://github.com/o/r/pull/1', ...builder });
  assert.match(stateOf(store), /verifying/);
  const r = refused(store, spawned('verifier', { brief: H('e') }), 'item:a', 'a verifier with an edited brief');
  assert.match(r.why, /briefDiffers/);
  refused(store, spawned('verifier', { agentType: 'general-purpose' }), 'item:a', 'a verifier of another agent type');
  refused(store, spawned('builder'), 'item:a', 'a builder once built');
  const verifier = worker(store, 'verifier', 'v1');
  refused(store, verdict('PASS', SHA('a'), lead), 'item:a', 'the lead gives the verdict');
  refused(store, verdict('PASS', SHA('a'), builder), 'item:a', 'the builder gives the verdict');
  refused(store, verdict('PASS', SHA('a'), agent('roleless')), 'item:a', 'a roleless agent gives the verdict');
  refused(store, verdict('PASS', SHA('a'), verifier, 'PASS without the hash'), 'item:a', 'a verdict not ending with the brief hash');
  refused(store, verdict('MAYBE', SHA('a'), verifier), 'item:a', 'a verdict other than PASS or FAIL');
  refused(store, verdict('PASS', 'abc', verifier), 'item:a', 'a short sha');
  taken(store, verdict('FAIL', SHA('a'), verifier));
  assert.deepEqual(ctx(store).verdicts[SHA('a')].verdict, 'FAIL');
});

test('MERGED is taken only for a head whose latest verdict is the verifier PASS', () => {
  const store = building();
  taken(store, { type: 'VERIFIER_BRIEF_FIXED', sha256: BRIEF, ...lead });
  const builder = worker(store, 'builder', 'b1');
  taken(store, { type: 'RUN_SUCCEEDED', pr: 'https://github.com/o/r/pull/1', ...builder });
  const verifier = worker(store, 'verifier', 'v1');
  taken(store, { type: 'CHECKS_PASSED', ...github('o/r#1@' + SHA('a') + ':checks=success') });
  assert.match(stateOf(store), /merging/, 'tier 0 goes straight to merging');
  const merge = (sha) => ({ type: 'MERGED', sha, ...github() });
  assert.match(refused(store, merge(SHA('a')), 'item:a', 'no verdict').why, /unverifiedHead/);
  taken(store, verdict('PASS', SHA('a'), verifier));
  taken(store, verdict('FAIL', SHA('a'), verifier));
  refused(store, merge(SHA('a')), 'item:a', 'the latest verdict is a FAIL');
  taken(store, verdict('PASS', SHA('a'), verifier));
  refused(store, merge(SHA('c')), 'item:a', 'a PASS on an older head');
  refused(store, merge(undefined), 'item:a', 'no head named');
  taken(store, merge(SHA('a')));
  assert.match(stateOf(store), /done/);
});
