import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, init, requestFromIssue, requestOf } from '../src/index.js';

const bin = new URL('../bin/harness.js', import.meta.url).pathname;
const issue = {
  number: 88,
  title: 'File a backlog issue as a request',
  html_url: 'https://github.com/o/r/issues/88',
  repository_url: 'https://api.github.com/repos/o/r',
  body: 'Item id: `issue-request`, tier 1. Why.\n\nExpect: a works\nExpect: b is refused\n\n---\n_footer_'
};

test("an issue's JSON becomes a request with its id, tier, url and expect", () => {
  assert.deepEqual(requestFromIssue(issue), { id: 'issue-request', title: issue.title, project: 'r', tier: 1, url: issue.html_url, expect: 'a works\nb is refused' });
  const dir = mkdtempSync(join(tmpdir(), 'harness-'));
  init(openStore(dir));
  const f = join(dir, 'issue.json');
  writeFileSync(f, JSON.stringify(issue));
  const r = spawnSync(process.execPath, [bin, 'issue-request', f, '--dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(requestOf(openStore(dir), 'issue-request').expect, 'a works\nb is refused');
  const again = spawnSync(process.execPath, [bin, 'issue-request', f, '--dir', dir], { encoding: 'utf8' });
  assert.equal(JSON.parse(again.stdout).duplicate, true, 'req-issue88 files once');
});

test('an issue without an item id line is refused', () => {
  assert.throws(() => requestFromIssue({ ...issue, body: 'no item line' }), /#88 has no "Item id/);
});
