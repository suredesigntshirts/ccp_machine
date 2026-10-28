// #100: at a decision the stand-in holds, it answers with any of the decision's options (spec decision, context.options
// and the choiceNotOffered guard on STAND_IN_ANSWERED), the same the person's card offers. Revise sends the item back to
// building, as a person's revise tap does; reject cancels it. Seen on dogfood2: replay-facts (PR #98) conflicted with
// main at its land gate, and the stand-in holding that gate had no way to send it back to its builder. Every event goes
// through the real CLI on a scratch store, from the party that sends it for real, except CI and the person's grant,
// applied as from-github and the host record them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore } from '../src/index.js';
import { apply } from '../src/runtime.js';
import { tempDir } from './tmp.js';

const bin = new URL('../bin/harness.js', import.meta.url).pathname;
const LIB = tempDir('harness-lib-standin-revise-');
const LEAD = 'lead';
const BRIEF = 'b'.repeat(64);
const HEAD = '1'.repeat(40);
const PR = 'https://github.com/o/r/pull/7';

let calls = 0;
// The plugin's PreToolUse hook's record of a subagent's call (as in agent-actors.test.js): HARNESS_CALL as it stamps it.
const recordCall = (aid) => {
  const key = randomBytes(16).toString('hex');
  const id = `toolu_revise_${++calls}`;
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
const standIn = () => sub('s1', 'general-purpose');
const builder = (aid = 'b1') => sub(aid, 'harness:builder');
const verifier = () => sub('v1', 'harness:verifier');

function send(dir, env, event, to = 'item:a', ...more) {
  const r = run(env, 'send', JSON.stringify(event), '--to', to, '--dir', dir, ...more);
  return { ok: r.status === 0, out: r.stdout + r.stderr };
}
const ok = (dir, env, event, to, ...more) => {
  const r = send(dir, env, event, to, ...more);
  assert.ok(r.ok, `${event.type}: ${r.out}`);
};
const spawn = (dir, role, aid) => {
  const type = role === 'triager' || role === 'stand-in' ? 'general-purpose' : `harness:${role}`;
  ok(dir, lead, { type: 'WORKER_SPAWNED', role, briefSha256: BRIEF, agentType: type });
  ok(dir, lead, { type: 'WORKER_STARTED', agent: `${LEAD}/${aid}`, agentType: type });
};
const statusOf = (dir) => JSON.parse(run(lead, 'status', '--dir', dir).stdout).items.find((i) => i.id === 'a');
const answer = (dir, env, choice, ...more) => run(env, 'answer', 'a', `--${choice}`, '--reason', `${choice}: the stand-in's call`, '--confidence', '0.9', '--dir', dir, ...more);
const answered = (dir, choice) => {
  const r = answer(dir, standIn(), choice);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout);
};

// Item a, tier 2 (so it has a land gate), under the person's grant for every class and the one-way door: the
// stand-in decides plan and accept alone, and the item waits at its land gate on the stand-in.
function atLandGate() {
  const dir = tempDir('harness-standin-revise-');
  assert.equal(run(lead, 'init', '--dir', dir).status, 0);
  const g = apply(openStore(dir), { type: 'PERSON_GRANTED', picks: ['kind:plan', 'kind:accept', 'kind:merge', 'one-way'], actor: { kind: 'person', id: 'sd' }, source: { kind: 'message', ref: 'cmsg_grant' }, relayedBy: LEAD });
  assert.equal(g.refused, undefined, g.why);
  ok(dir, lead, { type: 'REQUEST_RECEIVED', request: { id: 'a' } }, 'harness');
  spawn(dir, 'triager', 't1');
  ok(dir, sub('t1', 'general-purpose'), { type: 'TRIAGED', tier: 2, criteria: ['a works'] });
  spawn(dir, 'stand-in', 's1');
  answered(dir, 'approve');
  assert.equal(statusOf(dir).state, 'active.building', 'plan approved under the grant');
  ok(dir, lead, { type: 'VERIFIER_BRIEF_FIXED', sha256: BRIEF });
  spawn(dir, 'builder', 'b1');
  ok(dir, builder(), { type: 'RUN_SUCCEEDED', pr: PR });
  spawn(dir, 'verifier', 'v1');
  const c = apply(openStore(dir), { type: 'CHECKS_PASSED', sha: HEAD.slice(0, 7), actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref: `o/r#7@${HEAD}:checks=success` } }, { to: 'item:a' });
  assert.equal(c.refused, undefined, c.why);
  ok(dir, verifier(), { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'test a passes' });
  ok(dir, verifier(), { type: 'VERDICT_GIVEN', verdict: 'PASS', sha: HEAD, review: 101, text: `PASS\n\nBrief-Sha256: ${BRIEF}` });
  answered(dir, 'approve');
  assert.equal(statusOf(dir).state, 'active.awaitingMergeDecision', 'accepted under the grant: tier 2 waits at its land gate');
  return dir;
}

test('#100: the stand-in answers revise at the land gate; the item goes back to building and a builder may be spawned', () => {
  const dir = atLandGate();
  // Only the stand-in answers: neither the lead nor the item's builder can send it back.
  for (const [env, who] of [[lead, 'the lead'], [builder(), 'the builder']]) {
    const r = answer(dir, env, 'revise');
    assert.notEqual(r.status, 0, who);
    assert.match(r.stderr, /refused: STAND_IN_ANSWERED/, who);
  }
  assert.equal(statusOf(dir).state, 'active.awaitingMergeDecision', 'nothing refused was taken');

  const r = answered(dir, 'revise');
  assert.match(r.subject, /^decision:a:merge:/);
  const store = openStore(dir);
  assert.equal(store.events().at(-1).event.answer.choice, 'revise');
  assert.equal(statusOf(dir).state, 'active.building', 'revise at the land gate sends the item back to building');
  spawn(dir, 'builder', 'b2');
  ok(dir, builder('b2'), { type: 'RUN_SUCCEEDED', pr: PR });
  assert.equal(statusOf(dir).state, 'active.verifying', 'the new builder\'s run is recorded as a build');
  const rp = run(lead, 'replay', '--dir', dir);
  assert.equal(rp.status, 0, rp.stdout + rp.stderr);
});

test('#100: reject at the land gate still cancels the item', () => {
  const dir = atLandGate();
  answered(dir, 'reject');
  assert.equal(openStore(dir).events().at(-1).event.answer.choice, 'reject');
  assert.equal(statusOf(dir).state, 'cancelled', 'reject at the land gate cancels the item');
});

test('#100: the decision machine holds which choices a stand-in may give; an answer outside its options is refused', () => {
  const dir = atLandGate();
  const r = apply(openStore(dir), { type: 'STAND_IN_ANSWERED', answer: { choice: 'ship-it', confidence: 0.9, reason: 'not an option' }, actor: { kind: 'session', id: 'stand-in-session' }, source: { kind: 'cli', ref: 'harness answer' } }, { to: 'item:a/decision:a:merge:3' });
  assert.equal(r.refused, true);
  assert.match(r.why, /choiceNotOffered/);
  assert.equal(statusOf(dir).state, 'active.awaitingMergeDecision');
});
