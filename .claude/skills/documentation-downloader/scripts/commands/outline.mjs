/**
 * `docs outline <file-or-url>` — a page's headings with line ranges: its table of
 * contents, so a reader can pick the lines to Read instead of reading the page.
 *
 *   code.claude.com/docs/en/hooks.md — Hooks reference (3179 lines)
 *   11-3179 # Hooks reference (3169)
 *     21-168 ## Hook lifecycle (148)
 *       74-168 ### How a hook resolves (95)
 *
 * Each range is the heading's whole section (subsections included). Output is
 * bounded: when a page has more headings than --max, deeper levels are dropped
 * first, then the list is truncated.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, join, sep, isAbsolute } from 'node:path';
import { runCommand, rootFromArgs, displayPrefix, UsageError } from '../lib/index/cli.mjs';
import { parseDocument, outlineOf } from '../lib/index/markdown.mjs';
import { lookupUrl } from '../lib/index/lookup.mjs';
import { openIndex } from '../lib/index/index.mjs';

export const summary = 'Headings of a cached page with line ranges (its table of contents)';

const USAGE = `Usage: docs outline <file-or-url> [options]

Prints a page's headings with line ranges and line counts.

Options:
  --depth <n>   only headings of level ≤ n
  --max <n>     max headings shown (default 120; deeper levels are dropped first)
  --json        structured output
  --root <dir>  cache root (default: $DD_DOCS_ROOT or external-docs/)`;

/** Resolve a file argument or URL to an absolute file path. */
async function resolveTarget(root, target) {
  if (/^https?:\/\//i.test(target)) {
    let idx = null;
    try { idx = await openIndex(root.abs); } catch { /* lookup by path only */ }
    try {
      const hit = lookupUrl(root.abs, target, idx);
      if (!hit.cached) throw new UsageError(`Not cached: ${target} (expected at ${displayPrefix(root)}${hit.expected})`);
      return join(root.abs, hit.path);
    } finally { idx?.close(); }
  }
  for (const cand of [isAbsolute(target) ? target : resolve(target), join(root.abs, target)]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  throw new UsageError(`No such file: ${target}`);
}

export function renderOutline(doc, { depth = 6, max = 120 } = {}) {
  let items = outlineOf(doc).filter(h => h.level <= depth);
  let hidden = 0;
  // Drop the deepest levels until the list fits.
  let level = Math.max(0, ...items.map(h => h.level));
  while (items.length > max && level > 1) {
    const kept = items.filter(h => h.level < level);
    if (!kept.length) break;
    hidden += items.length - kept.length;
    items = kept;
    level--;
  }
  let truncated = 0;
  if (items.length > max) { truncated = items.length - max; items = items.slice(0, max); }
  const minLevel = Math.min(...items.map(h => h.level));
  return { items: items.map(h => ({ ...h, indent: h.level - minLevel })), hidden, truncated, maxLevel: level };
}

export async function run(argv) {
  return runCommand(argv, { depth: 'number', max: 'number', json: 'boolean' }, USAGE, async (args) => {
    const target = args._[0];
    if (!target) throw new UsageError(USAGE);
    const root = rootFromArgs(args);
    const file = await resolveTarget(root, target);
    const doc = parseDocument(readFileSync(file, 'utf-8'));
    const out = renderOutline(doc, { depth: args.depth ?? 6, max: args.max ?? 120 });
    let shown = relative(root.abs, file).split(sep).join('/');
    shown = shown.startsWith('..') ? relative(process.cwd(), file) : displayPrefix(root) + shown;
    if (args.json) {
      console.log(JSON.stringify({
        file: shown, title: doc.title, lines: doc.lineCount, frontMatterEnd: doc.frontMatterEnd,
        headings: out.items.map(h => ({ level: h.level, text: h.text, start: h.start, end: h.spanEnd, lines: h.spanEnd - h.start + 1 })),
        hidden: out.hidden, truncated: out.truncated,
      }));
      return 0;
    }
    const lines = [`${shown} — ${doc.title || shown.split('/').pop().replace(/\.md$/, '')} (${doc.lineCount} lines)`];
    if (doc.frontMatterEnd) lines.push(`1-${doc.frontMatterEnd} front matter`);
    for (const h of out.items) {
      const clip = h.text.length > 100 ? h.text.slice(0, 99) + '…' : h.text;
      lines.push(`${'  '.repeat(h.indent)}${h.start}-${h.spanEnd} ${'#'.repeat(h.level)} ${clip} (${h.spanEnd - h.start + 1})`);
    }
    if (!out.items.length) lines.push('(no headings — use `docs search` with --path-prefix to find ranges)');
    if (out.hidden) lines.push(`(${out.hidden} headings below level ${out.maxLevel} hidden; use --depth/--max)`);
    if (out.truncated) lines.push(`(${out.truncated} more headings not shown; use --max)`);
    console.log(lines.join('\n'));
    return 0;
  });
}
