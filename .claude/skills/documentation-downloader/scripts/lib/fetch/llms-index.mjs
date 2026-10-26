/**
 * The site's own llms.txt entries, for page descriptions (lib/convert/describe.mjs).
 *
 * An llms.txt lists a site's pages for LLMs, usually with a one-line description
 * each: `- [Title](https://site/page.md): What the page is for`. For a page being
 * fetched, the llms.txt files that can list it are read — the origin's, and the
 * ones at the page's first one and two path segments (`/docs/llms.txt`,
 * `/docs/python/llms.txt`), where sites put a section's own list — and the entry
 * whose link is this page gives its description.
 *
 * Each llms.txt is fetched once per run and remembered (found or not) for
 * MAX_AGE_DAYS in `.cache/llms/<host>.json`, so a site costs at most a few requests
 * a week. The site's home page is read the same way, once, for its own description:
 * a site that puts that one description on every page has not described the page. Entries are matched by URL with the scheme, `www.`, a trailing slash,
 * `index`, and a `.md`/`.html` extension ignored.
 */

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../store/atomic.mjs';
import { ACCEPT } from './http.mjs';
import { htmlDescriptions } from '../convert/describe.mjs';

export const MAX_AGE_DAYS = 7;
const MAX_BYTES = 8_000_000;

/** URL → match key: host (no www) + path, without extension, `index` or trailing slash. */
export function pageKey(url) {
  try {
    const u = new URL(url);
    let p = decodeURIComponent(u.pathname).replace(/\/+$/, '').replace(/\.(?:mdx?|html?|txt)$/i, '').replace(/\/index$/i, '');
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${p}`;
  } catch { return null; }
}

/** The llms.txt files that can list this page: origin, then 1 and 2 path segments deep. */
export function llmsCandidates(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    const out = [`${u.origin}/llms.txt`];
    // Only directories above the page (a page `/docs/x` has `/docs/` above it).
    for (let n = 1; n <= 2 && n < segs.length; n++) out.push(`${u.origin}/${segs.slice(0, n).join('/')}/llms.txt`);
    return [...new Set(out)];
  } catch { return []; }
}

/**
 * Entries with a description: `- [Title](url): text`, `- [Title](url) - text`,
 * `- [Title](url) — text`, relative links resolved against the llms.txt URL.
 * @returns {Record<string, string>} pageKey → description
 */
export function parseLlmsEntries(text, base) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^\s*(?:[-*+]|\d+\.)\s*\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)\s*(?::|-|–|—)\s*(\S.*)$/.exec(line);
    if (!m) continue;
    let key;
    try { key = pageKey(new URL(m[1], base).href); } catch { continue; }
    if (key && !(key in out)) out[key] = m[2].trim();
  }
  return out;
}

/**
 * @param {{http: {get: Function}, root?: string|null, now?: () => number, log?: Function}} o
 * @returns {{describe: (url: string, finalUrl?: string) => Promise<string|null>}}
 */
export function createLlmsIndex({ http, root = null, now = () => Date.now(), log = () => {} }) {
  const mem = new Map(); // llms.txt URL → Promise<entries|null>
  const hostFile = (host) => join(root, '.cache', 'llms', `${host.replace(/[^\w.-]/g, '_')}.json`);

  async function readDisk(host) {
    if (!root) return {};
    try { return JSON.parse(await fsp.readFile(hostFile(host), 'utf-8')); } catch { return {}; }
  }
  async function writeDisk(host, llmsUrl, record) {
    if (!root) return;
    try {
      const data = await readDisk(host); // last writer wins; a lost entry only costs a refetch
      data[llmsUrl] = record;
      await fsp.mkdir(join(root, '.cache', 'llms'), { recursive: true });
      await writeFileAtomic(hostFile(host), JSON.stringify(data) + '\n');
    } catch { /* a cache, never a failure */ }
  }

  async function fetchEntries(llmsUrl) {
    const host = new URL(llmsUrl).host;
    const cached = (await readDisk(host))[llmsUrl];
    if (cached && now() - cached.at < MAX_AGE_DAYS * 86_400_000) return cached.entries ?? null;
    let entries = null;
    try {
      const res = await http.get(llmsUrl, {
        accept: ACCEPT.text, timeoutMs: 15_000, retries: 0,
        // An HTML 200 is a soft 404 (or a site shell), never an llms.txt.
        want: ({ status, contentType }) => status === 200 && !/html/i.test(contentType),
      });
      if (res.status === 200 && !res.skipped && res.text && res.text.length <= MAX_BYTES) {
        const parsed = parseLlmsEntries(res.text, res.url || llmsUrl);
        if (Object.keys(parsed).length) entries = parsed;
      }
    } catch (err) {
      log(`[llms] ${llmsUrl}: ${err.message}`);
      return null; // not remembered: a network error is not an answer
    }
    await writeDisk(host, llmsUrl, { at: now(), ...(entries ? { entries } : {}) });
    return entries;
  }

  // The site's home page description: what a site that repeats one description on
  // every page puts there (lib/convert/describe.mjs rejects it as not about the page).
  async function fetchHomeDescriptions(origin) {
    const host = new URL(origin).host;
    const key = `${origin}/ (home)`;
    const cached = (await readDisk(host))[key];
    if (cached && now() - cached.at < MAX_AGE_DAYS * 86_400_000) return cached.descriptions ?? [];
    let descriptions = [];
    try {
      const res = await http.get(`${origin}/`, { accept: ACCEPT.html, timeoutMs: 15_000, retries: 0 });
      if (res.status === 200 && /html/i.test(res.contentType || '')) descriptions = htmlDescriptions(res.text);
    } catch (err) {
      log(`[home] ${origin}: ${err.message}`);
      return [];
    }
    await writeDisk(host, key, { at: now(), descriptions });
    return descriptions;
  }
  const home = new Map();
  const homeFor = (origin) => {
    if (!home.has(origin)) home.set(origin, fetchHomeDescriptions(origin));
    return home.get(origin);
  };

  const entriesFor = (llmsUrl) => {
    if (!mem.has(llmsUrl)) mem.set(llmsUrl, fetchEntries(llmsUrl));
    return mem.get(llmsUrl);
  };

  return {
    /** Is this text the site's own description (its home page's), not a page's? */
    async isHomeDescription(url, text) {
      let origin;
      try { origin = new URL(url).origin; } catch { return false; }
      // The home page describes itself.
      try { if (new URL(url).pathname.replace(/\/+$/, '') === '') return false; } catch { /* checked above */ }
      // The same text, or one contained in the other ("The library for web and native user
      // interfaces" on every page; "React is the library for web and native user interfaces.
      // Build…" on the home page).
      const n = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const t = n(text);
      return (await homeFor(origin)).some(d => { const h = n(d); return h === t || (t.length >= 20 && h.includes(t)) || (h.length >= 20 && t.includes(h)); });
    },
    async describe(url, finalUrl = url) {
      const keys = [...new Set([pageKey(url), pageKey(finalUrl)].filter(Boolean))];
      // Deepest list first: a section's own llms.txt describes its pages best.
      const lists = [...new Set([...llmsCandidates(finalUrl), ...llmsCandidates(url)])].reverse();
      const all = await Promise.all(lists.map(entriesFor));
      for (const entries of all) {
        if (!entries) continue;
        for (const k of keys) if (entries[k]) return entries[k];
      }
      return null;
    },
  };
}
