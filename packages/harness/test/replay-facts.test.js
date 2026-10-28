// A logged event is a fact (#85, R1 of epic #59; #55, #67): it was admitted once, by the rules of the release that wrote
// it, so replay applies it again without its admission rules and by the route its logged effects took. A rule tightened
// or loosened later is listed (admittedThen), not a problem; a corrupt store or a lost event still is. And an older
// release does not write a store a newer one has written (writerNotOlder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.js';
import { apply, start } from './send.js';
import { openStore, init, replay, doctor } from '../src/index.js';
import { harnessVersion, writerError } from '../src/runtime.js';
import { validate } from '../src/history.js';
import { verifyActors } from '../src/verify-actors.js';

// The retired dogfood store as harness 0.1.0 wrote it (commits 0b43582, d8edf5a and 3789038), copied from a copy of
// /mnt/project-files/harness/state/dogfood: events by agents spawned before WORKER_SPAWNED existed (#55).
const RETIRED = fileURLToPath(new URL('./fixtures/dogfood-retired/', import.meta.url));
const copyOf = (dir) => {
  const to = tempDir('harness-replay-facts-');
  cpSync(dir, to, { recursive: true });
  return openStore(to);
};
const lastAt = (store) => Date.parse(store.events().at(-1).at);

test('a store written by an earlier release replays clean against the current code, each event a fact', () => {
  const store = copyOf(RETIRED);
  const r = replay(store);
  assert.deepEqual([r.ok, r.firstDivergence, r.differences], [true, null, []]);
  assert.equal(r.events, 93);
  // Today's agentEvents rule (#46) refuses TRIAGED from an agent with no spawn; harness 0.1.0 admitted it.
  const triage = r.admittedThen.find((a) => a.id === 'triage-spawn-merge-gates-1');
  assert.deepEqual(triage.release, { version: '0.1.0', commit: '0b435826cc53c5ed5a559637fea8ecc8927198b6' });
  assert.match(triage.why, /agentEvents/);
  // A machine admission rule (a guard that only refuses) is passed over the same way.
  assert.match(r.admittedThen.find((a) => a.id === 'merge-pr47').why, /unverifiedHead/);
});

test('doctor lists an event the rules changed for, with its id and release, and it is not a problem', async () => {
  const store = copyOf(RETIRED);
  const d = await doctor(store, { verify: false, now: lastAt(store) });
  assert.deepEqual(d.problems, []);
  assert.equal(d.ok, true);
  const line = d.admittedThen.find((l) => l.startsWith('triage-spawn-merge-gates-1 '));
  assert.match(line, /^triage-spawn-merge-gates-1 \(TRIAGED\): admitted when written by harness 0\.1\.0@0b43582; today's rules: refused: .*agentEvents/);
});

// The ledgers as the Library filed them for the retired store's actors (session windows, SubagentStart records). Two
// records were rewritten by a resume before #82 kept the first start (#50): aa493f167da2afc8f and a78cba7f1a72829a1.
const LEDGER = fileURLToPath(new URL('./fixtures/dogfood-retired-ledger/', import.meta.url));
const offline = async () => {
  throw new Error('offline');
};

test('doctor on the retired store with its ledgers is clean: a rewritten start record yields to the recovered first start, which doctor lists', async () => {
  const store = copyOf(RETIRED);
  const d = await doctor(store, { now: lastAt(store), ledgers: LEDGER, fetcher: offline });
  assert.deepEqual(d.problems, []);
  assert.equal(d.ok, true);
  const starts = d.recoveredStarts.join('\n');
  for (const [agent, at, line] of [['aa493f167da2afc8f', '2026-10-27T18:52:55.991Z', 13449], ['a78cba7f1a72829a1', '2026-10-28T02:31:43.291Z', 18618]])
    assert.ok(starts.includes(`2ce18a8f-fd3a-507a-82d3-2dea2ed3db49/${agent} started ${at}`) && starts.includes(`sessions/session_01KfkB5JrJtRHxr12jv9nkHq/events.jsonl.gz line ${line}`), starts);
});

test('a recovered first start names its source, and without it the rewritten records still fail: no waiver', () => {
  const rows = readFileSync(fileURLToPath(new URL('../scripts/history/recovered/dogfood.jsonl', import.meta.url)), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(rows.flatMap(validate), []);
  for (const r of rows) {
    assert.equal(r.event.type, 'AGENT_STARTED');
    assert.equal(r.provenance.origin, 'recovered');
    assert.match(r.provenance.from.ref, /^sessions\/session_\w+\/events\.jsonl\.gz$/);
    assert.ok(r.provenance.from.line >= 1);
  }
  const store = copyOf(RETIRED);
  const without = verifyActors(store, { dir: LEDGER, starts: [] }).filter((r) => r.result !== 'ok');
  assert.deepEqual(without.map((r) => r.id.split('/')[1]).sort(), ['a78cba7f1a72829a1', 'aa493f167da2afc8f']);
  // A recovered start only ever moves a window earlier: one later than the hook's record changes nothing.
  const late = rows.map((r) => ({ ...r, at: '2026-10-28T03:50:00.000Z' }));
  assert.equal(verifyActors(store, { dir: LEDGER, starts: late }).filter((r) => r.result !== 'ok').length, 2);
});

test('a corrupt store or a lost event stays a problem', async () => {
  // A lost event: one row gone from the middle of the log.
  const lost = copyOf(RETIRED);
  const rows = readFileSync(join(lost.dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
  writeFileSync(join(lost.dir, 'events.jsonl'), rows.filter((l) => !l.includes('"id":"triage-harness-pages-1"')).join('\n') + '\n');
  const d = await doctor(lost, { verify: false, now: lastAt(lost) });
  assert.equal(d.ok, false);
  assert.ok(d.problems.some((p) => /expected/.test(p)), d.problems.join('\n'));
  assert.ok(d.problems.some((p) => /^replay/.test(p)), 'the rebuilt state differs');
  // A corrupt store: an event whose logged effects no route gives.
  const corrupt = copyOf(RETIRED);
  const outbox = readFileSync(join(corrupt.dir, 'outbox.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const victim = outbox.find((e) => e.name === 'postDecisionCard');
  writeFileSync(join(corrupt.dir, 'outbox.jsonl'), outbox.map((e) => JSON.stringify(e === victim ? { ...e, params: { forged: true } } : e)).join('\n') + '\n');
  const r = replay(corrupt);
  assert.equal(r.ok, false);
  assert.match(r.firstDivergence, new RegExp(`^${victim.eventId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\w+\\): effects differ`));
  const dc = await doctor(corrupt, { verify: false, now: lastAt(corrupt) });
  assert.ok(dc.problems.some((p) => p.startsWith(`replay diverges at ${victim.eventId}`)), dc.problems.join('\n'));
});

// The writer check.
const T0 = '2026-10-28T12:00:00.000Z';
function fresh() {
  const store = openStore(tempDir('harness-writer-'));
  init(store, { wipLimit: 4 }, T0);
  start(store, T0);
  return store;
}
const request = (id) => ({ type: 'REQUEST_RECEIVED', request: { id }, actor: { kind: 'session', id: 'writer' }, source: { kind: 'cli', ref: 'test' } });
const writtenBy = (store, by) => {
  const state = store.read();
  const { writtenBy: _, ...rest } = state;
  store.write(by === undefined ? rest : { ...rest, writtenBy: by }, state.version);
};
const newer = (v) => v.split('.').map((n, i) => (i === 0 ? Number(n) + 1 : n)).join('.');
const release = (r) => `${r.version}${r.commit ? `@${r.commit.slice(0, 7)}` : ''}`;

test('the store records the release that last wrote it', () => {
  const store = fresh();
  const me = harnessVersion();
  assert.match(me.version, /^\d+\.\d+\.\d+$/, 'the plugin version');
  assert.equal(me.version, JSON.parse(readFileSync(new URL('../../../plugins/harness/.claude-plugin/plugin.json', import.meta.url), 'utf8')).version);
  assert.deepEqual(store.read().writtenBy, me);
  assert.deepEqual(store.events().at(-1).harness, me);
});

test('an older writer is refused, naming both releases; an equal or newer writer is accepted', () => {
  const store = fresh();
  const me = harnessVersion();
  // Equal: the same release.
  assert.equal(apply(store, request('equal'), { id: 'req-equal' }).refused, undefined);
  // The store was written by a newer release: this one is older and is refused, writing nothing.
  const ahead = { version: newer(me.version), commit: 'a'.repeat(40) };
  writtenBy(store, ahead);
  const before = [store.read().version, store.events().length];
  const r = apply(store, request('older'), { id: 'req-older' });
  assert.equal(r.refused, true);
  assert.equal(r.rule, 'writerNotOlder');
  assert.ok(r.why.includes(release(me)) && r.why.includes(release(ahead)), r.why);
  assert.deepEqual([store.read().version, store.events().length], before);
  // The store was written by an older release: this newer one is accepted and records itself.
  writtenBy(store, { version: '0.0.1', commit: 'b'.repeat(40) });
  assert.equal(apply(store, request('newer'), { id: 'req-newer' }).refused, undefined);
  assert.deepEqual(store.read().writtenBy, me);
});

test('the same version on another commit is refused unless the store commit is an ancestor of the writer commit', () => {
  const store = fresh();
  const me = harnessVersion();
  writtenBy(store, { version: me.version, commit: '0'.repeat(40) });
  const r = apply(store, request('other-commit'), { id: 'req-other-commit' });
  assert.equal(r.refused, true);
  assert.match(r.why, /writerNotOlder/);
  const stored = { version: '1.2.3', commit: 'c'.repeat(40) };
  assert.equal(writerError(stored, { version: '1.2.3', commit: 'd'.repeat(40) }, () => true), null, 'a descendant of the store commit');
  assert.match(writerError(stored, { version: '1.2.3', commit: 'd'.repeat(40) }, () => false), /^from harness 1\.2\.3@ddddddd, the same version on a commit not known to descend from 1\.2\.3@ccccccc/);
  assert.match(writerError(stored, { version: '1.2.3', commit: null }, () => true), /not known to descend/, 'a writer that cannot name its commit');
  assert.equal(writerError(stored, { version: '1.2.3', commit: 'c'.repeat(40) }), null);
  assert.equal(writerError(stored, { version: '1.10.0', commit: null }), null, 'versions compare as numbers');
});

test('a writer with no version is refused; a store that records none takes any writer', () => {
  const stored = { version: '0.7.2', commit: 'e'.repeat(40) };
  assert.match(writerError(stored, { version: null, commit: 'f'.repeat(40) }), /no version.*older than 0\.7\.2@eeeeeee/);
  assert.match(writerError(stored, { version: 'unknown', commit: null }), /older/);
  assert.equal(writerError(null, { version: null, commit: null }), null);
  assert.equal(writerError({ version: null, commit: 'e'.repeat(40) }, { version: '0.0.1', commit: null }), null);
});

test('a store with no recorded release is judged by its last log row', () => {
  const store = fresh();
  const me = harnessVersion();
  writtenBy(store, undefined);
  assert.equal(apply(store, request('legacy'), { id: 'req-legacy' }).refused, undefined, 'its last row is this release');
  writtenBy(store, undefined);
  const rows = readFileSync(join(store.dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  rows.at(-1).harness = { version: newer(me.version), commit: null };
  writeFileSync(join(store.dir, 'events.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const r = apply(store, request('behind'), { id: 'req-behind' });
  assert.equal(r.refused, true);
  assert.ok(r.why.includes(newer(me.version)), r.why);
});

test('replay applies a fact whatever the release that wrote the store', () => {
  const store = fresh();
  apply(store, request('a'), { id: 'req-a' });
  writtenBy(store, { version: newer(harnessVersion().version), commit: null });
  const r = replay(store);
  assert.deepEqual([r.ok, r.firstDivergence, r.differences, r.admittedThen], [true, null, [], []]);
});
