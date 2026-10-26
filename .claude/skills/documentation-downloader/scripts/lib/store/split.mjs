/**
 * Large pages on disk.
 *
 * A page too big for one Read (DESIGN.md "Large pages") keeps its URL-shaped
 * path — so lookups by URL are unchanged — but that file becomes the page's
 * index, and the verbatim content moves into parts next to it:
 *
 *   <page>.md            front matter of the page + a table of its parts
 *   <page>.parts/<slug>.md   one part each (`Source: <url>#<anchor>`)
 *
 * `.parts` (not `<page>/`) because `<page>/` may legitimately hold the URL's
 * child pages. Parts carry no `Updated:`, so refresh only ever re-fetches the
 * page itself, which re-splits it and removes parts that no longer exist.
 *
 * Writers hold the page FILE's lock (`withPageLock`) across the page write and
 * this split: several URLs can land on one file, and an interleaved
 * write/write/split/split would otherwise split one writer's index as content.
 * Pass `root` and this takes that lock itself (re-entrant).
 */

import { promises as fsp } from 'node:fs';
import { basename, join } from 'node:path';
import { writeFileAtomic } from './atomic.mjs';
import { parseFrontMatter } from './frontmatter.mjs';
import { withPageLock } from './locks.mjs';
import { listPages } from './pages.mjs';
import { splitLargePage, estimateTokens } from '../convert/split.mjs';

export const PARTS_SUFFIX = '.parts';
export const DEFAULT_MAX_TOKENS = 25000;

export const partsDirFor = (pagePath) => pagePath.replace(/\.md$/, PARTS_SUFFIX);

/**
 * Is `text` the index of an already-split page (front matter `Parts: <n>` and
 * links into its own `<page>.parts/`)? Such a file is not page content: it
 * must never be re-split, and its parts must never be deleted because of it.
 */
export function isSplitIndex(text, pagePath) {
  const { data, body } = parseFrontMatter(text);
  const n = Number(data.Parts);
  return Number.isInteger(n) && n > 0 && body.includes(`](${basename(partsDirFor(pagePath))}/`);
}

/**
 * Split the page at `pagePath` if it is too large; clean up parts from an
 * earlier, larger version when it no longer is. A file that is already an
 * index is left alone (`alreadySplit: true`).
 * @param {string} pagePath
 * @param {{url?: string, maxTokens?: number, root?: string}} [opts]
 *   `root`: take the page file's lock for the split (callers that already hold it may omit it)
 * @returns {Promise<{split: boolean, alreadySplit?: boolean, written: string[], removed: string[]}>}
 *   written/removed are absolute paths, for the search index.
 */
export async function splitPageIfLarge(pagePath, opts = {}) {
  return opts.root ? withPageLock(opts.root, pagePath, () => splitUnlocked(pagePath, opts)) : splitUnlocked(pagePath, opts);
}

async function splitUnlocked(pagePath, { url, maxTokens = DEFAULT_MAX_TOKENS } = {}) {
  const text = await fsp.readFile(pagePath, 'utf-8');
  const dir = partsDirFor(pagePath);
  if (isSplitIndex(text, pagePath)) return { split: false, alreadySplit: true, written: [], removed: [] };
  const result = splitLargePage(text, { url, maxTokens, linkPrefix: `${basename(dir)}/` });

  let existing = [];
  try { existing = (await fsp.readdir(dir)).filter(n => n.endsWith('.md')).map(n => join(dir, n)); } catch { /* none */ }

  if (!result) {
    for (const p of existing) await fsp.rm(p, { force: true });
    if (existing.length) await fsp.rm(dir, { recursive: true, force: true });
    return { split: false, written: [], removed: existing };
  }

  await fsp.mkdir(dir, { recursive: true });
  const written = [];
  for (const part of result.parts) {
    const p = join(dir, `${part.slug}.md`);
    await writeFileAtomic(p, part.markdown);
    written.push(p);
  }
  // The index replaces the full page only after every part is on disk: a crash
  // in between leaves the full page (plus spare parts), never a dangling index.
  await writeFileAtomic(pagePath, result.index.markdown);
  written.unshift(pagePath);

  const keep = new Set(written);
  const removed = existing.filter(p => !keep.has(p));
  for (const p of removed) await fsp.rm(p, { force: true });
  return { split: true, written, removed };
}

/**
 * Bytes at or under which a file cannot exceed `maxTokens`: estimateTokens is
 * chars / 3.5, and a file has at least as many UTF-8 bytes as UTF-16 chars.
 */
const fitsBytes = (maxTokens) => (estimateTokens('x'.repeat(35)) === 10 ? Math.floor(maxTokens * 3.5) : 0);

/**
 * Split every page under `root` that is too large for one Read — not just the
 * pages some run just wrote (an interrupted or partly failed `migrate` leaves
 * large pages behind that a later run never touched). Parts (`*.parts/`) and
 * existing indexes are left alone; files small enough by size are not read.
 * The page's URL (`Final:`, else `Source:`) comes from its front matter.
 * @returns {Promise<{split: Array<{path: string, parts: number, written: string[], removed: string[]}>,
 *   errors: Array<{path: string, error: string}>}>}
 */
export async function splitLargePages(root, { maxTokens = DEFAULT_MAX_TOKENS } = {}) {
  const limit = fitsBytes(maxTokens);
  const split = [];
  const errors = [];
  for await (const { path, relPath } of listPages(root)) {
    if (relPath.split('/').slice(0, -1).some(seg => seg.endsWith(PARTS_SUFFIX))) continue;
    try {
      if ((await fsp.stat(path)).size <= limit) continue;
      const { data } = parseFrontMatter(await fsp.readFile(path, 'utf-8'));
      const url = data.Final ?? data.Source;
      const r = await splitPageIfLarge(path, { url: url ? String(url) : undefined, maxTokens, root });
      if (r.split) split.push({ path, parts: r.written.length - 1, written: r.written, removed: r.removed });
    } catch (err) {
      errors.push({ path, error: err.message });
    }
  }
  return { split, errors };
}
