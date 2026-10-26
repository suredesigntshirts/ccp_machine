import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, init, apply, status, parseGithubEvent, mapGithubEvent, fromGithub, prMap, prKey } from '../src/index.js';

const wake = (kind, data) => `<wake reason="external-event"><event source="github" kind="${kind}" from="system" trust="relay">
    <!-- harness guidance, with a {"brace"} in it -->
    ${JSON.stringify(data)}
  </event></wake>`;
const PR = 'o/r#7';
const PR_URL = 'https://github.com/o/r/pull/7';

function storeAtVerify() {
  const dir = mkdtempSync(join(tmpdir(), 'harness-'));
  const store = openStore(dir);
  init(store);
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'x', tier: 0 } });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:x' });
  apply(store, { type: 'RUN_SUCCEEDED', pr: PR_URL }, { to: 'item:x' });
  return { dir, store };
}
const state = (store) => status(store).items[0].state;

test('a wake\'s event text and plain JSON both parse; PR refs normalise', () => {
  assert.deepEqual(parseGithubEvent(wake('pull_request.closed', { outcome: 'merged', pr: PR })), { kind: 'pull_request.closed', data: { outcome: 'merged', pr: PR } });
  assert.deepEqual(parseGithubEvent('{"kind":"check_suite.completed","data":{"pr":"o/r#7"}}').kind, 'check_suite.completed');
  assert.equal(prKey(PR_URL), PR);
  assert.equal(prKey(PR), PR);
  assert.equal(prKey('nothing'), null);
});

test('each kind maps to its event; successes and other kinds are ignored', () => {
  assert.equal(mapGithubEvent({ kind: 'check_suite.completed', data: { pr: PR, head_sha: 'abcdef123' } }).id, 'ci-abcdef1-passed');
  assert.equal(mapGithubEvent({ kind: 'check_run.completed', data: { pr: PR, head_sha: 'abcdef123', conclusion: 'failure', check: 'test' } }).event.type, 'CHECKS_FAILED');
  assert.ok(mapGithubEvent({ kind: 'check_run.completed', data: { pr: PR, conclusion: 'success' } }).ignore);
  assert.equal(mapGithubEvent({ kind: 'pull_request.closed', data: { pr: PR, outcome: 'merged' } }).id, 'merge-pr7');
  assert.equal(mapGithubEvent({ kind: 'pull_request.closed', data: { pr: PR, outcome: 'closed' } }).event.type, 'CANCEL');
  assert.ok(mapGithubEvent({ kind: 'subscription.created', data: { pr: PR } }).ignore);
});

test('a failed check, then a green suite, then the merge drive the item to done', () => {
  const { store } = storeAtVerify();
  assert.deepEqual(prMap(store.events()), { [PR]: 'x' });
  const fail = fromGithub(store, wake('check_run.completed', { check: 'test', conclusion: 'failure', head_sha: '1111111aaa', pr: PR }));
  assert.deepEqual([fail.result, fail.event, fail.id], ['sent', 'CHECKS_FAILED', 'ci-1111111-failed']);
  assert.equal(fromGithub(store, wake('check_suite.completed', { head_sha: '1111111aaa', pr: PR })).result, 'stale', 'building again, not verifying');
  apply(store, { type: 'RUN_SUCCEEDED', pr: PR_URL }, { to: 'item:x' });
  assert.equal(fromGithub(store, wake('check_suite.completed', { head_sha: '2222222bbb', pr: PR })).result, 'sent');
  assert.match(state(store), /merging/);
  assert.equal(fromGithub(store, wake('check_suite.completed', { head_sha: '2222222bbb', pr: PR })).result, 'stale');
  const merged = fromGithub(store, wake('pull_request.closed', { outcome: 'merged', pr: PR }));
  assert.deepEqual([merged.result, merged.id], ['sent', 'merge-pr7']);
  assert.equal(state(store), 'done');
  assert.deepEqual(store.pending().filter((e) => e.name === 'mergePullRequest'), [], 'the merge effect is acked');
  assert.equal(fromGithub(store, wake('pull_request.closed', { outcome: 'merged', pr: PR })).result, 'stale');
  assert.equal(fromGithub(store, wake('check_suite.completed', { head_sha: '3', pr: 'o/r#99' })).result, 'unknown');
});

test('harness from-github reads a file', () => {
  const { dir } = storeAtVerify();
  const f = join(dir, 'ev.txt');
  writeFileSync(f, wake('check_suite.completed', { head_sha: 'feedbee', pr: PR }));
  const r = spawnSync(process.execPath, [new URL('../bin/harness.js', import.meta.url).pathname, 'from-github', f, '--dir', dir], { encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).event, 'CHECKS_PASSED');
});

test('a wake\'s current-time is stamped on the event as observedAt', () => {
  const { store } = storeAtVerify();
  const text = wake('check_suite.completed', { head_sha: '2222222bbb', pr: PR }).replace('<wake ', '<wake current-time="2026-10-26T20:45:55Z" ');
  assert.equal(parseGithubEvent(text).at, '2026-10-26T20:45:55Z');
  assert.equal(fromGithub(store, text).result, 'sent');
  assert.equal(store.events().at(-1).event.observedAt, '2026-10-26T20:45:55.000Z');
});

test('a failed check, then a passing re-run on the same commit, both reach the item', () => {
  const { store } = storeAtVerify();
  assert.equal(fromGithub(store, wake('check_run.completed', { check: 'test', conclusion: 'failure', head_sha: '1111111aaa', pr: PR })).result, 'sent');
  // The host re-ran the job instead of pushing: the same build goes back to verify.
  apply(store, { type: 'RUN_SUCCEEDED', pr: PR_URL }, { to: 'item:x', id: 'run-pr7-rerun' });
  const pass = fromGithub(store, wake('check_suite.completed', { head_sha: '1111111aaa', pr: PR }));
  assert.deepEqual([pass.result, pass.id], ['sent', 'ci-1111111-passed']);
  assert.match(state(store), /merging/);
});
