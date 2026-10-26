/**
 * Pages whose URL path has a segment starting with `_` or `.` (docs.python.org
 * `__main__`, Sphinx `_modules/`, `.well-known/`) are pages like any other:
 * only the names the tool generates itself are skipped, and a URL can never map
 * onto one of those names.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '../lib/paths.mjs';
import { writePage, listPages } from '../lib/store/pages.mjs';
import { isPagePath, scanPages } from '../lib/index/files.mjs';
import { CacheLookup } from '../lib/fetch/batch.mjs';

const { urlToRelPath } = paths;
const isDerivedFile = (rel) => paths.isDerivedFile(rel);
const isDerivedDir = (rel) => paths.isDerivedDir(rel);

const BODY = '# Page\n\nReal content about the module, long enough to be a page.\n';

test('pages under `_`/`.` URL segments are listed, indexed and found by Source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dd-derived-'));
  try {
    await writePage(root, 'https://docs.python.org/3/library/__main__.html', BODY);
    await writePage(root, 'https://docs.python.org/3/library/__future__.html', BODY);
    // Stored at its final URL; looked up later by the requested URL (Source:).
    await writePage(root, 'https://docs.python.org/3/_modules/json.html', BODY, { source: 'https://docs.python.org/3/_modules/json/old' });
    await writePage(root, 'https://example.com/.well-known/security', BODY);
    // Generated / derived files beside them.
    writeFileSync(join(root, 'catalog.md'), 'generated');
    writeFileSync(join(root, 'docs.python.org', '_outline.md'), 'generated');
    mkdirSync(join(root, '_profiles'), { recursive: true });
    writeFileSync(join(root, '_profiles', 'x.md'), 'profile');
    mkdirSync(join(root, '.cache', 'legacy'), { recursive: true });
    writeFileSync(join(root, '.cache', 'legacy', 'y.md'), 'derived');
    writeFileSync(join(root, 'docs.python.org', '3', '.index.md.tmp-dd-abc123'), 'in flight');

    const expected = [
      'docs.python.org/3/_modules/json.md',
      'docs.python.org/3/library/__future__.md',
      'docs.python.org/3/library/__main__.md',
      'example.com/.well-known/security.md',
    ];
    const listed = [];
    for await (const p of listPages(root)) listed.push(p.relPath);
    assert.deepEqual(listed.sort(), expected);
    assert.deepEqual([...scanPages(root).keys()].sort(), expected);
    for (const rel of expected) assert.equal(isPagePath(rel), true, rel);

    const hit = await new CacheLookup(root).find('https://docs.python.org/3/_modules/json/old');
    assert.equal(hit, join(root, 'docs.python.org/3/_modules/json.md'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('only the generated names are derived', () => {
  for (const rel of ['catalog.md', '.docs-cache.json', 'a.dev/_outline.md', '_profiles/a.dev.json', '.cache/index.json',
    'a.dev/x/.cache/y.md', 'a.dev/.x.md.tmp-dd-1f', '.git/HEAD']) {
    assert.equal(isDerivedFile(rel), true, rel);
  }
  for (const rel of ['a.dev/catalog.md', 'a.dev/x/_outline.md', 'a.dev/_profiles/x.md', 'a.dev/__main__.md',
    'a.dev/_modules/json.md', 'a.dev/.well-known/x.md', 'a.dev/big.parts/intro.md', 'a.dev/_index.md']) {
    assert.equal(isDerivedFile(rel), false, rel);
  }
  assert.equal(isDerivedDir('_profiles'), true);
  assert.equal(isDerivedDir('a.dev/_profiles'), false);
  assert.equal(isDerivedDir('a.dev/_modules'), false);
});

test('a malformed %-escape keeps the raw pathname instead of throwing', () => {
  assert.equal(urlToRelPath('https://h.dev/a%E0b'), 'h.dev/a%E0b.md');
  assert.equal(urlToRelPath('https://h.dev/ok%20name'), 'h.dev/ok name.md');
});

test('a URL never maps onto a generated name (escaped with a trailing `_`, one-to-one)', () => {
  assert.equal(urlToRelPath('https://docs.python.org/3/library/__main__.html'), 'docs.python.org/3/library/__main__.md');
  assert.equal(urlToRelPath('https://h.dev/_outline'), 'h.dev/_outline_.md');
  assert.equal(urlToRelPath('https://h.dev/_outline_'), 'h.dev/_outline__.md');
  assert.equal(urlToRelPath('https://h.dev/_Outline'), 'h.dev/_Outline_.md');
  assert.equal(urlToRelPath('https://h.dev/a/_outline'), 'h.dev/a/_outline.md', 'only the domain-level outline is generated');
  assert.equal(urlToRelPath('https://h.dev/big.parts/x'), 'h.dev/big.parts_/x.md', 'not big.md\'s parts directory');
  assert.equal(urlToRelPath('https://h.dev/big.parts'), 'h.dev/big.parts.md');
  assert.equal(urlToRelPath('https://h.dev/.cache/x'), 'h.dev/.cache_/x.md');
  assert.equal(urlToRelPath('https://h.dev/.git/x'), 'h.dev/.git_/x.md');
  assert.equal(urlToRelPath('https://catalog.md/x'), 'catalog.md_/x.md');
  assert.equal(urlToRelPath('https://_profiles/x'), '_profiles_/x.md');
  for (const url of ['https://h.dev/_outline', 'https://h.dev/big.parts/x', 'https://h.dev/.cache/x', 'https://catalog.md/']) {
    assert.equal(isDerivedFile(urlToRelPath(url)), false, url);
    assert.equal(isPagePath(urlToRelPath(url)), true, url);
  }
});
