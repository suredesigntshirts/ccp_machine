import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, init, status, parseGithubEvent, mapGithubEvent, fromGithub, fromGithubText, prMap, prKey } from '../src/index.js';
import { readFact, combined } from '../src/github-read.js';
import { apply, start } from './send.js';
import { fakeGithub, recorded, HEAD, MERGE } from './github-fake.js';

const wake = (kind, data) => `<wake reason="external-event"><event source="github" kind="${kind}" from="system" trust="relay">
    <!-- harness guidance, with a {"brace"} in it -->
    ${JSON.stringify(data)}
  </event></wake>`;
const PR = 'o/r#7';
const PR_URL = 'https://github.com/o/r/pull/7';
const H7 = HEAD.slice(0, 7);
const OTHER = '2222222bbb2222222bbb2222222bbb2222222bbb';

function storeAtVerify() {
  const dir = mkdtempSync(join(tmpdir(), 'harness-'));
  const store = openStore(dir);
  init(store);
  start(store);
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'x', tier: 0 } });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:x' });
  apply(store, { type: 'RUN_SUCCEEDED', pr: PR_URL }, { to: 'item:x' });
  return { dir, store };
}
const state = (store) => status(store).items[0].state;
const counts = (store) => [store.read().version, store.events().length, store.outbox().length, store.acks().length];
const suite = (head_sha = HEAD) => wake('check_suite.completed', { head_sha, pr: PR });
const failedRun = (head_sha = HEAD) => wake('check_run.completed', { check: 'test', conclusion: 'failure', head_sha, pr: PR });
const merge = wake('pull_request.closed', { outcome: 'merged', pr: PR });

/** from-github refuses with a reason naming GitHub, and writes nothing. */
async function refusedByGithub(store, text, fetcher, why) {
  const before = counts(store);
  const r = await fromGithub(store, text, { fetcher });
  assert.equal(r.result, 'refused', JSON.stringify(r));
  assert.match(r.why, why);
  assert.deepEqual(counts(store), before, 'a refusal writes nothing');
  return r;
}

test('a wake\'s event text and plain JSON both parse; PR refs normalise', () => {
  assert.deepEqual(parseGithubEvent(wake('pull_request.closed', { outcome: 'merged', pr: PR })), { kind: 'pull_request.closed', data: { outcome: 'merged', pr: PR } });
  assert.deepEqual(parseGithubEvent('{"kind":"check_suite.completed","data":{"pr":"o/r#7"}}').kind, 'check_suite.completed');
  assert.equal(prKey(PR_URL), PR);
  assert.equal(prKey(PR), PR);
  assert.equal(prKey('nothing'), null);
});

test('no delivery id is read from a wake, and an attribute matches only by its whole name', () => {
  // No real wake carries a delivery id, so none is looked for (the ref is the GitHub fact instead).
  const withIds = wake('pull_request.closed', { outcome: 'merged', pr: PR, delivery_id: 'd-1', event_id: 'e-1' }).replace('kind=', 'id="evt-9" delivery="d-2" kind=');
  assert.deepEqual(Object.keys(parseGithubEvent(withIds)), ['kind', 'data']);
  assert.deepEqual(Object.keys(parseGithubEvent('{"kind":"check_suite.completed","delivery":"d-1","delivery_id":"d-2","data":{"pr":"o/r#7","event_id":"e"}}')), ['kind', 'data']);
  // `pr-kind=` is not `kind=`, and `x-current-time=` is not `current-time=`.
  const decoy = wake('check_suite.completed', { pr: PR }).replace('kind=', 'pr-kind="pull_request.closed" kind=').replace('<wake ', '<wake x-current-time="1999-01-01T00:00:00Z" ');
  assert.deepEqual(parseGithubEvent(decoy), { kind: 'check_suite.completed', data: { pr: PR } });
});

test('each kind maps to its event; successes and other kinds are ignored', () => {
  assert.equal(mapGithubEvent({ kind: 'check_suite.completed', data: { pr: PR, head_sha: 'abcdef123' } }).id, 'ci-abcdef1-passed');
  assert.equal(mapGithubEvent({ kind: 'check_run.completed', data: { pr: PR, head_sha: 'abcdef123', conclusion: 'failure', check: 'test' } }).event.type, 'CHECKS_FAILED');
  assert.ok(mapGithubEvent({ kind: 'check_run.completed', data: { pr: PR, conclusion: 'success' } }).ignore);
  assert.equal(mapGithubEvent({ kind: 'pull_request.closed', data: { pr: PR, outcome: 'merged' } }).id, 'merge-pr7');
  assert.equal(mapGithubEvent({ kind: 'pull_request.closed', data: { pr: PR, outcome: 'closed' } }).event.type, 'CANCEL');
  assert.ok(mapGithubEvent({ kind: 'subscription.created', data: { pr: PR } }).ignore);
});

test('the reader reads recorded REST responses for #21: the checks and the merge as GitHub states them', async () => {
  const fetcher = fakeGithub();
  const pr = 'suredesigntshirts/ccp_machine#21';
  assert.deepEqual(await readFact({ type: 'CHECKS_PASSED', pr }, fetcher), { ref: `${pr}@${HEAD}:checks=success`, sha: HEAD });
  assert.deepEqual(await readFact({ type: 'MERGED', pr }, fetcher), { ref: `${pr}:merged@${MERGE}` });
  assert.ok(fetcher.calls.every((p) => p.startsWith('repos/suredesigntshirts/ccp_machine/')), `REST only: ${fetcher.calls}`);
  assert.deepEqual(fetcher.calls, [`repos/suredesigntshirts/ccp_machine/pulls/21`, `repos/suredesigntshirts/ccp_machine/commits/${HEAD}/check-runs?per_page=100`, `repos/suredesigntshirts/ccp_machine/pulls/21`, `repos/suredesigntshirts/ccp_machine/commits/${MERGE}`]);
  assert.equal(combined(recorded.runs.check_runs), 'success');
  assert.equal(combined([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }]), 'failure');
  assert.equal(combined([{ status: 'completed', conclusion: 'skipped' }, { status: 'in_progress', conclusion: null }]), 'pending');
  assert.equal(combined([{ status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'timed_out' }]), 'failure', 'one failed run fails the commit');
  assert.equal(combined([]), 'none');
});

test('a failed check, then a green suite, then the merge drive the item to done; each ref is the GitHub fact', async () => {
  const { store } = storeAtVerify();
  assert.deepEqual(prMap(store.events()), { [PR]: 'x' });
  const fail = await fromGithub(store, failedRun(), { fetcher: fakeGithub({ checks: 'failure' }) });
  assert.deepEqual([fail.result, fail.event, fail.id], ['sent', 'CHECKS_FAILED', `ci-${H7}-failed`]);
  const row = store.events().at(-1);
  assert.deepEqual([row.actor, row.source], [{ kind: 'github', id: 'github' }, { kind: 'github-wake', ref: `${PR}@${HEAD}:checks=failure` }]);
  assert.deepEqual(await fromGithub(store, suite(), { fetcher: fakeGithub() }), { result: 'refused', item: 'x', id: `ci-${H7}-passed`, why: 'refused: CHECKS_PASSED in active.building' }, 'building again, not verifying');
  apply(store, { type: 'RUN_SUCCEEDED', pr: PR_URL }, { to: 'item:x' });
  const green = fakeGithub({ head: OTHER });
  assert.equal((await fromGithub(store, suite(OTHER), { fetcher: green })).result, 'sent');
  assert.equal(store.events().at(-1).source.ref, `${PR}@${OTHER}:checks=success`);
  assert.match(state(store), /merging/);
  assert.equal((await fromGithub(store, suite(OTHER), { fetcher: green })).result, 'duplicate');
  const merged = await fromGithub(store, merge, { fetcher: fakeGithub({ head: OTHER }) });
  assert.deepEqual([merged.result, merged.id], ['sent', 'merge-pr7']);
  assert.deepEqual(store.events().at(-1).source, { kind: 'github-wake', ref: `${PR}:merged@${MERGE}` });
  assert.equal(state(store), 'done');
  assert.deepEqual(store.pending().filter((e) => e.name === 'mergePullRequest'), [], 'the merge effect is acked');
  assert.equal((await fromGithub(store, merge, { fetcher: fakeGithub() })).result, 'duplicate');
  assert.equal((await fromGithub(store, suite(), { fetcher: fakeGithub() })).why, 'refused: CHECKS_PASSED in done');
  const unknown = fakeGithub();
  assert.equal((await fromGithub(store, wake('check_suite.completed', { head_sha: '3', pr: 'o/r#99' }), { fetcher: unknown })).result, 'unknown');
  assert.deepEqual(unknown.calls, [], 'an event for no item needs no read');
});

test('from-github applies a CI result only when GitHub agrees, and refuses with the reason otherwise', async () => {
  const { store } = storeAtVerify();
  await refusedByGithub(store, suite(), fakeGithub({ checks: 'failure' }), /GitHub.*checks=failure, not success/);
  await refusedByGithub(store, suite(), fakeGithub({ checks: 'in_progress' }), /GitHub.*checks=pending, not success/);
  await refusedByGithub(store, failedRun(), fakeGithub({ checks: 'success' }), /GitHub.*checks=success, not failure/);
  // The wake names a commit that is no longer the PR's head.
  await refusedByGithub(store, suite('1111111aaa'), fakeGithub(), new RegExp(`GitHub.*head is ${H7}, not 1111111`));
  await refusedByGithub(store, suite(), fakeGithub({ down: 'gh: error connecting to api.github.com' }), /cannot reach GitHub: gh: error connecting/);
  assert.match(state(store), /verifying/);
  assert.equal((await fromGithub(store, suite(), { fetcher: fakeGithub() })).result, 'sent');
});

test('from-github applies MERGED only when GitHub says merged and the merge commit exists', async () => {
  const { store } = storeAtVerify();
  assert.equal((await fromGithub(store, suite(), { fetcher: fakeGithub() })).result, 'sent');
  await refusedByGithub(store, merge, fakeGithub({ merged: false }), /GitHub says o\/r#7 is not merged/);
  await refusedByGithub(store, merge, fakeGithub({ mergeSha: null }), /not merged/);
  await refusedByGithub(store, merge, fakeGithub({ mergeSha: 'f'.repeat(40) }), /merge commit f{7}.*(not found|404)/i);
  await refusedByGithub(store, merge, fakeGithub({ down: 'HTTP 502' }), /cannot reach GitHub/);
  assert.equal(store.pending().filter((e) => e.name === 'mergePullRequest').length, 1, 'the merge is still to do');
  assert.equal((await fromGithub(store, merge, { fetcher: fakeGithub() })).result, 'sent');
  assert.equal(state(store), 'done');
});

test('a wake\'s current-time is stamped on the event as observedAt', async () => {
  const { store } = storeAtVerify();
  const text = suite().replace('<wake ', '<wake current-time="2026-10-26T20:45:55Z" ');
  assert.equal(parseGithubEvent(text).at, '2026-10-26T20:45:55Z');
  assert.equal((await fromGithub(store, text, { fetcher: fakeGithub() })).result, 'sent');
  assert.equal(store.events().at(-1).event.observedAt, '2026-10-26T20:45:55.000Z');
});

test('a file with three wakes applies all three in order and reports each', async () => {
  const { store } = storeAtVerify();
  const text = [suite(), 'notification header text between wakes', merge, wake('check_suite.completed', { head_sha: '3', pr: 'o/r#99' })].join('\n');
  assert.deepEqual((await fromGithubText(store, text, { fetcher: fakeGithub() })).map((r) => r.result), ['sent', 'sent', 'unknown']);
  assert.equal(state(store), 'done');
});

test('a failed check, then a passing re-run on the same commit, both reach the item', async () => {
  const { store } = storeAtVerify();
  assert.equal((await fromGithub(store, failedRun(), { fetcher: fakeGithub({ checks: 'failure' }) })).result, 'sent');
  // The host re-ran the job instead of pushing: the same build goes back to verify.
  apply(store, { type: 'RUN_SUCCEEDED', pr: PR_URL }, { to: 'item:x', id: 'run-pr7-rerun' });
  const pass = await fromGithub(store, suite(), { fetcher: fakeGithub() });
  assert.deepEqual([pass.result, pass.id], ['sent', `ci-${H7}-passed`]);
  assert.match(state(store), /merging/);
});

test('a merge the item is not waiting for is refused, and the merge effect stays pending', async () => {
  const { store } = storeAtVerify();
  const merged = await fromGithub(store, merge, { fetcher: fakeGithub() });
  assert.deepEqual([merged.result, merged.why], ['refused', 'refused: MERGED in active.verifying']);
  assert.match(state(store), /verifying/);
  // A batch goes on after a refusal.
  const text = [merge, suite()].join('\n');
  assert.deepEqual((await fromGithubText(store, text, { fetcher: fakeGithub() })).map((r) => r.result), ['refused', 'sent']);
  assert.equal(store.pending().filter((e) => e.name === 'mergePullRequest').length, 1, 'the merge is still to do');
});

/** A `gh` on PATH that answers `gh api <path>` from the recorded responses, or fails like a dead network. */
function fakeGh(dir, { down = false } = {}) {
  const log = join(dir, 'gh-calls.log');
  const fixtures = new URL('./fixtures/github/', import.meta.url).pathname;
  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const [cmd, path] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
if (${down} || cmd !== 'api') { console.error('error connecting to api.github.com'); process.exit(1); }
const file = /\\/pulls\\/\\d+$/.test(path) ? 'pulls-21.json' : /check-runs/.test(path) ? 'check-runs-ceeba95.json' : path.endsWith('${MERGE}') ? 'commit-354ac30.json' : null;
if (!file) { console.error('gh: Not Found (HTTP 404)'); process.exit(1); }
process.stdout.write(fs.readFileSync(${JSON.stringify(fixtures)} + file, 'utf8'));
`);
  chmodSync(join(dir, 'gh'), 0o755);
  return log;
}

test('harness from-github reads the wake file, then GitHub through `gh api` (REST), then applies', () => {
  const { dir, store } = storeAtVerify();
  const bin = new URL('../bin/harness.js', import.meta.url).pathname;
  const ghDir = mkdtempSync(join(tmpdir(), 'harness-gh-'));
  const run = (file, opts) => {
    const log = fakeGh(ghDir, opts);
    const r = spawnSync(process.execPath, [bin, 'from-github', file, '--dir', dir], { encoding: 'utf8', env: { ...process.env, PATH: `${ghDir}:${process.env.PATH}` } });
    return { ...r, calls: existsSync(log) ? readFileSync(log, 'utf8') : '' };
  };
  const f = join(dir, 'ev.txt');
  writeFileSync(f, suite());
  const before = counts(store);
  const down = run(f, { down: true });
  assert.equal(down.status, 1, 'GitHub out of reach: from-github fails');
  assert.match(JSON.parse(down.stdout).why, /cannot reach GitHub/);
  assert.deepEqual(counts(store), before, 'nothing written');
  const r = run(f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).event, 'CHECKS_PASSED');
  assert.equal(store.events().at(-1).source.ref, `${PR}@${HEAD}:checks=success`);
  assert.match(r.calls, /^api repos\/o\/r\/pulls\/7$/m);
  assert.doesNotMatch(r.calls, /graphql/);
});

// Opt-in: reads the real PR #21 from GitHub. HARNESS_LIVE_GITHUB=1 npm test -w @ccp/harness
test('live: GitHub says suredesigntshirts/ccp_machine#21 merged at its merge commit, with green checks', { skip: !process.env.HARNESS_LIVE_GITHUB && 'set HARNESS_LIVE_GITHUB=1 to read GitHub' }, async () => {
  const pr = 'suredesigntshirts/ccp_machine#21';
  assert.deepEqual(await readFact({ type: 'MERGED', pr }), { ref: `${pr}:merged@${MERGE}` });
  assert.deepEqual(await readFact({ type: 'CHECKS_PASSED', pr }), { ref: `${pr}@${HEAD}:checks=success`, sha: HEAD });
});
