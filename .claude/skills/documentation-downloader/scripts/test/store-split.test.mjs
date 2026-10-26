import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitPageIfLarge, partsDirFor, isSplitIndex } from '../lib/store/split.mjs';
import { parseFrontMatter } from '../lib/store/frontmatter.mjs';

const section = (n, words) => `## Section ${n}\n\n${'word '.repeat(words).trim()}\n\n`;
const page = (sections, words) =>
  `---\nSource: https://x.example/big\nGenerated: 2026-01-01\nUpdated: 2026-01-02\n---\n\n# Big page\n\n${Array.from({ length: sections }, (_, i) => section(i + 1, words)).join('')}`;

test('a large page becomes an index at its own path plus verbatim parts in <page>.parts/', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-split-'));
  try {
    const p = join(dir, 'big.md');
    const original = page(12, 3000);
    writeFileSync(p, original);
    const r = await splitPageIfLarge(p, { url: 'https://x.example/big', maxTokens: 5000 });
    assert.equal(r.split, true);
    const partsDir = partsDirFor(p);
    const parts = readdirSync(partsDir).sort();
    assert.ok(parts.length >= 2);
    const index = readFileSync(p, 'utf-8');
    const { data } = parseFrontMatter(index);
    assert.equal(data.Source, 'https://x.example/big');
    assert.equal(String(data.Generated), '2026-01-01');
    assert.match(index, /\]\(big\.parts\//, 'index links point into big.parts/');
    // Verbatim: part bodies in order reproduce the original body.
    const ordered = r.written.slice(1).map(f => parseFrontMatter(readFileSync(f, 'utf-8')).body);
    assert.equal(ordered.join(''), parseFrontMatter(original).body);

    // Page shrinks on refresh → back to one file, parts removed.
    writeFileSync(p, page(2, 50));
    const r2 = await splitPageIfLarge(p, { url: 'https://x.example/big', maxTokens: 5000 });
    assert.equal(r2.split, false);
    assert.equal(existsSync(partsDir), false);
    assert.equal(r2.removed.length, parts.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing index is never treated as page content (its parts are never deleted)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-split-'));
  try {
    const p = join(dir, 'big.md');
    writeFileSync(p, page(12, 3000));
    const r = await splitPageIfLarge(p, { url: 'https://x.example/big', maxTokens: 5000 });
    assert.equal(r.split, true);
    const index = readFileSync(p, 'utf-8');
    const parts = readdirSync(partsDirFor(p)).sort();
    // A second split of the same file (a racing writer, a re-run) reads the index.
    const again = await splitPageIfLarge(p, { url: 'https://x.example/big', maxTokens: 5000 });
    assert.equal(again.split, false);
    assert.equal(again.alreadySplit, true);
    assert.deepEqual(again.removed, []);
    assert.equal(readFileSync(p, 'utf-8'), index);
    assert.deepEqual(readdirSync(partsDirFor(p)).sort(), parts);
    assert.equal(isSplitIndex(index, p), true);
    assert.equal(isSplitIndex(page(2, 50), p), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
