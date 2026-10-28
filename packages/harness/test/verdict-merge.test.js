// #36: the verifier's verdict goes to the PR (a COMMENT review on the head sha it checked, ending with the verifier
// brief's sha256) and to the store (VERDICT_GIVEN from its agent actor) in one command; the merge gate's question
// (harness merge-gate); and doctor's audit of merged PRs. GitHub is a fake: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, init, giveVerdict, mergeGate, verifyMerges, verdictOf, doctor } from '../src/index.js';
import { apply, start } from './send.js';
import { tempDir } from './tmp.js';
import { readFileSync } from 'node:fs';
import { specs } from '../src/machines.js';

const LEAD = 'sim-orchestrator';
const cli = { kind: 'cli', ref: 'harness send' };
const lead = { actor: { kind: 'session', id: LEAD }, source: cli };
const agent = (aid) => ({ actor: { kind: 'agent', id: `${LEAD}/${aid}`, type: 'harness:verifier' }, source: { kind: 'cli', ref: 'harness verdict' } });
const BRIEF = 'b'.repeat(64);
const HEAD = 'a'.repeat(40);
const OLD = 'c'.repeat(40);
const PR = 'https://github.com/o/r/pull/7';
const ok = (r, label) => assert.ok(!r.refused, `${label}: ${r.why}`);

// Item x, tier 0, built on PR o/r#7 by a session worker, its verifier spawned and bound, CI green: verifying until the
// verdict (#71), merging once it is in.
function merging(brief = BRIEF) {
  const store = openStore(tempDir('harness-verdict-'));
  init(store);
  start(store);
  ok(apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'x' }, ...lead }), 'request');
  ok(apply(store, { type: 'TRIAGED', tier: 0, criteria: ['it works'] }, { to: 'item:x' }), 'triage');
  ok(apply(store, { type: 'VERIFIER_BRIEF_FIXED', sha256: brief, ...lead }, { to: 'item:x' }), 'brief');
  ok(apply(store, { type: 'RUN_SUCCEEDED', pr: PR }, { to: 'item:x' }), 'run');
  ok(apply(store, { type: 'WORKER_SPAWNED', role: 'verifier', briefSha256: brief, agentType: 'harness:verifier', ...lead }, { to: 'item:x' }), 'spawn');
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
  assert.match(none.why, /in active\.verifying/, 'no verdict yet: the item still waits in verifying (#71)');
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

// #61: GitHub holds a verdict review as the stored text plus the host's footer (harness meta.reviewFooter). The real
// case: review 5680229689 on #60 at d7799a5, and the VERDICT_GIVEN row the store held for it.
const real = JSON.parse(readFileSync(new URL('./fixtures/github/review-5680229689.json', import.meta.url), 'utf8'));
// Item x passed at the real head with the real stored verdict; GitHub (merged at that head) holds `review`.
function passedReal(review) {
  const v = real.verdict;
  const store = merging(/Brief-Sha256: (\w{64})$/.exec(v.text)[1]);
  ok(apply(store, { type: 'VERDICT_GIVEN', verdict: v.verdict, sha: v.sha, pr: PR, text: v.text, review: v.review, ...agent('v1') }, { to: 'item:x' }), 'the stored verdict');
  const fetcher = async (path) => {
    if (path === 'repos/o/r/pulls/7/reviews?per_page=100') return [review];
    if (path === 'repos/o/r/pulls/7') return { number: 7, merged: true, head: { sha: v.sha } };
    throw new Error(`HTTP 404 ${path}`);
  };
  return { gate: () => mergeGate(store, { pr: PR, sha: v.sha }, { fetcher }), audit: async () => (await verifyMerges(store, { fetcher }))[0] };
}

test('#61: the real review 5680229689 is the stored verdict followed by exactly the spec\'s review footer', () => {
  assert.equal(real.review.body, real.verdict.text + specs.harness.meta.reviewFooter.text);
});

test('#61: the merge gate and doctor accept review 5680229689 as GitHub holds it (the #60 refusal)', async () => {
  const { gate, audit } = passedReal(real.review);
  const yes = await gate();
  assert.equal(yes.allow, true, yes.why);
  assert.equal((await audit()).result, 'ok', (await audit()).why);
  const plain = passedReal({ ...real.review, body: real.verdict.text });
  assert.equal((await plain.gate()).allow, true, 'the verdict verbatim, with no footer');
  assert.equal((await plain.audit()).result, 'ok');
});

test('#61: the merge gate and doctor refuse any other difference from the stored verdict', async () => {
  const { text } = real.verdict;
  const footer = specs.harness.meta.reviewFooter.text;
  const cases = {
    'changed verdict text': { body: text.replace('PASS', 'PASS!') + footer },
    'a different Brief-Sha256': { body: text.replace(/Brief-Sha256: \w+/, `Brief-Sha256: ${'0'.repeat(64)}`) + footer },
    'another review id': { id: real.review.id + 1 },
    'another sha': { commit_id: 'e'.repeat(40) },
    'text added after the footer': { body: `${text}${footer}\nand more` },
    'another footer': { body: `${text}\n\n---\n_Generated by something else_` },
    'the footer twice': { body: text + footer + footer },
    'not COMMENTED': { state: 'APPROVED' }
  };
  for (const [label, change] of Object.entries(cases)) {
    const { gate, audit } = passedReal({ ...real.review, ...change });
    assert.equal((await gate()).rule, 'reviewOnHead', label);
    assert.equal((await audit()).result, 'problem', label);
  }
});
