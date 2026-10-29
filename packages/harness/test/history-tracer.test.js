// Tracer T of epic #59 (#65): a store's rows go through the old-store extractor (E1, scripts/history/extract-store.mjs)
// and the merger (M1, scripts/history/join.mjs) into one history store, which replays clean, passes doctor and shows
// mission control the same items in the same stages. The golden history always runs. dogfood2 runs on a copy of the
// store HARNESS_DOGFOOD2_DIR names; CI has no Library, so there the test says the dogfood2 case did not run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, cpSync, statSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, dedupe } from '../src/history.js';
import { openStore } from '../src/store.js';
import { replay } from '../src/replay.js';
import { doctor } from '../src/doctor.js';
import { project, valueText } from '../src/live.js';
import { loadNeeds } from '../src/pages.js';

const SCRIPTS = fileURLToPath(new URL('../scripts/history/', import.meta.url));
const GOLDEN = fileURLToPath(new URL('./fixtures/history-golden/', import.meta.url));
const DOGFOOD2 = process.env.HARNESS_DOGFOOD2_DIR;
// What no store recorded as a row, recovered from dogfood2's own rows and GitHub: the #66 landing out of band.
const RECOVERED = fileURLToPath(new URL('../scripts/history/recovered/dogfood2.jsonl', import.meta.url));

const rowsOf = (text) => text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const run = (script, args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8' });
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
// A folder's sha256: every file's relative path and bytes, in path order.
const shaDir = (dir) => {
  const h = createHash('sha256');
  for (const f of readdirSync(dir, { recursive: true }).sort()) if (statSync(join(dir, f)).isFile()) h.update(`${f}\n`).update(readFileSync(join(dir, f)));
  return h.digest('hex');
};
const extract = (dir, ref, tmp) => {
  const r = run('extract-store.mjs', [dir, ref]);
  assert.equal(r.status, 0, r.stderr);
  const file = join(tmp, 'candidates.jsonl');
  writeFileSync(file, r.stdout);
  const said = rowsOf(r.stderr);
  return { file, rows: rowsOf(r.stdout), skips: said.filter((l) => l.skip), count: said.at(-1) };
};
const joinTo = (files, out) => {
  const r = run('join.mjs', [...files, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  return { report: JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')), history: rowsOf(readFileSync(join(out, 'events.jsonl'), 'utf8')) };
};
const isHistory = (rows) => {
  assert.deepEqual(rows.flatMap(validate), []);
  assert.deepEqual(rows.map((r) => r.version), rows.map((_, i) => i + 1), 'numbered from 1');
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].at <= rows[i].at, `${rows[i].id} is before ${rows[i - 1].id}`);
};
// What mission control shows of each item (pages/mission-control/needs.json): its stage and status, and the scheduler.
const stages = (dir) => {
  const view = project(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')), loadNeeds('mission-control'));
  return { harness: view.harness, items: Object.fromEntries(view.items.map((i) => [i.id, `${valueText(i.state)} (${i.status})`])) };
};

test('T: the golden history goes through both scripts: every row a row, one per fact, numbered in time order', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'history-tracer-'));
  const before = shaDir(GOLDEN);
  const golden = rowsOf(readFileSync(join(GOLDEN, 'events.jsonl'), 'utf8'));
  const ex = extract(GOLDEN, 'test/fixtures/history-golden/events.jsonl', tmp);
  assert.deepEqual(ex.skips, []);
  assert.equal(ex.rows.length, golden.length);
  assert.deepEqual(ex.count, { ref: 'test/fixtures/history-golden/events.jsonl', rows: golden.length, skips: 0 });
  assert.deepEqual(ex.rows.flatMap(validate), []);
  const candidates = sha(ex.file);
  const { report, history } = joinTo([ex.file], join(tmp, 'joined'));
  const want = dedupe(golden);
  assert.ok(want.dropped.length >= 1);
  assert.equal(history.length, golden.length - want.dropped.length);
  assert.deepEqual(report.dropped, want.dropped);
  assert.deepEqual(report.conflicts, []);
  assert.equal(report.rows, history.length);
  isHistory(history);
  assert.deepEqual(readdirSync(tmp).sort(), ['candidates.jsonl', 'joined'], 'join writes nothing outside --out');
  assert.deepEqual(readdirSync(join(tmp, 'joined')).sort(), ['events.jsonl', 'outbox.jsonl', 'report.json', 'state.json']);
  assert.equal(shaDir(GOLDEN), before, 'the golden history is untouched');
  assert.equal(sha(ex.file), candidates, 'join never edits an input');
});

test('T: the recovered rows are history rows, each recovered from a source it names, with what it could not recover as a placeholder', () => {
  const rows = rowsOf(readFileSync(RECOVERED, 'utf8'));
  assert.deepEqual(rows.flatMap(validate), []);
  for (const r of rows) {
    assert.equal(r.provenance.origin, 'recovered');
    assert.ok(r.provenance.also?.length, `${r.id} names no second source`);
  }
  const oob = rows.find((r) => r.id === 'oob-review-footer-pr66');
  assert.deepEqual([oob.event.type, oob.event.pr, oob.event.sha, oob.provenance.placeholders], ['OUT_OF_BAND', 'https://github.com/suredesigntshirts/ccp_machine/pull/66', '2d04bb40779cd73e7cfc3872328bc8d13057da2b', ['event.message']]);
});

test('T: extract skips a row it cannot turn, naming the line and why; join refuses bad rows and an existing --out, writing nothing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'history-tracer-'));
  const store = join(tmp, 'old');
  mkdirSync(store);
  const good = rowsOf(readFileSync(join(GOLDEN, 'events.jsonl'), 'utf8')).find((r) => !r.provenance.placeholders);
  const { provenance, ...bare } = good;
  writeFileSync(join(store, 'events.jsonl'), `${JSON.stringify(bare)}\nnot json\n${JSON.stringify({ ...bare, id: 'no-at', at: undefined })}\n`);
  const r = run('extract-store.mjs', [store, 'library/old/events.jsonl']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(rowsOf(r.stdout).length, 1);
  const said = rowsOf(r.stderr);
  assert.deepEqual(said.filter((l) => l.skip).map((l) => [l.skip.line, l.reason.split(':')[0]]), [[2, 'not JSON'], [3, 'no-at']]);
  assert.match(said.find((l) => l.skip?.line === 3).reason, /at: missing/);
  assert.deepEqual(said.at(-1), { ref: 'library/old/events.jsonl', rows: 1, skips: 2 });
  const bad = join(tmp, 'bad.jsonl');
  writeFileSync(bad, JSON.stringify(bare) + '\n');
  const refused = run('join.mjs', [bad, '--out', join(tmp, 'never')]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /provenance: missing/);
  assert.deepEqual(readdirSync(tmp).sort(), ['bad.jsonl', 'old']);
  const taken = run('join.mjs', [bad, '--out', store]);
  assert.equal(taken.status, 1);
  assert.match(taken.stderr, /exists/);
  assert.deepEqual(readdirSync(store), ['events.jsonl']);
});

test('T: extract-store lists a legacy placeholder in provenance.placeholders and still skips one the schema does not allow', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'history-tracer-'));
  const { provenance, ...stored } = rowsOf(readFileSync(RECOVERED, 'utf8'))[0];
  const dir = join(tmp, 'store');
  mkdirSync(dir);
  const bad = { ...stored, id: 'bad-placeholder', at: { legacy: 'no time was recorded' } };
  writeFileSync(join(dir, 'events.jsonl'), [stored, bad].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const ex = extract(dir, 'fixture/events.jsonl', tmp);
  assert.deepEqual(ex.rows.map((r) => [r.id, r.provenance.placeholders]), [[stored.id, ['event.message']]]);
  assert.deepEqual(ex.skips.map((s) => s.skip.line), [2], 'a placeholder in a field the schema does not allow one in is skipped');
  assert.match(ex.skips[0].reason, /at:/);
});

test('T: dogfood2 goes through both scripts into a store that replays, passes doctor and shows the same stages', { skip: !DOGFOOD2 && 'the dogfood2 case did not run: HARNESS_DOGFOOD2_DIR names no store (CI has no Library). Run it against a path to dogfood2; it works on a copy' }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'history-tracer-'));
  const original = shaDir(DOGFOOD2);
  const copy = join(tmp, 'dogfood2');
  cpSync(DOGFOOD2, copy, { recursive: true });
  const copied = shaDir(copy);
  const lines = readFileSync(join(copy, 'events.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).length;
  const ex = extract(copy, 'library/harness/state/dogfood2/events.jsonl', tmp);
  assert.deepEqual(ex.skips, [], 'on dogfood2 every row becomes a row');
  assert.equal(ex.rows.length, lines);
  const out = join(tmp, 'joined');
  // The copy's outbox gives each row the route its logged effects took (harness meta.store.facts).
  const { report, history } = joinTo([ex.file, RECOVERED, '--outbox', join(copy, 'outbox.jsonl')], out);
  assert.equal(history.length, lines + 1, 'one history row per events.jsonl line, and the recovered row');
  assert.deepEqual(history.filter((r) => r.provenance.origin === 'recovered').map((r) => r.id), ['oob-review-footer-pr66']);
  assert.deepEqual([report.dropped, report.conflicts], [[], []]);
  isHistory(history);
  const store = openStore(out);
  const r = replay(store);
  assert.deepEqual([r.ok, r.firstDivergence, r.differences], [true, null, []]);
  assert.deepEqual(report.refused, [], 'join applies every row as a fact (R1, #85): it refuses none');
  const R1 = ['spawn-toolu_01KyZNYss7BW3tKekro5RPeK', 'spawn-toolu_011auzhHXfFayBACUm5eqxZP', 'start-a1789bcb30965ef75', 'spawn-toolu_01Ey5FUaAHa6NiXrTdCmtYqD', 'spawn-toolu_01SHeiefeUku4ueafvSeLRyu'];
  assert.ok(R1.every((id) => history.some((h) => h.id === id)), 'the rows the tracer refused before R1 are in the history');
  const d = await doctor(store, { verify: false, now: Date.parse(history.at(-1).at) });
  assert.deepEqual(d.problems, []);
  assert.deepEqual(d.outOfBand.map((l) => l.split(':')[0]), ['oob-review-footer-pr66'], 'doctor lists the #66 landing out of band');
  assert.deepEqual(stages(out), stages(copy), 'mission control shows the same items in the same stages');
  assert.equal(shaDir(copy), copied, 'the copy is untouched');
  assert.equal(shaDir(DOGFOOD2), original, 'the store is untouched');
  console.log(`dogfood2: ${lines} lines, ${ex.rows.length} extracted, ${history.length} joined, ${report.refused.length} refused, ${r.admittedThen.length} today's rules would refuse or route otherwise: ${r.admittedThen.map((x) => x.id).join(', ')}`);
});
