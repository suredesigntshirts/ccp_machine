#!/usr/bin/env node
/**
 * Search Cached Documentation
 *
 * Query what documentation is cached locally and search within it.
 * Designed for token-efficient output when used by Claude.
 *
 * Usage:
 *   node search-docs.js --list                     List all cached docs
 *   node search-docs.js "query"                    Search by keyword in names/descriptions
 *   node search-docs.js --content "query"          Search within doc content
 *   node search-docs.js --stale 30                 Show docs older than N days
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, relative, sep } from 'path';
import { generateDescriptionFromFile } from './lib/descriptions.mjs';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_DOCS_DIR = 'docs';
const DEFAULT_LLMS_FILE = 'docs/llms.txt';
const MAX_CONTENT_MATCHES_PER_FILE = 5;
const MAX_TOTAL_CONTENT_MATCHES = 30;

// ============================================================================
// Argument Parsing
// ============================================================================

function parseArgs(args) {
  const result = {
    list: false,
    query: null,
    content: null,
    stale: null,
    docsDir: DEFAULT_DOCS_DIR,
    llmsFile: DEFAULT_LLMS_FILE,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list' || args[i] === '-l') {
      result.list = true;
    } else if (args[i] === '--content') {
      result.content = args[++i];
    } else if (args[i] === '--stale') {
      const val = parseInt(args[++i], 10);
      result.stale = Number.isFinite(val) ? val : 30; // `--stale 0` means 0, not 30
    } else if (args[i] === '--docs-dir') {
      result.docsDir = args[++i];
    } else if (args[i] === '--llms-file') {
      result.llmsFile = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      showHelp();
      process.exit(0);
    } else if (!args[i].startsWith('-')) {
      result.query = args[i];
    }
  }

  return result;
}

function showHelp() {
  console.log('Usage: node search-docs.js [options] [query]');
  console.log('');
  console.log('Commands:');
  console.log('  --list, -l              List all cached docs with descriptions');
  console.log('  <query>                 Search file names and descriptions by keyword');
  console.log('  --content <query>       Search within doc content (grep-like)');
  console.log('  --stale <days>          Show docs older than N days (default: 30)');
  console.log('');
  console.log('Options:');
  console.log('  --docs-dir <path>       Docs directory (default: docs)');
  console.log('  --llms-file <path>      Index file (default: docs/llms.txt)');
  console.log('  --help, -h              Show this help');
}

// ============================================================================
// Index Parsing
// ============================================================================

function parseLlmsFile(llmsFile) {
  if (!existsSync(llmsFile)) return [];

  const content = readFileSync(llmsFile, 'utf-8');
  const entries = [];
  // The path prefix is whatever --output-dir produced, not necessarily `docs/`.
  const entryPattern = /^-?\s*(\S+\.md):\s*(.*)$/;

  for (const line of content.split('\n')) {
    const match = line.match(entryPattern);
    if (match) {
      entries.push({ path: match[1].trim(), description: match[2].trim() });
    }
  }

  return entries;
}

// ============================================================================
// File System Helpers
// ============================================================================

function findAllDocs(docsDir) {
  const files = [];

  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.md') && entry.name !== 'llms.txt') {
        files.push(fullPath);
      }
    }
  }

  walk(docsDir);
  return files;
}

/** Path as llms.txt records it: the docs dir the caller passed, forward slashes. */
function toIndexPath(docsDir, file) {
  return join(docsDir, relative(docsDir, file)).split(sep).join('/');
}

/**
 * Entries to search over: the index, plus anything on disk the index omits.
 *
 * This is the skill's "what's already cached?" step. Answering it purely from
 * llms.txt means any index drift is reported as "nothing cached" — which sends
 * the caller off to re-fetch documentation that is sitting right there.
 */
function loadEntries(llmsFile, docsDir) {
  const indexed = parseLlmsFile(llmsFile);
  const onDisk = findAllDocs(docsDir);
  const known = new Set(indexed.map(e => e.path));

  const unlisted = onDisk.filter(file => !known.has(toIndexPath(docsDir, file)));
  if (unlisted.length === 0) return indexed;

  console.error(`Note: ${unlisted.length} cached doc(s) not listed in ${llmsFile} — including them from disk.`);
  console.error(`      Run compare-docs.js to resync the index.`);

  return indexed.concat(unlisted.map(file => ({
    path: toIndexPath(docsDir, file),
    description: generateDescriptionFromFile(file) || '(not indexed)',
  })));
}

function extractFrontMatter(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};

    const fm = {};
    for (const line of match[1].split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim().toLowerCase();
        const value = line.slice(colonIdx + 1).trim();
        fm[key] = value;
      }
    }
    return fm;
  } catch {
    return {};
  }
}

// ============================================================================
// Commands
// ============================================================================

function listDocs(entries) {
  if (entries.length === 0) {
    console.log('No cached docs found.');
    return;
  }

  console.log(`Cached docs (${entries.length}):`);
  for (const entry of entries) {
    console.log(`  ${entry.path} — ${entry.description}`);
  }
}

function searchDocs(entries, query) {
  const q = query.toLowerCase();
  const matches = entries.filter(e =>
    e.path.toLowerCase().includes(q) ||
    e.description.toLowerCase().includes(q)
  );

  if (matches.length === 0) {
    console.log(`No docs matching "${query}".`);
    return;
  }

  console.log(`Matching docs (${matches.length}):`);
  for (const entry of matches) {
    console.log(`  ${entry.path} — ${entry.description}`);
  }
}

function searchContent(docsDir, query) {
  const files = findAllDocs(docsDir);
  const q = query.toLowerCase();
  let totalMatches = 0;

  for (const file of files) {
    if (totalMatches >= MAX_TOTAL_CONTENT_MATCHES) {
      console.log(`\n(Stopped at ${MAX_TOTAL_CONTENT_MATCHES} matches. Refine your query for more specific results.)`);
      break;
    }

    try {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      const matches = [];

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          matches.push({ line: i + 1, text: lines[i].trim().slice(0, 120) });
        }
      }

      if (matches.length > 0) {
        const relPath = toIndexPath(docsDir, file);
        const showCount = Math.min(matches.length, MAX_CONTENT_MATCHES_PER_FILE, MAX_TOTAL_CONTENT_MATCHES - totalMatches);

        for (let i = 0; i < showCount; i++) {
          const m = matches[i];
          console.log(`${relPath}:${m.line}: ${m.text}`);
          totalMatches++;
        }
        if (matches.length > showCount) {
          console.log(`  ... +${matches.length - showCount} more in this file`);
        }
      }
    } catch { /* skip unreadable files */ }
  }

  if (totalMatches === 0) {
    console.log(`No content matching "${query}".`);
  }
}

function findStaleDocs(docsDir, maxDays) {
  const files = findAllDocs(docsDir);
  const now = new Date();
  const stale = [];

  for (const file of files) {
    const fm = extractFrontMatter(file);
    const updated = fm.updated || fm.generated;
    if (!updated) continue;

    const date = new Date(updated);
    if (isNaN(date.getTime())) continue;

    const ageDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
    if (ageDays > maxDays) {
      stale.push({ path: toIndexPath(docsDir, file), updated, ageDays, source: fm.source });
    }
  }

  stale.sort((a, b) => b.ageDays - a.ageDays);

  if (stale.length === 0) {
    console.log(`No docs older than ${maxDays} days.`);
    return;
  }

  console.log(`Stale docs (older than ${maxDays} days):`);
  for (const doc of stale) {
    console.log(`  ${doc.path} — Updated: ${doc.updated} (${doc.ageDays}d ago)${doc.source ? ` [${doc.source}]` : ''}`);
  }
}

// ============================================================================
// Main
// ============================================================================

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.list && !args.query && !args.content && args.stale === null) {
    showHelp();
    process.exit(1);
  }

  if (args.stale !== null) {
    findStaleDocs(args.docsDir, args.stale);
    return;
  }

  if (args.content) {
    searchContent(args.docsDir, args.content);
    return;
  }

  const entries = loadEntries(args.llmsFile, args.docsDir);

  if (args.list) {
    listDocs(entries);
  } else if (args.query) {
    searchDocs(entries, args.query);
  }
}

main();
