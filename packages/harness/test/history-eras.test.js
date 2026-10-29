// #141 (epic #59): the era boundary. Each source store is an era: its rows are facts of their time, and its state.json
// is the era's own record of where it ended. join.mjs --from closes each store's era with an ERA_ENDED row that carries
// that record (harness meta.store.eras), and replay takes each item's state at its era's end from it, applying
// today's machine only to the rows after. The fixture has two eras that disagree: main triaged by RUN_SUCCEEDED, which
// today's item machine does not take, so today's machine alone leaves main's item in triaging and refuses its later
// rows; main recorded the item done. No network, no Library: every source is built in a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../src/history.js';
import { openStore } from '../src/store.js';
import { init, apply } from '../src/runtime.js';
import { replay } from '../src/replay.js';
import { doctor } from '../src/doctor.js';
import { tempDir } from './tmp.js';

const SCRIPTS = fileURLToPath(new URL('../scripts/history/', import.meta.url));
const LEAD = '2ce18a8f-fd3a-507a-82d3-2dea2ed3db49';
const ENVELOPE = { actor: { kind: 'session', id: LEAD }, source: { kind: 'cli', ref: 'harness send' } };
const rowsOf = (text) => text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const jsonl = (rows) => rows.map((r) => JSON.stringify(r) + '\n').join('');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const run = (script, args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8', env });
const request = (id) => ({ type: 'REQUEST_RECEIVED', request: { id, title: id, project: 'ccp_machine' } });

/** A store today's runtime writes from rows ({id, at, to, event}, each sent with the envelope): its own record. */
function written(dir, rows) {
  const store = openStore(dir);
  init(store, {}, rows[0].at);
  for (const r of rows) {
    const done = apply(store, { ...r.event, ...ENVELOPE }, { to: r.to === 'harness' ? undefined : r.to, id: r.id, now: r.at });
    assert.ok(!done.refused, `${r.id}: ${done.why}`);
  }
  return store;
}

// main, the old era: rows from before the envelope, and an item triaged by RUN_SUCCEEDED (today's item takes TRIAGED).
// Its state.json records where its rules took the item: done. req-shared is an id dogfood2 uses too, for another item.
const MAIN = [
  { id: 'req-old', version: 2, at: '2026-10-26T09:00:00.000Z', to: 'harness', event: request('old') },
  { id: 'e3', version: 3, at: '2026-10-26T09:00:01.000Z', to: 'item:old', event: { type: 'RUN_SUCCEEDED' } },
  { id: 'e4', version: 4, at: '2026-10-26T09:00:02.000Z', to: 'item:old/decision:old:plan:1', event: { type: 'STAND_IN_ANSWERED', answer: { choice: 'approve', confidence: 0.95 } } },
  { id: 'e5', version: 5, at: '2026-10-26T09:00:03.000Z', to: 'item:old', event: { type: 'RUN_SUCCEEDED' } },
  { id: 'req-shared', version: 6, at: '2026-10-26T09:00:04.000Z', to: 'harness', event: request('shared-main') },
];
// dogfood: today's rules, two items filed; refiled is filed again in dogfood2, which cancels it.
const DOGFOOD = [
  { id: 'req-dog', at: '2026-10-27T09:00:00.000Z', to: 'harness', event: request('dog') },
  { id: 'req-refiled', at: '2026-10-27T09:00:01.000Z', to: 'harness', event: request('refiled') },
];
const DOGFOOD2 = [
  { id: 'req-shared', at: '2026-10-28T09:00:00.000Z', to: 'harness', event: request('shared-new') },
  { id: 'req-refiled', at: '2026-10-28T09:00:01.000Z', to: 'harness', event: request('refiled') },
  { id: 'cancel-refiled', at: '2026-10-28T09:00:02.000Z', to: 'item:refiled', event: { type: 'CANCEL' } },
];
const REPOS = ['suredesigntshirts--ccp_machine', 'suredesigntshirts--ccp_machine_test'];

/** A copy of the Library's harness/ folder with the three stores, both repos and no sessions. */
function library() {
  const root = join(tempDir('history-eras-'), 'harness');
  const dir = (...p) => {
    mkdirSync(join(root, ...p), { recursive: true });
    return join(root, ...p);
  };
  // main's record: what today's runtime gives for its items, with old where main's own rules took it (done).
  const mainDir = dir('state', 'main');
  const scratch = written(tempDir('history-eras-main-'), MAIN.filter((r) => r.event.type === 'REQUEST_RECEIVED'));
  const state = scratch.read();
  const old = state.snapshot.children.old.snapshot;
  state.snapshot.children.old.snapshot = { ...old, status: 'done', value: 'done', children: {} };
  state.snapshot.context = { ...state.snapshot.context, inFlight: state.snapshot.context.inFlight.filter((x) => x !== 'old') };
  writeFileSync(join(mainDir, 'events.jsonl'), jsonl(MAIN));
  writeFileSync(join(mainDir, 'state.json'), JSON.stringify(state));
  writeFileSync(join(mainDir, 'outbox.jsonl'), '');
  written(dir('state', 'dogfood'), DOGFOOD);
  // dogfood2 acks its first effect; the rest are pending when its era ends.
  const d2 = written(dir('state', 'dogfood2'), DOGFOOD2);
  d2.withLock(() => d2.appendAcks([{ effectId: d2.outbox()[0].id, outcome: 'done', note: 'run done', at: '2026-10-28T09:30:00.000Z' }]));
  // GitHub: dog's PR merged after dogfood's era ended, so today's machine applies it.
  const gh = dir('archive', 'github', REPOS[0]);
  mkdirSync(join(gh, 'pages'));
  const pages = {
    'issues-001': [{ number: 5, title: 'dog', body: 'Item id: `dog`.\n\n## Expect\n\n- a', html_url: 'https://github.com/suredesigntshirts/ccp_machine/issues/5' }],
    'pulls-001': [{ number: 9, state: 'closed', html_url: 'https://github.com/suredesigntshirts/ccp_machine/pull/9', title: 'dog', body: null, created_at: '2026-10-27T10:00:00Z', merged_at: '2026-10-27T12:00:00Z', head: { ref: 'feat/5-dog', sha: '9'.repeat(40) }, base: { ref: 'main' } }],
  };
  const entries = Object.entries(pages).map(([name, json]) => {
    const raw = Buffer.from(JSON.stringify(json));
    const gz = gzipSync(raw);
    writeFileSync(join(gh, 'pages', `${name}.json.gz`), gz);
    return { file: `pages/${name}.json.gz`, items: json.length, sha256: sha(raw), gzSha256: sha(gz) };
  });
  writeFileSync(join(gh, 'manifest.json'), JSON.stringify({ source: 'github', id: 'suredesigntshirts/ccp_machine', pages: entries, totals: { pulls: 1 } }));
  const empty = dir('archive', 'github', REPOS[1]);
  writeFileSync(join(empty, 'manifest.json'), JSON.stringify({ source: 'github', id: 'suredesigntshirts/ccp_machine_test', pages: [], totals: { pulls: 0 } }));
  dir('archive', 'sessions');
  return root;
}

const stateOf = (store, id) => store.read().snapshot.children[id]?.snapshot;

test('#141: today\'s machine alone leaves main\'s item in triaging and refuses its later rows (what the era boundary is for)', () => {
  const root = library();
  const e1 = run('extract-store.mjs', [join(root, 'state', 'main'), 'main']);
  const tmp = tempDir('history-eras-plain-');
  writeFileSync(join(tmp, 'main.jsonl'), e1.stdout);
  const j = run('join.mjs', [join(tmp, 'main.jsonl'), '--out', join(tmp, 'out')]);
  assert.equal(j.status, 0, j.stderr);
  const report = JSON.parse(readFileSync(join(tmp, 'out', 'report.json'), 'utf8'));
  assert.ok(report.refused.some((r) => r.startsWith('e4: ')), 'the decision main answered does not exist under today\'s machine');
  assert.deepEqual(stateOf(openStore(join(tmp, 'out')), 'old').value, { active: 'triaging' });
});

test('#141: join --from ends each store\'s era with its own record; the old-era item ends in its recorded state and no row is refused', async () => {
  const root = library();
  const out = join(tempDir('history-eras-out-'), 'history');
  const j = run('join.mjs', ['--from', root, '--out', out]);
  assert.equal(j.status, 0, j.stderr);
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  const history = rowsOf(readFileSync(join(out, 'events.jsonl'), 'utf8'));
  assert.deepEqual(history.flatMap(validate), []);
  assert.deepEqual(report.refused, [], 'no row is refused: old rows are facts of their era');

  // One era mark per store, after its era's rows, carrying the store's state.json as it is.
  const marks = history.filter((r) => r.event.type === 'ERA_ENDED');
  assert.deepEqual(marks.map((m) => m.event.era), ['main', 'dogfood', 'dogfood2']);
  for (const m of marks) {
    const own = history.filter((r) => r.provenance.from.source === 'store' && r.provenance.from.ref === m.event.era && r !== m);
    assert.ok(own.every((r) => r.version < m.version), `${m.event.era}'s rows come before its mark`);
    assert.deepEqual(m.event.snapshot, JSON.parse(readFileSync(join(root, 'state', m.event.era, 'state.json'), 'utf8')).snapshot);
    assert.deepEqual(m.provenance.from, { source: 'store', ref: m.event.era });
  }

  // Old-era rows keep their type and payload as the store wrote them.
  for (const r of MAIN) assert.deepEqual(history.find((h) => h.id === r.id && h.provenance.from.ref === 'main').event, r.event);

  // Each item ends in the state its own store last recorded (a later era's record of an item wins).
  const store = openStore(out);
  assert.equal(stateOf(store, 'old').value, 'done', 'main recorded old done');
  assert.deepEqual(stateOf(store, 'shared-main').value, JSON.parse(readFileSync(join(root, 'state/main/state.json'), 'utf8')).snapshot.children['shared-main'].snapshot.value);
  assert.equal(stateOf(store, 'refiled').value, 'cancelled', 'dogfood2, the later era, cancelled it');
  assert.ok(stateOf(store, 'shared-new'), 'dogfood2\'s item under the id main used too');
  assert.ok(stateOf(store, 'dog'), 'dogfood\'s item');
  const ctx = store.read().snapshot.context;
  assert.ok(!ctx.inFlight.includes('old') && !ctx.inFlight.includes('refiled'), 'no slot held by an item its store moved on');

  // Rows with an id two stores share: both in the history, each once, each a fact of its own era; none dropped.
  const r = replay(store, { steps: true });
  assert.deepEqual([r.ok, r.firstDivergence, r.differences], [true, null, []]);
  for (const id of ['req-shared', 'req-refiled']) {
    const rows = history.filter((h) => h.id === id);
    assert.equal(rows.length, 2, `${id}: one row per store`);
    const steps = r.steps.filter((s) => s.id === id);
    assert.deepEqual(steps.map((s) => [s.era, s.refused]), rows.map((h) => [h.provenance.from.ref, null]));
  }
  assert.deepEqual(report.dropped.filter((d) => d.from.source === 'store'), [], 'no store row is dropped');
  // After the boundary, today's machine: GitHub's merge of dog came after dogfood's era ended.
  const merged = r.steps.find((s) => s.id === 'gh-ccp_machine-pr-9-merged');
  assert.deepEqual([merged.era, merged.refused], [null, null]);
  assert.ok(r.steps.filter((s) => s.era).every((s) => s.actors.length === 0 && s.effects.length === 0), 'an era\'s rows are not re-judged');

  // The effects pending when an era ended are pending still; the ones its store acked are not.
  const acked = openStore(join(root, 'state/dogfood2')).acks().map((a) => a.effectId);
  const d2 = openStore(join(root, 'state/dogfood2')).outbox();
  const key = (e) => JSON.stringify([e.name, e.subject, e.params]);
  assert.deepEqual(store.pending().filter((e) => e.eventId === 'era:dogfood2').map(key), d2.filter((e) => !acked.includes(e.id)).map(key));

  const d = await doctor(store, { verify: false, now: Date.parse(history.at(-1).at), pendingMaxMs: Infinity });
  assert.deepEqual(d.history.schemaErrors, []);
  assert.ok(!d.problems.some((p) => /^replay/.test(p)), d.problems.join('\n'));
});
