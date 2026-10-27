// Fault injection: break a store on purpose and check that doctor names each fault with its repair,
// and that harness repair fixes the safe ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { readFileSync, writeFileSync, appendFileSync, utimesSync, closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openStore, init, status, doctor, repair } from '../src/index.js';
import { apply, start } from './send.js';

const fresh = () => {
  const store = openStore(tempDir('harness-chaos-'));
  init(store, {}, '2026-10-26T10:00:00Z');
  start(store, '2026-10-26T10:00:00Z');
  return store;
};
const soon = Date.parse('2026-10-26T11:00:00Z');
const req = (id) => ({ type: 'REQUEST_RECEIVED', request: { id } });
const problems = async (store, now = soon) => (await doctor(store, { now, verify: false })).problems;

test('a crash after state.json and before the log: doctor says so, repair --rebuild undoes it and a resend applies', async () => {
  const store = fresh();
  apply(store, req('a'), { id: 'req-a', now: '2026-10-26T10:01:00Z' });
  // The snapshot of the next event lands; the process dies before events.jsonl and outbox.jsonl.
  const before = readFileSync(join(store.dir, 'events.jsonl'), 'utf8');
  const outbox = readFileSync(join(store.dir, 'outbox.jsonl'), 'utf8');
  apply(store, { type: 'TRIAGED', tier: 0, criteria: ['it works'] }, { to: 'item:a', id: 'run-a', now: '2026-10-26T10:02:00Z' });
  writeFileSync(join(store.dir, 'events.jsonl'), before);
  writeFileSync(join(store.dir, 'outbox.jsonl'), outbox);
  assert.ok((await problems(store)).some((p) => /state.json is version 4, the last event is 3 .*repair --rebuild/.test(p)));
  assert.deepEqual(repair(store).left.length, 1, 'not rebuilt without --rebuild');
  assert.deepEqual(repair(store, { rebuild: true }).fixed, ['rebuilt state.json from events.jsonl at version 3']);
  assert.deepEqual((await problems(store)), []);
  const again = apply(store, { type: 'TRIAGED', tier: 0, criteria: ['it works'] }, { to: 'item:a', id: 'run-a', now: '2026-10-26T10:03:00Z' });
  assert.equal(again.duplicate, undefined, 'the resent event applies');
  assert.deepEqual(again.effects.map((e) => e.params?.step), ['build']);
  assert.deepEqual((await problems(store)), []);
});

test('a stale lock: the next writer takes over, doctor names it, repair clears it', async () => {
  const store = fresh();
  const lock = join(store.dir, 'lock');
  closeSync(openSync(lock, 'w'));
  const old = (Date.now() - 120_000) / 1000;
  utimesSync(lock, old, old);
  assert.ok((await problems(store, Date.now())).some((p) => /lock is older than 60s \(fix with harness repair\)/.test(p)));
  assert.deepEqual(repair(store).fixed, ['cleared a stale lock']);
  assert.deepEqual((await problems(store, Date.now())), []);
  closeSync(openSync(lock, 'w'));
  utimesSync(lock, old, old);
  apply(store, req('a'));
  assert.equal(status(store).items.length, 1, 'a writer clears a stale lock itself');
});

test('a fresh lock refuses a second writer', () => {
  const store = fresh();
  assert.throws(() => store.withLock(() => apply(store, req('a'))), /another writer holds/);
  assert.equal(status(store).items.length, 0);
});

test('two writer processes at once: every event lands once and the log stays contiguous', async () => {
  const store = fresh();
  const runtime = new URL('../src/index.js', import.meta.url).href;
  const writer = (tag) =>
    new Promise((resolve, reject) => {
      const code = `
        const { openStore, apply } = await import(${JSON.stringify(runtime)});
        const store = openStore(${JSON.stringify(store.dir)});
        for (let i = 0; i < 8; i++) {
          for (let tries = 0; ; tries++) {
            try { apply(store, { type: 'REQUEST_RECEIVED', request: { id: '${tag}' + i }, actor: { kind: 'session', id: 'writer-${tag}' }, source: { kind: 'cli', ref: 'test' } }, { id: 'req-${tag}' + i }); break; }
            catch (e) { if (tries > 2000 || !/another writer|state changed/.test(e.message)) throw e; }
          }
        }`;
      const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(err))));
    });
  await Promise.all([writer('x'), writer('y')]);
  const events = store.events();
  assert.equal(events.length, 17, 'the orchestrator starting, then 8 from each writer');
  assert.equal(new Set(events.map((e) => e.id)).size, 17);
  assert.deepEqual((await problems(store, Date.now())), []);
  assert.equal(store.read().version, 18);
});

test('the same event twice, or out of order, changes nothing and leaves a sound store', async () => {
  const store = fresh();
  apply(store, req('a'), { id: 'req-a' });
  assert.equal(apply(store, req('a'), { id: 'req-a' }).duplicate, true);
  // CHECKS_PASSED and MERGED before any build: the item is triaging, so both are ignored.
  assert.deepEqual(apply(store, { type: 'MERGED' }, { to: 'item:a', id: 'early-merge' }).effects, []);
  assert.deepEqual(apply(store, { type: 'CHECKS_PASSED' }, { to: 'item:a', id: 'early-ci' }).effects, []);
  assert.equal(status(store).items[0].state, 'active.triaging');
  assert.deepEqual((await problems(store, Date.now())), []);
});

test('a torn last line: doctor names it, the next append is not glued to it, repair drops it', async () => {
  const store = fresh();
  apply(store, req('a'), { id: 'req-a' });
  appendFileSync(join(store.dir, 'acks.jsonl'), '{"effectId":"req-a.0","outc');
  assert.ok((await problems(store, Date.now())).some((p) => /acks.jsonl line 1 is not JSON \(a torn last write: fix with harness repair\)/.test(p)));
  store.appendAcks([{ effectId: 'req-a.0', outcome: 'done', at: '2026-10-26T10:05:00Z' }]);
  assert.equal(store.acks().length, 1, 'the new row survives the torn one');
  assert.ok((await problems(store, Date.now())).some((p) => /line 1 is not JSON \(not the last line: repair by hand\)/.test(p)));
  assert.equal(repair(store).left.length, 1, 'a torn middle line is left for a person');

  const other = fresh();
  apply(other, req('b'), { id: 'req-b' });
  appendFileSync(join(other.dir, 'outbox.jsonl'), '{"id":"half');
  assert.deepEqual(repair(other).fixed, ['dropped torn line 2 of outbox.jsonl']);
  assert.deepEqual((await problems(other, Date.now())), []);
  assert.equal(other.outbox().length, 1);
});

test('a slow mount whose lock looks stale mid-write: compare-and-set refuses the late writer', async () => {
  const store = fresh();
  const lock = join(store.dir, 'lock');
  assert.throws(
    () =>
      store.withLock(() => {
        const mine = store.read();
        // The mount stalls past the stale-lock limit; another writer clears the lock and commits.
        const old = (Date.now() - 120_000) / 1000;
        utimesSync(lock, old, old);
        apply(store, req('b'), { id: 'req-b' });
        closeSync(openSync(lock, 'w')); // our finally still has a lock to remove
        store.write({ ...mine, version: mine.version + 1 }, mine.version);
      }),
    /state changed: expected version 2, found 3/
  );
  assert.deepEqual(status(store).items.map((i) => i.id), ['b']);
  assert.deepEqual((await problems(store, Date.now())), []);
});
