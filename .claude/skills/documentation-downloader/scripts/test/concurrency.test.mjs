/**
 * Many processes, one cache: the v1 failure mode (duplicated `## domain` headers,
 * lost index entries, half-written files) must be impossible in v2.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRawMap, parseFrontMatter, pagePath, withUrlLock, LockTimeoutError, TEMP_MARK, sha256 } from '../lib/store/index.mjs';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'store-worker.mjs');

let tmp;
before(() => { tmp = mkdtempSync(join(tmpdir(), 'dd-conc-')); });
after(() => rmSync(tmp, { recursive: true, force: true }));

function run(cfg) {
  const child = spawn(process.execPath, [WORKER, JSON.stringify(cfg)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, out, err })));
  return { child, done, stdout: () => out };
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out.push(p);
    if (e.isDirectory()) walk(p, out);
  }
  return out;
}

// Deterministic per-worker URL subsets that overlap heavily.
function urlsFor(id, universe, count) {
  const picked = [];
  let x = id * 7919 + 1;
  while (picked.length < count) {
    x = (x * 48271) % 2147483647;
    const u = universe[x % universe.length];
    if (!picked.includes(u)) picked.push(u);
  }
  return picked;
}

test('12 processes writing overlapping pages, raw records and generated files lose nothing', { timeout: 120_000 }, async () => {
  const root = join(tmp, 'storm', 'external-docs');
  const machineDir = join(tmp, 'storm', 'machine');
  const browserLog = join(tmp, 'storm', 'browsers.jsonl');
  const WORKERS = 12, RAW = 25, RMW = 6, BROWSER_ROUNDS = 3, MAX_BROWSERS = 2;
  const universe = Array.from({ length: 30 }, (_, i) =>
    i % 3 === 0 ? `https://example.com/docs/page-${i}` : `https://www.other${i % 4}.dev/guide/p${i}.html`);
  const startAt = Date.now() + 1500;

  const procs = Array.from({ length: WORKERS }, (_, id) => run({
    mode: 'storm', root, machineDir, browserLog, id, startAt,
    urls: urlsFor(id, universe, 20), rawPerWorker: RAW, rmwPerWorker: RMW,
    browserRounds: BROWSER_ROUNDS, maxBrowsers: MAX_BROWSERS,
  }));
  const results = await Promise.all(procs.map(p => p.done));
  for (const r of results) assert.equal(r.code, 0, `worker failed: ${r.err}`);
  const stats = results.map(r => JSON.parse(r.out));

  const requested = new Set(procs.flatMap((_, id) => urlsFor(id, universe, 20)));

  // Per-URL locks deduped the fetches: every URL fetched exactly once in total.
  assert.equal(stats.reduce((s, x) => s + x.fetched, 0), requested.size);
  assert.equal(stats.reduce((s, x) => s + x.fetched + x.skipped, 0), WORKERS * 20);

  // No lost pages, no partial or corrupt ones: each is exactly one writer's
  // complete refresh, under one front-matter block with intact provenance.
  const today = new Date().toISOString().slice(0, 10);
  for (const url of requested) {
    const text = readFileSync(pagePath(root, url), 'utf-8');
    assert.equal(text.match(/^---$/gm).length, 2, `one front-matter block in ${url}`);
    const { data, body } = parseFrontMatter(text);
    assert.equal(data.Source, url);
    assert.equal(data.Generated, today);
    const writer = /^\n# .+\n\nwriter (\d+) refresh\n/.exec(body);
    assert.ok(writer, `body of ${url} starts with a refresh header`);
    const id = writer[1];
    assert.equal(body, `\n# ${url}\n\nwriter ${id} refresh\n\n${'lorem ipsum dolor sit amet '.repeat(2200)}\nEND ${id} refresh\n`);
  }

  // raw-map: every line parses (none torn or interleaved) and none were lost.
  const rawText = readFileSync(join(root, '.cache', 'raw-map.jsonl'), 'utf-8');
  const lines = rawText.split('\n').filter(Boolean);
  for (const line of lines) JSON.parse(line);
  const recs = await readRawMap(root);
  assert.equal(recs.length, lines.length);
  assert.equal(recs.filter(r => requested.has(r.url)).length, requested.size, 'one raw record per fetched page');
  assert.equal(recs.filter(r => r.url.startsWith('https://raw.example/')).length, WORKERS * RAW);
  assert.equal(new Set(recs.map(r => r.url)).size, recs.length);
  for (const r of recs) {
    assert.equal(sha256(readFileSync(join(root, '.cache', 'raw', r.sha256))), r.sha256, 'blob intact');
  }

  // Lock-protected read-modify-write of generated files lost no update.
  for (const file of [join(root, 'example.com', '_outline.md'), join(root, 'catalog.md')]) {
    const entries = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    assert.equal(entries.length, WORKERS * RMW, file);
    assert.equal(new Set(entries).size, entries.length);
  }

  // The machine-wide browser semaphore held across processes.
  const events = readFileSync(browserLog, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    .sort((a, b) => a.t - b.t || (a.e === 'out' ? -1 : 1));
  let inside = 0, maxInside = 0;
  for (const ev of events) { inside += ev.e === 'in' ? 1 : -1; maxInside = Math.max(maxInside, inside); }
  assert.equal(events.filter(e => e.e === 'in').length, WORKERS * BROWSER_ROUNDS);
  assert.ok(maxInside <= MAX_BROWSERS, `max ${maxInside} browsers at once`);

  // Nothing left behind: no temp files, no held locks.
  const leftovers = [...walk(root), ...walk(machineDir)].filter(p => p.includes(TEMP_MARK) || p.endsWith('.lock'));
  assert.deepEqual(leftovers, []);
});

test('a lock held by another process: bounded wait fails; after that process dies the lock is reclaimed', { timeout: 60_000 }, async () => {
  const root = join(tmp, 'hold', 'external-docs');
  const url = 'https://example.com/held';
  const holder = run({ mode: 'hold', root, url, machineDir: join(tmp, 'hold', 'machine') });
  const t0 = Date.now();
  while (!holder.stdout().includes('locked')) {
    assert.ok(Date.now() - t0 < 20_000, 'holder never took the lock');
    await new Promise(r => setTimeout(r, 20));
  }

  await assert.rejects(withUrlLock(root, url, async () => {}, { waitMs: 300 }),
    (err) => err instanceof LockTimeoutError && err.message.includes(url));

  holder.child.kill('SIGKILL'); // no cleanup handlers run: the lock dir stays behind
  const { signal } = await holder.done;
  assert.equal(signal, 'SIGKILL');

  const t1 = Date.now();
  const got = await withUrlLock(root, url, async () => 'mine', { waitMs: 15_000, staleMs: 2000 });
  assert.equal(got, 'mine');
  assert.ok(Date.now() - t1 < 10_000);
});
