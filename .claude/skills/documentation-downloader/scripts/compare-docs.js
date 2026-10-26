#!/usr/bin/env node
/**
 * Compare llms.txt against the docs/ folder
 *
 * Reports:
 * - Files listed in llms.txt that don't exist in docs/ folder
 * - Files in docs/ folder that aren't listed in llms.txt
 *
 * Usage:
 *   node compare-docs.js [--docs-dir <path>] [--llms-file <path>]
 *
 * Examples:
 *   node compare-docs.js
 *   node compare-docs.js --docs-dir ./docs --llms-file ./docs/llms.txt
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'fs';
import { join, relative, sep } from 'path';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_DOCS_DIR = 'docs';
const DEFAULT_LLMS_FILE = 'docs/llms.txt';

// Files to ignore in the docs folder
const IGNORE_FILES = new Set([
  'llms.txt',
  '.DS_Store',
]);

// ============================================================================
// Argument Parsing
// ============================================================================

function parseArgs(args) {
  const result = {
    docsDir: DEFAULT_DOCS_DIR,
    llmsFile: DEFAULT_LLMS_FILE,
    fixPaths: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--docs-dir' || args[i] === '-d') {
      result.docsDir = args[++i];
    } else if (args[i] === '--llms-file' || args[i] === '-l') {
      result.llmsFile = args[++i];
    } else if (args[i] === '--fix-paths') {
      result.fixPaths = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node compare-docs.js [options]');
      console.log('');
      console.log('Options:');
      console.log('  --docs-dir, -d <path>   Directory containing docs (default: docs)');
      console.log('  --llms-file, -l <path>  Path to llms.txt (default: docs/llms.txt)');
      console.log('  --fix-paths             Normalize double-slash paths in llms.txt');
      console.log('  --help, -h              Show this help message');
      process.exit(0);
    }
  }

  return result;
}

// ============================================================================
// File System Helpers
// ============================================================================

/**
 * Recursively find all .md files in a directory
 * @param {string} dir - Directory to search
 * @param {string} baseDir - Base directory for relative paths
 * @returns {string[]} Array of relative file paths
 */
function findMarkdownFiles(dir, baseDir = dir) {
  const files = [];

  if (!existsSync(dir)) {
    return files;
  }

  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...findMarkdownFiles(fullPath, baseDir));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      if (!IGNORE_FILES.has(entry.name)) {
        // Prefix with the docs dir the caller actually passed. Hardcoding 'docs/'
        // here made --docs-dir <anything-else> report every file as unlisted,
        // because llms.txt records the real output path.
        files.push(join(baseDir, relative(baseDir, fullPath)).split(sep).join('/'));
      }
    }
  }

  return files;
}

/**
 * Parse llms.txt and extract file paths
 * @param {string} llmsFile - Path to llms.txt
 * @returns {Map<string, string>} Map of file path -> description
 */
function parseLlmsFile(llmsFile) {
  const entries = new Map();

  if (!existsSync(llmsFile)) {
    return entries;
  }

  const content = readFileSync(llmsFile, 'utf-8');
  const lines = content.split('\n');

  // Match lines like: - docs/domain.com/path.md: Description
  // Also handle variations without the leading dash. The path prefix is not
  // assumed to be `docs/` — it is whatever --output-dir produced.
  const entryPattern = /^-?\s*(\S+\.md):\s*(.*)$/;

  for (const line of lines) {
    const match = line.match(entryPattern);
    if (match) {
      const [, filePath, description] = match;
      entries.set(filePath.trim(), description.trim());
    }
  }

  return entries;
}

// ============================================================================
// Main
// ============================================================================

function main() {
  const args = parseArgs(process.argv.slice(2));

  // Check if llms.txt exists
  if (!existsSync(args.llmsFile)) {
    console.error(`Error: llms.txt not found at ${args.llmsFile}`);
    process.exit(1);
  }

  // Check if docs directory exists
  if (!existsSync(args.docsDir)) {
    console.error(`Error: docs directory not found at ${args.docsDir}`);
    process.exit(1);
  }

  // Handle --fix-paths: normalize double-slash paths
  if (args.fixPaths) {
    const raw = readFileSync(args.llmsFile, 'utf-8');
    const fixed = raw.replace(/docs\/\/+/g, 'docs/');
    if (fixed !== raw) {
      const count = (raw.match(/docs\/\/+/g) || []).length;
      writeFileSync(args.llmsFile, fixed);
      console.log(`Fixed ${count} double-slash paths in ${args.llmsFile}`);
    } else {
      console.log('No double-slash paths found.');
    }
    if (args.fixPaths) return; // exit after fix-paths unless combined with comparison
  }

  // Parse llms.txt
  const llmsEntries = parseLlmsFile(args.llmsFile);
  const llmsFiles = new Set(llmsEntries.keys());

  // Find all .md files in docs/
  const docsFiles = new Set(findMarkdownFiles(args.docsDir));

  // Find differences
  const inLlmsNotInDocs = [...llmsFiles].filter(f => !docsFiles.has(f)).sort();
  const inDocsNotInLlms = [...docsFiles].filter(f => !llmsFiles.has(f)).sort();

  // Report results
  let hasIssues = false;

  if (inLlmsNotInDocs.length > 0) {
    hasIssues = true;
    console.log('Files in llms.txt that do NOT exist in docs/ folder:');
    console.log('─'.repeat(60));
    for (const file of inLlmsNotInDocs) {
      console.log(`  ✗ ${file}`);
    }
    console.log('');
  }

  if (inDocsNotInLlms.length > 0) {
    hasIssues = true;
    console.log('Files in docs/ folder that are NOT in llms.txt:');
    console.log('─'.repeat(60));
    for (const file of inDocsNotInLlms) {
      console.log(`  ✗ ${file}`);
    }
    console.log('');
  }

  // Summary
  console.log('Summary:');
  console.log('─'.repeat(60));
  console.log(`  llms.txt entries:  ${llmsFiles.size}`);
  console.log(`  docs/ files:       ${docsFiles.size}`);
  console.log(`  Missing files:     ${inLlmsNotInDocs.length}`);
  console.log(`  Unlisted files:    ${inDocsNotInLlms.length}`);

  if (!hasIssues) {
    console.log('\n✓ llms.txt is in sync with docs/ folder');
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main();
