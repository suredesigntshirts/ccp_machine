// #83: a FAIL verdict sends the item back to building (spec workItem, verifying: VERDICT_GIVEN with verdict FAIL), so
// the builder's round-2 run is recorded as a build, it clears the round-1 checks, and a verifier spawned with the
// brief fixed before round 1 checks it. Seen on dogfood2: gate-word-match (PR #72) had its round-2 RUN_SUCCEEDED
// refused in verifying. Every event goes through the real CLI on a scratch store, from the party that sends it for
// real, except CI: from-github sends CHECKS_PASSED only after reading GitHub, so the test applies that fact as
// from-github would, with the GitHub actor and the fact as ref.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore } from '../src/index.js';
import { apply } from '../src/runtime.js';
import { tempDir } from './tmp.js';

const bin = new URL('../bin/harness.js', import.meta.url).pathname;
const LIB = tempDir('harness-lib-fail-reopens-building-');
const LEAD = 'lead';
const BRIEF = 'b'.repeat(64);
const OTHER_BRIEF = 'd'.repeat(64);
const HEAD1 = '1'.repeat(40);
const HEAD2 = '2'.repeat(40);
const PR = 'https://github.com/o/r/pull/7';

let calls = 0;
// The plugin's PreToolUse hook's record of a subagent's call (as in agent-actors.test.js): HARNESS_CALL as it stamps it.
const recordCall = (aid) => {
  const key = randomBytes(16).toString('hex');
  const id = `toolu_fail_${++calls}`;
  const dir = join(LIB, 'ledger', 'sessions', LEAD, 'calls');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ sessionId: LEAD, toolUseId: id, at: new Date().toISOString(), kind: 'bash', agentId: aid, keySha256: createHash('sha256').update(key).digest('hex'), enforced: false }));
  return `${id}:${key}`;
};
const run = (env, ...args) => {
  const e = { ...process.env, HARNESS_LIBRARY_DIR: LIB, CLAUDE_CODE_SESSION_ID: LEAD, ...env };
  for (const k of ['HARNESS_AGENT', 'HARNESS_CALL', 'HARNESS_ENFORCE', 'HARNESS_DIR']) if (!(k in env)) delete e[k];
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: e });
};
const lead = {};
const sub = (aid, type) => ({ HARNESS_AGENT: `${aid}:${type}`, HARNESS_CALL: recordCall(aid) });

function send(dir, env, event, to = 'item:a', ...more) {
  const r = run(env, 'send', JSON.stringify(event), '--to', to, '--dir', dir, ...more);
  return { ok: r.status === 0, out: r.stdout + r.stderr };
}
const ok = (dir, env, event, to, ...more) => {
  const r = send(dir, env, event, to, ...more);
  assert.ok(r.ok, `${event.type}: ${r.out}`);
};
const spawn = (dir, role, aid, brief = BRIEF) => {
  const type = role === 'triager' ? 'general-purpose' : `harness:${role}`;
  ok(dir, lead, { type: 'WORKER_SPAWNED', role, briefSha256: brief, agentType: type });
  ok(dir, lead, { type: 'WORKER_STARTED', agent: `${LEAD}/${aid}`, agentType: type });
};
const statusOf = (dir) => JSON.parse(run(lead, 'status', '--dir', dir).stdout).items.find((i) => i.id === 'a');
const ctx = (dir) => openStore(dir).read().snapshot.children.a.snapshot.context;
// The stand-in subagent answers the item's open decision (harness answer); the person then taps approve on its card,
// posted (acked with its message id) first.
function approve(dir, gate) {
  const a0 = run(sub('s1', 'general-purpose'), 'answer', 'a', '--approve', '--reason', 'small', '--confidence', '0.9', '--dir', dir);
  assert.equal(a0.status, 0, a0.stdout + a0.stderr);
  const effects = JSON.parse(run(lead, 'effects', '--dir', dir).stdout);
  const card = effects.find((e) => e.name === 'postDecisionCard' && String(e.subject).includes(`:${gate}:`));
  assert.ok(card, `a ${gate} card is asked for`);
  const cmsg = `cmsg_${gate}_card`;
  const a = run(lead, 'ack', card.id, '--card', cmsg, '--dir', dir);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  ok(dir, lead, { type: 'PERSON_DECIDED', choice: 'approve' }, `item:a/${card.subject}`, '--actor', 'person:sd', '--source', `tap:${cmsg}`);
}
// CI passing on head, as from-github records it after reading GitHub.
function ci(dir, sha) {
  const r = apply(openStore(dir), { type: 'CHECKS_PASSED', sha: sha.slice(0, 7), actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref: `o/r#7@${sha}:checks=success` } }, { to: 'item:a' });
  assert.equal(r.refused, undefined, r.why);
}
const verdict = (verdict, sha, review) => ({ type: 'VERDICT_GIVEN', verdict, sha, review, text: `${verdict}\n\nround on ${sha.slice(0, 7)}\n\nBrief-Sha256: ${BRIEF}` });

test('#83: FAIL in round 1 reopens building; the builder\'s round-2 run, fresh checks and a PASS reach accept, through the CLI', () => {
  const dir = tempDir('harness-fail-reopens-building-');
  assert.equal(run(lead, 'init', '--dir', dir).status, 0);
  ok(dir, lead, { type: 'REQUEST_RECEIVED', request: { id: 'a' } }, 'harness');
  spawn(dir, 'triager', 't1');
  ok(dir, sub('t1', 'general-purpose'), { type: 'TRIAGED', tier: 1, criteria: ['a works'] });
  spawn(dir, 'stand-in', 's1');
  approve(dir, 'plan');
  ok(dir, lead, { type: 'VERIFIER_BRIEF_FIXED', sha256: BRIEF });
  spawn(dir, 'builder', 'b1');
  const builder = () => sub('b1', 'harness:builder');

  // Round 1: built, CI green, the verifier finds the criterion unmet and fails the head.
  ok(dir, builder(), { type: 'RUN_SUCCEEDED', pr: PR });
  spawn(dir, 'verifier', 'v1');
  ci(dir, HEAD1);
  ok(dir, sub('v1', 'harness:verifier'), { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'unmet', evidence: 'test a fails' });
  const before = ctx(dir);
  ok(dir, sub('v1', 'harness:verifier'), verdict('FAIL', HEAD1, 101));
  assert.equal(statusOf(dir).state, 'active.building', 'a FAIL verdict reopens building');
  const after = ctx(dir);
  for (const k of ['tier', 'criteria', 'verifierBrief', 'workers', 'requester', 'triagers', 'checkers', 'answerers', 'spawns', 'orchestrator'])
    assert.deepEqual(after[k], before[k], `${k} is kept`);
  assert.deepEqual(after.workers, [`${LEAD}/b1`]);
  assert.equal(after.verdicts[HEAD1].verdict, 'FAIL', 'the FAIL is recorded');
  assert.deepEqual([after.checks, after.checksPassed], [{}, null], 'the new build starts with no check and no CI head');

  // Round 2: the same builder agent reports the fixed head; no new brief is fixed.
  ok(dir, builder(), { type: 'RUN_SUCCEEDED', pr: PR });
  assert.equal(statusOf(dir).state, 'active.verifying', 'the round-2 run is recorded as a build');
  assert.equal(ctx(dir).runs, 2);
  assert.ok(!send(dir, lead, { type: 'WORKER_SPAWNED', role: 'verifier', briefSha256: OTHER_BRIEF, agentType: 'harness:verifier' }).ok, 'a verifier with another brief is refused');
  spawn(dir, 'verifier', 'v2');
  assert.equal(ctx(dir).verifierBrief, BRIEF, 'the brief fixed before round 1 is the one');
  ok(dir, sub('v2', 'harness:verifier'), { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'test a passes' });
  ci(dir, HEAD2);
  ok(dir, sub('v2', 'harness:verifier'), verdict('PASS', HEAD2, 102));
  assert.equal(statusOf(dir).state, 'active.awaitingAcceptance');
  assert.equal(ctx(dir).expectationsMet, true, 'round 2\'s check counts; round 1\'s unmet was cleared');

  approve(dir, 'accept');
  assert.equal(statusOf(dir).state, 'active.awaitingMergeDecision', 'accepted');
  const r = run(lead, 'replay', '--dir', dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
