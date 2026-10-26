/**
 * Fetch many URLs into a cache root: skip-if-cached, one fetch per URL across
 * processes (the store's URL lock), atomic page writes, and a hook after each
 * write. The `docs fetch` command and the v1 `fetch-docs.js` wrapper both run
 * through `fetchUrls`.
 *
 * Per URL (DESIGN.md → Concurrency):
 *
 *   withUrlLock(url):
 *     cached?  → skip          (unless force; checked again inside the lock, so a
 *                               second process waiting on the same URL finds the
 *                               first one's page instead of fetching it again)
 *     fetchPage(url)           (lib/fetch/pipeline.mjs)
 *     withUrlLock(finalUrl) → withPageLock(its file):
 *       writePage(finalUrl, md, {source: url, frontMatter: {Via, Library, DocsVersion}})
 *       splitPageIfLarge       (too big for one Read → index + parts)
 *     onWritten([path])        (index-update hook)
 */

import { promises as fsp } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { canonicalUrl, hostKey, urlToRelPath, isDerivedDir, isDerivedFile } from '../paths.mjs';
import { withUrlLock, withPageLock } from '../store/locks.mjs';
import { readPage, writePage, pagePath } from '../store/pages.mjs';
import { splitPageIfLarge, PARTS_SUFFIX } from '../store/split.mjs';
import { latestRaw, readRawMap, readRaw } from '../store/raw.mjs';
import { parseFrontMatter } from '../store/frontmatter.mjs';
import { fetchPage } from './pipeline.mjs';

const canon = (u) => { try { return canonicalUrl(String(u)); } catch { return String(u); } };
const sameQuery = (a, b) => { try { return new URL(canon(a)).search === new URL(canon(b)).search; } catch { return false; } };

/** Run `worker` over `items` with at most `concurrency` in flight; results in input order. */
export async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency || 1, items.length || 1));
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }));
  return results;
}

// ---------------------------------------------------------------------------
// "Is this URL cached?"
// ---------------------------------------------------------------------------

/**
 * Finds the cached page for a requested URL:
 *   1. the path the URL maps to (its own page, or a page that redirected there);
 *   2. where the URL landed last time it was fetched (raw-map `finalUrl`), for a
 *      URL that redirects — its page lives at the final URL's path;
 *   3. a page anywhere in the URL's domain whose `Source:` is the URL (a cache
 *      whose .cache/ is gone, e.g. a fresh clone). Scanned once per domain per
 *      process; split parts (`*.parts/`, `Source: <url>#<anchor>`) are never
 *      returned as the page.
 */
export class CacheLookup {
  constructor(root) {
    this.root = root;
    this.bySource = new Map(); // host → Promise<Map<canonical source, path>>
  }

  /** @returns {Promise<string|null>} absolute path of the cached page */
  async find(url) {
    const key = canon(url);
    const own = await readPage(this.root, url).catch(() => null);
    if (own) {
      // URLs that map to one file are one page (`/a`, `/a/`, `/a.md`, `/a.html`) —
      // unless their query strings differ: then another URL owns the file.
      const ids = [own.source, own.final].filter(Boolean);
      if (ids.length === 0 || ids.some(id => sameQuery(id, url))) return own.path;
    }
    const rec = await latestRaw(this.root, url).catch(() => null);
    if (rec && canon(rec.url) === key && rec.finalUrl && canon(rec.finalUrl) !== key) {
      const landed = await readPage(this.root, rec.finalUrl).catch(() => null);
      if (landed && [landed.source, landed.final].filter(Boolean).map(canon).some(id => id === key || id === canon(rec.finalUrl))) {
        return landed.path;
      }
    }
    const index = await this.#domainIndex(url);
    const hit = index.get(key);
    if (hit) {
      try { await fsp.access(hit); return hit; } catch { index.delete(key); }
    }
    return null;
  }

  /** Remember a page this process wrote. */
  noteWritten(url, path) {
    let host;
    try { host = hostKey(url); } catch { return; }
    const p = this.bySource.get(host);
    if (p) p.then(m => m.set(canon(url), path));
  }

  #domainIndex(url) {
    let host;
    try { host = hostKey(url); } catch { return Promise.resolve(new Map()); }
    // The domain's folder is the first segment of its pages' paths (a host named
    // like a generated file is escaped there).
    if (!this.bySource.has(host)) this.bySource.set(host, scanDomain(this.root, urlToRelPath(url).split('/')[0]));
    return this.bySource.get(host);
  }
}

/** Source → path for every page under one domain folder (`relDir` is its root-relative name). */
async function scanDomain(root, relDir) {
  const map = new Map();
  async function walk(d, rel) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      const r = `${rel}/${e.name}`;
      // `<page>.parts/` holds a split page's parts (`Source: <url>#<anchor>`): never a page of its own.
      if (e.isDirectory()) { if (!isDerivedDir(r) && !e.name.endsWith(PARTS_SUFFIX)) await walk(p, r); }
      else if (e.isFile() && e.name.endsWith('.md') && !isDerivedFile(r)) {
        let head = '';
        try {
          const fh = await fsp.open(p, 'r');
          try {
            const { bytesRead, buffer } = await fh.read(Buffer.alloc(2048), 0, 2048, 0);
            head = buffer.subarray(0, bytesRead).toString('utf-8');
          } finally { await fh.close(); }
        } catch { continue; }
        const m = /^Source:\s*(\S+)\s*$/m.exec(head.split(/\n---\s*\n/)[0] ?? '');
        if (m) map.set(canon(m[1].replace(/^["']|["']$/g, '')), p);
      }
    }
  }
  await walk(join(root, relDir), relDir);
  return map;
}

// ---------------------------------------------------------------------------
// Siblings for template detection, from the raw cache
// ---------------------------------------------------------------------------

/**
 * Up to `n` other pages of the same host already in the raw cache (their most
 * recent HTML, rendered preferred), for the converter's cross-page template
 * detection. Blobs over `maxBytes` are skipped.
 * @returns {(finalUrl: string) => Promise<Array<{url: string, html: string}>>}
 */
export function rawCacheSiblings(root, { n = 3, maxBytes = 3_000_000 } = {}) {
  return async (finalUrl) => {
    const host = hostKey(finalUrl);
    const self = canon(finalUrl);
    const recs = await readRawMap(root);
    const latest = new Map(); // url → rec
    for (const rec of recs) {
      if (rec.kind !== 'rendered-html' && rec.kind !== 'html') continue;
      let u;
      try { u = rec.finalUrl || rec.url; if (hostKey(u) !== host) continue; } catch { continue; }
      const k = canon(u);
      if (k === self) continue;
      const prev = latest.get(k);
      if (!prev || rec.kind === 'rendered-html' || prev.kind !== 'rendered-html') latest.set(k, rec);
    }
    const picked = [...latest.entries()].slice(-n);
    const out = [];
    for (const [u, rec] of picked) {
      try {
        const bytes = await readRaw(root, rec.sha256);
        if (bytes.length <= maxBytes) out.push({ url: u, html: bytes.toString('utf-8') });
      } catch { /* blob gone */ }
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

function rel(root, p) {
  return relative(root, p).split(sep).join('/');
}

/**
 * @param {string[]} urls
 * @param {object} opts
 * @param {string} opts.root                 absolute cache root
 * @param {object} opts.ctx                  pipeline context (createFetchContext)
 * @param {boolean} [opts.force]             fetch even when cached
 * @param {Set<string>} [opts.forceUrls]     canonical URLs to fetch even when cached (--refresh)
 * @param {number} [opts.concurrency=3]
 * @param {string} [opts.lib]                → front matter Library
 * @param {string} [opts.version]            → front matter DocsVersion
 * @param {(paths: string[], info: {root: string, url: string, finalUrl: string}) => Promise<void>|void} [opts.onWritten]
 * @param {(msg: string) => void} [opts.log]
 * @param {{afterWrite?: Function, afterSplit?: Function}} [opts.hooks]  test hooks, run inside the page lock
 * @returns {Promise<Array<{url: string, status: 'fetched'|'cached'|'failed', path?: string, relPath?: string,
 *   finalUrl?: string, via?: string, reason?: string, ms: number, browser?: boolean, route?: object, timings?: object}>>}
 */
export async function fetchUrls(urls, opts) {
  const { root, ctx } = opts;
  const log = opts.log ?? (() => {});
  const lookup = new CacheLookup(root);
  const forceUrls = opts.forceUrls ?? new Set();

  const one = async (url) => {
    const t0 = Date.now();
    try {
      return await withUrlLock(root, url, async () => {
        if (!opts.force && !forceUrls.has(canon(url))) {
          const hit = await lookup.find(url);
          if (hit) {
            log(`[CACHED] ${url} -> ${rel(root, hit)}`);
            return { url, status: 'cached', path: hit, relPath: rel(root, hit), ms: Date.now() - t0 };
          }
        }
        const r = await fetchPage(url, ctx);
        if (!r.ok) {
          log(`[FAIL] ${url}: ${r.reason}`);
          return { url, status: 'failed', reason: r.reason, finalUrl: r.finalUrl, ms: Date.now() - t0, browser: !!r.route?.rendered, route: r.route, timings: r.timings };
        }
        const upstream = parseFrontMatter(r.markdown).data;
        const frontMatter = {
          Via: r.via,
          ...(opts.lib ? { Library: opts.lib } : {}),
          ...(opts.version ? { DocsVersion: opts.version } : {}),
          ...(r.title && upstream.title == null ? { title: r.title } : {}),
          // The fetch chose the description (lib/convert/describe.mjs); null: none qualified.
          ...(r.descriptionFrom !== undefined ? { description: r.description, DescriptionFrom: r.descriptionFrom } : {}),
        };
        // One lock over write AND split, keyed on the page FILE: two requested
        // URLs that land on one file (redirects to one final URL, `/a` and `/a/`)
        // hold different url locks, and an interleaved write, write, split, split
        // would split the other writer's index. Order: url(requested) →
        // url(final) → page, as writePage takes them (all re-entrant).
        const { path, split } = await withUrlLock(root, r.finalUrl, () =>
          withPageLock(root, pagePath(root, r.finalUrl), async () => {
            const path = await writePage(root, r.finalUrl, r.markdown, { source: url, frontMatter });
            await opts.hooks?.afterWrite?.({ url, finalUrl: r.finalUrl, path });
            // Too big for one Read → the page file becomes an index of verbatim parts.
            const split = await splitPageIfLarge(path, { url: r.finalUrl });
            await opts.hooks?.afterSplit?.({ url, finalUrl: r.finalUrl, path, split });
            return { path, split };
          }));
        lookup.noteWritten(url, path);
        const touched = split.split || split.removed.length ? [...new Set([path, ...split.written, ...split.removed])] : [path];
        const ms = Date.now() - t0;
        const moved = canon(r.finalUrl) !== canon(url) ? ` (landed on ${r.finalUrl})` : '';
        const parts = split.split ? `, split into ${split.written.length - 1} parts` : '';
        log(`[OK] ${url} -> ${rel(root, path)}  via ${r.via}${r.route?.rendered ? ', rendered' : ''}${parts}, ${(ms / 1000).toFixed(1)}s${moved}`);
        if (opts.onWritten) {
          try { await opts.onWritten(touched, { root, url, finalUrl: r.finalUrl }); } catch (err) { log(`[WARN] index hook failed for ${rel(root, path)}: ${err.message}`); }
        }
        return { url, status: 'fetched', path, relPath: rel(root, path), finalUrl: r.finalUrl, via: r.via, ms, browser: !!r.route?.rendered, route: r.route, timings: r.timings };
      });
    } catch (err) {
      log(`[FAIL] ${url}: ${err.message}`);
      return { url, status: 'failed', reason: err.message, ms: Date.now() - t0 };
    }
  };

  const results = await runPool(urls, one, opts.concurrency ?? 3);

  // Second chance, one page at a time, for failures that look transient: under
  // load, proxied renders time out or a site refuses a burst. Pages refused on
  // their content (bot-check, error page, empty shell, 404/410) are not retried.
  const retry = results.map((r, i) => [r, i]).filter(([r]) => r?.status === 'failed' && isTransientFailure(r.reason));
  if (retry.length && opts.retry !== false) {
    log(`Retrying ${retry.length} page(s) that failed transiently, one at a time`);
    for (const [r, i] of retry) {
      const again = await one(r.url);
      if (again.status !== 'failed') results[i] = { ...again, retried: true };
    }
  }
  return results;
}

/** Failures worth one more try: timeouts, network errors, throttling/refusals of a burst, render crashes. */
export function isTransientFailure(reason = '') {
  if (/bot[- ]?check|interstitial|captcha|challenge|empty|shell|tiny-body|soft 404|error-page|HTTP (404|410)\b/i.test(reason)) return false;
  return /timed? ?out|timeout|ERR_|ECONN|EAI_AGAIN|socket|network|navigation failed|render failed|HTTP (400|403|408|425|429|5\d\d)\b/i.test(reason);
}

