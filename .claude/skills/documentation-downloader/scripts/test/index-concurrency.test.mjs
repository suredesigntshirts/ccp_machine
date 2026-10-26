/**
 * Many agents run `docs search` / `docs reindex` against one cache at once. This
 * spawns reindexers (incremental and --full), searchers, a writer that adds and
 * edits pages mid-run, and a reader that keeps reading catalog.md, all in
 * parallel, then checks that:
 *   - every process exits 0 with nothing on stderr (no SQLITE_BUSY, no lock errors);
 *   - every search printed well-formed results;
 *   - no reader ever saw a partial catalog.md;
 *   - afterwards the index matches the pages on disk exactly, the lock is released
 *     and no temp files are left behind.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openIndex, refreshIndex } from '../lib/index/index.mjs';
import { scanPages } from '../lib/index/files.mjs';
import { loadSqlite } from '../lib/index/sqlite.mjs';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs.mjs');
const BACKENDS = (await loadSqlite()) ? ['sqlite', 'json'] : ['json'];
const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa'.split(' ');

function page(i) {
  const w = k => WORDS[(i * 7 + k) % WORDS.length];
  const sections = Array.from({ length: 6 }, (_, s) =>
    `## Section ${s} ${w(s)}\n\n${Array.from({ length: 12 }, (_, l) => `Line ${l} about ${w(s + l)} and ${w(l)} with \`fn${i}_${s}()\`.`).join('\n')}\n`);
  return `---\nSource: https://d${i % 3}.example/p${i}\n---\n\n# Page ${i} ${w(0)}\n\n${sections.join('\n')}`;
}

function makeRoot(n) {
  const root = mkdtempSync(join(tmpdir(), 'dd-conc-test-'));
  for (let i = 0; i < n; i++) {
    const rel = `d${i % 3}.example/p${i}.md`;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), page(i));
  }
  return root;
}

function run(args, env) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, args, { env: { ...process.env, ...env } });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ args, code, out, err }));
  });
}

// Adds pages and edits one while everything else runs; the search that follows
// must see the edit (freshness check before every search).
const WRITER = `
const { writeFileSync, readFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const root = process.argv[1];
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < 6; i++) {
    mkdirSync(join(root, 'new.example'), { recursive: true });
    writeFileSync(join(root, 'new.example', 'n' + i + '.md'), '# New ' + i + '\\n\\nZanzibar item ' + i + '.\\n');
    await sleep(15);
  }
  const f = join(root, 'd0.example', 'p0.md');
  writeFileSync(f, readFileSync(f, 'utf-8') + '\\n## Quetzal\\n\\nQuetzal appendix.\\n');
})();
`;

// Reads catalog.md in a loop; any read that is not a complete file is an error.
const READER = `
const { readFileSync } = require('node:fs');
const file = require('node:path').join(process.argv[1], 'catalog.md');
const end = Date.now() + 1500;
let reads = 0;
while (Date.now() < end) {
  let t;
  try { t = readFileSync(file, 'utf-8'); } catch { continue; }
  reads++;
  if (!t.startsWith('# Documentation cache') || !t.endsWith('\\n')) { console.error('partial catalog.md'); process.exit(1); }
}
console.log(reads);
`;

for (const backend of BACKENDS) {
  test(`[${backend}] concurrent reindex/search/writes stay consistent`, { timeout: 120000 }, async () => {
    const root = makeRoot(45);
    const env = { DD_INDEX_BACKEND: backend };
    try {
      // Seed the catalog so the reader has something to read from the start.
      await refreshIndex(root, { backend, generate: 'all' });
      const jobs = [
        run([DOCS, 'reindex', '--root', root], env),
        run([DOCS, 'reindex', '--full', '--root', root], env),
        run([DOCS, 'reindex', '--root', root], env),
        run(['-e', READER, root], env),
        run(['-e', WRITER, root], env),
      ];
      for (const q of ['alpha bravo', 'fn3_2', 'zanzibar', 'section golf', 'kilo lima mike', 'papa']) {
        jobs.push(run([DOCS, 'search', q, '--root', root], env));
      }
      jobs.push(run([DOCS, 'reindex', '--full', '--root', root], env));
      const results = await Promise.all(jobs);

      for (const r of results) {
        assert.equal(r.code, 0, `${r.args.slice(1).join(' ')} failed: ${r.err}`);
        assert.equal(r.err, '', `${r.args.slice(1).join(' ')} wrote to stderr: ${r.err}`);
      }
      for (const r of results.filter(x => x.args[1] === 'search')) {
        for (const line of r.out.trim().split('\n')) {
          assert.match(line, /^(\/\S+\.md — .+| {2}\d+-\d+ \(\d+ lines(, ~\d+k tok)?\)( .+)?|No sections match .+|\(\d+ more; raise --budget\))$/, line);
        }
      }

      // After the dust settles: the index is exactly the pages on disk.
      const after = await run([DOCS, 'search', 'quetzal appendix', '--root', root], env);
      assert.match(after.out, /d0\.example\/p0\.md/, 'the mid-run edit is searchable');
      const idx = await openIndex(root, { backend });
      try {
        const indexed = idx.fileStates();
        const disk = scanPages(root);
        assert.deepEqual([...indexed.keys()].sort(), [...disk.keys()].sort());
        for (const [p, st] of disk) assert.equal(indexed.get(p).size, st.size, p);
      } finally {
        idx.close();
      }
      assert.ok(!existsSync(join(root, '.cache', 'locks', 'index.lock')), 'lock released');
      const leftovers = [];
      const walk = d => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(join(d, e.name));
          else if (e.name.endsWith('.tmp')) leftovers.push(join(d, e.name));
        }
      };
      walk(root);
      assert.deepEqual(leftovers, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
