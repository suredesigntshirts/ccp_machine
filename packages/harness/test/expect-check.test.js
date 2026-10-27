import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, init, apply, status, expectLines, checkTemplate, parseCheck, checkVerdict, initCheck, readCheck, acceptBlocked, renderItemPage } from '../src/index.js';

const bin = new URL('../bin/harness.js', import.meta.url).pathname;
const harness = (dir, ...args) => spawnSync(process.execPath, [bin, ...args, '--dir', dir], { encoding: 'utf8' });

test('expect splits into lines; a check parses and counts met only with evidence', () => {
  assert.deepEqual(expectLines('- a works\n2. b works; c works\n\n'), ['a works', 'b works', 'c works']);
  const md = checkTemplate('x', ['a | b', 'c']);
  assert.deepEqual(parseCheck(md), [{ status: 'unclear', line: 'a / b', evidence: '' }, { status: 'unclear', line: 'c', evidence: '' }]);
  const lines = parseCheck('- [met] a | evidence: test a\n- [met] b | evidence:\n- [unmet] c | evidence: no test\n- [maybe] d');
  assert.deepEqual(checkVerdict(lines), { lines: 4, met: 1, unmet: 1, unclear: 2, allMet: false });
  assert.equal(checkVerdict([]).allMet, false);
});

test('the stand-in may approve an accept gate only when every expected line is met', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-'));
  const store = openStore(dir);
  init(store);
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'x', tier: 1, expect: 'a works; b works' } });
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'y', tier: 1 } });
  const approve = { type: 'STAND_IN_ANSWERED', answer: { choice: 'approve', confidence: 0.95, threshold: 0.9, autonomy: 'act' } };
  const to = 'item:x/decision:x:accept:2';
  assert.match(acceptBlocked(store, approve, to), /write the check first: harness check x --init/);
  assert.equal(acceptBlocked(store, approve, 'item:x/decision:x:plan:1'), null, 'only the accept gate');
  assert.equal(acceptBlocked(store, approve, 'item:y/decision:y:accept:2'), null, 'no expect, no check');
  assert.equal(acceptBlocked(store, { ...approve, answer: { ...approve.answer, choice: 'revise' } }, to), null);

  assert.equal(initCheck(store, 'x', 'a works; b works').created, true);
  assert.equal(initCheck(store, 'x', 'ignored').created, false, 'never overwrites');
  assert.match(acceptBlocked(store, approve, to), /0 of 2 expected lines met/);
  writeFileSync(join(dir, 'checks', 'x.md'), '- [met] a works | evidence: test a\n- [met] b works | evidence: PR #1\n');
  assert.equal(acceptBlocked(store, approve, to), null);

  // The CLI refuses the send and the item page shows the check beside the ask.
  writeFileSync(join(dir, 'checks', 'x.md'), '- [met] a works | evidence: test a\n- [unmet] b works | evidence: none yet\n');
  const r = harness(dir, 'send', JSON.stringify(approve), '--to', to);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /1 of 2 expected lines met/);
  assert.equal(harness(dir, 'check', 'x').status, 1);
  const item = status(store).items.find((i) => i.id === 'x');
  const page = renderItemPage(item, { events: store.events(), outbox: store.outbox(), acks: store.acks(), checks: { x: readCheck(store, 'x') } });
  assert.match(page, /<li class="ok"><b>met<\/b> a works<br><span class="m">test a<\/span><\/li><li class="bad"><b>unmet<\/b> b works/);
  assert.match(renderItemPage(item, { events: store.events() }), /Not yet checked against these expectations/);
});
