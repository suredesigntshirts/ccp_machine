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
import { SKILL_ROOT, setupCommand } from './lib/deps.mjs';

const PACKAGES = ['playwright', 'turndown', 'turndown-plugin-gfm'];
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
  const isCloud = process.env.CLAUDE_CODE_REMOTE === 'true';
  try {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      ...(isCloud ? { channel: 'chrome' } : {}),
    });
    const version = browser.version();
    await browser.close();
    record(true, 'Browser binary', `${isCloud ? 'system Chrome' : 'chromium'} ${version}`, null);
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
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  notes.push('Claude Code cloud session — browser launches use system Chrome + a TLS 1.2 pin.');
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
  console.log(`  node ${join(SKILL_ROOT, 'scripts', 'fetch-docs.js')} <url> --output-dir docs/ --update-index\n`);
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
