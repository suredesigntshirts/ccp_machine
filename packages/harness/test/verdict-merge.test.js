// #36: the verifier's verdict goes to the PR (a COMMENT review on the head sha it checked, ending with the verifier
// brief's sha256) and to the store (VERDICT_GIVEN from its agent actor) in one command; the merge gate's question
// (harness merge-gate); and doctor's audit of merged PRs. GitHub is a fake: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, init, giveVerdict, mergeGate, verifyMerges, verdictOf, doctor } from '../src/index.js';
import { apply, start } from './send.js';
import { tempDir } from './tmp.js';

const LEAD = 'sim-orchestrator';
const cli = { kind: 'cli', ref: 'harness send' };
const lead = { actor: { kind: 'session', id: LEAD }, source: cli };
const agent = (aid) => ({ actor: { kind: 'agent', id: `${LEAD}/${aid}`, type: 'harness:verifier' }, source: { kind: 'cli', ref: 'harness verdict' } });
const BRIEF = 'b'.repeat(64);
const HEAD = 'a'.repeat(40);
const OLD = 'c'.repeat(40);
const PR = 'https://github.com/o/r/pull/7';
const ok = (r, label) => assert.ok(!r.refused, `${label}: ${r.why}`);

// Item x, tier 0, built on PR o/r#7 by a session worker, its verifier spawned and bound, CI green: merging.
function merging() {
  const store = openStore(tempDir('harness-verdict-'));
  init(store);
  start(store);
  ok(apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'x' }, ...lead }), 'request');
  ok(apply(store, { type: 'TRIAGED', tier: 0, criteria: ['it works'] }, { to: 'item:x' }), 'triage');
  ok(apply(store, { type: 'VERIFIER_BRIEF_FIXED', sha256: BRIEF, ...lead }, { to: 'item:x' }), 'brief');
  ok(apply(store, { type: 'RUN_SUCCEEDED', pr: PR }, { to: 'item:x' }), 'run');
  ok(apply(store, { type: 'WORKER_SPAWNED', role: 'verifier', briefSha256: BRIEF, agentType: 'harness:verifier', ...lead }, { to: 'item:x' }), 'spawn');
  ok(apply(store, { type: 'WORKER_STARTED', agent: `${LEAD}/v1`, agentType: 'harness:verifier', ...lead }, { to: 'item:x' }), 'start');
  ok(apply(store, { type: 'CHECKS_PASSED', actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref: 'ci' } }, { to: 'item:x' }), 'ci');
  return store;
}
// A fake GitHub: POST reviews keeps them; GET reviews and the PR read them back.
function github({ merged = false, head = HEAD } = {}) {
  const reviews = [];
  const post = async (path, body) => {
    assert.equal(path, 'repos/o/r/pulls/7/reviews');
    const r = { id: 100 + reviews.length, commit_id: body.commit_id, state: body.event === 'COMMENT' ? 'COMMENTED' : body.event, body: body.body, html_url: `https://github.com/o/r/pull/7#pullrequestreview-${100 + reviews.length}` };
    reviews.push(r);
    return r;
  };
  const fetcher = async (path) => {
    if (path === 'repos/o/r/pulls/7/reviews?per_page=100') return reviews;
    if (path === 'repos/o/r/pulls/7') return { number: 7, merged, head: { sha: head } };
    throw new Error(`HTTP 404 ${path}`);
  };
  return { post, fetcher, reviews };
}
const give = (store, gh, text, sha = HEAD, by = agent('v1')) => giveVerdict(store, { text, to: 'item:x', pr: PR, sha, by }, { post: gh.post });

test('verdictOf reads PASS or FAIL from the first line only', () => {
  for (const [t, v] of [['PASS', 'PASS'], ['FAIL\nbecause', 'FAIL'], ['Verdict: PASS', 'PASS'], ['**FAIL** on 3 lines', 'FAIL'], ['# PASS', 'PASS'], ['looks fine\nPASS', null], ['PASSABLE', null], ['', null]])
    assert.equal(verdictOf(t), v, JSON.stringify(t));
});

test('harness verdict posts the verdict verbatim as a COMMENT review on the head, ending with the brief hash, and records it from the agent', async () => {
  const store = merging();
  const gh = github();
  const text = 'PASS\n\nEvery Expect line holds.\n\nIssue-Body-Sha256: ' + 'e'.repeat(64);
  const r = await give(store, gh, text);
  ok(r, 'verdict');
  assert.equal(gh.reviews.length, 1);
  assert.deepEqual([gh.reviews[0].commit_id, gh.reviews[0].state], [HEAD, 'COMMENTED']);
  assert.equal(gh.reviews[0].body, `${text}\n\nBrief-Sha256: ${BRIEF}`, 'verbatim, then the brief hash last');
  const row = store.events().at(-1);
  assert.deepEqual([row.event.type, row.event.verdict, row.event.sha, row.event.review, row.event.text, row.actor.id], ['VERDICT_GIVEN', 'PASS', HEAD, 100, gh.reviews[0].body, `${LEAD}/v1`]);
});

test('a verdict the machine would refuse is never posted', async () => {
  const store = merging();
  const gh = github();
  for (const [by, label] of [[lead, 'the lead'], [agent('roleless'), 'a roleless agent']]) {
    const r = await give(store, gh, 'PASS', HEAD, by);
    assert.equal(r.refused, true, label);
  }
  await assert.rejects(give(store, gh, 'it is fine'), /PASS or FAIL/);
  assert.equal((await give(store, gh, 'PASS', 'abc')).refused, true, 'a short sha');
  assert.equal(gh.reviews.length, 0, 'nothing posted');
});

test('merge-gate: bound, pinned, the machine takes MERGED of the head, and the PASS is a review on that sha', async () => {
  const store = merging();
  const gh = github();
  const gate = (pr, sha) => mergeGate(store, { pr, sha }, { fetcher: gh.fetcher });
  assert.deepEqual((await gate('o/r#8', HEAD)).rule, 'mergeBound', 'a PR bound to no item');
  assert.deepEqual((await gate('none', HEAD)).rule, 'mergeBound', 'no PR');
  assert.deepEqual((await gate(PR, undefined)).rule, 'pinnedHead', 'no head pinned');
  assert.deepEqual((await gate(PR, 'abc')).rule, 'pinnedHead', 'a short head');
  const none = await gate(PR, HEAD);
  assert.deepEqual([none.allow, none.rule], [false, 'machine']);
  assert.match(none.why, /unverifiedHead/);
  await give(store, gh, 'FAIL\nbroken');
  assert.match((await gate(PR, HEAD)).why, /unverifiedHead/, 'a FAIL');
  await give(store, gh, 'PASS\nfixed', OLD);
  assert.match((await gate(PR, HEAD)).why, /unverifiedHead/, 'a PASS on an older head');
  await give(store, gh, 'PASS\nall good');
  const yes = await gate(PR, HEAD);
  assert.deepEqual([yes.allow, yes.item], [true, 'x'], yes.why);
  // The review on GitHub is the one the store names, on that sha, verbatim.
  gh.reviews.at(-1).body += ' edited';
  assert.equal((await gate(PR, HEAD)).rule, 'reviewOnHead', 'an edited review');
  gh.reviews.pop();
  assert.equal((await gate(PR, HEAD)).rule, 'reviewOnHead', 'no review');
  assert.equal((await mergeGate(store, { pr: PR, sha: HEAD }, { fetcher: async () => { throw new Error('HTTP 502'); } })).rule, 'reviewOnHead', 'GitHub out of reach');
});

test('doctor lists a merged PR whose merge head has no verifier PASS in the store or no PASS review on GitHub', async () => {
  const store = merging();
  const merged = github({ merged: true });
  assert.deepEqual((await verifyMerges(store, { fetcher: merged.fetcher })).map((r) => r.result), ['problem']);
  const report = await doctor(store, { ledgers: tempDir('harness-ledgers-'), fetcher: merged.fetcher });
  assert.ok(report.problems.some((l) => /^merges: problem o\/r#7 item:x: the store holds no verifier PASS for its merge head a{7}; GitHub has no PASS review on a{7}/.test(l)), report.problems.join('\n'));
  await give(store, merged, 'PASS');
  assert.deepEqual((await verifyMerges(store, { fetcher: merged.fetcher })).map((r) => r.result), ['ok']);
  // Merged at another head than the one passed.
  const other = github({ merged: true, head: OLD });
  assert.match((await verifyMerges(store, { fetcher: other.fetcher }))[0].why, /no verifier PASS for its merge head c{7}; GitHub has no PASS review/);
  assert.deepEqual((await verifyMerges(store, { fetcher: github().fetcher })), [], 'an open PR is not audited');
  const down = await doctor(store, { ledgers: tempDir('harness-ledgers-'), fetcher: async () => { throw new Error('HTTP 502'); } });
  assert.ok(down.unverifiable.some((l) => /^merges: unreachable o\/r#7/.test(l)));
});
