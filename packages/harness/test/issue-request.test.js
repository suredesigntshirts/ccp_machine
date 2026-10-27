import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, init, requestFromIssue, issueBody, expectFrom } from '../src/index.js';

const bin = new URL('../bin/harness.js', import.meta.url).pathname;
// The issue is written by the writer, so the body is in the one format.
const base = {
  number: 88,
  title: 'File a backlog issue as a request',
  html_url: 'https://github.com/o/r/issues/88',
  repository_url: 'https://api.github.com/repos/o/r',
  body: `${issueBody({ id: 'issue-request', why: 'Why it matters.', expect: ['a works', 'b is refused'] })}\n---\n_footer_`
};
const filed = (dir, id) => openStore(dir).events().find((e) => e.event.type === 'REQUEST_RECEIVED' && e.event.request?.id === id)?.event.request;

for (const [eol, name] of [['\n', '\\n'], ['\r\n', '\\r\\n']])
test(`round trip (${name} line ends): an issue body the writer writes is filed and parsed back to the same id and expect lines, with no tier`, () => {
  const issue = { ...base, body: base.body.replace(/\n/g, eol) };
  if (eol !== '\n') assert.match(issue.body, /\r\n## Expect\r\n/);
  assert.deepEqual(requestFromIssue(issue), { id: 'issue-request', title: issue.title, project: 'r', url: issue.html_url, expect: 'a works\nb is refused' });
  const dir = tempDir('harness-');
  init(openStore(dir));
  const f = join(dir, 'issue.json');
  writeFileSync(f, JSON.stringify(issue));
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: 'orchestrator-session' };
  const r = spawnSync(process.execPath, [bin, 'issue-request', f, '--dir', dir], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).refused, undefined, r.stdout);
  const request = filed(dir, 'issue-request');
  assert.deepEqual(expectFrom(issueBody({ id: request.id, expect: request.expect.split('\n') })), ['a works', 'b is refused'], 'written again, it parses the same');
  assert.equal('tier' in request, false, 'the filer sets no tier');
  const again = spawnSync(process.execPath, [bin, 'issue-request', f, '--dir', dir], { encoding: 'utf8', env });
  assert.equal(JSON.parse(again.stdout).duplicate, true, 'req-issue88 files once');
});

test('one Expect format: the "## Expect" section\'s bullets, up to the next heading or rule; a tier on the item line is ignored', () => {
  const body = 'Item id: `x`, tier 0. Why.\n\nExpect: an old-style line is not the format\n\n## Expect (outcomes, not a design)\n\nProse is not a line.\n\n- one\n* two\n\n## Notes\n\n- not expected';
  assert.deepEqual(expectFrom(body), ['one', 'two']);
  assert.deepEqual(requestFromIssue({ number: 1, title: 't', body }), { id: 'x', title: 't', project: null, url: undefined, expect: 'one\ntwo' });
  assert.equal(requestFromIssue({ number: 2, title: 't', body: 'Item id: `y`.' }).expect, undefined, 'no Expect section, no expect');
});

test('the issue template is in the writer\'s format and parses with the parser', () => {
  const template = readFileSync(new URL('../../../.github/ISSUE_TEMPLATE/harness-backlog.md', import.meta.url), 'utf8');
  const body = template.replace(/^---\n[^]*?\n---\n\n/, '');
  const r = requestFromIssue({ number: 0, title: 'template', body });
  assert.ok(r.id && r.expect, 'an item id and expect lines');
  assert.doesNotMatch(body.split('\n')[0], /tier/i, 'the item line names no tier');
  const why = body.split('\n\n')[1];
  assert.equal(issueBody({ id: r.id, why, expect: r.expect.split('\n') }), body, 'the writer writes the template exactly');
});

test('an issue without an item id line is refused', () => {
  assert.throws(() => requestFromIssue({ ...base, body: 'no item line' }), /#88 has no "Item id/);
});
