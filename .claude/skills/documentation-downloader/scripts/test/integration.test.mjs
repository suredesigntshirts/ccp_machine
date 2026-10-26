/**
 * Integration tests: the llms.txt writer against a real filesystem, and the CLI
 * tools against a docs tree that is NOT called `docs/`.
 *
 * No network access — nothing here fetches.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';

import { updateLlmsIndex } from '../fetch-docs.js';

const MODULE_URL = new URL('../fetch-docs.js', import.meta.url).href;
const SCRIPTS_DIR = new URL('..', import.meta.url).pathname;

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'docdl-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function doc(title) {
  return `---\nSource: https://x/y\ndescription: ${title} reference for the API surface\n---\n\n# ${title}\n\nBody.\n`;
}

function entry(dir, host, path, title) {
  return { url: `https://${host}${path}`, outputPath: `${dir}/${host}${path}.md`, markdown: doc(title) };
}

/** Run a snippet of ESM in a fresh node process. */
function runNode(code) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
    child.on('exit', (codeOut) => resolve(codeOut));
  });
}

/** Run one of the skill's CLI scripts inside `cwd`. */
function runScript(script, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(SCRIPTS_DIR, script), ...args], { cwd });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

// ============================================================================
// Index writing
// ============================================================================

test('updateLlmsIndex creates the index and groups by domain', () => {
  const ws = workspace();
  try {
    const docs = join(ws.dir, 'docs');
    updateLlmsIndex([
      entry(docs, 'a.com', '/one', 'One'),
      entry(docs, 'a.com', '/two', 'Two'),
      entry(docs, 'b.com', '/three', 'Three'),
    ], docs);

    const index = readFileSync(join(docs, 'llms.txt'), 'utf-8');
    assert.equal(index.match(/^## a\.com$/gm).length, 1);
    assert.equal(index.match(/^## b\.com$/gm).length, 1);
    assert.equal(index.match(/^- /gm).length, 3);
  } finally { ws.cleanup(); }
});

test('updateLlmsIndex is idempotent — a re-run adds nothing', () => {
  const ws = workspace();
  try {
    const docs = join(ws.dir, 'docs');
    const batch = [entry(docs, 'a.com', '/one', 'One')];
    updateLlmsIndex(batch, docs);
    const first = readFileSync(join(docs, 'llms.txt'), 'utf-8');
    updateLlmsIndex(batch, docs);
    assert.equal(readFileSync(join(docs, 'llms.txt'), 'utf-8'), first);
  } finally { ws.cleanup(); }
});

test('updateLlmsIndex does not treat a path prefix as already indexed', () => {
  // `existing.includes(outputPath)` made `.../api.md` suppress nothing, but any
  // path that is a substring of an indexed one was silently dropped.
  const ws = workspace();
  try {
    const docs = join(ws.dir, 'docs');
    updateLlmsIndex([entry(docs, 'a.com', '/guide/api-reference', 'API Reference')], docs);
    updateLlmsIndex([entry(docs, 'a.com', '/guide/api', 'API')], docs);

    const index = readFileSync(join(docs, 'llms.txt'), 'utf-8');
    assert.match(index, /guide\/api\.md:/);
    assert.match(index, /guide\/api-reference\.md:/);
  } finally { ws.cleanup(); }
});

test('updateLlmsIndex dedupes repeats inside a single batch', () => {
  const ws = workspace();
  try {
    const docs = join(ws.dir, 'docs');
    const one = entry(docs, 'a.com', '/one', 'One');
    updateLlmsIndex([one, one], docs);
    assert.equal(readFileSync(join(docs, 'llms.txt'), 'utf-8').match(/^- /gm).length, 1);
  } finally { ws.cleanup(); }
});

test('updateLlmsIndex files a new entry under its existing domain section', () => {
  const ws = workspace();
  try {
    const docs = join(ws.dir, 'docs');
    updateLlmsIndex([entry(docs, 'a.com', '/one', 'One')], docs);
    updateLlmsIndex([entry(docs, 'b.com', '/two', 'Two')], docs);
    updateLlmsIndex([entry(docs, 'a.com', '/three', 'Three')], docs);

    const lines = readFileSync(join(docs, 'llms.txt'), 'utf-8').split('\n');
    const aHeading = lines.findIndex(l => l === '## a.com');
    const bHeading = lines.findIndex(l => l === '## b.com');
    const three = lines.findIndex(l => l.includes('/three.md'));

    assert.ok(aHeading !== -1 && bHeading !== -1);
    assert.ok(three > aHeading && three < bHeading,
      'entry was appended at the end instead of inside its own section');
  } finally { ws.cleanup(); }
});

test('updateLlmsIndex survives two processes writing at once', async () => {
  // Parallel agents fetching different libraries into one docs/ tree used to
  // read-then-append over each other, losing entries and duplicating headers.
  const ws = workspace();
  try {
    const docs = join(ws.dir, 'docs');
    const snippet = (path, title) => `
      const m = await import(${JSON.stringify(MODULE_URL)});
      m.updateLlmsIndex(${JSON.stringify([entry(docs, 'a.com', path, title)])}, ${JSON.stringify(docs)});
    `;

    const codes = await Promise.all([
      runNode(snippet('/alpha', 'Alpha')),
      runNode(snippet('/beta', 'Beta')),
      runNode(snippet('/gamma', 'Gamma')),
    ]);
    assert.deepEqual(codes, [0, 0, 0]);

    const index = readFileSync(join(docs, 'llms.txt'), 'utf-8');
    assert.equal(index.match(/^## a\.com$/gm).length, 1, 'duplicate domain header');
    assert.equal(index.match(/^- /gm).length, 3, 'an entry was lost to the race');
    for (const name of ['alpha', 'beta', 'gamma']) {
      assert.match(index, new RegExp(`/${name}\\.md:`));
    }
  } finally { ws.cleanup(); }
});

// ============================================================================
// CLI tools with a non-default docs directory
// ============================================================================

function seedDocs(root, docsDir) {
  const file = join(root, docsDir, 'a.com', 'guide.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, doc('Guide'));
  return file;
}

test('compare-docs reports in sync for a nested --docs-dir', async () => {
  // The docs/ prefix used to be hardcoded, so any other output dir reported
  // every file as unlisted and every entry as missing.
  const ws = workspace();
  try {
    const docsDir = join('cache', 'docs');
    seedDocs(ws.dir, docsDir);
    writeFileSync(join(ws.dir, docsDir, 'llms.txt'),
      `## a.com\n\n- ${docsDir}/a.com/guide.md: Guide reference\n`);

    const res = await runScript('compare-docs.js',
      ['--docs-dir', docsDir, '--llms-file', join(docsDir, 'llms.txt')], ws.dir);

    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /in sync/);
  } finally { ws.cleanup(); }
});

test('compare-docs still detects a genuinely unlisted file', async () => {
  const ws = workspace();
  try {
    const docsDir = join('cache', 'docs');
    seedDocs(ws.dir, docsDir);
    writeFileSync(join(ws.dir, docsDir, 'llms.txt'), `## a.com\n\n`);

    const res = await runScript('compare-docs.js',
      ['--docs-dir', docsDir, '--llms-file', join(docsDir, 'llms.txt')], ws.dir);

    assert.equal(res.code, 1);
    assert.match(res.stdout, /guide\.md/);
  } finally { ws.cleanup(); }
});

test('search-docs finds a cached doc that the index has not caught up with', async () => {
  // Step 1 of the skill's workflow is "check what's cached". Answering only from
  // llms.txt made index drift look like an empty cache and triggered a re-fetch.
  const ws = workspace();
  try {
    seedDocs(ws.dir, 'docs');
    writeFileSync(join(ws.dir, 'docs', 'llms.txt'), '');

    const res = await runScript('search-docs.js', ['--list'], ws.dir);

    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /a\.com\/guide\.md/);
    assert.match(res.stderr, /not listed/);
  } finally { ws.cleanup(); }
});

test('search-docs --content greps the cached body', async () => {
  const ws = workspace();
  try {
    seedDocs(ws.dir, 'docs');
    const res = await runScript('search-docs.js', ['--content', 'Body'], ws.dir);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /docs\/a\.com\/guide\.md:\d+:/);
  } finally { ws.cleanup(); }
});
