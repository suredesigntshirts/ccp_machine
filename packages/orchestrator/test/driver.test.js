import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drive } from '../src/driver.js';
import { openItem } from '../src/item.js';

const start = '2026-10-28T18:00:00.000Z';
const sha = (c) => c.repeat(40);
const INIT = { event: { type: 'xstate.init', input: { issue: { url: 'sandbox:issues/1', expect: ['multiply works'] } } }, source: 'person' };
const tick = () => new Promise((resolve) => setImmediate(resolve));

const fakeClock = () => {
  let now = Date.parse(start);
  const timers = new Set();
  return {
    now: () => new Date(now).toISOString(),
    setTimeout: (fn, ms) => timers.add({ due: now + ms, fn }) && [...timers].at(-1),
    clearTimeout: (t) => timers.delete(t),
    advance(ms) {
      now += ms;
      for (const t of [...timers]) if (t.due <= now) timers.delete(t) && t.fn();
    }
  };
};

const stub = (output) => async () => ({ output, source: 'stub' });
const never = (aborted) => (_input, { signal }) => new Promise(() => signal.addEventListener('abort', () => aborted.push('build')));
const actors = (over = {}) => ({
  brief: stub({ builder: 'b.md', verifier: 'v.md' }),
  build: stub({ pr: { branch: 'item/1', headSha: sha('a'), url: 'file:///repo#item/1' } }),
  verify: async ({ pr }) => ({ output: { result: 'PASS', sha: pr.headSha, report: 'r.md' }, source: 'stub' }),
  ask: async ({ choices }) => ({ output: { choice: choices[0], by: 'stub' }, source: 'stub' }),
  merge: stub({ sha: sha('c') }),
  ...over
});
const tempItem = () => openItem(mkdtempSync(join(tmpdir(), 'orchestrator-test-')));

test('drives an item to done, journaling every input it accepted', async () => {
  const item = tempItem();
  const { send, settled } = drive({ ...item, actors: actors(), clock: fakeClock() });
  send(INIT);
  const snapshot = await settled;
  assert.equal(snapshot.value, 'done');
  assert.deepEqual(item.journal.read(), item.host.journal);
  assert.deepEqual(item.host.journal.map((e) => e.event.type.replace('xstate.done.actor.', '')), ['xstate.init', 'brief', 'build', 'verify', 'ask', 'merge']);
});

test('resumes after a crash: the run in flight starts again under the same id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestrator-test-'));
  const first = openItem(dir);
  drive({ ...first, actors: actors({ build: never([]) }), clock: fakeClock() }).send(INIT);
  await tick();
  assert.equal(first.host.snapshot.value, 'building'); // and then the process dies

  const second = openItem(dir);
  assert.deepEqual(second.host.pending.map((p) => p.run ?? p.id), ['1.build', 'xstate.after.buildTimeout.item.building']);
  assert.equal((await drive({ ...second, actors: actors(), clock: fakeClock() }).settled).value, 'done');
  assert.equal(second.journal.read().find((e) => e.event.type === 'xstate.done.actor.build').run, '1.build');
});

test('a build that outlives its timer is stopped, and the item goes to replanning', async () => {
  const clock = fakeClock();
  const aborted = [];
  const asked = [];
  const item = tempItem();
  const { send, settled } = drive({
    ...item,
    clock,
    actors: actors({ build: never(aborted), ask: async (input) => (asked.push(input.question), { output: { choice: 'drop', by: 'stub' }, source: 'stub' }) })
  });
  send(INIT);
  await tick();
  clock.advance(3_600_000);
  assert.equal((await settled).value, 'dropped');
  assert.deepEqual(aborted, ['build']);
  assert.match(asked[0], /Replan/);
});

test('an actor that throws sends its error event, and a refused input is logged, not journaled', async () => {
  const logged = [];
  const item = tempItem();
  const { send, settled } = drive({
    ...item,
    clock: fakeClock(),
    log: (x) => logged.push(x),
    actors: actors({ build: async () => { throw new Error('no network'); }, ask: stub({ choice: 'drop', by: 'stub' }) })
  });
  send(INIT);
  assert.equal(send({ event: { type: 'pr.pushed', headSha: sha('b') }, source: 'github' }).ok, false);
  assert.equal((await settled).value, 'dropped');
  const error = item.host.journal.find((e) => e.event.type === 'xstate.error.actor.build');
  assert.equal(error.event.error, 'no network');
  assert.equal(item.host.journal.at(-1).event.output.choice, 'drop');
  assert.equal(item.host.snapshot.context.failure, 'no network');
  assert.match(logged.find((x) => x.refused).refused, /not taken in "briefing"/);
});

test('idle comes once only sessions are left: an answered session runs on first', async () => {
  const item = tempItem();
  const agent = (claim) => ({ claim: { type: 'object' }, tools: [], prepare: () => ({ prompt: 'p' }), finish: () => claim });
  const parked = [];
  const sessions = (job, { run }) => (run.endsWith('build') ? Promise.resolve({ claim: {}, source: 'answered' }) : (parked.push(run), new Promise(() => {})));
  const driver = drive({ ...item, sessions, clock: fakeClock(), actors: actors({ build: agent({ pr: { branch: 'b', headSha: sha('a'), url: 'u' } }), verify: agent({}) }) });
  driver.send(INIT);
  const snapshot = await driver.idle();
  assert.equal(snapshot.value, 'verifying');
  assert.deepEqual(parked, ['2.verify']);
});
