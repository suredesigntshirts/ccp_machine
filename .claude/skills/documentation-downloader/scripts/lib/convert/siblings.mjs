/**
 * Sibling pages for cross-page template detection (extract.mjs layer 2).
 *
 * extractContent() takes `siblings: [{url, html}]` — other pages of the same site.
 * Text that repeats on them is template. In production they come from:
 *   1. the raw cache: HTML already fetched from the same host (free), or
 *   2. one extra fetch: a same-site link taken from the page itself
 *      (siblingLinkCandidates), preferring the site's own navigation.
 * Raw server HTML is enough — the template (nav, footer, banners) is almost always
 * server-rendered, and htmlTextPieces() reads text without a DOM.
 */
import { promises as fsp } from 'node:fs';
import { readRawMap, rawPath } from '../store/raw.mjs';

const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return null; } };
const pathSegs = (u) => { try { return new URL(u).pathname.split('/').filter(Boolean); } catch { return []; } };

function sharedPrefix(a, b) {
  const x = pathSegs(a), y = pathSegs(b);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

/**
 * Up to `limit` cached HTML pages from the same host (most path-similar first).
 * @param {string} root  cache root (external-docs/)
 * @returns {Promise<{url:string, html:string}[]>}
 */
export async function siblingsFromRawCache(root, url, { limit = 3, maxBytes = 8e6 } = {}) {
  const host = hostOf(url);
  const self = String(url).split('#')[0];
  const seen = new Set();
  const cands = [];
  for (const rec of (await readRawMap(root)).reverse()) {
    const u = rec.finalUrl || rec.url;
    if (hostOf(u) !== host || u.split('#')[0] === self || seen.has(u)) continue;
    if (rec.status && rec.status >= 400) continue;
    if (rec.kind ? rec.kind !== 'html' : !/html/i.test(rec.contentType || '')) continue;
    seen.add(u);
    cands.push({ url: u, sha256: rec.sha256, prefix: sharedPrefix(u, url) });
  }
  cands.sort((a, b) => b.prefix - a.prefix);
  const out = [];
  for (const c of cands) {
    if (out.length >= limit) break;
    try {
      const p = rawPath(root, c.sha256);
      const st = await fsp.stat(p);
      if (st.size > maxBytes) continue;
      out.push({ url: c.url, html: await fsp.readFile(p, 'utf-8') });
    } catch { /* blob gone */ }
  }
  return out;
}

/**
 * Same-site pages linked from this page, best first, for fetching one sibling when
 * the cache has none: links inside navigation (template) regions that share the
 * longest path prefix with the page; never the page itself, fragments or assets.
 * @param {Document} doc
 * @returns {string[]}
 */
export function siblingLinkCandidates(doc, url, { limit = 5 } = {}) {
  const host = hostOf(url);
  const self = String(url).split('#')[0];
  const scored = new Map();
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    let abs;
    try { abs = new URL(a.getAttribute('href'), url); } catch { continue; }
    if (!/^https?:$/.test(abs.protocol) || hostOf(abs.href) !== host) continue;
    abs.hash = '';
    const u = abs.href;
    if (u === self || /\.(png|jpe?g|gif|svg|webp|pdf|zip|gz|css|js|json|xml|txt|md)$/i.test(abs.pathname)) continue;
    let inNav = false;
    for (let p = a.parentNode; p && p.nodeType === 1; p = p.parentNode) {
      const t = p.nodeName.toLowerCase();
      const r = p.getAttribute('role');
      if (t === 'nav' || t === 'aside' || r === 'navigation' || r === 'complementary') { inNav = true; break; }
    }
    const s = sharedPrefix(u, url) * 2 + (inNav ? 1 : 0);
    if (!scored.has(u) || scored.get(u) < s) scored.set(u, s);
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([u]) => u);
}
