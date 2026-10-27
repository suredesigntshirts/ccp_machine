// M1c: a GitHub fact counts only for its own item, and every fact can be re-checked afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, init, status, fromGithub, prMap, verifyFacts, verifyFactsText } from '../src/index.js';
import { readFact, resolveGh, ghPath, restFetcher } from '../src/github-read.js';
import { apply, start } from './send.js';
import { fakeGithub, recorded, HEAD, MERGE, CREATED } from './github-fake.js';

const bin = new URL('../bin/harness.js', import.meta.url).pathname;
const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const wake = (kind, data) => `<wake reason="external-event"><event source="github" kind="${kind}" from="system" trust="relay">${JSON.stringify(data)}</event></wake>`;
const R21 = 'suredesigntshirts/ccp_machine#21';
const URL21 = 'https://github.com/suredesigntshirts/ccp_machine/pull/21';
const OTHER = '2222222bbb'.repeat(4);
const counts = (store) => [store.read().version, store.events().length, store.outbox().length, store.acks().length];
const state = (store, id) => status(store).items.find((i) => i.id === id)?.state;
const bytes = (dir) => Object.fromEntries(readdirSync(dir, { recursive: true }).sort().map((f) => { try { return [f, readFileSync(join(dir, f), 'utf8')]; } catch { return [f, 'dir']; } }));

/** A store with item `id`, requested at `at`, its build naming `pr` (owner/repo#N), now verifying. */
function itemAtVerify(id, pr, at = '2026-10-27T12:00:00.000Z') {
  const dir = tempDir('harness-facts-');
  const store = openStore(dir);
  init(store);
  start(store);
  apply(store, { type: 'REQUEST_RECEIVED', request: { id } }, { id: `req-${id}`, now: at });
  apply(store, { type: 'TRIAGED', tier: 0, criteria: ['it works'] }, { to: `item:${id}` });
  const r = apply(store, { type: 'RUN_SUCCEEDED', pr: `https://github.com/${pr.replace('#', '/pull/')}` }, { to: `item:${id}` });
  assert.ok(!r.refused, r.why);
  return { dir, store };
}
const suite = (pr, head_sha = HEAD) => wake('check_suite.completed', { head_sha, pr });
const failed = (pr, head_sha = HEAD) => wake('check_run.completed', { check: 'test', conclusion: 'failure', head_sha, pr });
const merge = (pr) => wake('pull_request.closed', { outcome: 'merged', pr });

async function refused(store, text, fetcher, why) {
  const before = counts(store);
  const r = await fromGithub(store, text, { fetcher });
  assert.equal(r.result, 'refused', JSON.stringify(r));
  assert.match(r.why, why);
  assert.deepEqual(counts(store), before, 'a refusal writes nothing');
  return r;
}

// Outcome 1: binding.

test('an item\'s PR is bound by the first event that names it; a later event naming another PR is refused', () => {
  const { store } = itemAtVerify('x', 'o/r#7');
  apply(store, { type: 'RUN_FAILED', reason: 'flaky', pr: 'https://github.com/o/r/pull/7' }, { to: 'item:x' });
  const before = counts(store);
  const r = apply(store, { type: 'RUN_SUCCEEDED', pr: 'https://github.com/o/r/pull/8' }, { to: 'item:x' });
  assert.equal(r.refused, true);
  assert.match(r.why, /o\/r#8.*item x is bound to o\/r#7/);
  assert.deepEqual(counts(store), before, 'store unchanged');
  assert.deepEqual(prMap(store.events()), { 'o/r#7': 'x' });
});

test('one PR binds to at most one item', () => {
  const { store } = itemAtVerify('x', 'o/r#7');
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'y' } }, { id: 'req-y' });
  apply(store, { type: 'TRIAGED', tier: 0, criteria: ['it works'] }, { to: 'item:y' });
  const before = counts(store);
  const r = apply(store, { type: 'RUN_SUCCEEDED', pr: 'o/r#7' }, { to: 'item:y' });
  assert.equal(r.refused, true);
  assert.match(r.why, /o\/r#7 is bound to item x/);
  assert.deepEqual(counts(store), before);
  // prMap keeps the first binding even for a log written before the rule.
  const old = [
    { to: 'item:a', event: { pr: 'o/r#1' } },
    { to: 'item:b', event: { pr: 'o/r#1' } },
    { to: 'item:a', event: { pr: 'o/r#2' } }
  ];
  assert.deepEqual(prMap(old), { 'o/r#1': 'a' });
});

test('harness send refuses a rebinding with a clear error and exit 1', () => {
  const { dir, store } = itemAtVerify('x', 'o/r#7');
  const before = counts(store);
  const r = spawnSync(process.execPath, [bin, 'send', '{"type":"RUN_SUCCEEDED","pr":"https://github.com/o/r/pull/9"}', '--to', 'item:x', '--actor', 'session:worker-1', '--source', 'cli:handback', '--dir', dir], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'orch' } });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /item x is bound to o\/r#7/);
  assert.deepEqual(counts(store), before);
});

test('the verifier\'s attack: an item bound to an unrelated merged PR (#21) gets no CI or merge from it', async () => {
  // Item login-fix is requested after #21 was opened, and #21's branch does not name it.
  const { store } = itemAtVerify('login-fix', R21, '2026-10-27T19:00:00.000Z');
  const fetcher = fakeGithub();
  const r = await refused(store, suite(R21), fetcher, /created .*before .*request|branch/);
  assert.match(r.why, /#21/);
  await refused(store, failed(R21), fakeGithub({ checks: 'failure' }), /created .*before .*request|branch/);
  await refused(store, merge(R21), fetcher, /created .*before .*request|branch/);
  assert.match(state(store, 'login-fix'), /verifying/);
});

test('from-github refuses a PR created before the item\'s request, and one whose branch does not name the item', async () => {
  const { store } = itemAtVerify('x', 'o/r#7');
  await refused(store, suite('o/r#7'), fakeGithub({ ref: 'feat/7-x', createdAt: '2026-10-27T11:59:59Z' }), /o\/r#7 was created 2026-10-27T11:59:59Z, before item x's request at 2026-10-27T12:00:00/);
  await refused(store, suite('o/r#7'), fakeGithub({ ref: 'feat/7-login' }), /branch feat\/7-login does not name item x/);
  // Created at the request time exactly is fine.
  assert.equal((await fromGithub(store, suite('o/r#7'), { fetcher: fakeGithub({ ref: 'feat/x', createdAt: '2026-10-27T12:00:00Z' }) })).result, 'sent');
});

test('the README tells workers to put the item id in the branch name', () => {
  assert.match(README, /item id in (the|its|their) branch name/i);
});

// Outcome 2: exact head.

test('the head match is exact on the full 40-character sha; no sha or a short one is refused', async () => {
  const { store } = itemAtVerify('x', 'o/r#7');
  const fetcher = fakeGithub({ ref: 'feat/x' });
  await refused(store, suite('o/r#7', HEAD.slice(0, 7)), fetcher, /full 40-character head sha/);
  await refused(store, suite('o/r#7', HEAD.slice(0, 39)), fetcher, /full 40-character head sha/);
  await refused(store, wake('check_suite.completed', { pr: 'o/r#7' }), fetcher, /full 40-character head sha/);
  await refused(store, failed('o/r#7', ''), fetcher, /full 40-character head sha/);
  assert.deepEqual(fetcher.calls, [], 'refused before reading GitHub');
  // A full sha that shares the head's first 39 characters is still another commit.
  const near = HEAD.slice(0, 39) + (HEAD.at(-1) === '0' ? '1' : '0');
  await refused(store, suite('o/r#7', near), fetcher, /head is ceeba95/);
  assert.match((await readFact({ type: 'CHECKS_PASSED', pr: R21, sha: HEAD.slice(0, 7) }, fakeGithub())).why, /40/);
  assert.equal((await fromGithub(store, suite('o/r#7'), { fetcher })).result, 'sent');
});

// Outcome 3: the reader.

test('gh is run by absolute path: /usr/local/bin/gh, else `command -v gh`, resolved once', async () => {
  const fakeOnPath = '/tmp/evil/gh';
  assert.equal(resolveGh({ isFile: (p) => p === '/usr/local/bin/gh', commandV: () => fakeOnPath }), '/usr/local/bin/gh', 'a gh first on PATH does not win');
  assert.equal(resolveGh({ isFile: () => false, commandV: () => '/usr/bin/gh' }), '/usr/bin/gh');
  assert.equal(resolveGh({ isFile: () => false, commandV: () => 'gh' }), null, 'only an absolute path');
  assert.equal(resolveGh({ isFile: () => false, commandV: () => null }), null);
  assert.equal(ghPath(), ghPath(), 'resolved once');
  const ran = [];
  const run = async (file, args) => (ran.push([file, ...args]), { stdout: JSON.stringify(recorded.pull) });
  assert.equal((await restFetcher('repos/o/r/pulls/7', { gh: '/opt/gh/bin/gh', run })).number, 21);
  assert.deepEqual(ran, [['/opt/gh/bin/gh', 'api', 'repos/o/r/pulls/7']]);
  // Without gh: fetch with GH_TOKEN; without either: an error, never a PATH lookup.
  const fetched = [];
  const fetchImpl = async (url, init) => (fetched.push([url, init.headers.authorization]), { ok: true, json: async () => recorded.pull });
  assert.equal((await restFetcher('repos/o/r/pulls/7', { gh: null, token: 't0k', fetchImpl })).number, 21);
  assert.deepEqual(fetched, [['https://api.github.com/repos/o/r/pulls/7', 'Bearer t0k']]);
  await assert.rejects(restFetcher('repos/o/r/pulls/7', { gh: null, token: '', fetchImpl }), /no gh.*GH_TOKEN/);
});

test('a malformed PR answer is refused: number, head.sha (40 hex), merged (boolean) and created_at are checked', async () => {
  const { store } = itemAtVerify('x', 'o/r#7');
  const bad = [
    (p) => ({ ...p, number: undefined }),
    (p) => ({ ...p, number: 8 }),
    (p) => ({ ...p, head: { ...p.head, sha: HEAD.slice(0, 7) } }),
    (p) => ({ ...p, head: undefined }),
    (p) => ({ ...p, merged: 'true' }),
    (p) => ({ ...p, created_at: undefined }),
    (p) => ({ ...p, created_at: 'yesterday' }),
    () => 'not json'
  ];
  for (const mangle of bad) await refused(store, suite('o/r#7'), fakeGithub({ ref: 'feat/x', mangle }), /malformed/);
  for (const mangle of bad.slice(0, 2)) await refused(store, merge('o/r#7'), fakeGithub({ ref: 'feat/x', mangle }), /malformed/);
});

test('the README says local checks stop mistakes, not a hostile session, and that verify-facts is the check', () => {
  assert.match(README, /stop mistakes, not a hostile session/);
  assert.match(README, /verify-facts/);
});

// Outcome 6: pagination.

test('more check runs than one page holds (total_count > runs) is pending, so CHECKS_PASSED is refused', async () => {
  const { store } = itemAtVerify('x', 'o/r#7');
  await refused(store, suite('o/r#7'), fakeGithub({ ref: 'feat/x', totalCount: 2 }), /checks=pending, not success/);
  await refused(store, failed('o/r#7'), fakeGithub({ ref: 'feat/x', checks: 'failure', totalCount: 101 }), /checks=pending, not failure/);
  assert.equal((await fromGithub(store, suite('o/r#7'), { fetcher: fakeGithub({ ref: 'feat/x', totalCount: 1 }) })).result, 'sent');
});

// Outcome 4: verify-facts.

/** Item x driven to done through from-github: a failed check on an earlier commit, a green head, the merge. */
async function doneThroughGithub() {
  const s = itemAtVerify('x', 'o/r#7');
  const early = '1111111aaa'.repeat(4);
  assert.equal((await fromGithub(s.store, failed('o/r#7', early), { fetcher: fakeGithub({ ref: 'feat/x', head: early, checks: 'failure' }) })).result, 'sent');
  apply(s.store, { type: 'RUN_SUCCEEDED', pr: 'o/r#7' }, { to: 'item:x' });
  assert.equal((await fromGithub(s.store, suite('o/r#7'), { fetcher: fakeGithub({ ref: 'feat/x' }) })).result, 'sent');
  assert.equal((await fromGithub(s.store, merge('o/r#7'), { fetcher: fakeGithub({ ref: 'feat/x' }) })).result, 'sent');
  assert.equal(state(s.store, 'x'), 'done');
  return { ...s, early };
}

test('verify-facts re-reads GitHub for every github-wake event: ok when GitHub still says the same', async () => {
  const { store, early } = await doneThroughGithub();
  // GitHub now: the head is HEAD, the earlier commit is on the PR and its checks failed.
  const results = await verifyFacts(store, { fetcher: fakeGithub({ ref: 'feat/x', earlier: [early], checks: 'failure' }) });
  assert.deepEqual(results.map((r) => [r.result, r.type]), [['ok', 'CHECKS_FAILED'], ['mismatch', 'CHECKS_PASSED'], ['ok', 'MERGED']], JSON.stringify(results));
  const green = await verifyFacts(store, { fetcher: fakeGithub({ ref: 'feat/x', earlier: [early] }) });
  assert.deepEqual(green.map((r) => r.result), ['mismatch', 'ok', 'ok'], 'each fact is checked as it was stated');
  const text = verifyFactsText(green);
  assert.equal(text.split('\n').length, 3, 'one line per fact');
  assert.match(text.split('\n')[1], /^ok .*CHECKS_PASSED o\/r#7@[0-9a-f]{40}:checks=success/);
});

test('verify-facts catches a forged fact: a ref GitHub does not back, written straight into the log', async () => {
  const { store } = await doneThroughGithub();
  const github = { actor: { kind: 'github', id: 'github' } };
  // A session can call apply() itself and write any ref (the M1b lesson); only a later re-read sees it.
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'y' } }, { id: 'req-y' });
  apply(store, { type: 'TRIAGED', tier: 0, criteria: ['it works'] }, { to: 'item:y' });
  apply(store, { type: 'RUN_SUCCEEDED', pr: URL21 }, { to: 'item:y' });
  apply(store, { type: 'CHECKS_PASSED', pr: URL21, ...github, source: { kind: 'github-wake', ref: `${R21}@${HEAD}:checks=success` } }, { to: 'item:y', id: 'forged-ci' });
  apply(store, { type: 'MERGED', pr: URL21, ...github, source: { kind: 'github-wake', ref: `${R21}:merged@${'f'.repeat(40)}` } }, { to: 'item:y', id: 'forged-merge' });
  const before = bytes(store.dir);
  const results = await verifyFacts(store, { fetcher: fakeGithub({ ref: 'feat/x' }) });
  const forged = results.filter((r) => r.id.startsWith('forged'));
  assert.deepEqual(forged.map((r) => r.result), ['mismatch', 'mismatch']);
  assert.match(forged[0].why, /created .*before .*request|branch/);
  assert.match(forged[1].why, /merge/);
  assert.deepEqual(bytes(store.dir), before, 'verify-facts never writes to the store');
});

test('verify-facts says unreachable when GitHub cannot be read, and mismatch for a ref it cannot parse', async () => {
  const { store } = await doneThroughGithub();
  const down = await verifyFacts(store, { fetcher: fakeGithub({ down: 'HTTP 502' }) });
  assert.deepEqual(down.map((r) => r.result), ['unreachable', 'unreachable', 'unreachable']);
  assert.match(verifyFactsText(down), /^unreachable .*HTTP 502/m);
  const page = await verifyFacts(store, { fetcher: fakeGithub({ ref: 'feat/x', earlier: ['1111111aaa'.repeat(4)], totalCount: 5 }) });
  assert.equal(page[1].result, 'mismatch', 'the pagination rule holds here too');
});

test('harness verify-facts --store: one line per fact, exit 1 on a mismatch, nothing written', () => {
  const { dir, store } = itemAtVerify('x', 'o/r#7');
  const run = () => spawnSync(process.execPath, [bin, 'verify-facts', '--store', dir], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: '' } });
  const none = run();
  assert.equal(none.status, 0, none.stderr);
  // A ref that names no GitHub fact is a mismatch without reading GitHub.
  apply(store, { type: 'CHECKS_PASSED', pr: 'o/r#7', actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref: 'trust me' } }, { to: 'item:x', id: 'forged' });
  const before = bytes(dir);
  const r = run();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^mismatch forged item:x CHECKS_PASSED trust me: /m);
  assert.deepEqual(bytes(dir), before);
});

test('replay and repair docs point to verify-facts', () => {
  const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' }).stdout.split('\n');
  for (const cmd of ['replay', 'repair']) {
    const at = help.findIndex((l) => l.startsWith(`  ${cmd} `));
    const rest = help.slice(at + 1);
    const block = [help[at], ...rest.slice(0, rest.findIndex((l) => !/^ {5,}/.test(l)))].join('\n');
    assert.match(block, /verify-facts/, `help for ${cmd}`);
    assert.match(README.slice(README.indexOf(`harness ${cmd}`)).split('\n- ')[0], /verify-facts/, `README for ${cmd}`);
  }
  assert.match(help.join('\n'), /verify-facts \[--store/);
});
