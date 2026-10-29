// #137: a verifier PASS carries to a merge-of-main head. The rule is the workItem machine's (merging, CHECKS_PASSED):
// the head is a merge of the verified sha and a commit on the PR's base branch, its diff against that commit is the
// verified sha's, and its CI passed. The fact it reads (head, parents, which is on main, diff hashes) is CHECKS_PASSED's
// head, which from-github reads from GitHub's REST API. GitHub is a fake: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore, init, status, fromGithub, mergeGate, verifyMerges, verifyFacts, renderLivePage } from '../src/index.js';
import { diffHash, headFact } from '../src/github-read.js';
import { parseLog, projectLog, renderData } from '../src/live.js';
import { loadNeeds } from '../src/pages.js';
import { apply, start } from './send.js';
import { tempDir } from './tmp.js';

const LEAD = 'sim-orchestrator';
const lead = { actor: { kind: 'session', id: LEAD }, source: { kind: 'cli', ref: 'harness send' } };
const verifier = { actor: { kind: 'agent', id: `${LEAD}/v1` }, source: { kind: 'cli', ref: 'harness verdict' } };
const BRIEF = 'b'.repeat(64);
const A = 'a'.repeat(40); // the head the verifier passed
const M = '3'.repeat(40); // a commit on main
const B = 'b'.repeat(40); // main merged into A
const C = 'c'.repeat(40); // a head no verifier passed
const D = 'd'.repeat(40); // main merged into B
const PR = 'https://github.com/o/r/pull/7';
const H = '9'.repeat(64);
const ok = (r, label) => assert.ok(!r.refused, `${label}: ${r.why}`);
const ci = (sha, head, ref = `o/r#7@${sha}:checks=success`) => ({ type: 'CHECKS_PASSED', pr: PR, sha: sha.slice(0, 7), ...(head && { head }), actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref } });
const merged = (sha) => ({ type: 'MERGED', pr: PR, sha, actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref: `o/r#7:merged@${'e'.repeat(40)}` } });
const fact = (over = {}) => ({ sha: B, parents: [A, M], onMain: M, diff: { [B]: H, [A]: H }, ...over });
const itemOf = (store) => status(store).items.find((i) => i.id === 'x');
const ctx = (store) => store.read().snapshot.children.x.snapshot.context;

// Item x (tier 0) on PR o/r#7, CI green and the verifier's PASS on A: merging.
function merging() {
  const store = openStore(tempDir('harness-carry-'));
  init(store);
  start(store);
  ok(apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'x' }, ...lead }, { now: '2026-10-29T09:00:00.000Z' }), 'request');
  ok(apply(store, { type: 'TRIAGED', tier: 0, criteria: ['it works'] }, { to: 'item:x' }), 'triage');
  ok(apply(store, { type: 'VERIFIER_BRIEF_FIXED', sha256: BRIEF, ...lead }, { to: 'item:x' }), 'brief');
  ok(apply(store, { type: 'RUN_SUCCEEDED', pr: PR }, { to: 'item:x' }), 'run');
  ok(apply(store, { type: 'WORKER_SPAWNED', role: 'verifier', briefSha256: BRIEF, agentType: 'harness:verifier', ...lead }, { to: 'item:x' }), 'spawn');
  ok(apply(store, { type: 'WORKER_STARTED', agent: `${LEAD}/v1`, agentType: 'harness:verifier', ...lead }, { to: 'item:x' }), 'start');
  ok(apply(store, ci(A), { to: 'item:x', id: 'ci-a' }), 'ci on A');
  ok(apply(store, { type: 'VERDICT_GIVEN', verdict: 'PASS', sha: A, pr: PR, review: 100, text: `PASS\n\nBrief-Sha256: ${BRIEF}`, ...verifier }, { to: 'item:x', id: 'verdict-a' }), 'PASS on A');
  assert.equal(itemOf(store).state, 'active.merging');
  return store;
}

test('a PASS on A carries to B, a merge of A and a commit on main with the same diff and CI green: MERGED of B is taken with no new verdict', () => {
  const store = merging();
  const r = apply(store, ci(B, fact()), { to: 'item:x', id: 'ci-b' });
  ok(r, 'the carrying fact');
  const carried = ctx(store).verdicts[B];
  assert.equal(carried.verdict, 'PASS');
  assert.equal(carried.givenOn, A, 'the record names the sha the PASS was given on');
  assert.equal(carried.review, 100, "the verifier's review on A");
  assert.deepEqual(carried.fact, { ref: `o/r#7@${B}:checks=success`, parents: [A, M], onMain: M, diff: H }, 'and the fact that carried it');
  assert.equal(store.events().filter((e) => e.event.type === 'VERDICT_GIVEN').length, 1, 'no new verifier run');
  ok(apply(store, merged(B), { to: 'item:x' }), 'MERGED of B');
  assert.equal(itemOf(store).state, 'done');
});

test('a carried PASS carries again: D, main merged into B, carries the PASS given on A', () => {
  const store = merging();
  ok(apply(store, ci(B, fact()), { to: 'item:x' }), 'B');
  ok(apply(store, ci(D, { sha: D, parents: [B, M], onMain: M, diff: { [D]: H, [B]: H } }), { to: 'item:x' }), 'D');
  assert.equal(ctx(store).verdicts[D].givenOn, A);
  ok(apply(store, merged(D), { to: 'item:x' }), 'MERGED of D');
});

// Each part of the rule, failing alone: the fact is refused, naming the part, and MERGED of the head is still refused
// by unverifiedHead.
const failing = {
  'a non-merge head': [fact({ parents: [A], onMain: null, diff: {} }), 'notMergeOfMain'],
  'a merge with no parent on main': [fact({ parents: [A, C], onMain: null, diff: {} }), 'notMergeOfMain'],
  'a fact about another head': [fact({ sha: C }), 'notMergeOfMain'],
  'a head whose parent is not the verified sha': [fact({ parents: [C, M], diff: { [B]: H, [C]: H } }), 'parentNotVerified'],
  'a changed diff': [fact({ diff: { [B]: '8'.repeat(64), [A]: H } }), 'diffChanged'],
  'a diff GitHub could not hash': [fact({ diff: { [B]: null, [A]: null } }), 'diffChanged']
};
for (const [label, [head, guard]] of Object.entries(failing))
  test(`${label}: no PASS carries, and MERGED of the head is refused by unverifiedHead`, () => {
    const store = merging();
    const r = apply(store, ci(B, head), { to: 'item:x' });
    assert.equal(r.refused, true, label);
    assert.match(r.why, new RegExp(`in active\\.merging \\(${guard}\\)`));
    assert.equal(ctx(store).verdicts[B], undefined);
    const m = apply(store, merged(B), { to: 'item:x' });
    assert.equal(m.refused, true);
    assert.match(m.why, /\(unverifiedHead\)/);
  });

test('no CI on the head: with no CHECKS_PASSED for B, MERGED of B is refused by unverifiedHead', () => {
  const store = merging();
  const m = apply(store, merged(B), { to: 'item:x' });
  assert.equal(m.refused, true);
  assert.match(m.why, /\(unverifiedHead\)/);
});

test('a CI result with no head fact carries nothing, and only GitHub records one: a session or agent sending the fact is refused', () => {
  const store = merging();
  assert.match(apply(store, ci(B), { to: 'item:x' }).why, /\(notMergeOfMain\)/);
  for (const by of [lead, verifier]) {
    const r = apply(store, { ...ci(B, fact()), ...by }, { to: 'item:x' });
    assert.equal(r.refused, true);
  }
  assert.equal(ctx(store).verdicts[B], undefined);
});

// GitHub, offline: PR o/r#7 on branch feat/137-x at head `head`, and the commits and comparisons headFact reads.
const files = (lines, extra = {}) => [{ filename: 'src/a.js', status: 'modified', patch: `@@ -1,3 +1,4 @@\n ctx\n${lines}\n ctx`, ...extra }];
function github({ head = B, parents = { [B]: [A, M], [A]: [M] }, onMain = [M], diffs = { [B]: files('+one'), [A]: files('+one') }, checks = 'success' } = {}) {
  const calls = [];
  const fetcher = async (path) => {
    calls.push(path);
    if (path === 'repos/o/r/pulls/7') return { number: 7, state: 'open', merged: false, created_at: '2026-10-29T10:00:00Z', head: { sha: head, ref: 'feat/137-x' }, base: { ref: 'main' }, merge_commit_sha: null };
    const runs = /^repos\/o\/r\/commits\/(\w{40})\/check-runs/.exec(path);
    if (runs) return { total_count: 1, check_runs: [{ status: 'completed', conclusion: checks }] };
    const commit = /^repos\/o\/r\/commits\/(\w{40})$/.exec(path);
    if (commit && parents[commit[1]]) return { sha: commit[1], parents: parents[commit[1]].map((sha) => ({ sha })) };
    const cmp = /^repos\/o\/r\/compare\/([\w.-]+)\.\.\.(\w{40})$/.exec(path);
    if (cmp && cmp[1] === 'main') return { status: onMain.includes(cmp[2]) ? 'behind' : 'diverged', files: [] };
    if (cmp && diffs[cmp[2]]) return { status: 'ahead', files: diffs[cmp[2]] };
    throw new Error(`HTTP 404 ${path}`);
  };
  fetcher.calls = calls;
  return fetcher;
}
const suite = (sha, extra = {}) => `<wake reason="external-event"><event source="github" kind="check_suite.completed">${JSON.stringify({ pr: 'o/r#7', head_sha: sha, ...extra })}</event></wake>`;

test('diffHash: the changed lines of each file, not the context around them or where the hunks sit', () => {
  const base = files('+one\n-two');
  assert.equal(diffHash(base), diffHash([{ ...base[0], patch: '@@ -40,3 +41,4 @@\n other\n+one\n-two\n context' }]), 'other context, other line numbers');
  assert.notEqual(diffHash(base), diffHash(files('+one\n-three')), 'another changed line');
  assert.notEqual(diffHash(base), diffHash([...base, ...files('+x', { filename: 'src/b.js' })]), 'another file');
  assert.notEqual(diffHash(base), diffHash(files('+one\n-two', { status: 'renamed', previous_filename: 'src/old.js' })), 'a rename');
  assert.equal(diffHash(base), diffHash([...base].reverse()), 'file order does not count');
  assert.notEqual(diffHash([{ filename: 'img.png', status: 'modified', sha: '1'.repeat(40) }]), diffHash([{ filename: 'img.png', status: 'modified', sha: '2'.repeat(40) }]), 'a file with no patch is its blob');
  assert.equal(diffHash(Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}`, status: 'added', patch: '+x' }))), null, 'GitHub lists at most 300 files: a diff it may have cut has no hash');
  assert.equal(diffHash(undefined), null);
});

test('headFact reads the head, its parents, which parent is on main and the diff hashes from GitHub\'s REST API', async () => {
  const gh = github();
  assert.deepEqual(await headFact('o/r', B, 'main', gh), { sha: B, parents: [A, M], onMain: M, diff: { [B]: diffHash(files('+one')), [A]: diffHash(files('+one')) } });
  assert.ok(gh.calls.includes(`repos/o/r/compare/${M}...${B}`) && gh.calls.includes(`repos/o/r/compare/${M}...${A}`), 'both diffs against the commit on main');
  assert.deepEqual(await headFact('o/r', A, 'main', github()), { sha: A, parents: [M], onMain: null, diff: {} }, 'a non-merge head: its parents only');
  assert.deepEqual((await headFact('o/r', B, 'main', github({ onMain: [] }))).onMain, null, 'no parent on main');
  assert.deepEqual(await headFact('o/r', B, 'main', github({ onMain: [A, M] }), M), await headFact('o/r', B, 'main', github()), 'read again once the PR landed and A is on main too');
  assert.ok(gh.calls.every((p) => !/graphql/i.test(p)), 'REST only');
});

test('from-github records the head fact from GitHub, never from the wake, and the PASS carries through it', async () => {
  const store = merging();
  const r = await fromGithub(store, suite(B, { parents: [A, M], onMain: M, diff: 'forged', head: { sha: B } }), { fetcher: github() });
  assert.equal(r.result, 'sent', JSON.stringify(r));
  const row = store.events().at(-1);
  assert.deepEqual(row.event.head, { sha: B, parents: [A, M], onMain: M, diff: { [B]: diffHash(files('+one')), [A]: diffHash(files('+one')) } });
  assert.equal(ctx(store).verdicts[B].givenOn, A);
});

test('from-github: a merge whose diff GitHub says changed is refused, naming the part of the rule', async () => {
  const store = merging();
  const r = await fromGithub(store, suite(B), { fetcher: github({ diffs: { [B]: files('+one\n+resolved'), [A]: files('+one') } }) });
  assert.equal(r.result, 'refused');
  assert.match(r.why, /\(diffChanged\)/);
  assert.equal(apply(store, merged(B), { to: 'item:x' }).refused, true);
});

test('verify-facts re-reads the head fact: a fact GitHub does not back is a mismatch', async () => {
  const store = merging();
  ok(apply(store, ci(B, fact({ diff: { [B]: diffHash(files('+one')), [A]: diffHash(files('+one')) } })), { to: 'item:x', id: 'ci-b' }), 'fact');
  const gh = (diffs) => github({ diffs });
  const row = (rows) => rows.find((x) => x.id === 'ci-b');
  assert.equal(row(await verifyFacts(store, { fetcher: gh(undefined) })).result, 'ok');
  const bad = row(await verifyFacts(store, { fetcher: gh({ [B]: files('+two'), [A]: files('+one') }) }));
  assert.equal(bad.result, 'mismatch');
  assert.match(bad.why, /head fact/);
});

// The merge gate and doctor check the PASS review on the sha the PASS was given on (reviewOnHead).
function reviews(head) {
  const review = { id: 100, commit_id: A, state: 'COMMENTED', body: `PASS\n\nBrief-Sha256: ${BRIEF}` };
  return async (path) => {
    if (path === 'repos/o/r/pulls/7/reviews?per_page=100') return [review];
    if (path === 'repos/o/r/pulls/7') return { number: 7, merged: true, head: { sha: head } };
    if (path === 'repos/o/r/pulls?state=closed&base=main&per_page=100&page=1') return [{ number: 7, head: { sha: head }, merged_at: '2999-01-01T00:00:00Z' }];
    throw new Error(`HTTP 404 ${path}`);
  };
}

test('the merge gate allows B on the PASS carried from A, its review on A; doctor counts the landing as verified', async () => {
  const store = merging();
  const before = await mergeGate(store, { pr: PR, sha: B }, { fetcher: reviews(B) });
  assert.deepEqual([before.allow, before.rule], [false, 'machine']);
  ok(apply(store, ci(B, fact()), { to: 'item:x' }), 'carry');
  const gate = await mergeGate(store, { pr: PR, sha: B }, { fetcher: reviews(B) });
  assert.equal(gate.allow, true, gate.why);
  assert.match(gate.why, /carried/);
  assert.deepEqual((await verifyMerges(store, { fetcher: reviews(B) })).map((r) => r.result), ['ok']);
});

test('mission control shows a carried PASS: the sha it was given on and the fact that carried it', () => {
  const store = merging();
  ok(apply(store, ci(B, fact()), { to: 'item:x' }), 'carry');
  const html = renderLivePage(store.read(), { page: 'mission-control' });
  assert.match(html, /PASS on aaaaaaa carried to bbbbbbb by o\/r#7@b{40}:checks=success/);
});

test('flow replay shows the carried PASS on the step of the fact that carried it', () => {
  const store = merging();
  ok(apply(store, ci(B, fact()), { to: 'item:x', id: 'ci-b' }), 'carry');
  const bin = new URL('../bin/harness.js', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [bin, 'replay', '--steps', '--dir', store.dir], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.equal(r.status, 0, r.stderr);
  const rows = parseLog(readFileSync(join(store.dir, 'events.jsonl'), 'utf8'));
  const steps = parseLog(readFileSync(join(store.dir, 'steps.jsonl'), 'utf8'));
  const step = steps.find((s) => s.id === 'ci-b');
  assert.equal(step.refused, null);
  const field = step.context.find((c) => c.field === 'verdicts');
  assert.equal(field.after[B].givenOn, A);
  const needs = loadNeeds('flow-replay');
  const html = renderData(projectLog(rows, needs, { 'steps.jsonl': steps }), needs);
  const card = html.split('class="card step"').find((c) => c.includes('· id ci-b<'));
  assert.match(card, /verdicts/);
  assert.match(card, /PASS on aaaaaaa carried to bbbbbbb/);
});
