// The step protocol a host that runs its own sessions (the Claude Code mod) speaks, on a real sandbox repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSandboxItem } from '../src/sandbox.js';
import { refusal, step } from '../src/step.js';

const ISSUE = { url: 'sandbox:issues/7', title: 'Add multiply', expect: ['math.js exports multiply'] };
// Each call opens the item afresh, as each of the mod's calls is its own process.
const call = (dir, input) => step(openSandboxItem(dir), input);

test('a host that runs its own sessions takes an item from issue to merge, one step at a time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestrator-step-'));
  const started = await call(dir, { event: { type: 'xstate.init', input: { issue: ISSUE } }, source: 'person' });
  assert.equal(started.state, 'building');
  const [build] = started.sessions;
  assert.deepEqual([build.run, build.actor, build.tools.includes('Edit')], ['1.build', 'build', true]);
  assert.equal(started.timers.length, 1);

  assert.deepEqual(refusal(openSandboxItem(dir), { run: '1.build', claim: {} }), { rejected: ['$.summary is missing'] });
  writeFileSync(join(build.cwd, 'math.js'), 'export const add = (a, b) => a + b;\nexport const multiply = (a, b) => a * b;\n');
  const built = await call(dir, { run: '1.build', claim: { summary: 'multiply' }, source: 'agent:b' });
  assert.deepEqual([built.state, built.sessions.map((s) => s.run), built.timers], ['verifying', ['2.verify'], []]);
  assert.match(built.sessions[0].prompt, /export const multiply/); // the diff the host gathered

  const resumed = await call(dir, null); // a host that lost track asks again: the same session, not a new one
  assert.deepEqual(resumed.sessions.map((s) => s.run), ['2.verify']);

  const verified = await call(dir, { run: '2.verify', claim: { result: 'PASS', report: 'holds' }, source: 'agent:v' });
  assert.deepEqual(verified.sessions.map((s) => [s.run, s.actor]), [['3.ask', 'ask']]);
  assert.deepEqual(await call(dir, { run: '2.verify', claim: { result: 'PASS', report: 'again' }, source: 'agent:v' }), { refused: 'run 2.verify is not in flight' });

  const merged = await call(dir, { run: '3.ask', claim: { choice: 'approve', why: 'it holds' }, source: 'agent:s' });
  assert.equal(merged.done, true);
  assert.equal(merged.output.verdict.sha, merged.output.pr.headSha);
  assert.match(merged.output.merge.sha, /^[0-9a-f]{40}$/);
});

test('a session that ends without a claim fails its actor, and the item goes to replanning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestrator-step-'));
  await call(dir, { event: { type: 'xstate.init', input: { issue: ISSUE } }, source: 'person' });
  const out = await call(dir, { run: '1.build', failed: 'the session ended without returning a claim', source: 'agent:b' });
  assert.equal(out.state, 'replanning');
  assert.equal(openSandboxItem(dir).host.snapshot.context.failure, 'the session ended without returning a claim');
});
