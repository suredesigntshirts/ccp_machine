/**
 * Search index behaviour, on both backends: ranking, incremental refresh,
 * generated files, lookup, and the CLI output formats.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { refreshIndex, searchIndex, openIndex, updateIndexForFiles, formatText, formatJson } from '../lib/index/index.mjs';
import { loadSqlite } from '../lib/index/sqlite.mjs';
import { lookupUrl, candidatePaths } from '../lib/index/lookup.mjs';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs.mjs');
const HAVE_SQLITE = !!(await loadSqlite());
const BACKENDS = HAVE_SQLITE ? ['sqlite', 'json'] : ['json'];

const PAGES = {
  'orm.example.dev/docs/select.md': `---
Source: https://orm.example.dev/docs/select
title: Select
---

# Select

Query rows from a table with \`db.select()\`.

## Partial select

Pick columns: \`db.select({ id: users.id }).from(users)\`.

## Conditional filters

Use \`where\` with \`eq()\` and \`and()\` to filter rows.
`,
  'orm.example.dev/docs/insert.md': `---
Source: https://orm.example.dev/docs/insert
---

# Insert

Insert rows with \`db.insert(users).values(...)\`.

## Upserts

### onConflictDoUpdate()

Update the existing row when a unique constraint conflicts:

\`\`\`ts
await db.insert(users).values(u).onConflictDoUpdate({ target: users.id, set: { name } });
\`\`\`

## Returning

Get inserted rows back with \`.returning()\`.
`,
  'api.other.dev/limits.md': `# Limits

## Rate limits

Each app may send 50 requests per second. Bursts are throttled with a leaky bucket.

| Limit | Value |
| --- | --- |
| Batch size | 50 requests per batch |
| Payload | 10 MB |
`,
  // A v1-style root page (`https://fly.example/` was written as `fly.example.md`).
  'fly.example.md': `---
Source: https://fly.example/
---

# Fly example home

Run apps close to users.
`,
  // Old-tool subtree: the path is not the URL; only Source: tells.
  'legacy/support/answer/123.md': `---
Source: https://support.example.com/answer/123
---

# About snippets

Snippets highlight products.
`,
  // Not pages: must be ignored by the index.
  'CLAUDE.md': '# Notes for agents\n\nnot a page\n',
  '.cache/raw/whatever.md': '# hidden\n',
};

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dd-index-test-'));
  for (const [rel, text] of Object.entries(PAGES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

for (const backend of BACKENDS) {
  test(`[${backend}] builds, ranks sections, and returns tight line ranges`, async () => {
    const root = makeRoot();
    try {
      const s = await refreshIndex(root, { backend, generate: 'all' });
      assert.equal(s.added, 5, 'five pages indexed (CLAUDE.md and dot-dirs skipped)');

      const r1 = await searchIndex(root, 'onConflictDoUpdate', { backend });
      assert.equal(r1.results[0].path, 'orm.example.dev/docs/insert.md');
      assert.equal(r1.results[0].heading, 'Insert › Upserts › onConflictDoUpdate()');
      assert.deepEqual([r1.results[0].start, r1.results[0].end], [9, 17], 'the empty ## Upserts folds in');

      const r2 = await searchIndex(root, 'filter rows with where', { backend });
      assert.equal(r2.results[0].heading, 'Select › Conditional filters');

      const r3 = await searchIndex(root, 'how many requests fit in one batch', { backend });
      assert.equal(r3.results[0].path, 'api.other.dev/limits.md');

      const filtered = await searchIndex(root, 'rows', { backend, domain: 'api.other.dev' });
      assert.ok(filtered.results.every(r => r.path.startsWith('api.other.dev/')));
      const prefixed = await searchIndex(root, 'rows', { backend, pathPrefix: 'orm.example.dev/docs/sel' });
      assert.ok(prefixed.results.length && prefixed.results.every(r => r.path === 'orm.example.dev/docs/select.md'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`[${backend}] refresh is incremental and search never sees a stale index`, async () => {
    const root = makeRoot();
    try {
      await refreshIndex(root, { backend });
      assert.equal((await refreshIndex(root, { backend })).unchanged, 5, 'no-op refresh');

      // touch without a content change: no re-analysis
      const f = join(root, 'orm.example.dev/docs/select.md');
      const later = new Date(Date.now() + 5000);
      utimesSync(f, later, later);
      const t = await refreshIndex(root, { backend });
      assert.equal(t.touched, 1);
      assert.equal(t.updated, 0);

      // edit a page: the next search sees it without an explicit reindex
      writeFileSync(f, readFileSync(f, 'utf-8') + '\n## Distinct values\n\nUse selectDistinctOn for zebra-unique rows.\n');
      const r = await searchIndex(root, 'zebra unique', { backend });
      assert.equal(r.refreshed.updated, 1);
      assert.equal(r.results[0].heading, 'Select › Distinct values');

      // add and delete pages
      writeFileSync(join(root, 'api.other.dev/new.md'), '# New page\n\nQuokka content.\n');
      unlinkSync(join(root, 'orm.example.dev/docs/insert.md'));
      const r2 = await searchIndex(root, 'quokka', { backend });
      assert.equal(r2.refreshed.added, 1);
      assert.equal(r2.refreshed.removed, 1);
      assert.equal(r2.results[0].path, 'api.other.dev/new.md');
      assert.equal((await searchIndex(root, 'onConflictDoUpdate', { backend })).results.length, 0);

      // updateIndexForFiles: what fetch calls after writing a page
      writeFileSync(join(root, 'api.other.dev/fetched.md'), '# Fetched\n\nPlatypus facts.\n');
      const u = await updateIndexForFiles(root, ['api.other.dev/fetched.md'], { backend });
      assert.equal(u.added, 1);
      assert.equal((await searchIndex(root, 'platypus', { backend, refresh: false })).results[0].path, 'api.other.dev/fetched.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`[${backend}] writes catalog.md and per-domain _outline.md; lookup resolves v1 paths and Source:`, async () => {
    const root = makeRoot();
    try {
      await refreshIndex(root, { backend, generate: 'all' });
      const catalog = readFileSync(join(root, 'catalog.md'), 'utf-8');
      assert.match(catalog, /^orm\.example\.dev \(2\): /m);
      assert.match(catalog, /^fly\.example \(1\): Fly example home$/m);
      const outline = readFileSync(join(root, 'orm.example.dev/_outline.md'), 'utf-8');
      assert.match(outline, /^docs\/insert\.md — Insert \(\d+\)$/m);
      assert.match(outline, /^docs\/select\.md — Select \(\d+\)$/m);
      // Generated files are not indexed as pages.
      assert.equal((await refreshIndex(root, { backend })).added, 0);
      // No temp files left behind; the derived-state dir ignores itself in git.
      assert.ok(!readdirSync(root).some(n => n.endsWith('.tmp')));
      assert.equal(readFileSync(join(root, '.cache', '.gitignore'), 'utf-8').trim().split('\n').pop(), '*');

      const idx = await openIndex(root, { backend });
      try {
        assert.deepEqual(lookupUrl(root, 'https://orm.example.dev/docs/select/', idx),
          { url: 'https://orm.example.dev/docs/select/', cached: true, path: 'orm.example.dev/docs/select.md', via: 'path', expected: 'orm.example.dev/docs/select.md' });
        const fly = lookupUrl(root, 'https://www.fly.example/', idx);
        assert.equal(fly.path, 'fly.example.md');
        assert.equal(fly.via, 'legacy-path');
        const legacy = lookupUrl(root, 'https://support.example.com/answer/123', idx);
        assert.equal(legacy.path, 'legacy/support/answer/123.md');
        assert.equal(legacy.via, 'source');
        assert.equal(lookupUrl(root, 'https://nope.example/x', idx).cached, false);
      } finally {
        idx.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

if (HAVE_SQLITE) {
  test('both backends return the same results', async () => {
    const root = makeRoot();
    try {
      for (const q of ['select rows', 'onConflictDoUpdate', 'requests per batch', 'snippets products', 'insert returning']) {
        const a = await searchIndex(root, q, { backend: 'sqlite' });
        const b = await searchIndex(root, q, { backend: 'json' });
        assert.deepEqual(b.results.map(r => [r.path, r.start, r.end]), a.results.map(r => [r.path, r.start, r.end]), q);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('lookup candidate paths cover the v2 rule and the v1 variants', () => {
  assert.deepEqual(candidatePaths('https://www.fly.io/'), ['fly.io/index.md', 'fly.io.md', 'www.fly.io.md']);
  assert.ok(candidatePaths('https://x.dev/a%20b/c.html').includes('x.dev/a b/c.md'));
  assert.ok(candidatePaths('https://x.dev/a%20b/c.html').includes('x.dev/a%20b/c.md'));
});

test('text output is grouped by file, bounded, and --json carries the same data', () => {
  const res = {
    query: 'q',
    results: [
      { path: 'a.dev/x.md', title: 'X page', start: 10, end: 20, lines: 11, tokens: 100, heading: 'X page › Part', snippet: 'hello', score: 1 },
      { path: 'b.dev/y.md', title: 'Y', start: 1, end: 5, lines: 5, tokens: 9000, heading: '', snippet: 'intro', score: 0.9 },
      { path: 'a.dev/x.md', title: 'X page', start: 40, end: 45, lines: 6, tokens: 50, heading: 'X page › Other', snippet: 'more', score: 0.8 },
    ],
  };
  assert.equal(formatText(res, { prefix: 'external-docs/' }), [
    'external-docs/a.dev/x.md — X page',
    '  10-20 (11 lines) Part — hello',
    '  40-45 (6 lines) Other — more',
    'external-docs/b.dev/y.md — Y',
    '  1-5 (5 lines, ~9k tok) — intro',
  ].join('\n'));
  const small = formatText(res, { budget: 20 });
  assert.ok(small.length < 200 && small.includes('more; raise --budget'));
  const j = formatJson(res, { prefix: 'external-docs/' });
  assert.equal(j.results[0].file, 'external-docs/a.dev/x.md');
  assert.deepEqual(j.results[0].heading, ['X page', 'Part']);
});

test('CLI: search, outline, lookup, catalog, reindex', () => {
  const root = makeRoot();
  const run = (...args) => spawnSync(process.execPath, [DOCS, ...args, '--root', root], { encoding: 'utf-8' });
  try {
    const re = run('reindex');
    assert.equal(re.status, 0, re.stderr);
    assert.match(re.stdout, /Indexed 5 pages/);
    assert.equal(re.stderr, '', 'no ExperimentalWarning or other noise on stderr');

    const s = run('search', 'onConflictDoUpdate');
    assert.equal(s.status, 0, s.stderr);
    const lines = s.stdout.trim().split('\n');
    assert.ok(lines[0].endsWith('orm.example.dev/docs/insert.md — Insert'));
    assert.match(lines[1], /^ {2}9-17 \(9 lines\) Upserts › onConflictDoUpdate\(\) — /);

    const js = JSON.parse(run('search', 'rows', '--json', '--limit', '2').stdout);
    assert.equal(js.results.length, 2);
    assert.ok(js.results.every(r => r.file.startsWith(root) && r.start > 0 && r.end >= r.start && Array.isArray(r.heading)));

    const o = run('outline', 'orm.example.dev/docs/insert.md');
    assert.equal(o.status, 0, o.stderr);
    assert.match(o.stdout, /^1-3 front matter$/m);
    assert.match(o.stdout, /^ {4}11-17 ### onConflictDoUpdate\(\) \(7\)$/m);
    const ou = run('outline', 'https://orm.example.dev/docs/insert');
    assert.equal(ou.stdout, o.stdout, 'outline by URL = outline by path');

    const l = run('lookup', 'https://orm.example.dev/docs/insert', 'https://missing.example/');
    assert.equal(l.status, 1, 'exit 1 when any URL is missing');
    assert.match(l.stdout, /^cached {2}https:\/\/orm\.example\.dev\/docs\/insert → .*orm\.example\.dev\/docs\/insert\.md \(21 lines\)$/m);
    assert.match(l.stdout, /^missing https:\/\/missing\.example\/ → would be .*missing\.example\/index\.md$/m);

    const c = run('catalog');
    assert.equal(c.status, 0);
    assert.match(c.stdout, /^api\.other\.dev \(1\): Limits$/m);
    const cd = run('catalog', '--domain', 'orm.example.dev');
    assert.match(cd.stdout, /^docs\/select\.md — Select \(\d+\)$/m);

    assert.equal(run('search', '--bogus').status, 2, 'unknown flags are usage errors');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an index from another analyzer version is rebuilt in full, once', async () => {
  const root = makeRoot();
  try {
    const backend = BACKENDS[0];
    await refreshIndex(root, { backend });
    const setOld = async () => {
      const idx = await openIndex(root, { backend });
      idx.update({ meta: { analyzer: 'old' } });
      idx.close();
    };
    await setOld();
    const s = await refreshIndex(root, { backend });
    assert.equal(s.added + s.updated, 5);
    assert.equal((await refreshIndex(root, { backend })).unchanged, 5, 'version recorded');
    // Also when the rebuild is triggered by a fetch's updateIndexForFiles call.
    await setOld();
    const u = await updateIndexForFiles(root, ['api.other.dev/limits.md'], { backend });
    assert.equal(u.added + u.updated, 5);
    assert.equal((await refreshIndex(root, { backend })).unchanged, 5, 'version recorded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing cache root is a usage error, not a crash', () => {
  const r = spawnSync(process.execPath, [DOCS, 'search', 'x', '--root', join(tmpdir(), 'does-not-exist-dd')], { encoding: 'utf-8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /No documentation cache/);
  assert.ok(!existsSync(join(tmpdir(), 'does-not-exist-dd')));
});
