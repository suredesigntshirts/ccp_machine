/**
 * Integration tests: the v1 CLI tools against a docs tree that is NOT called
 * `docs/`. (The v1 llms.txt writer that used to be tested here is gone: v2
 * pages are indexed by the search index, not appended to llms.txt.)
 *
 * No network access — nothing here fetches.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';

const SCRIPTS_DIR = new URL('..', import.meta.url).pathname;

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'docdl-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function doc(title) {
  return `---\nSource: https://x/y\ndescription: ${title} reference for the API surface\n---\n\n# ${title}\n\nBody.\n`;
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
// CLI tools with a non-default docs directory
// ============================================================================

function seedDocs(root, docsDir) {
  const file = join(root, docsDir, 'a.com', 'guide.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, doc('Guide'));
  return file;
}

test('search-docs (v1 wrapper) lists pages straight from disk, even in a v1 docs/ cache', async () => {
  // Step 1 of the skill's workflow is "check what's cached"; an index that lags
  // the files must never make the cache look empty.
  const ws = workspace();
  try {
    seedDocs(ws.dir, 'docs');
    writeFileSync(join(ws.dir, 'docs', 'llms.txt'), '');

    const res = await runScript('search-docs.js', ['--list'], ws.dir);

    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /a\.com\/guide\.md/);
    assert.match(res.stderr, /v1 cache/);
  } finally { ws.cleanup(); }
});

test('search-docs --content (v1 wrapper) returns ranked line ranges from the index', async () => {
  const ws = workspace();
  try {
    seedDocs(ws.dir, 'docs');
    const res = await runScript('search-docs.js', ['--content', 'Body'], ws.dir);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /a\.com\/guide\.md/);
    assert.match(res.stdout, /\d+-\d+ \(\d+ lines?\)/);
  } finally { ws.cleanup(); }
});
