// M1d: close the M1c binding gaps. The branch names the item exactly, PR refs normalise to one key,
// verify-facts needs a log, its binding and on-the-PR rules are pinned, a close goes through the same checks
// as a merge, and CI ids name the PR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, init, status, fromGithub, prMap, prKey, verifyFacts } from '../src/index.js';
import * as binding from '../src/pr-binding.js';
import { apply, start } from './send.js';
import { fakeGithub, HEAD } from './github-fake.js';

const bin = new URL('../bin/harness.js', import.meta.url).pathname;
const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const wake = (kind, data) => `<wake reason="external-event"><event source="github" kind="${kind}" from="system" trust="relay">${JSON.stringify(data)}</event></wake>`;
const counts = (store) => [store.read().version, store.events().length, store.outbox().length, store.acks().length];
const state = (store, id) => status(store).items.find((i) => i.id === id)?.state;
const suite = (pr, head_sha = HEAD) => wake('check_suite.completed', { head_sha, pr });
const closed = (pr) => wake('pull_request.closed', { outcome: 'closed', pr });
const merge = (pr) => wake('pull_request.closed', { outcome: 'merged', pr });
const github = { actor: { kind: 'github', id: 'github' } };

/** A store with item `id` requested at 12:00, its build naming `pr`, now verifying. */
function itemAtVerify(id, pr, store) {
  if (!store) {
    store = openStore(tempDir('harness-m1d-'));
    init(store);
    start(store);
  }
  apply(store, { type: 'REQUEST_RECEIVED', request: { id, tier: 0 } }, { id: `req-${id}`, now: '2026-10-27T12:00:00.000Z' });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: `item:${id}` });
  const r = apply(store, { type: 'RUN_SUCCEEDED', pr }, { to: `item:${id}` });
  assert.ok(!r.refused, r.why);
  return store;
}

async function refused(store, text, fetcher, why) {
  const before = counts(store);
  const r = await fromGithub(store, text, { fetcher });
  assert.equal(r.result, 'refused', JSON.stringify(r));
  assert.match(r.why, why);
  assert.deepEqual(counts(store), before, 'a refusal writes nothing');
  return r;
}

// Outcome 1: the branch's slug is the item id.

test('the branch slug must equal the item id: <type>/[<issue>-]<id>[--<agent>]', () => {
  const yes = [
    ['feat/github-facts-from-github', 'github-facts-from-github'],
    ['feat/42-github-facts-from-github', 'github-facts-from-github'],
    ['feat/42-github-facts-from-github--tests', 'github-facts-from-github'],
    ['fix/e', 'e'],
    ['feat/12-e', 'e'],
    ['feat/e--tests', 'e'],
    ['feat/x', 'x'],
    ['feat/7-x', 'x'],
    ['feat/42-retry', '42-retry']
  ];
  const no = [
    ['feat/github-facts-from-github', 'github-facts'],
    ['feat/github-facts-from-github', 'from-github'],
    ['feat/42-github-facts', 'github'],
    ['feat/ex', 'e'],
    ['feat/e-x', 'e'],
    ['feat/x-e', 'e'],
    ['feat/12-e-2', 'e'],
    ['feat/a/e', 'e'],
    ['e', 'e'],
    ['feat/', 'e'],
    ['feat/7-x-login', 'x'],
    ['feat/actor-on-envelope', 'actor'],
    ['', 'x']
  ];
  const { branchNamesItem } = binding;
  assert.equal(typeof branchNamesItem, 'function', 'pr-binding.js exports branchNamesItem');
  for (const [branch, item] of yes) assert.equal(branchNamesItem(branch, item), true, `${branch} names ${item}`);
  for (const [branch, item] of no) assert.equal(branchNamesItem(branch, item), false, `${branch} does not name ${item}`);
});

test('from-github: feat/github-facts-from-github is item github-facts-from-github\'s PR, not item github-facts\'s', async () => {
  const fetcher = fakeGithub({ ref: 'feat/github-facts-from-github' });
  const a = itemAtVerify('github-facts', 'o/r#7');
  await refused(a, suite('o/r#7'), fetcher, /branch feat\/github-facts-from-github does not name item github-facts/);
  const b = itemAtVerify('github-facts-from-github', 'o/r#7');
  assert.equal((await fromGithub(b, suite('o/r#7'), { fetcher })).result, 'sent');
  // A one-character id matches only a slug that is exactly that id.
  const e = itemAtVerify('e', 'o/r#7');
  await refused(e, suite('o/r#7'), fakeGithub({ ref: 'feat/github-facts-from-github' }), /does not name item e/);
  await refused(e, suite('o/r#7'), fakeGithub({ ref: 'feat/e-2' }), /does not name item e/);
  assert.equal((await fromGithub(e, suite('o/r#7'), { fetcher: fakeGithub({ ref: 'feat/12-e' }) })).result, 'sent');
});

test('verify-facts uses the same branch rule', async () => {
  const store = itemAtVerify('github-facts', 'o/r#7');
  apply(store, { type: 'CHECKS_PASSED', pr: 'o/r#7', ...github, source: { kind: 'github-wake', ref: `o/r#7@${HEAD}:checks=success` } }, { to: 'item:github-facts', id: 'ci' });
  const [r] = await verifyFacts(store, { fetcher: fakeGithub({ ref: 'feat/github-facts-from-github' }) });
  assert.equal(r.result, 'mismatch');
  assert.match(r.why, /does not name item github-facts/);
  assert.equal((await verifyFacts(store, { fetcher: fakeGithub({ ref: 'feat/3-github-facts--tests' }) }))[0].result, 'ok');
});

test('the README gives the exact branch form workers must use', () => {
  assert.match(README, /item id in (the|its|their) branch name/i);
  assert.match(README, /`<type>\/<issue>-<item id>`/);
  assert.match(README, /`<type>\/<issue>-<item id>--<agent>`/);
  assert.doesNotMatch(README, /branch whose name (does not )?contains? the item id/);
});

// Outcome 2: one key per PR.

test('prKey normalises: owner/repo lowercased, the number an integer, every spelling one key', () => {
  for (const ref of ['o/r#7', 'O/R#7', 'o/r#007', 'https://github.com/o/r/pull/7', 'https://github.com/O/R/pull/0007', 'https://github.com/o/r/pull/7/files', 'o/r/pull/7', 'github.com/O/r/pull/07#discussion', 'https://api.github.com/repos/o/r/pulls/7'])
    assert.equal(prKey(ref), 'o/r#7', ref);
  assert.equal(prKey('Suredesigntshirts/CCP_machine#21'), 'suredesigntshirts/ccp_machine#21');
  assert.equal(prKey('o/r#0'), 'o/r#0');
  assert.equal(prKey('no pr here'), null);
  assert.equal(prKey(null), null);
});

test('a spelling variant of a bound PR is the same PR: refused as a second binding, fine for its own item', async () => {
  const store = itemAtVerify('x', 'https://github.com/o/r/pull/7');
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'y', tier: 0 } }, { id: 'req-y' });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:y' });
  for (const variant of ['O/R#7', 'o/r#07', 'https://github.com/O/r/pull/0007']) {
    const before = counts(store);
    const r = apply(store, { type: 'RUN_SUCCEEDED', pr: variant }, { to: 'item:y' });
    assert.equal(r.refused, true, variant);
    assert.match(r.why, /o\/r#7 is bound to item x/);
    assert.deepEqual(counts(store), before);
  }
  assert.deepEqual(prMap(store.events()), { 'o/r#7': 'x' });
  // Item x naming its own PR in another spelling is not a rebinding.
  assert.equal(binding.bindingError?.(store.events(), 'item:x', 'O/R#007'), null);
  // A wake spelling the PR differently finds the bound item.
  assert.equal((await fromGithub(store, suite('https://github.com/O/R/pull/07'), { fetcher: fakeGithub({ ref: 'feat/x' }) })).item, 'x');
});

// Outcome 3: verify-facts needs a log.

test('verify-facts on a store with no events.jsonl exits non-zero with a clear message and creates nothing', () => {
  const parent = tempDir('harness-m1d-nostore-');
  const missing = join(parent, 'nope');
  const r = spawnSync(process.execPath, [bin, 'verify-facts', '--store', missing], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: '' } });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /no events\.jsonl/);
  assert.match(r.stderr, /nope/);
  assert.equal(existsSync(missing), false, 'no folder created');
  // An existing folder without a log: the same, and nothing written into it.
  const empty = tempDir('harness-m1d-empty-');
  const e = spawnSync(process.execPath, [bin, 'verify-facts', '--dir', empty], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: '' } });
  assert.notEqual(e.status, 0);
  assert.match(e.stderr, /no events\.jsonl/);
  assert.deepEqual(readdirSync(empty), []);
});

test('other commands still open (and create) the store as before', () => {
  const dir = join(tempDir('harness-m1d-other-'), 'fresh');
  const r = spawnSync(process.execPath, [bin, 'init', '--dir', dir], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'orch' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(dir, 'events.jsonl')), true);
});

// Outcome 4: verify-facts' binding and on-the-PR rules, each pinned.

test('verify-facts: a fact logged to an item the PR is not bound to is a mismatch, though GitHub backs it', async () => {
  const store = itemAtVerify('x', 'o/r#7');
  itemAtVerify('y', 'o/r#8', store);
  // Written straight into the log for item y (no `pr`, so apply() has no binding to check); every GitHub
  // check passes for y (branch feat/y, created after the request, head on the PR, green), so only the
  // binding rule can say no.
  apply(store, { type: 'CHECKS_PASSED', ...github, source: { kind: 'github-wake', ref: `o/r#7@${HEAD}:checks=success` } }, { to: 'item:y', id: 'other-item' });
  const [r] = await verifyFacts(store, { fetcher: fakeGithub({ ref: 'feat/y' }) });
  assert.equal(r.result, 'mismatch', JSON.stringify(r));
  assert.match(r.why, /o\/r#7 is bound to item x, not y/);
  // An item no event binds to a PR.
  itemAtVerify('z', 'o/r#9', store);
  apply(store, { type: 'CHECKS_PASSED', ...github, source: { kind: 'github-wake', ref: `o/r#10@${HEAD}:checks=success` } }, { to: 'item:z', id: 'unbound' });
  const z = (await verifyFacts(store, { fetcher: fakeGithub({ ref: 'feat/z' }) })).find((f) => f.id === 'unbound');
  assert.equal(z.result, 'mismatch');
  assert.match(z.why, /no event of item z names o\/r#10/);
});

test('verify-facts: a CI fact for a commit that is not on the PR is a mismatch, though its checks are green', async () => {
  const store = itemAtVerify('x', 'o/r#7');
  const elsewhere = '3333333ccc'.repeat(4);
  apply(store, { type: 'CHECKS_PASSED', pr: 'o/r#7', ...github, source: { kind: 'github-wake', ref: `o/r#7@${elsewhere}:checks=success` } }, { to: 'item:x', id: 'off-pr' });
  // GitHub has green runs for that commit, but it is not one of the PR's.
  const [r] = await verifyFacts(store, { fetcher: fakeGithub({ ref: 'feat/x', offPr: [elsewhere] }) });
  assert.equal(r.result, 'mismatch', JSON.stringify(r));
  assert.match(r.why, /3333333 is not a commit of o\/r#7/);
  // The same commit on the PR is ok.
  assert.equal((await verifyFacts(store, { fetcher: fakeGithub({ ref: 'feat/x', earlier: [elsewhere] }) }))[0].result, 'ok');
});

// Outcome 5: a close goes through the same checks as a merge.

test('a closed-unmerged wake (CANCEL) is refused unless the PR is the item\'s own and GitHub says closed unmerged', async () => {
  const store = itemAtVerify('x', 'o/r#7');
  const shut = (o) => fakeGithub({ ref: 'feat/x', merged: false, state: 'closed', ...o });
  await refused(store, closed('o/r#7'), shut({ createdAt: '2026-10-27T11:00:00Z' }), /created 2026-10-27T11:00:00Z, before item x's request/);
  await refused(store, closed('o/r#7'), shut({ ref: 'feat/7-x-login' }), /does not name item x/);
  await refused(store, closed('o/r#7'), shut({ mangle: (p) => ({ ...p, number: 8 }) }), /malformed/);
  await refused(store, closed('o/r#7'), shut({ down: 'HTTP 502' }), /cannot reach GitHub/);
  await refused(store, closed('o/r#7'), shut({ state: 'open' }), /o\/r#7 is open, not closed without merging/);
  await refused(store, closed('o/r#7'), fakeGithub({ ref: 'feat/x', merged: true }), /o\/r#7 is merged, not closed without merging/);
  // A PR no item names is unknown, as for a merge.
  assert.equal((await fromGithub(store, closed('o/r#99'), { fetcher: shut() })).result, 'unknown');
  assert.match(state(store, 'x'), /verifying/);
  const ok = shut();
  const r = await fromGithub(store, closed('o/r#7'), { fetcher: ok });
  assert.equal(r.result, 'sent', JSON.stringify(r));
  assert.deepEqual(ok.calls, ['repos/o/r/pulls/7'], 'GitHub was read');
  assert.deepEqual(store.events().at(-1).source, { kind: 'github-wake', ref: 'o/r#7' });
  // verify-facts agrees.
  assert.equal((await verifyFacts(store, { fetcher: shut() })).at(-1).result, 'ok');
});

test('the binding check holds for a close as for a merge: a PR bound to another item cancels only that item', async () => {
  const store = itemAtVerify('x', 'o/r#7');
  itemAtVerify('y', 'o/r#8', store);
  const shut = fakeGithub({ ref: 'feat/y', merged: false, state: 'closed' });
  // #7 is x's, so its close is checked against x (branch feat/y is not x's) and y is untouched.
  await refused(store, closed('o/r#7'), shut, /does not name item x/);
  await refused(store, merge('o/r#7'), fakeGithub({ ref: 'feat/y' }), /does not name item x/);
  assert.match(state(store, 'y'), /verifying/);
});

// Outcome 6: CI ids name the PR.

test('two items\' CI wakes on the same sha are both applied, with ids naming their PRs', async () => {
  const store = itemAtVerify('x', 'o/r#7');
  itemAtVerify('y', 'o/r#8', store);
  const fx = fakeGithub({ ref: 'feat/x' });
  const fy = fakeGithub({ ref: 'feat/y' });
  const fetcher = async (path) => (/\/pulls\/8\b/.test(path) ? fy(path) : fx(path));
  const a = await fromGithub(store, suite('o/r#7'), { fetcher });
  const b = await fromGithub(store, suite('o/r#8'), { fetcher });
  assert.deepEqual([a.result, b.result], ['sent', 'sent'], JSON.stringify([a, b]));
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /o\/r#7/);
  assert.match(b.id, /o\/r#8/);
  assert.match(state(store, 'x'), /merging/);
  assert.match(state(store, 'y'), /merging/);
  // The same wake again is still a duplicate.
  assert.equal((await fromGithub(store, suite('o/r#8'), { fetcher })).result, 'duplicate');
});
