import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  writeFileAtomic, sweepTempFiles, TEMP_MARK, sha256,
  parseFrontMatter, serializeFrontMatter, mergeFrontMatter, parseUnstacked, renderDocument,
  writePage, readPage, isCached, pagePath, listPages, findStalePages,
  withUrlLock, withDomainLock, withGlobalLock, lockFileFor, holdsLock, LockTimeoutError,
  putRaw, recordRaw, storeRaw, readRawMap, parseRawMap, latestRaw,
  withBrowserSlot, withHostSlot, acquireBrowserSlot, SlotTimeoutError, machineDir, limitsConfig,
  ensureRoot, detectBadPage,
} from '../lib/store/index.mjs';
import { MARKER_FILE, SCHEMA_VERSION } from '../lib/config.mjs';

let tmp;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dd-store-'));
  process.env.DD_MACHINE_DIR = join(tmp, 'machine');
});
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const freshRoot = () => join(tmp, `root-${++n}`);

/** Every file path under dir (recursive), for leftover checks. */
function allEntries(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out.push(p);
    if (e.isDirectory()) allEntries(p, out);
  }
  return out;
}

// ─── atomic writes ───────────────────────────────────────────────────────────

describe('writeFileAtomic', () => {
  test('creates parents, replaces content, leaves no temp file', async () => {
    const p = join(freshRoot(), 'a', 'b', 'f.md');
    await writeFileAtomic(p, 'one');
    await writeFileAtomic(p, 'two');
    assert.equal(readFileSync(p, 'utf-8'), 'two');
    assert.ok(!allEntries(join(p, '..')).some(f => f.includes(TEMP_MARK)));
  });

  test('exclusive mode refuses to replace an existing file', async () => {
    const p = join(freshRoot(), 'once');
    await writeFileAtomic(p, 'first', { exclusive: true });
    await assert.rejects(writeFileAtomic(p, 'second', { exclusive: true }), { code: 'EEXIST' });
    assert.equal(readFileSync(p, 'utf-8'), 'first');
    assert.ok(!allEntries(join(p, '..')).some(f => f.includes(TEMP_MARK)));
  });

  test('a failed write cleans up its temp file', async () => {
    const dir = freshRoot();
    mkdirSync(join(dir, 'target-is-a-dir'), { recursive: true });
    await assert.rejects(writeFileAtomic(join(dir, 'target-is-a-dir'), 'x'));
    assert.ok(!allEntries(dir).some(f => f.includes(TEMP_MARK)));
  });

  test('sweepTempFiles removes only stale temp files', async () => {
    const dir = freshRoot();
    mkdirSync(dir, { recursive: true });
    const old = join(dir, `.x.md${TEMP_MARK}1-aa`);
    const fresh = join(dir, `.y.md${TEMP_MARK}2-bb`);
    writeFileSync(old, 'x'); writeFileSync(fresh, 'y');
    const past = new Date(Date.now() - 3600_000);
    utimesSync(old, past, past);
    const removed = await sweepTempFiles(dir, { olderThanMs: 60_000 });
    assert.deepEqual(removed, [old]);
    assert.ok(existsSync(fresh));
  });
});

// ─── front matter ────────────────────────────────────────────────────────────

describe('front matter', () => {
  test('parses block scalars and nested maps; serializes in a stable, fixed order', () => {
    const doc = '---\ntitle: T\ndescription: >-\n  folded\n  text\nsource_url:\n  md: https://x/a.md\nSource: https://x/a\n---\n\n# Body\n';
    const { data, body } = parseFrontMatter(doc);
    assert.equal(data.description, 'folded text');
    assert.equal(body, '\n# Body\n');
    const out = serializeFrontMatter({ ...data, Via: 'markdown', Generated: '2026-01-01', Updated: '2026-01-02' });
    assert.equal(out, [
      '---', 'Source: https://x/a', 'Generated: 2026-01-01', 'Updated: 2026-01-02',
      'title: T', 'description: folded text', 'Via: markdown', 'source_url:', '  md: https://x/a.md', '---', '',
    ].join('\n'));
    assert.equal(serializeFrontMatter(parseFrontMatter(out).data), out, 'round trip is byte-stable');
  });

  test('values that need quoting are quoted; long values are not folded', () => {
    const long = 'word '.repeat(60).trim();
    const out = serializeFrontMatter({ description: 'a: b # c', DocsVersion: '0.44', title: long });
    const back = parseFrontMatter(out + '\n').data;
    assert.equal(back.description, 'a: b # c');
    assert.equal(back.DocsVersion, '0.44'); // stays a string, not the number 0.44
    assert.equal(out.trimEnd().split('\n').length, 5); // --- + 3 keys + ---
  });

  test('invalid YAML is recovered leniently, not dropped', () => {
    const r = parseFrontMatter('---\nSource: https://x/y\nnpm: @scope/pkg 1.0\n---\nbody');
    assert.equal(r.valid, false);
    assert.equal(r.data.Source, 'https://x/y');
    assert.equal(r.data.npm, '@scope/pkg 1.0');
    assert.equal(r.body, 'body');
  });

  test('no front matter → empty data, body untouched; empty block is fine', () => {
    assert.deepEqual(parseFrontMatter('# Hi\n').data, {});
    assert.equal(parseFrontMatter('# Hi\n').body, '# Hi\n');
    assert.deepEqual(parseFrontMatter('---\n---\nx').data, {});
  });

  test('parseUnstacked folds a v1 stacked block into the first; a --- rule is not a block', () => {
    const stacked = '---\nSource: https://s/p\nGenerated: 2026-01-01\n---\n\n---\ntitle: "Up"\nSource: wrong\n---\n\n# Up\n';
    const r = parseUnstacked(stacked);
    assert.equal(r.unstacked, true);
    assert.equal(r.data.title, 'Up');
    assert.equal(r.data.Source, 'https://s/p', 'outer provenance wins');
    assert.equal(r.body, '\n# Up\n');

    const rule = '---\nSource: https://s/p\n---\n\n---\nJust prose here.\n---\n';
    assert.equal(parseUnstacked(rule).unstacked, false);
  });

  test('mergeFrontMatter: provenance, Generated kept, upstream merged, sticky keys, null deletes', () => {
    const now = new Date('2026-09-30T12:00:00Z');
    const m = mergeFrontMatter({
      url: 'https://x/a',
      previous: { Source: 'https://x/a', Generated: '2025-01-01', Updated: '2025-02-02', description: 'kept', Library: 'lib', title: 'old' },
      upstream: { title: 'New', Source: 'upstream-lies', Updated: 'nope' },
      supplied: { Via: 'markdown' },
      now,
    });
    assert.deepEqual(m, {
      Source: 'https://x/a', Generated: '2025-01-01', Updated: '2026-09-30',
      title: 'New', Via: 'markdown', description: 'kept', Library: 'lib',
    });
    const d = mergeFrontMatter({ url: 'u', previous: { description: 'kept' }, supplied: { description: null }, now });
    assert.ok(!('description' in d));
    assert.equal(mergeFrontMatter({ url: 'u', generated: '2020-01-01', now }).Generated, '2020-01-01');
  });

  test('renderDocument puts exactly one blank line between block and body', () => {
    assert.equal(renderDocument({ Source: 's' }, '\n\n# B\n'), '---\nSource: s\n---\n\n# B\n');
  });
});

// ─── pages ───────────────────────────────────────────────────────────────────

describe('writePage', () => {
  test('writes at the URL-derived path with merged provenance; initialises the root', async () => {
    const root = freshRoot();
    const md = '---\ntitle: Select\ndescription: Pick rows\n---\n\n# Select\n\ntext\n';
    const p = await writePage(root, 'https://www.example.com/docs/select.html?utm_source=x#frag', md, {
      frontMatter: { Library: 'drizzle-orm', DocsVersion: '0.44', Via: 'markdown' },
      now: new Date('2026-09-01T00:00:00Z'),
    });
    assert.equal(p, join(root, 'example.com/docs/select.md'));
    assert.equal(readFileSync(p, 'utf-8'), [
      '---',
      'Source: https://www.example.com/docs/select.html',
      'Generated: 2026-09-01',
      'Updated: 2026-09-01',
      'title: Select',
      'description: Pick rows',
      'Library: drizzle-orm',
      'DocsVersion: "0.44"',
      'Via: markdown',
      '---',
      '',
      '# Select',
      '',
      'text',
      '',
    ].join('\n'));
    assert.ok(existsSync(join(root, MARKER_FILE)));
    assert.equal(readFileSync(join(root, '.cache/.gitignore'), 'utf-8').trim().split('\n').at(-1), '*');
  });

  test('refresh keeps Generated, bumps Updated, keeps sticky keys, never stacks', async () => {
    const root = freshRoot();
    const url = 'https://example.com/guide';
    await writePage(root, url, '# v1\n', { frontMatter: { description: 'from index', Library: 'x' }, now: new Date('2026-01-01') });
    const p = await writePage(root, url, '---\ntitle: V2\n---\n# v2\n', { now: new Date('2026-03-03') });
    const text = readFileSync(p, 'utf-8');
    const { data, body } = parseFrontMatter(text);
    assert.equal(data.Generated, '2026-01-01');
    assert.equal(data.Updated, '2026-03-03');
    assert.equal(data.description, 'from index');
    assert.equal(data.Library, 'x');
    assert.equal(data.title, 'V2');
    assert.equal(text.match(/^---$/gm).length, 2, 'exactly one front-matter block');
    assert.equal(body, '\n# v2\n');
  });

  test('redirects: path from the final URL, Source = requested URL, Final recorded', async () => {
    const root = freshRoot();
    const p = await writePage(root, 'https://new.dev/docs/a', '# A\n', {
      source: 'https://old.dev/a?utm_source=x', now: new Date('2026-01-01'),
    });
    assert.equal(p, join(root, 'new.dev/docs/a.md'));
    const d1 = parseFrontMatter(readFileSync(p, 'utf-8')).data;
    assert.deepEqual(Object.keys(d1).slice(0, 4), ['Source', 'Final', 'Generated', 'Updated']);
    assert.equal(d1.Source, 'https://old.dev/a');
    assert.equal(d1.Final, 'https://new.dev/docs/a');
    const page = await readPage(root, 'https://new.dev/docs/a');
    assert.equal(page.final, 'https://new.dev/docs/a');
    assert.equal(page.source, 'https://old.dev/a');

    // Refresh through the redirect keeps Generated; a direct fetch of the final
    // URL is the same page too (not a query-string collision) and drops Final.
    await writePage(root, 'https://new.dev/docs/a', '# A2\n', { source: 'https://old.dev/a', now: new Date('2026-02-02') });
    await writePage(root, 'https://new.dev/docs/a', '# A3\n', { now: new Date('2026-03-03') });
    const d3 = parseFrontMatter(readFileSync(p, 'utf-8')).data;
    assert.equal(d3.Generated, '2026-01-01');
    assert.equal(d3.Source, 'https://new.dev/docs/a');
    assert.ok(!('Final' in d3));

    // A v1-migrated page (Source = requested URL, no Final) keeps its history too.
    mkdirSync(join(root, 'moved.dev'), { recursive: true });
    writeFileSync(join(root, 'moved.dev/x.md'), '---\nSource: https://orig.dev/x\nGenerated: 2025-05-05\nUpdated: 2025-05-05\n---\n\n# X\n');
    await writePage(root, 'https://moved.dev/x', '# X2\n', { source: 'https://orig.dev/x' });
    assert.equal(parseFrontMatter(readFileSync(join(root, 'moved.dev/x.md'), 'utf-8')).data.Generated, '2025-05-05');
  });

  test('a different URL sharing the path (query string) starts a fresh history', async () => {
    const root = freshRoot();
    await writePage(root, 'https://q.dev/list?page=1', '# 1\n', { frontMatter: { description: 'one' }, now: new Date('2026-01-01') });
    const p = await writePage(root, 'https://q.dev/list?page=2', '# 2\n', { now: new Date('2026-02-02') });
    const d = parseFrontMatter(readFileSync(p, 'utf-8')).data;
    assert.equal(d.Generated, '2026-02-02');
    assert.ok(!('description' in d));
  });

  test('`/a` and `/a/` (same path, no query) are one page: its history is kept, not reset', async () => {
    const root = freshRoot();
    await writePage(root, 'https://q.dev/a', '# A\n', { frontMatter: { description: 'kept' }, now: new Date('2026-01-01') });
    const p = await writePage(root, 'https://q.dev/a/', '# A\n', { now: new Date('2026-02-02') });
    const d = parseFrontMatter(readFileSync(p, 'utf-8')).data;
    assert.equal(d.Generated, '2026-01-01');
    assert.equal(d.Updated, '2026-02-02');
    assert.equal(d.description, 'kept');
  });

  test('readPage / isCached / pagePath / listPages / findStalePages', async () => {
    const root = freshRoot();
    await writePage(root, 'https://a.dev/x', '# X\n', { now: new Date('2026-01-01') });
    await writePage(root, 'https://a.dev/', '# Root\n', { now: new Date('2026-09-29') });
    mkdirSync(join(root, 'a.dev'), { recursive: true });
    writeFileSync(join(root, 'a.dev', '_outline.md'), 'generated');
    writeFileSync(join(root, 'catalog.md'), 'generated');

    assert.equal(await isCached(root, 'https://a.dev/x'), true);
    assert.equal(await isCached(root, 'https://a.dev/nope'), false);
    assert.equal(pagePath(root, 'https://a.dev/'), join(root, 'a.dev/index.md'));
    const page = await readPage(root, 'https://a.dev/x#frag');
    assert.equal(page.source, 'https://a.dev/x');
    assert.equal(page.relPath, 'a.dev/x.md');
    assert.equal(await readPage(root, 'https://a.dev/nope'), null);

    const listed = [];
    for await (const p of listPages(root)) listed.push(p.relPath);
    assert.deepEqual(listed, ['a.dev/index.md', 'a.dev/x.md']);

    const stale = await findStalePages(root, 30, { now: new Date('2026-09-30') });
    assert.deepEqual(stale.map(s => [s.source, s.relPath, s.generated]), [['https://a.dev/x', 'a.dev/x.md', '2026-01-01']]);
  });
});

// ─── locks ───────────────────────────────────────────────────────────────────

describe('locks', () => {
  test('mutual exclusion within one process, and nothing left behind', async () => {
    const root = freshRoot();
    let inside = 0, maxInside = 0;
    await Promise.all(Array.from({ length: 8 }, () => withDomainLock(root, 'example.com', async () => {
      inside++; maxInside = Math.max(maxInside, inside);
      await sleep(5);
      inside--;
    })));
    assert.equal(maxInside, 1);
    assert.ok(!allEntries(join(root, '.cache/locks')).some(p => p.endsWith('.lock')));
  });

  test('re-entrant within one async chain (writePage inside withUrlLock)', async () => {
    const root = freshRoot();
    const url = 'https://example.com/r';
    const path = await withUrlLock(root, url, async () => {
      assert.ok(holdsLock(root, 'url', url));
      return writePage(root, url, '# nested\n');
    }, { waitMs: 1000 });
    assert.ok(existsSync(path));
    assert.ok(!holdsLock(root, 'url', url));
    // After a redirect: holding the requested URL's lock, write the final URL's page.
    const final = await withUrlLock(root, 'https://old.example.com/r', () =>
      writePage(root, 'https://example.com/r-final', '# final\n'), { waitMs: 1000 });
    assert.equal(final, join(root, 'example.com/r-final.md'));
  });

  test('bounded wait fails with LockTimeoutError instead of proceeding', async () => {
    const root = freshRoot();
    let entered, release;
    const inLock = new Promise(r => { entered = r; });
    const gate = new Promise(r => { release = r; });
    const holder = withGlobalLock(root, 'catalog', async () => { entered(); await gate; });
    await inLock;
    let ran = false;
    // Started from the test's own async chain, so it is a genuine second holder.
    await assert.rejects(withGlobalLock(root, 'catalog', async () => { ran = true; }, { waitMs: 150 }),
      (err) => err instanceof LockTimeoutError && err.code === 'ELOCKTIMEOUT' && /catalog/.test(err.message));
    assert.equal(ran, false);
    release();
    await holder;
  });

  test('re-entrancy ends when the lock is released (a straggler task must lock for itself)', async () => {
    const root = freshRoot();
    let straggler;
    await withDomainLock(root, 'e.com', async () => {
      straggler = (async () => {
        await sleep(30); // still running after the holder released
        return holdsLock(root, 'domain', 'e.com');
      })();
    });
    assert.equal(await straggler, false);
  });

  test('a stale lock left by a dead process is reclaimed', async () => {
    const root = freshRoot();
    const lockDir = `${lockFileFor(root, 'domain', 'example.com')}.lock`;
    mkdirSync(lockDir, { recursive: true });
    const past = new Date(Date.now() - 120_000);
    utimesSync(lockDir, past, past);
    const t0 = Date.now();
    const v = await withDomainLock(root, 'https://www.example.com/x', async () => 42, { waitMs: 2000, staleMs: 5000 });
    assert.equal(v, 42);
    assert.ok(Date.now() - t0 < 1000);
    assert.ok(!existsSync(lockDir));
  });

  test('url locks key on the canonical URL (fragment and tracking params ignored)', () => {
    const root = '/r';
    assert.equal(lockFileFor(root, 'url', 'https://e.com/a#x'), lockFileFor(root, 'url', 'https://e.com/a?utm_source=y'));
    assert.notEqual(lockFileFor(root, 'url', 'https://e.com/a'), lockFileFor(root, 'url', 'https://e.com/b'));
  });
});

// ─── raw cache ───────────────────────────────────────────────────────────────

describe('raw cache', () => {
  test('content-addressed, write-once blobs', async () => {
    const root = freshRoot();
    const h1 = await putRaw(root, '<html>same</html>');
    const h2 = await putRaw(root, Buffer.from('<html>same</html>'));
    assert.equal(h1, h2);
    assert.equal(h1, sha256('<html>same</html>'));
    assert.deepEqual(readdirSync(join(root, '.cache/raw')), [h1]);
  });

  test('raw-map records and latestRaw lookup (url or finalUrl, canonicalised)', async () => {
    const root = freshRoot();
    await storeRaw(root, 'v1', { url: 'https://e.com/a', status: 200, contentType: 'text/html', kind: 'html', fetchedAt: '2026-01-01T00:00:00Z' });
    await storeRaw(root, 'v2', { url: 'https://e.com/old', finalUrl: 'https://e.com/a', status: 200, kind: 'html', fetchedAt: '2026-02-01T00:00:00Z' });
    await storeRaw(root, 'other', { url: 'https://e.com/b', kind: 'markdown' });
    const recs = await readRawMap(root);
    assert.equal(recs.length, 3);
    assert.deepEqual(Object.keys(recs[0]), ['url', 'finalUrl', 'sha256', 'status', 'contentType', 'fetchedAt', 'kind']);
    const latest = await latestRaw(root, 'https://e.com/a#frag');
    assert.equal(latest.sha256, sha256('v2'));
    assert.equal(readFileSync(latest.path, 'utf-8'), 'v2');
    assert.equal(await latestRaw(root, 'https://e.com/none'), null);
  });

  test('reader tolerates a torn last line and a torn line glued to the next record', () => {
    const good = (u) => JSON.stringify({ url: u, finalUrl: u, sha256: 'a'.repeat(64) });
    const text = `${good('https://1')}\n{"url":"https://torn","fin${good('https://2')}\n${good('https://3')}\n{"url":"https://4","sha`;
    assert.deepEqual(parseRawMap(text).map(r => r.url), ['https://1', 'https://2', 'https://3']);
  });

  test('recordRaw requires url and sha256', async () => {
    await assert.rejects(recordRaw(freshRoot(), { url: 'https://x' }));
  });
});

// ─── machine-wide limits ─────────────────────────────────────────────────────

describe('limits', () => {
  test('machineDir honours DD_MACHINE_DIR, and defaults to a per-user tmp dir', () => {
    assert.equal(machineDir(), process.env.DD_MACHINE_DIR);
    assert.match(machineDir({}), /documentation-downloader-/);
  });

  test('browser slots cap concurrency', async () => {
    const dir = join(freshRoot(), 'm');
    let inside = 0, maxInside = 0;
    await Promise.all(Array.from({ length: 6 }, () => withBrowserSlot(async () => {
      inside++; maxInside = Math.max(maxInside, inside);
      await sleep(20);
      inside--;
    }, { dir, max: 2 })));
    assert.equal(maxInside, 2);
  });

  test('defaults: 3 browsers, 3 requests per host, 200 ms between starts', () => {
    const cfg = limitsConfig({});
    assert.equal(cfg.maxBrowsers, 3);
    assert.equal(cfg.hostConcurrency, 3);
    assert.equal(cfg.hostIntervalMs, 200);
    assert.equal(limitsConfig({ DD_MAX_BROWSERS: '5' }).maxBrowsers, 5);
  });

  test('short, frequent acquisitions (one per page render) are fast', async () => {
    const dir = join(freshRoot(), 'm');
    let inside = 0, maxInside = 0;
    const t0 = Date.now();
    // 60 renders of ~2 ms through 3 slots: ~40 ms of work. Polling-only waiters
    // would stall for their backoff; in-process release wake-ups avoid that.
    await Promise.all(Array.from({ length: 60 }, () => withBrowserSlot(async () => {
      inside++; maxInside = Math.max(maxInside, inside);
      await sleep(2);
      inside--;
    }, { dir })));
    assert.equal(maxInside, 3);
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  });

  test('slot wait is bounded', async () => {
    const dir = join(freshRoot(), 'm');
    const held = await acquireBrowserSlot({ dir, max: 1 });
    await assert.rejects(withBrowserSlot(async () => {}, { dir, max: 1, waitMs: 100 }),
      (err) => err instanceof SlotTimeoutError && err.code === 'ESLOTTIMEOUT');
    await held.release();
    assert.equal(await withBrowserSlot(async () => 'ok', { dir, max: 1, waitMs: 100 }), 'ok');
  });

  test('host slots: max in flight and a minimum interval between starts', async () => {
    const dir = join(freshRoot(), 'm');
    const starts = [];
    let inside = 0, maxInside = 0;
    await Promise.all(Array.from({ length: 5 }, () => withHostSlot('https://www.slow.example/x', async () => {
      starts.push(Date.now());
      inside++; maxInside = Math.max(maxInside, inside);
      await sleep(10);
      inside--;
    }, { dir, max: 2, intervalMs: 60, burst: 1 })));
    assert.ok(maxInside <= 2);
    starts.sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 55, `gap ${starts[i] - starts[i - 1]}ms`);
    assert.ok(existsSync(join(dir, 'hosts', 'slow.example', 'next-start')), 'host keyed without www.');
  });

  test('host slots: a burst starts together, the rest keep the average interval', async () => {
    const dir = join(freshRoot(), 'm');
    const t0 = Date.now();
    const starts = [];
    await Promise.all(Array.from({ length: 5 }, () => withHostSlot('https://burst.example/x', async () => {
      starts.push(Date.now() - t0);
    }, { dir, max: 5, intervalMs: 150, burst: 3 })));
    starts.sort((a, b) => a - b);
    // Scheduled starts: 0, 0, 0, 150, 300 (lock handling adds a little, never removes;
    // under a loaded test run it can add ~100 ms — exact semantics: the gcraReserve test).
    assert.ok(starts[2] - starts[0] < 290, `first 3 before the 5th's slot: ${starts}`);
    assert.ok(starts[3] - starts[0] >= 140 && starts[4] - starts[0] >= 290, `then one per interval: ${starts}`);
  });
});

// ─── root marker ─────────────────────────────────────────────────────────────

describe('ensureRoot', () => {
  test('creates marker and self-ignoring .cache; idempotent', async () => {
    const root = freshRoot();
    const a = await ensureRoot(root);
    const b = await ensureRoot(root);
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(JSON.parse(readFileSync(join(root, MARKER_FILE), 'utf-8')).schema, SCHEMA_VERSION);
    assert.match(readFileSync(join(root, '.cache/.gitignore'), 'utf-8'), /^\*$/m);
  });

  test('refuses a cache from a newer schema', async () => {
    const root = freshRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, MARKER_FILE), JSON.stringify({ schema: SCHEMA_VERSION + 1 }));
    await assert.rejects(ensureRoot(root), /schema/);
  });
});

// ─── bad-page detection ──────────────────────────────────────────────────────

describe('detectBadPage', () => {
  const fm = '---\nSource: https://x\n---\n\n';
  const filler = 'Real documentation sentence with enough words to count as content. '.repeat(10);
  test('flags interstitials, error pages and stubs', () => {
    assert.equal(detectBadPage(`${fm}# Just a moment...\n`).reason, 'interstitial');
    assert.equal(detectBadPage(`${fm}# Verification successful\n\n${filler}`).reason, 'interstitial');
    assert.equal(detectBadPage(`${fm}# Page Not Found - Site\n\n${filler}`).reason, 'error-page');
    assert.equal(detectBadPage(`${fm}# 500\n\n${filler}`).reason, 'error-page');
    assert.equal(detectBadPage(`${fm}# Title\n\nshort`).reason, 'tiny-body');
    assert.equal(detectBadPage(`${fm}# Docs\n\nEnable JavaScript and cookies to continue\n${filler}`).reason, 'interstitial');
  });
  test('leaves real pages alone, including long ones with alarming titles', () => {
    assert.equal(detectBadPage(`${fm}# Select\n\n${filler}`), null);
    assert.equal(detectBadPage(`${fm}# Not Found errors\n\n${filler.repeat(10)}`), null);
  });
});

test('host rate: GCRA token bucket — burst of B, then one per interval; burst 1 is a plain gap', async () => {
  const { gcraReserve } = await import('../lib/store/limits.mjs');
  // burst 1: the old minimum gap between starts
  let tat = 0; const waits1 = [];
  for (let i = 0; i < 3; i++) { const r = gcraReserve(tat, 1000, 200, 1); waits1.push(r.wait); tat = r.tat; }
  assert.deepEqual(waits1, [0, 200, 400]);
  // burst 3: three at once, then spaced
  tat = 0; const waits3 = [];
  for (let i = 0; i < 5; i++) { const r = gcraReserve(tat, 1000, 200, 3); waits3.push(r.wait); tat = r.tat; }
  assert.deepEqual(waits3, [0, 0, 0, 200, 400]);
  // idle time refills the bucket, but never beyond the burst
  const later = gcraReserve(tat, 1000 + 10_000, 200, 3);
  assert.equal(later.wait, 0);
  // average rate over a long run is one per interval whatever the burst
  tat = 0; let last = 0;
  for (let i = 0; i < 100; i++) { const r = gcraReserve(tat, 1000, 200, 6); last = r.wait; tat = r.tat; }
  assert.equal(last, (100 - 6) * 200);
});
