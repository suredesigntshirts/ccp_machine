/**
 * `--discover <url>`: find the documentation pages under a URL.
 *
 * Scope (v1 crawled whole sites and followed off-site links; both fixed):
 *   - same site: the start URL's host, `www.` folded (subdomains are other sites)
 *   - within the start URL's path prefix: `--discover https://x.com/docs/python`
 *     queues /docs/python and /docs/python/…, never /docs/java or /blog
 *     (segment-aware: not /docs/pythonic either). A file-like last segment
 *     (`/docs/intro.html`) scopes to its directory.
 *
 * Sources, all links-only (DESIGN.md: never llms-full.txt as content):
 *   1. llms.txt, path-scoped first (`/docs/python/llms.txt`, `/docs/llms.txt`),
 *      then the origin's. llms-full.txt only when no llms.txt exists anywhere.
 *   2. Sitemaps: robots.txt `Sitemap:` lines, conventional paths (origin and
 *      path-scoped), sitemap indexes expanded, gzipped sitemaps (`.xml.gz`) inflated.
 *   3. When those cover (almost) nothing under the prefix — Read the Docs
 *      versions have no per-version sitemap — the start page's own links.
 * URLs are de-duplicated by the cache file they map to (so `/guide/x.md` from
 * llms.txt and `/guide/x` from the sitemap are one page, and the HTML URL wins),
 * English/unprefixed locales are ordered first on i18n sites, and the cap is
 * reported loudly.
 */

import { gunzipSync } from 'node:zlib';
import { urlToRelPath } from '../paths.mjs';
import { ACCEPT } from './http.mjs';

export const DISCOVERY = {
  MAX_URLS: 50,              // default cap on pages returned
  DOC_FILTER_THRESHOLD: 100, // whole-site discovery above this many URLs narrows to doc-like paths
  MAX_SITEMAP_DOCS: 20,      // sitemap documents fetched per run (indexes + children)
  MAX_CHILD_SITEMAPS: 15,    // children taken from one sitemap index
  TIMEOUT_MS: 15_000,
  FAST_TIMEOUT_MS: 6_000,
};

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

const foldHost = (h) => h.toLowerCase().replace(/^www\./, '');

/**
 * @param {string} startUrl
 * @returns {{origin: string, host: string, prefix: string}} prefix always ends with '/'
 */
export function discoveryScope(startUrl) {
  const u = new URL(startUrl);
  let path = decodeURIComponentSafe(u.pathname).replace(/\/{2,}/g, '/');
  const last = path.split('/').pop();
  if (last && /\.[a-z0-9]{1,6}$/i.test(last)) path = path.slice(0, path.length - last.length); // file → its dir
  if (!path.endsWith('/')) path += '/';
  return { origin: u.origin, host: foldHost(u.hostname), prefix: path };
}

function decodeURIComponentSafe(s) {
  try { return decodeURI(s); } catch { return s; }
}

/**
 * Is `url` inside the scope? The prefix directory itself counts
 * (`/docs/python` and `/docs/python/` for prefix `/docs/python/`).
 * @returns {null | 'offsite' | 'out-of-prefix' | 'not-http'}  null when in scope
 */
export function scopeMiss(url, scope) {
  let u;
  try { u = new URL(url); } catch { return 'not-http'; }
  if (!/^https?:$/.test(u.protocol)) return 'not-http';
  if (foldHost(u.hostname) !== scope.host) return 'offsite';
  const path = decodeURIComponentSafe(u.pathname).replace(/\/{2,}/g, '/');
  if (scope.prefix === '/') return null;
  if (path.startsWith(scope.prefix) || path === scope.prefix.slice(0, -1)) return null;
  // `/docs/python/` prefix, page `/docs/python.md` (the directory's own markdown)
  if (/\.mdx?$/i.test(path) && path.replace(/\.mdx?$/i, '/') === scope.prefix) return null;
  return 'out-of-prefix';
}

/** Directories from the prefix up to the root: `/a/b/` → ['/a/b/', '/a/', '/']. */
export function ancestorDirs(prefix) {
  const parts = prefix.split('/').filter(Boolean);
  const out = [];
  for (let i = parts.length; i >= 0; i--) out.push('/' + parts.slice(0, i).join('/') + (i ? '/' : ''));
  return out;
}

// ---------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------

/**
 * Links in an llms.txt: markdown links and bare URLs, resolved against `base`.
 * @returns {string[]} in document order, de-duplicated
 */
export function parseLlmsTxt(text, base) {
  const out = [];
  const seen = new Set();
  const add = (href) => {
    try {
      const u = new URL(href.trim().replace(/^<|>$/g, ''), base);
      if (!/^https?:$/.test(u.protocol)) return;
      u.hash = '';
      if (!seen.has(u.href)) { seen.add(u.href); out.push(u.href); }
    } catch { /* not a URL */ }
  };
  // Links never span lines; markdown link targets have no spaces (an optional "title" aside).
  for (const m of text.matchAll(/\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g)) add(m[1]);
  for (const line of text.split('\n')) {
    const m = /^\s*(?:[-*]\s+)?(https?:\/\/\S+)/.exec(line);
    if (m) add(m[1].replace(/[),.;:]+$/, ''));
  }
  return out;
}

/**
 * Parse a sitemap document. An index's <loc>s are other sitemaps, not pages.
 * @returns {{isIndex: boolean, locs: string[]}}
 */
export function parseSitemapXml(text) {
  const isIndex = /<(?:\w+:)?sitemapindex[\s>]/i.test(text);
  const locs = [];
  for (const m of text.matchAll(/<(?:\w+:)?loc>\s*([\s\S]*?)\s*<\/(?:\w+:)?loc>/gi)) {
    const url = m[1].trim()
      .replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
      .replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .trim();
    if (/^https?:\/\//i.test(url)) locs.push(url);
  }
  return { isIndex, locs };
}

/** `Sitemap:` lines of a robots.txt, resolved against the origin. */
export function parseRobotsSitemaps(text, origin) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (!m) continue;
    try { out.push(new URL(m[1], origin).href); } catch { /* skip */ }
  }
  return out;
}

/** Sitemap bytes → XML text, inflating gzip (by magic bytes, whatever the URL or headers say). */
export function sitemapText(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? '');
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf).toString('utf-8');
  return buf.toString('utf-8');
}

const LOCALE_SEGMENT = /^[a-z]{2}(-[a-z]{2,4})?$/i;

function firstSegmentAfter(url, prefix) {
  try {
    const rest = new URL(url).pathname.slice(prefix.length);
    return rest.split('/').filter(Boolean)[0] || '';
  } catch { return ''; }
}

/**
 * Stable-sort URLs so English / unprefixed paths come first. A two-letter first
 * segment (after the scope prefix) counts as a locale only when several distinct
 * ones appear — a `/go/` or `/js/` section is not a language.
 */
export function preferDefaultLocale(urls, prefix = '/') {
  const candidates = new Set();
  for (const url of urls) {
    const seg = firstSegmentAfter(url, prefix).toLowerCase();
    if (LOCALE_SEGMENT.test(seg)) candidates.add(seg);
  }
  const nonEnglish = [...candidates].filter(s => !/^en(-|$)/.test(s));
  if (nonEnglish.length < 3) return urls;
  const locales = new Set(nonEnglish);
  const rank = (u) => (locales.has(firstSegmentAfter(u, prefix).toLowerCase()) ? 1 : 0);
  return [...urls].sort((a, b) => rank(a) - rank(b));
}

/** Is `url` the prefix directory itself (the start page), rather than a page under it? */
function isScopeRoot(url, scope) {
  try {
    const p = new URL(url).pathname.replace(/\/{2,}/g, '/');
    return p === scope.prefix || p === scope.prefix.slice(0, -1) || p === `${scope.prefix}index.html`;
  } catch { return false; }
}

const DOC_PATH = /\/(docs?|api|guides?|reference|tutorials?|getting-started|quickstart|sdk|learn|manual|handbook)(\/|$)/i;
const NOT_A_PAGE = /\.(xml|gz|txt|json|rss|atom|png|jpe?g|gif|svg|webp|ico|pdf|zip|tar|tgz|css|js|mjs|woff2?|ttf|mp4|webm)$/i;
// Generated pages of doc generators that are not documentation: Sphinx indexes,
// search pages, highlighted source code, build assets.
const NOT_A_DOC = /\/(?:genindex|py-modindex|modindex|search)(?:\.html)?$|\/_(?:sources|static|images|downloads|modules)\//i;
// Hosts that are documentation as a whole: never narrow them to "doc-like" paths.
const DOCS_HOST = /^(?:docs?|developers?|dev|api|learn|help|support|reference|manual|wiki)\./i;

function cacheKey(url) {
  try { return urlToRelPath(url); } catch { return url; }
}

/**
 * Merge candidate URL lists (in priority order) into unique pages: in scope,
 * one per cache file, preferring the non-`.md` URL for a page.
 * @returns {{urls: string[], rejected: {offsite: number, 'out-of-prefix': number, 'not-http': number, 'not-a-page': number}, rejectedSamples: string[]}}
 */
export function mergeCandidates(lists, scope) {
  const byKey = new Map(); // key → index in urls
  const urls = [];
  const rejected = { offsite: 0, 'out-of-prefix': 0, 'not-http': 0, 'not-a-page': 0 };
  const rejectedSamples = [];
  for (const list of lists) {
    for (const raw of list) {
      const miss = scopeMiss(raw, scope);
      let reason = miss;
      if (!reason) {
        try {
          const path = new URL(raw).pathname;
          if (NOT_A_PAGE.test(path) || NOT_A_DOC.test(path)) reason = 'not-a-page';
        } catch { reason = 'not-http'; }
      }
      if (reason) {
        rejected[reason]++;
        if (rejectedSamples.length < 5 && reason !== 'not-a-page') rejectedSamples.push(`${reason}: ${raw}`);
        continue;
      }
      const u = new URL(raw);
      u.hash = '';
      const href = u.href;
      const key = cacheKey(href);
      if (!byKey.has(key)) { byKey.set(key, urls.length); urls.push(href); continue; }
      const i = byKey.get(key);
      if (/\.mdx?$/i.test(new URL(urls[i]).pathname) && !/\.mdx?$/i.test(u.pathname)) urls[i] = href;
    }
  }
  return { urls, rejected, rejectedSamples };
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

async function tryGet(http, url, accept, timeoutMs, log) {
  try {
    const res = await http.get(url, { accept, timeoutMs, retries: 1 });
    if (res.status !== 200) {
      if (res.status !== 404 && res.status !== 410) log(`  ${url}: HTTP ${res.status}`); // misses are expected
      return null;
    }
    return res;
  } catch (err) {
    log(`  ${url}: ${err.message}`);
    return null;
  }
}

const looksHtml = (s) => /^\s*(<!doctype\s+html|<html[\s>]|<head[\s>])/i.test(s || '');

/** The deepest llms.txt at or above the prefix (then llms-full.txt): links + where they came from. */
async function llmsLinks(http, scope, log) {
  const dirs = ancestorDirs(scope.prefix).slice(0, 5);
  for (const name of ['llms.txt', 'llms-full.txt']) {
    const tries = await Promise.all(dirs.map(async (dir) => {
      const url = `${scope.origin}${dir}${name}`;
      const res = await tryGet(http, url, ACCEPT.text, DISCOVERY.FAST_TIMEOUT_MS, log);
      if (!res || looksHtml(res.text) || /html/i.test(res.contentType)) return null;
      return { url, links: parseLlmsTxt(res.text, url) };
    }));
    // Deepest first: a section's own llms.txt is the better list for that section.
    for (const t of tries) {
      if (t && t.links.some(l => scopeMiss(l, scope) === null)) return { source: t.url, links: t.links };
    }
    if (tries.some(Boolean)) {
      const found = tries.find(Boolean);
      log(`  ${found.url}: no links inside ${scope.prefix}`);
      return { source: found.url, links: found.links };
    }
  }
  return null;
}

async function sitemapLinks(http, scope, log) {
  const queue = [];
  const robots = await tryGet(http, `${scope.origin}/robots.txt`, ACCEPT.text, DISCOVERY.FAST_TIMEOUT_MS, log);
  if (robots && !looksHtml(robots.text)) queue.push(...parseRobotsSitemaps(robots.text, scope.origin));
  const guesses = new Set();
  for (const dir of ancestorDirs(scope.prefix)) {
    for (const name of dir === '/' ? ['sitemap.xml', 'sitemap-index.xml', 'sitemap_index.xml', 'sitemap/sitemap.xml'] : ['sitemap.xml']) {
      const u = `${scope.origin}${dir}${name}`;
      if (!queue.includes(u)) { queue.push(u); guesses.add(u); }
    }
  }
  const pages = [];
  const visited = new Set();
  const sources = [];
  let fetched = 0;
  // Conventional guesses that 404 are cheap; stop guessing once a declared or
  // found sitemap has produced pages.
  while (queue.length && fetched < DISCOVERY.MAX_SITEMAP_DOCS) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    if (guesses.has(url) && pages.some(l => scopeMiss(l, scope) === null && !isScopeRoot(l, scope))) continue;
    visited.add(url);
    const res = await tryGet(http, url, ACCEPT.xml, DISCOVERY.TIMEOUT_MS, log);
    if (!res) continue;
    let text;
    try { text = sitemapText(res.bytes ?? Buffer.from(res.text ?? '')); } catch (err) { log(`  ${url}: bad gzip (${err.message})`); continue; }
    if (looksHtml(text)) continue;
    fetched++;
    const { isIndex, locs } = parseSitemapXml(text);
    if (isIndex) {
      // Children whose URL mentions the prefix's last segment first (e.g. a per-section sitemap).
      const hint = scope.prefix.split('/').filter(Boolean).pop()?.toLowerCase();
      const ordered = hint ? [...locs].sort((a, b) => (b.toLowerCase().includes(hint) ? 1 : 0) - (a.toLowerCase().includes(hint) ? 1 : 0)) : locs;
      const children = ordered.slice(0, DISCOVERY.MAX_CHILD_SITEMAPS);
      log(`  ${url}: sitemap index, ${locs.length} child sitemap(s)${locs.length > children.length ? ` — expanding ${children.length}` : ''}`);
      queue.unshift(...children.filter(c => !visited.has(c)));
      continue;
    }
    sources.push(url);
    const inScope = locs.filter(l => scopeMiss(l, scope) === null).length;
    log(`  ${url}: ${locs.length} URL(s), ${inScope} inside ${scope.host}${scope.prefix}`);
    pages.push(...locs);
  }
  if (queue.length && fetched >= DISCOVERY.MAX_SITEMAP_DOCS) log(`  stopped after ${fetched} sitemap documents; ${queue.length} left unexplored`);
  return { sources, links: pages };
}

/** Links (`<a href>`) on a page, resolved, in document order. */
export function extractLinks(html, base) {
  const out = [];
  const seen = new Set();
  for (const m of String(html).matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').replace(/&amp;/g, '&').trim();
    if (!href || href.startsWith('#') || /^(?:javascript|mailto|tel|data):/i.test(href)) continue;
    try {
      const u = new URL(href, base);
      u.hash = '';
      if (!seen.has(u.href)) { seen.add(u.href); out.push(u.href); }
    } catch { /* bad URL */ }
  }
  return out;
}

async function pageLinks(http, url, log) {
  const res = await tryGet(http, url, ACCEPT.html, DISCOVERY.TIMEOUT_MS, log);
  if (!res || !/html/i.test(res.contentType || 'text/html')) return [];
  const links = extractLinks(res.text, res.url || url);
  log(`  ${url}: ${links.length} link(s) on the page`);
  return links;
}

/**
 * Discover documentation URLs under `startUrl`.
 * @param {string} startUrl
 * @param {{http: {get: Function}, max?: number, log?: (msg: string) => void, sitemaps?: boolean}} opts
 * @returns {Promise<{urls: string[], total: number, capped: boolean, scope: object,
 *   sources: string[], rejected: object, rejectedSamples: string[]}>}
 */
export async function discoverUrls(startUrl, { http, max = DISCOVERY.MAX_URLS, log = () => {}, sitemaps = true } = {}) {
  const scope = discoveryScope(startUrl);
  log(`Discovering pages in ${scope.host}${scope.prefix}`);
  const lists = [[startUrl]];
  const sources = [];

  const llms = await llmsLinks(http, scope, log);
  if (llms) { sources.push(llms.source); lists.push(llms.links); }

  // llms.txt is curated but often partial; the sitemap fills in the rest. Skip it
  // only when llms.txt alone already fills the cap.
  let merged = mergeCandidates(lists, scope);
  if (sitemaps && merged.urls.length <= max) {
    const sm = await sitemapLinks(http, scope, log);
    sources.push(...sm.sources);
    lists.push(sm.links);
    merged = mergeCandidates(lists, scope);
  }
  // Neither llms.txt nor a sitemap covers the prefix (Read the Docs versions,
  // hand-written sites): take the links on the start page itself, one level.
  if (merged.urls.length < max && merged.urls.filter(u => !isScopeRoot(u, scope)).length < 5) {
    const links = await pageLinks(http, startUrl, log);
    if (links.length) {
      sources.push(`${startUrl} (links)`);
      lists.push(links);
      merged = mergeCandidates(lists, scope);
    }
  }
  let urls = merged.urls;

  // Whole-site discovery on a big non-docs host (a product site with a /docs/
  // section): keep the doc-like paths — when they are a real share of the site.
  if (scope.prefix === '/' && !DOCS_HOST.test(scope.host) && urls.length > DISCOVERY.DOC_FILTER_THRESHOLD) {
    const docs = urls.filter((u, i) => i === 0 || DOC_PATH.test(new URL(u).pathname));
    if (docs.length > 1 && docs.length < urls.length && docs.length >= 0.1 * urls.length) {
      log(`  narrowed ${urls.length} URLs to ${docs.length} doc-like paths (pass a path to scope discovery instead)`);
      urls = docs;
    }
  }

  const total = urls.length;
  const capped = total > max;
  if (capped) urls = preferDefaultLocale(urls, scope.prefix).slice(0, max);
  const r = merged.rejected;
  if (r.offsite || r['out-of-prefix']) {
    log(`  ignored ${r.offsite} off-site and ${r['out-of-prefix']} out-of-prefix URL(s)`);
  }
  return { urls, total, capped, scope, sources, rejected: r, rejectedSamples: merged.rejectedSamples };
}
