/**
 * "Is this URL cached, and where?" — the URL is the cache key.
 *
 * Tried in order:
 *   1. the v2 path rule (`paths.mjs` urlToRelPath);
 *   2. v1 path rule variants, so caches written by the old fetch-docs.js resolve:
 *      v1 kept the pathname undecoded, and wrote a site root as `<host>.md` at the
 *      top level (v2: `<host>/index.md`); some older tools wrote `<dir>/index.md`;
 *   3. the index's `Source:` front matter — finds pages stored at paths that are
 *      not URL-shaped at all (the `google/` subtree in the fixture, split pages).
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { urlToRelPath, canonicalUrl, hostKey } from '../paths.mjs';

/** Candidate root-relative paths for a URL, most likely first, de-duplicated. */
export function candidatePaths(url) {
  const u = new URL(url);
  const out = [];
  const add = p => { if (p && !out.includes(p)) out.push(p); };
  add(urlToRelPath(url));
  // v1: `${hostname without www}${pathname}` — not decoded — minus trailing slash and extensions.
  const host = hostKey(url);
  let v1 = `${host}${u.pathname}`.replace(/\/$/, '').replace(/\.mdx?$/i, '').replace(/\.(html?|php|aspx?)$/i, '');
  add(`${v1}.md`);
  // Directory-style URL stored as <dir>/index.md, and vice versa.
  const v2 = urlToRelPath(url);
  if (v2.endsWith('/index.md')) add(v2.replace(/\/index\.md$/, '.md'));
  else add(v2.replace(/\.md$/, '/index.md'));
  // Hostname with `www.` kept (very old caches).
  if (u.hostname.startsWith('www.')) add(`${u.hostname}${u.pathname}`.replace(/\/$/, '') + '.md');
  return out;
}

/** Source-URL spellings a page's front matter might carry for this URL. */
function sourceVariants(url) {
  const c = canonicalUrl(url);
  const set = new Set([url, c, c.replace(/\/$/, ''), c.endsWith('/') ? c : `${c}/`]);
  for (const v of [...set]) {
    if (v.includes('://www.')) set.add(v.replace('://www.', '://'));
    else set.add(v.replace('://', '://www.'));
  }
  return [...set];
}

/**
 * @param {string} rootAbs
 * @param {string} url
 * @param {object|null} idx an open index (for the Source: lookup), optional
 * @returns {{url: string, cached: boolean, path: string|null, via: string|null, expected: string, size?: number}}
 */
export function lookupUrl(rootAbs, url, idx = null) {
  let cands;
  try { cands = candidatePaths(url); } catch { return { url, cached: false, path: null, via: null, expected: null, error: 'invalid URL' }; }
  const expected = cands[0];
  for (const [i, rel] of cands.entries()) {
    const abs = join(rootAbs, rel);
    if (existsSync(abs) && statSync(abs).isFile()) {
      return { url, cached: true, path: rel, via: i === 0 ? 'path' : 'legacy-path', expected };
    }
  }
  if (idx) {
    for (const src of sourceVariants(url)) {
      const hits = idx.pathsForSource(src);
      if (hits.length) return { url, cached: true, path: hits[0], via: 'source', expected, others: hits.slice(1) };
    }
  }
  return { url, cached: false, path: null, via: null, expected };
}
