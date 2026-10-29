// #146 (epic #59): the one history ready to be the live store. A two-era fixture (stores old and new, each ended by its
// ERA_ENDED row, and GitHub's archive of one repo) built with join.mjs: doctor judges a landing by the rules of the
// era it landed in (an era's landings are listed by era in admittedThen, harness meta.invariants reviewOnHead), a row
// the join's report lists refused is counted by reason, not a divergence (meta.store.facts), and an effect carried
// from an era keeps its source id, so the host acks it by either id, once (meta.store.eras). No network: GitHub is
// a fake fetcher, and every source is built in a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eraEnd } from '../src/history.js';
import { openStore } from '../src/store.js';
import { init, apply, ack } from '../src/runtime.js';
import { doctor } from '../src/doctor.js';
import { tempDir } from './tmp.js';

const SCRIPTS = fileURLToPath(new URL('../scripts/history/', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/harness.js', import.meta.url));
const LEAD = '2ce18a8f-fd3a-507a-82d3-2dea2ed3db49';
const ENVELOPE = { actor: { kind: 'session', id: LEAD }, source: { kind: 'cli', ref: 'harness send' } };
const REPO = 'suredesigntshirts/ccp_machine';
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const run = (script, args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8', env });
const cli = (dir, ...args) => spawnSync(process.execPath, [BIN, '--dir', dir, ...args], { encoding: 'utf8', env });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const rowsOf = (text) => text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const request = (id, n) => ({ type: 'REQUEST_RECEIVED', request: { id, title: id, project: 'ccp_machine', url: `https://github.com/${REPO}/issues/${n}` } });

// old, the first era, ends at 09:10 on the 26th; new, the second, at 09:00 on the 27th.
const OLD = [
  { id: 'req-a', at: '2026-10-26T09:00:00.000Z', event: request('a', 1) },
  { id: 'req-b', at: '2026-10-26T09:10:00.000Z', event: request('b', 2) },
];
const NEW = [{ id: 'req-c', at: '2026-10-27T09:00:00.000Z', event: request('c', 3) }];
// Landed on main, no PR with a verifier PASS: #3 in old's era, #4 and #7 in new's (after old's mark, before new's),
// #6 after the last mark. #7 is ghost's, an item its issue names and no store filed, so its MERGED row has no actor.
const LANDED = { 3: '2026-10-26T09:05:00Z', 4: '2026-10-26T20:00:00Z', 7: '2026-10-27T08:00:00Z', 6: '2026-10-28T12:00:00Z' };
const pull = (n) => ({ number: n, state: 'closed', html_url: `https://github.com/${REPO}/pull/${n}`, title: `pr ${n}`, body: null, created_at: LANDED[n], merged_at: LANDED[n], head: { ref: n === 7 ? 'feat/7-ghost' : `chore/pr-${n}`, sha: String(n).repeat(40) }, base: { ref: 'main' } });

/** A store today's runtime writes from rows, each sent with the envelope. */
function written(dir, rows) {
  const store = openStore(dir);
  init(store, {}, rows[0].at);
  for (const r of rows) assert.ok(!apply(store, { ...r.event, ...ENVELOPE }, { id: r.id, now: r.at }).refused, r.id);
  return store;
}

/** GitHub's archive of the repo: ghost's issue and #7, the only landing the archive holds. */
function archive(root) {
  const gh = join(root, 'github');
  mkdirSync(join(gh, 'pages'), { recursive: true });
  const pages = {
    'issues-001': [{ number: 7, title: 'ghost', body: 'Item id: `ghost`.\n\n## Expect\n\n- a', html_url: `https://github.com/${REPO}/issues/7` }],
    'pulls-001': [pull(7)],
  };
  const entries = Object.entries(pages).map(([name, json]) => {
    const raw = Buffer.from(JSON.stringify(json));
    const gz = gzipSync(raw);
    writeFileSync(join(gh, 'pages', `${name}.json.gz`), gz);
    return { file: `pages/${name}.json.gz`, items: json.length, sha256: sha(raw), gzSha256: sha(gz) };
  });
  writeFileSync(join(gh, 'manifest.json'), JSON.stringify({ source: 'github', id: REPO, pages: entries, totals: { pulls: 1 } }));
  return gh;
}

/** The two-era history: each store's rows and its era's end, and GitHub's rows, joined into a new store. */
function history() {
  const root = tempDir('history-live-');
  const candidates = [];
  for (const [ref, rows] of [['old', OLD], ['new', NEW]]) {
    const store = written(join(root, ref), rows);
    const e1 = run('extract-store.mjs', [store.dir, ref]);
    assert.equal(e1.status, 0, e1.stderr);
    const got = rowsOf(e1.stdout);
    candidates.push(...got, eraEnd(ref, store.read(), store.outbox(), store.acks(), got.map((r) => r.at).sort().at(-1)));
  }
  const e3 = run('extract-github.mjs', [archive(root), `github/${REPO.replace('/', '--')}`]);
  assert.equal(e3.status, 0, e3.stderr);
  candidates.push(...rowsOf(e3.stdout));
  writeFileSync(join(root, 'rows.jsonl'), candidates.map((r) => JSON.stringify(r) + '\n').join(''));
  const out = join(root, 'history');
  const j = run('join.mjs', [join(root, 'rows.jsonl'), '--out', out]);
  assert.equal(j.status, 0, j.stderr);
  return { out, newStore: openStore(join(root, 'new')) };
}

// GitHub as REST gives it: the landings above, no reviews; anything else is unreachable.
const fetcher = async (path) => {
  if (path.startsWith(`repos/${REPO}/pulls?state=closed`)) return Object.keys(LANDED).map(Number).map(pull);
  if (/\/reviews\b/.test(path)) return [];
  throw new Error(`not in the fixture: ${path}`);
};

test('#146: a landing before its era\'s ERA_ENDED mark is listed by era, not a problem; one after the last mark is still a problem', async () => {
  const { out } = history();
  const marks = rowsOf(readFileSync(join(out, 'events.jsonl'), 'utf8')).filter((r) => r.event.type === 'ERA_ENDED');
  assert.deepEqual(marks.map((m) => [m.event.era, m.at]), [['old', '2026-10-26T09:10:00.000Z'], ['new', '2026-10-27T09:00:00.000Z']]);
  const d = await doctor(openStore(out), { fetcher, ledgers: tempDir('history-live-ledgers-'), now: Date.parse('2026-10-28T13:00:00Z'), pendingMaxMs: Infinity });
  const merges = d.problems.filter((p) => p.startsWith('merges: '));
  assert.deepEqual(merges, [`merges: problem ${REPO}#6 no item: bound to no item: the store holds no verifier PASS for its landed head 6666666`], 'only the landing after the last mark meets today\'s rule');
  const eras = d.admittedThen.filter((a) => /^era /.test(a));
  assert.equal(eras.length, 2, 'one line per era');
  assert.match(eras[0], new RegExp(`^era old: 1 landing before its ERA_ENDED \\(2026-10-26T09:10:00.000Z\\).*${REPO}#3\\b`));
  assert.match(eras[1], new RegExp(`^era new: 2 landings before its ERA_ENDED \\(2026-10-27T09:00:00.000Z\\).*${REPO}#4\\b.*${REPO}#7\\b`));
  assert.ok(!eras.join('\n').includes('#6'), 'the landing after the last mark is no era\'s');
});

test('#146: a row the join\'s report lists refused is counted by reason, not a replay divergence; one the report does not list still is', async () => {
  const { out } = history();
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  assert.deepEqual(report.refused, ['gh-ccp_machine-pr-7-merged: no actor at "item:ghost"']);
  const d = await doctor(openStore(out), { verify: false, pendingMaxMs: Infinity });
  assert.deepEqual(d.problems.filter((p) => p.startsWith('replay')), []);
  assert.deepEqual(d.history.refused, { 'no actor at "…"': 1 });
  rmSync(join(out, 'report.json'));
  const without = await doctor(openStore(out), { verify: false, pendingMaxMs: Infinity });
  assert.deepEqual(without.problems.filter((p) => p.startsWith('replay')), ['replay diverges at gh-ccp_machine-pr-7-merged: no actor at "item:ghost"']);
});

test('#146: an era effect keeps its source id; harness ack <source id> acks it, effects shows both ids, and a second ack by either id is a duplicate', () => {
  const { out, newStore } = history();
  const source = newStore.pending()[0];
  const store = openStore(out);
  const carried = store.pending().find((e) => e.sourceId === source.id);
  assert.ok(carried, `the history holds ${source.id} under its source id`);
  assert.equal(carried.eventId, 'era:new');
  assert.notEqual(carried.id, source.id);

  const shown = JSON.parse(cli(out, 'effects').stdout);
  assert.deepEqual(shown.filter((e) => e.sourceId === source.id).map((e) => e.id), [carried.id], 'effects shows the source id next to the new one');

  const r = cli(out, 'ack', source.id, '--note', 'done in dogfood2\'s host');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { acked: 1 });
  assert.ok(!JSON.parse(cli(out, 'effects').stdout).some((e) => e.id === carried.id), 'acked: no longer listed');
  assert.deepEqual(store.acks().filter((a) => a.effectId === carried.id).map((a) => a.note), ['done in dogfood2\'s host']);

  for (const id of [source.id, carried.id]) {
    assert.deepEqual(ack(store, [id]), { acked: 0, duplicate: [id] }, `${id}: acked already`);
  }
  assert.equal(store.acks().filter((a) => a.effectId === carried.id).length, 1, 'one ack, not a second');
});
