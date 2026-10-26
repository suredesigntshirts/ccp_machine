/**
 * Page files: the source of truth of the cache.
 *
 * One URL ↔ one file, at the path `paths.mjs` derives from the URL. Pages are
 * written only through `writePage`, which holds that URL's lock and replaces the
 * file atomically, so concurrent subagents can neither interleave two versions
 * nor expose a half-written page to a reader.
 */

import { promises as fsp } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { canonicalUrl, urlToRelPath, isDerivedDir, isDerivedFile } from '../paths.mjs';
import { writeFileAtomic } from './atomic.mjs';
import { parseFrontMatter, mergeFrontMatter, renderDocument } from './frontmatter.mjs';
import { withUrlLock, withPageLock } from './locks.mjs';
import { ensureRoot } from './root.mjs';

const rootsReady = new Map(); // rootAbs → Promise, so each process initialises a root once

export function ensureRootOnce(root) {
  if (!rootsReady.has(root)) {
    const p = ensureRoot(root);
    p.catch(() => rootsReady.delete(root)); // let a later call retry after a failure
    rootsReady.set(root, p);
  }
  return rootsReady.get(root);
}

/** Absolute path of a URL's page file (whether or not it exists). */
export function pagePath(root, url) {
  return join(root, urlToRelPath(canonicalUrl(url)));
}

/**
 * The cached page for a URL, or null.
 * The page at the path `url` maps to (by its final-URL path rule). `source` is the
 * URL that was requested, `final` where it landed (= source without a redirect).
 * @returns {Promise<null|{path: string, relPath: string, source: string|null, final: string|null, data: object, body: string, text: string}>}
 */
export async function readPage(root, url) {
  const path = pagePath(root, url);
  let text;
  try { text = await fsp.readFile(path, 'utf-8'); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const { data, body } = parseFrontMatter(text);
  const source = data.Source ?? null;
  return { path, relPath: toRel(root, path), source, final: data.Final ?? source, data, body, text };
}

/** Is a page for this URL on disk? (Cheap: one stat.) */
export async function isCached(root, url) {
  try { return (await fsp.stat(pagePath(root, url))).isFile(); } catch { return false; }
}

/**
 * Write (or refresh) a page.
 *
 * Redirects: the file's path comes from the URL the fetch LANDED on (`url`),
 * while `Source:` records the URL that was requested (`opts.source`), so a
 * refresh re-requests it and re-follows the redirect. When the two differ the
 * page also records `Final: <url>`, so tools can tell the page moved without
 * re-fetching.
 *
 * @param {string} root      absolute cache root
 * @param {string} url       the FINAL url after redirects — decides the path
 * @param {string} markdown  converted page; may open with the upstream's own front matter
 * @param {object} [opts]
 * @param {string} [opts.source]       the URL that was requested (default: `url`)
 * @param {object} [opts.frontMatter]  keys to set: title, description, Library, DocsVersion,
 *                                     LibraryVersion, VersionMatch, Via, … (`null` deletes)
 * @param {string} [opts.generated]    force the Generated date (default: kept from the cached copy)
 * @param {Date}   [opts.now]          clock, for tests
 * @returns {Promise<string>} absolute path written
 */
export async function writePage(root, url, markdown, opts = {}) {
  const finalKey = canonicalUrl(url);
  const sourceKey = canonicalUrl(opts.source ?? url);
  await ensureRootOnce(root);
  const write = async () => {
    const path = pagePath(root, finalKey);
    let previous = {};
    try {
      previous = parseFrontMatter(await fsp.readFile(path, 'utf-8')).data;
      if (isQueryCollision(root, path, previous, [finalKey, sourceKey])) {
        // Two URLs that differ only in query string share a path. Last write wins;
        // say so, because the other URL is now effectively uncached.
        console.error(`[STORE] ${toRel(root, path)} held ${previous.Final ?? previous.Source}; replacing with ${finalKey}`);
        previous = {};
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const upstream = parseFrontMatter(markdown);
    const data = mergeFrontMatter({
      url: sourceKey,
      final: finalKey,
      previous,
      upstream: upstream.data,
      supplied: opts.frontMatter ?? {},
      generated: opts.generated,
      now: opts.now,
    });
    let text = renderDocument(data, upstream.body);
    if (!text.endsWith('\n')) text += '\n';
    await writeFileAtomic(path, text);
    return path;
  };
  // Lock order: requested URL, then final URL, then the page file (see locks.mjs).
  // A fetch normally already holds the first two (and the page lock, to split
  // under it too); all three are re-entrant.
  const locked = () => withPageLock(root, pagePath(root, finalKey), write);
  return sourceKey === finalKey
    ? withUrlLock(root, finalKey, locked)
    : withUrlLock(root, sourceKey, () => withUrlLock(root, finalKey, locked));
}

/**
 * Does the page already at `path` belong to a DIFFERENT URL that maps to the
 * same path and differs in its query string (e.g. `?page=1` vs `?page=2`)? A page whose Source was requested
 * elsewhere and redirected here is the same page, not a collision.
 */
function isQueryCollision(root, path, previous, keys) {
  const prevIds = [previous.Final, previous.Source].filter(Boolean).map(safeCanonical);
  if (prevIds.length === 0 || prevIds.some(id => keys.includes(id))) return false;
  // URLs that map to one file without a query difference (`/a`, `/a/`, `/a.md`,
  // `/a.html`) are one page, as CacheLookup treats them — not a collision.
  if (prevIds.some(id => keys.some(k => querySearch(id) === querySearch(k)))) return false;
  try { return pagePath(root, prevIds[0]) === path; } catch { return false; }
}

function querySearch(u) {
  try { return new URL(u).search; } catch { return null; }
}

function safeCanonical(u) {
  try { return canonicalUrl(String(u)); } catch { return String(u); }
}

function toRel(root, path) {
  return relative(root, path).split(sep).join('/');
}

/**
 * Every page file under the root. Skips only what the tool generates or derives
 * (paths.mjs isDerivedDir/isDerivedFile: `.cache/`, `_profiles/`, `catalog.md`,
 * `<domain>/_outline.md`, the marker, temp files); a URL segment starting with
 * `_` or `.` is a page. `<page>.parts/` files are listed too (callers that
 * want only refreshable pages skip them: parts carry no `Updated:`).
 * @returns {AsyncGenerator<{path: string, relPath: string}>}
 */
export async function* listPages(root) {
  async function* walk(dir, relDir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const p = join(dir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!isDerivedDir(rel)) yield* walk(p, rel);
      } else if (e.isFile() && e.name.endsWith('.md') && !isDerivedFile(rel)) {
        yield { path: p, relPath: rel };
      }
    }
  }
  yield* walk(root, '');
}

/**
 * Pages whose `Updated` (or `Generated`) is older than `maxDays` — the v2
 * `findStaleDocs`. Pages without a parseable Source/date are skipped.
 * @returns {Promise<{source: string, path: string, relPath: string, ageDays: number, generated: string|null}[]>}
 */
export async function findStalePages(root, maxDays, { now = new Date() } = {}) {
  const stale = [];
  for await (const { path, relPath } of listPages(root)) {
    let data;
    try { ({ data } = parseFrontMatter(await fsp.readFile(path, 'utf-8'))); } catch { continue; }
    const source = data.Source;
    const updated = data.Updated ?? data.Generated;
    if (!source || !updated) continue;
    const t = new Date(String(updated)).getTime();
    if (Number.isNaN(t)) continue;
    const ageDays = Math.floor((now.getTime() - t) / 86_400_000);
    if (ageDays > maxDays) {
      stale.push({ source: String(source), path, relPath, ageDays, generated: data.Generated ? String(data.Generated) : null });
    }
  }
  return stale;
}
