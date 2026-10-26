#!/usr/bin/env node
/**
 * doctor.js — answer "is this skill ready to run?" in one command.
 *
 * Exists so that neither a person nor an agent has to infer the state of the
 * install from a crash. Every check that fails prints the exact command that
 * fixes it. Exit code is 0 when the skill is ready, 1 when it is not.
 *
 *   node scripts/doctor.js        (or: npm run doctor)
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_ROOT, setupCommand, FETCH_PACKAGES } from './lib/deps.mjs';
import { launchBrowser, launchedWith } from './lib/browser.mjs';

const PACKAGES = FETCH_PACKAGES;
const MIN_NODE_MAJOR = 20;

const results = [];

function record(ok, label, detail, fix) {
  results.push({ ok, label, detail, fix });
}

// ---------------------------------------------------------------------------
// Node runtime
// ---------------------------------------------------------------------------
const major = Number(process.versions.node.split('.')[0]);
record(
  major >= MIN_NODE_MAJOR,
  'Node.js',
  `v${process.versions.node} (need >= ${MIN_NODE_MAJOR})`,
  `Install Node ${MIN_NODE_MAJOR} or newer — https://nodejs.org`,
);

// ---------------------------------------------------------------------------
// npm packages
// ---------------------------------------------------------------------------
const missing = [];
for (const name of PACKAGES) {
  try {
    await import(name);
  } catch {
    missing.push(name);
  }
}
record(
  missing.length === 0,
  'npm packages',
  missing.length ? `missing: ${missing.join(', ')}` : PACKAGES.join(', '),
  setupCommand(),
);

// ---------------------------------------------------------------------------
// Browser binary — the step `npm install` does not perform
// ---------------------------------------------------------------------------
if (missing.includes('playwright')) {
  record(false, 'Browser binary', 'not checked (playwright missing)', setupCommand());
} else {
  const { chromium } = await import('playwright');
  try {
    const browser = await launchBrowser(chromium);
    const version = browser.version();
    await browser.close();
    record(true, 'Browser binary', `${version} via ${launchedWith()}`, null);
  } catch (err) {
    record(
      false,
      'Browser binary',
      String(err.message).split('\n')[0],
      `cd ${JSON.stringify(SKILL_ROOT)} && npm run install-browsers`,
    );
  }
}

// ---------------------------------------------------------------------------
// Environment notes (informational — never a failure)
// ---------------------------------------------------------------------------
const notes = [];

// Search backend: node:sqlite (FTS5) from Node 22.13; otherwise the JSON fallback.
try {
  process.removeAllListeners('warning'); // node:sqlite prints an ExperimentalWarning
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
  db.close();
  notes.push('Search index: SQLite FTS5 (node:sqlite).');
} catch {
  notes.push('Search index: JSON fallback (node:sqlite needs Node >= 22.13) — works, ~0.5 s slower per search.');
}

// Optional: the Claude Code CLI, for --llm-profiles.
{
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('claude', ['--version'], { encoding: 'utf-8', timeout: 5000 });
  notes.push(r.status === 0
    ? `claude CLI ${r.stdout.trim()} — available for \`docs fetch --llm-profiles haiku\`.`
    : 'claude CLI not found — --llm-profiles unavailable (optional).');
}

// The cache in the current project.
{
  const { resolveRoot, detectLegacyRoot } = await import('./lib/config.mjs');
  const root = resolveRoot();
  const legacy = detectLegacyRoot();
  if (root.exists) notes.push(`Cache: ${root.rel}/ (schema ${root.marker?.schema ?? root.marker?.version ?? '?'}).`);
  else notes.push(`Cache: ${root.rel}/ does not exist yet — the first \`docs fetch\` creates it.`);
  if (legacy) notes.push(`A v1 cache is at ${legacy} — preview moving it with: node ${join(SKILL_ROOT, 'scripts', 'docs.mjs')} migrate`);
}
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  notes.push('Claude Code cloud session — the browser is resolved from what is installed (see lib/browser.mjs).');
}
if (!existsSync(join(SKILL_ROOT, 'package.json'))) {
  notes.push(`No package.json at ${SKILL_ROOT} — this file may have been copied out of the skill.`);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log(`\ndocumentation-downloader — ${SKILL_ROOT}\n`);
for (const { ok, label, detail } of results) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(14)} ${detail}`);
}

const failures = results.filter(r => !r.ok);
if (failures.length === 0) {
  console.log('\nReady. Fetch docs with:\n');
  console.log(`  node ${join(SKILL_ROOT, 'scripts', 'docs.mjs')} fetch <url>\n`);
} else {
  console.log('\nNot ready. Fix in this order:\n');
  const seen = new Set();
  for (const { fix } of failures) {
    if (!fix || seen.has(fix)) continue;
    seen.add(fix);
    console.log(`  ${fix}`);
  }
  console.log('');
}

for (const note of notes) console.log(`  note: ${note}`);
if (notes.length) console.log('');

process.exit(failures.length === 0 ? 0 : 1);
