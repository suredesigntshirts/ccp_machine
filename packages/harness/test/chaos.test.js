// Fault injection: break a store on purpose and check that doctor names each fault with its repair,
// and that harness repair fixes the safe ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import fs, { readFileSync, writeFileSync, appendFileSync, utimesSync, closeSync, openSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openStore, init, status, doctor, repair, ack } from '../src/index.js';
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

// Run fn with one fs function replaced, in every module that imports it: a test puts a step of its own at the
// moment it names, so an interleaving of two writers happens in the order the test gives, every time.
const withFs = (name, replace, fn) => {
  const real = fs[name];
  fs[name] = replace(real);
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fs[name] = real;
    syncBuiltinESMExports();
  }
};

test('repair is refused while another writer holds the lock, and the holder\'s row is kept', () => {
  const store = fresh();
  apply(store, req('a'), { id: 'req-a' });
  appendFileSync(join(store.dir, 'outbox.jsonl'), '{"id":"half');
  store.withLock(() => {
    assert.throws(() => repair(openStore(store.dir)), /another writer holds/);
    store.appendOutbox([{ id: 'held', eventId: 'req-a', at: '2026-10-26T10:05:00Z', name: 'note' }]);
  });
  assert.ok(store.outbox().some((e) => e.id === 'held'), 'the holder\'s row is in the log');
});

// The other writer runs in the moment between repair reading a log and writing it back. Refused because repair
// holds the lock, it writes once repair lets go, as the CLI's caller would send again.
for (const [log, late, landed] of [
  ['events.jsonl', (store) => apply(store, req('late'), { id: 'req-late' }), (store) => store.events().some((e) => e.id === 'req-late')],
  ['acks.jsonl', (store) => ack(store, ['req-a.0']), (store) => store.acks().some((a) => a.effectId === 'req-a.0')]
])
  test(`a row another writer appends to ${log} while repair rewrites it is not lost`, async () => {
    const store = fresh();
    apply(store, req('a'), { id: 'req-a' });
    appendFileSync(join(store.dir, log), '{"half');
    const other = openStore(store.dir);
    let heldOff = false;
    const r = withFs(
      'writeFileSync',
      (real) => (path, ...rest) => {
        if (path === join(store.dir, log) && !heldOff) {
          heldOff = true;
          try {
            late(other);
            heldOff = 'wrote';
          } catch (e) {
            if (!/another writer holds/.test(e.message)) throw e;
          }
        }
        return real(path, ...rest);
      },
      () => repair(store)
    );
    if (heldOff === true) late(other);
    assert.ok(landed(store), 'the other writer\'s row is in the log');
    assert.equal(heldOff, true, 'the other writer was refused while repair held the lock');
    assert.deepEqual(r.fixed, [`dropped torn line ${log === 'acks.jsonl' ? 1 : 3} of ${log}`]);
    assert.deepEqual(await problems(store, Date.now()), []);
  });

test('two writers that find the same stale lock: only the first to break it takes the lock', () => {
  const store = fresh();
  const lock = join(store.dir, 'lock');
  closeSync(openSync(lock, 'w'));
  const old = (Date.now() - 120_000) / 1000;
  utimesSync(lock, old, old);
  // Both writers stat the lock and find it stale. A breaks it and takes the lock; B, whose stat is the one taken
  // before A acted, comes next.
  const found = statSync(lock);
  const other = openStore(store.dir);
  let both = false;
  let aHolds;
  const run = () =>
    store.withLock(() => {
      withFs('statSync', (real) => (path, ...rest) => (path === lock ? found : real(path, ...rest)), () => {
        try {
          other.withLock(() => (both = true));
        } catch (e) {
          if (!/another writer holds/.test(e.message)) throw e;
        }
      });
      aHolds = existsSync(lock);
    });
  let error;
  try {
    run();
  } catch (e) {
    error = e;
  }
  assert.equal(both, false, 'B took the lock while A held it');
  assert.equal(aHolds, true, 'A still holds its lock');
  assert.equal(error, undefined);
  apply(store, req('a'));
  assert.equal(status(store).items.length, 1, 'the next writer takes the lock as usual');
});

// A writer process: it applies n events as session writer-<tag>, sending each one again for as long as the store
// refuses it because another writer holds the lock, and no longer: how long a holder keeps the lock depends on
// the machine, so a writer that gives up after a fixed number of tries fails on a slow one. A lock left behind is
// cleared after 60s (STALE_LOCK_MS). Any other error ends the writer: under the lock a compare-and-set refusal
// (state changed) means two writers held it at once. It writes a line for each refusal, so a test can count them,
// with a blocking write: a reader that falls behind slows the writer, instead of lines queueing in a loop that never yields.
const runtime = new URL('../src/index.js', import.meta.url).href;
const writer = (store, tag, { n = 8, onRefused = () => {} } = {}) =>
  new Promise((resolve, reject) => {
    const code = `
      const { writeSync } = await import('node:fs');
      const { openStore, apply } = await import(${JSON.stringify(runtime)});
      const store = openStore(${JSON.stringify(store.dir)});
      for (let i = 0; i < ${n}; i++) {
        for (;;) {
          try { apply(store, { type: 'REQUEST_RECEIVED', request: { id: '${tag}' + i }, actor: { kind: 'session', id: 'writer-${tag}' }, source: { kind: 'cli', ref: 'test' } }, { id: 'req-${tag}' + i }); break; }
          catch (e) { if (!/^another writer holds /.test(e.message)) throw e; writeSync(1, 'refused\\n'); }
        }
      }`;
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let refused = 0;
    p.stdout.on('data', (d) => {
      for (const c of String(d)) if (c === '\n') onRefused(++refused);
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (c) => (c === 0 ? resolve(refused) : reject(new Error(`writer-${tag} exited ${c} after ${refused} refusals: ${err}`))));
  });

test('a writer held off by the lock lands its events once the holder lets go, however long it held it', async () => {
  const store = fresh();
  const lock = join(store.dir, 'lock');
  // The test is the other writer: it takes the lock and lets go only after HOLD refusals in a row, a hold
  // counted in the waiting writer's own tries, so no machine is too fast or too slow for it.
  const held = openSync(lock, 'wx');
  const HOLD = 5000;
  let whileHeld;
  await writer(store, 'x', {
    n: 2,
    onRefused: (count) => {
      if (count !== HOLD) return;
      whileHeld = { events: store.events().length, version: store.read().version };
      closeSync(held);
      unlinkSync(lock);
    }
  });
  assert.deepEqual(whileHeld, { events: 1, version: 2 }, 'refused, the writer wrote nothing while the lock was held');
  assert.deepEqual(store.events().map((e) => [e.id, e.version]), [['orchestrator-started', 2], ['req-x0', 3], ['req-x1', 4]]);
  assert.deepEqual((await problems(store, Date.now())), []);
});

test('two writer processes at once: every event lands once and the log stays contiguous', async () => {
  const store = fresh();
  await Promise.all([writer(store, 'x'), writer(store, 'y')]);
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
