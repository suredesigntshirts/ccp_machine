// #139: a release from before writerNotOlder (#98) wrote a live store for seven hours from a plugin checkout that never
// moved forward. Its state.json write drops writtenBy, so today's guard fell back to its own last row and took it as
// the newest release; its rows named the harness version twice (envelope and payload) and disagreed; and nothing listed
// those rows. Each test names the issue's Expect line it covers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.js';
import { apply, start } from './send.js';
import { openStore, init, replay, doctor, repair } from '../src/index.js';
import { harnessVersion } from '../src/runtime.js';

const T0 = '2026-10-29T04:00:00.000Z';
const at = (m) => new Date(Date.parse(T0) + m * 60_000).toISOString();
const me = harnessVersion();
const newer = (v) => v.split('.').map((n, i) => (i === 0 ? Number(n) + 1 : n)).join('.');
const AHEAD = { version: newer(me.version), commit: 'a'.repeat(40) }; // a release newer than this one
const STALE = { version: '0.1.0', commit: '68e99f0'.padEnd(40, '0') }; // the release from before #98, as it stamped itself
const lead = { actor: { kind: 'session', id: 'sim-orchestrator' }, source: { kind: 'cli', ref: 'harness send' } };
const request = (id) => ({ type: 'REQUEST_RECEIVED', request: { id }, actor: { kind: 'session', id: 'writer' }, source: { kind: 'cli', ref: 'test' } });

function fresh() {
  const store = openStore(tempDir('harness-stale-writer-'));
  init(store, { wipLimit: 4 }, T0);
  start(store, T0);
  return store;
}
const rows = (store) => readFileSync(join(store.dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// Rewrite the log as other releases wrote it: release(row) gives the row's harness, or undefined to keep it.
const stampRows = (store, release) => writeFileSync(join(store.dir, 'events.jsonl'), rows(store).map((r) => JSON.stringify({ ...r, harness: release(r) ?? r.harness }) + '\n').join(''));
// state.json as a release from before writtenBy leaves it: the field gone.
const dropWrittenBy = (store) => {
  const { writtenBy: _, ...rest } = store.read();
  writeFileSync(join(store.dir, 'state.json'), JSON.stringify(rest, null, 1));
};
const setWrittenBy = (store, by) => writeFileSync(join(store.dir, 'state.json'), JSON.stringify({ ...store.read(), writtenBy: by }, null, 1));

test('Expect 1 and 2: a store a pre-#98 release wrote last is judged by the newest release its log names, not by that release', () => {
  const store = fresh();
  apply(store, request('newer'), { id: 'req-newer', now: at(1) });
  apply(store, request('stale'), { id: 'req-stale', now: at(2) });
  // A newer release wrote req-newer; then the stale release wrote req-stale and, as it does, dropped writtenBy.
  stampRows(store, (r) => (r.id === 'req-newer' ? AHEAD : r.id === 'req-stale' ? STALE : undefined));
  dropWrittenBy(store);
  const before = [store.read().version, store.events().length];
  const r = apply(store, request('behind'), { id: 'req-behind', now: at(3) });
  assert.equal(r.refused, true, 'this release is older than one the log names, even though the last row is older still');
  assert.equal(r.rule, 'writerNotOlder');
  assert.ok(r.why.includes(`${AHEAD.version}@${AHEAD.commit.slice(0, 7)}`), r.why);
  assert.deepEqual([store.read().version, store.events().length], before, 'nothing written');
});

test('Expect 2: a write by a release older than the one state.json names keeps the newer writtenBy', () => {
  // A fact (replay, the history join) is applied by whatever release runs it.
  const store = fresh();
  setWrittenBy(store, AHEAD);
  apply(store, request('fact'), { id: 'req-fact', now: at(1), fact: {} });
  assert.deepEqual(store.read().writtenBy, AHEAD, 'a fact applied by this release keeps the newer writer');
  // repair --rebuild by this release, on a state.json a newer one wrote ahead of its log.
  const crashed = fresh();
  apply(crashed, request('a'), { id: 'req-a', now: at(1) });
  const log = readFileSync(join(crashed.dir, 'events.jsonl'), 'utf8');
  apply(crashed, request('b'), { id: 'req-b', now: at(2) });
  writeFileSync(join(crashed.dir, 'events.jsonl'), log);
  setWrittenBy(crashed, AHEAD);
  assert.deepEqual(repair(crashed, { rebuild: true }).fixed.length, 1);
  assert.deepEqual(crashed.read().writtenBy, AHEAD, 'repair keeps the newer writer');
});

test("Expect 3: a row's envelope and payload name one release: the one that applied it, never the sender's", () => {
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'a' }, ...lead }, { now: at(1) });
  apply(store, { type: 'TRIAGED', tier: 0, criteria: ['a works'], actor: { kind: 'session', id: 'triager' }, source: lead.source }, { to: 'item:a', now: at(2) });
  apply(store, { type: 'VERIFIER_BRIEF_FIXED', sha256: 'b'.repeat(64), ...lead }, { to: 'item:a', now: at(3) });
  // The sender says it is the stale release, on this commit: the release that applies the event is this one.
  const spawn = { type: 'WORKER_SPAWNED', role: 'builder', briefSha256: '1'.repeat(64), agentType: 'harness:builder', model: 'opus', toolUseId: 'toolu_b', definition: { agentType: 'harness:builder', sha256: 'd'.repeat(64) }, harness: { version: STALE.version, commit: me.commit }, ...lead };
  const r = apply(store, spawn, { to: 'item:a', id: 'spawn-b', now: at(4) });
  assert.ok(!r.refused, r.why);
  const row = store.events().at(-1);
  assert.deepEqual(row.harness, me, 'the envelope: the release that applied it');
  assert.ok(row.event.harness === undefined || JSON.stringify(row.event.harness) === JSON.stringify(row.harness), `the payload names no other release: ${JSON.stringify(row.event.harness)}`);
  const [s] = store.read().snapshot.children.a.snapshot.context.spawns;
  assert.deepEqual(s.harness, row.harness, "the spawn's recorded release is the row's");
  // Each row is a fact: replay rebuilds the same spawn record from the row.
  const again = replay(store);
  assert.deepEqual([again.ok, again.firstDivergence, again.differences], [true, null, []]);
});

test('Expect 4: doctor lists each row written by a release older than one the log already holds', async () => {
  const store = fresh();
  for (const [i, id] of ['one', 'two', 'three', 'four'].entries()) apply(store, request(id), { id: `req-${id}`, now: at(i + 1) });
  // req-one by this release, req-two by a newer one, req-three by the stale release, req-four by the newer one again.
  stampRows(store, (r) => ({ 'req-two': AHEAD, 'req-three': STALE, 'req-four': AHEAD })[r.id]);
  const d = await doctor(store, { verify: false, now: Date.parse(at(5)) });
  assert.equal(d.ok, true, `listed, not a problem: ${d.problems.join('; ')}`);
  const listed = d.admittedThen.filter((a) => /writerNotOlder/.test(a));
  assert.equal(listed.length, 1, listed.join('\n'));
  assert.match(listed[0], /^req-three \(REQUEST_RECEIVED\): admitted when written by harness 0\.1\.0@68e99f0/);
  assert.ok(listed[0].includes(`older than ${AHEAD.version}@aaaaaaa`), listed[0]);
  // A release older than none before it is not listed: this release first, then a newer one.
  assert.ok(!d.admittedThen.some((a) => /^req-(one|two|four) /.test(a)), d.admittedThen.join('\n'));
});
