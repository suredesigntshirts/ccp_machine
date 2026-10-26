#!/usr/bin/env node
/**
 * Fix poor-quality descriptions in llms.txt
 *
 * Uses the shared description library for all extraction and validation.
 *
 * Usage:
 *   node fix-descriptions.js --stats                           # Show quality stats
 *   node fix-descriptions.js --apply                           # Apply deterministic fixes
 *   node fix-descriptions.js --deduplicate                     # Remove duplicate path entries
 *   node fix-descriptions.js --export-remaining <file>         # Export unfixable entries for agent
 *   node fix-descriptions.js --import-fixes <file>             # Import agent-generated descriptions (TSV)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import {
  generateDescriptionFromFile,
  isBadDescription,
  MAX_DESCRIPTION_LENGTH,
} from './lib/descriptions.mjs';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_LLMS_FILE = 'docs/llms.txt';
const CONTENT_PREVIEW_CHARS = 300;
const ENTRY_PATTERN = /^(-\s*)([\S]+\.md):\s*(.*)$/;

// ============================================================================
// Parsing
// ============================================================================

function parseEntries(lines) {
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(ENTRY_PATTERN);
    if (!match) continue;
    const [, prefix, filePath, desc] = match;
    entries.push({ lineIndex: i, prefix, filePath, desc });
  }
  return entries;
}

// ============================================================================
// Stats
// ============================================================================

function printStats(entries) {
  const reasons = {};
  let good = 0;
  let bad = 0;

  for (const entry of entries) {
    const reason = isBadDescription(entry.desc, entry.filePath);
    if (reason) {
      bad++;
      reasons[reason] = (reasons[reason] || 0) + 1;
    } else {
      good++;
    }
  }

  const total = entries.length;
  const pct = (n) => (total === 0 ? '0.0' : (n / total * 100).toFixed(1));
  console.log(`\nDescription Quality Report`);
  console.log('─'.repeat(50));
  console.log(`  Total entries:   ${total}`);
  console.log(`  Good:            ${good} (${pct(good)}%)`);
  console.log(`  Bad:             ${bad} (${pct(bad)}%)`);

  if (Object.keys(reasons).length > 0) {
    console.log('');
    console.log('  Breakdown:');
    for (const [reason, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${reason.padEnd(20)} ${count}`);
    }
  }

  return { good, bad, reasons };
}

// ============================================================================
// Deduplication
// ============================================================================

function deduplicate(lines, entries, apply) {
  const byPath = new Map();
  for (const entry of entries) {
    if (!byPath.has(entry.filePath)) byPath.set(entry.filePath, []);
    byPath.get(entry.filePath).push(entry);
  }

  const toRemove = new Set();
  let dupeCount = 0;

  for (const [filePath, group] of byPath) {
    if (group.length <= 1) continue;
    dupeCount++;

    // Keep the entry with the best description (passes validation, or longest)
    let best = group[0];
    for (const entry of group.slice(1)) {
      const bestBad = isBadDescription(best.desc, filePath);
      const entryBad = isBadDescription(entry.desc, filePath);
      if (bestBad && !entryBad) {
        best = entry;
      } else if (bestBad === entryBad && entry.desc.length > best.desc.length) {
        best = entry;
      }
    }

    for (const entry of group) {
      if (entry !== best) {
        toRemove.add(entry.lineIndex);
        console.log(`  DUP: ${filePath}`);
        console.log(`    KEEP: ${best.desc}`);
        console.log(`    DROP: ${entry.desc}`);
      }
    }
  }

  if (toRemove.size === 0) {
    console.log('\nNo duplicates found.');
    return;
  }

  console.log(`\n${toRemove.size} duplicate entries across ${dupeCount} paths.`);

  if (apply) {
    const newLines = lines.filter((_, i) => !toRemove.has(i));
    return newLines;
  } else {
    console.log('Run with --apply to remove them.');
  }
  return null;
}

// ============================================================================
// Apply (deterministic fixes)
// ============================================================================

function applyFixes(lines, entries) {
  let fixed = 0;
  const remaining = [];

  for (const entry of entries) {
    const reason = isBadDescription(entry.desc, entry.filePath);
    if (!reason) continue;

    const newDesc = generateDescriptionFromFile(entry.filePath);
    if (newDesc && !isBadDescription(newDesc, entry.filePath)) {
      lines[entry.lineIndex] = `${entry.prefix}${entry.filePath}: ${newDesc}`;
      fixed++;
    } else {
      remaining.push(entry);
    }
  }

  console.log(`\nFixed ${fixed} entries deterministically.`);
  if (remaining.length > 0) {
    console.log(`Remaining: ${remaining.length} entries need agent-assisted generation.`);
  }

  return { fixed, remaining };
}

// ============================================================================
// Export Remaining
// ============================================================================

function exportRemaining(entries, outputFile) {
  // Find bad entries that can't be fixed locally
  const toExport = [];
  for (const entry of entries) {
    const reason = isBadDescription(entry.desc, entry.filePath);
    if (!reason) continue;
    const newDesc = generateDescriptionFromFile(entry.filePath);
    if (!newDesc || isBadDescription(newDesc, entry.filePath)) {
      toExport.push(entry);
    }
  }

  if (toExport.length === 0) {
    console.log('\nNo entries need agent-assisted generation.');
    return;
  }

  let output = `# Entries needing descriptions\n`;
  output += `# For each entry, write a search-optimized description ≤${MAX_DESCRIPTION_LENGTH} chars.\n`;
  output += `# Start with the library/service name. Include searchable keywords.\n`;
  output += `# Save results as TSV: path<TAB>description\n\n`;

  for (const entry of toExport) {
    let content = '';
    if (existsSync(entry.filePath)) {
      const raw = readFileSync(entry.filePath, 'utf-8');
      // Strip frontmatter, get heading + first paragraph only
      const stripped = raw.replace(/^---\n[\s\S]*?\n---\n*/, '');
      content = stripped.slice(0, CONTENT_PREVIEW_CHARS).trim();
    }

    const domain = entry.filePath.replace(/^docs\//, '').split('/')[0] || 'unknown';
    output += `PATH: ${entry.filePath}\n`;
    output += `DOMAIN: ${domain}\n`;
    output += `CONTENT:\n${content}\n`;
    output += `---\n`;
  }

  writeFileSync(outputFile, output);
  console.log(`\nExported ${toExport.length} entries to ${outputFile}`);
  console.log(`\nTo fix: write descriptions in TSV format (path\\tdescription), then run:`);
  console.log(`  node fix-descriptions.js --import-fixes <fixes.tsv>`);
}

// ============================================================================
// Import Fixes
// ============================================================================

function importFixes(lines, fixesFile) {
  if (!existsSync(fixesFile)) {
    console.error(`Error: fixes file not found: ${fixesFile}`);
    process.exit(1);
  }

  const fixesContent = readFileSync(fixesFile, 'utf-8');
  const fixLines = fixesContent.split('\n').filter(l => l.includes('\t'));
  let applied = 0;

  for (const fixLine of fixLines) {
    const tabIdx = fixLine.indexOf('\t');
    if (tabIdx === -1) continue;
    const fixPath = fixLine.slice(0, tabIdx).trim();
    const fixDesc = fixLine.slice(tabIdx + 1).trim();
    if (!fixPath || !fixDesc) continue;

    // Update ALL matching entries (not just first)
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(ENTRY_PATTERN);
      if (match && match[2] === fixPath) {
        lines[i] = `${match[1]}${fixPath}: ${fixDesc}`;
        applied++;
      }
    }
  }

  console.log(`\nImported ${applied} fixes from ${fixesFile}`);
  return applied;
}

// ============================================================================
// Main
// ============================================================================

const HELP = `Usage: node fix-descriptions.js [options]

Improves the one-line descriptions in an llms.txt index. With no options it is
a dry run: it reports what it would change without writing.

Options:
  --stats                     Quality report only, no changes
  --apply                     Apply deterministic fixes and deduplicate
  --deduplicate               Drop duplicate paths, keeping the best description
  --export-remaining <file>   Write entries needing a human/agent description
  --import-fixes <file>       Read back a TSV of "path<TAB>description" lines
  --llms-file <path>          Index to operate on (default: docs/llms.txt)
  --help, -h                  Show this help

Descriptions should be under 120 characters, lead with the library name, and
carry searchable keywords (API methods, config options) — not marketing copy.
`;

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }
  const apply = args.includes('--apply');
  const statsOnly = args.includes('--stats');
  const dedup = args.includes('--deduplicate');
  const valueFor = (flag) => {
    const idx = args.indexOf(flag);
    if (idx === -1) return null;
    const value = args[idx + 1];
    if (!value || value.startsWith('-')) {
      console.error(`Error: ${flag} requires a file path`);
      process.exit(1);
    }
    return value;
  };

  const exportFile = valueFor('--export-remaining');
  const importFile = valueFor('--import-fixes');
  const llmsFile = valueFor('--llms-file') || DEFAULT_LLMS_FILE;

  if (!existsSync(llmsFile)) {
    console.error(`Error: ${llmsFile} not found`);
    process.exit(1);
  }

  const content = readFileSync(llmsFile, 'utf-8');
  let lines = content.split('\n');
  const entries = parseEntries(lines);

  // Always print stats
  printStats(entries);

  if (statsOnly) {
    process.exit(0);
  }

  // Handle --import-fixes
  if (importFile) {
    importFixes(lines, importFile);
    // Also deduplicate after import
    const freshEntries = parseEntries(lines);
    const deduped = deduplicate(lines, freshEntries, true);
    if (deduped) lines = deduped;
    writeFileSync(llmsFile, lines.join('\n'));
    return;
  }

  // Handle --deduplicate
  if (dedup) {
    const deduped = deduplicate(lines, entries, apply);
    if (deduped && apply) {
      writeFileSync(llmsFile, deduped.join('\n'));
      console.log('Duplicates removed.');
    }
    return;
  }

  // Handle --apply (deterministic fixes)
  if (apply) {
    const { fixed, remaining } = applyFixes(lines, entries);

    // Also deduplicate
    const freshEntries = parseEntries(lines);
    const deduped = deduplicate(lines, freshEntries, true);
    if (deduped) lines = deduped;

    writeFileSync(llmsFile, lines.join('\n'));

    // Re-print stats after fixes
    const updatedEntries = parseEntries(lines);
    printStats(updatedEntries);
    return;
  }

  // Handle --export-remaining
  if (exportFile) {
    exportRemaining(entries, exportFile);
    return;
  }

  // Default: dry run preview
  let previewCount = 0;
  for (const entry of entries) {
    const reason = isBadDescription(entry.desc, entry.filePath);
    if (!reason) continue;

    const newDesc = generateDescriptionFromFile(entry.filePath);
    if (newDesc && !isBadDescription(newDesc, entry.filePath)) {
      if (previewCount < 10) {
        console.log(`\n  ${entry.filePath}`);
        console.log(`    OLD: ${entry.desc}`);
        console.log(`    NEW: ${newDesc}`);
      }
      previewCount++;
    }
  }

  if (previewCount > 0) {
    if (previewCount > 10) console.log(`\n  ... and ${previewCount - 10} more`);
    console.log(`\nRun with --apply to write ${previewCount} fixes to ${llmsFile}`);
  }
}

main();
