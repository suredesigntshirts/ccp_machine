/**
 * Owner-published markdown for a page (DESIGN.md → Fetch pipeline, step 1).
 *
 * Two ways a site offers it:
 *   accept    `Accept: text/markdown` content negotiation on the page URL itself
 *             (Mintlify, Shopify, Render, … — and Cloudflare "markdown for agents",
 *             which is CDN-generated and not always clean: the converter decides)
 *   variant   the `<url>.md` file (VitePress, react.dev, llms.txt-convention sites)
 *
 * Both are speculative, so they fast-fail (a miss just means "render the HTML").
 * A variant request that redirects to a non-markdown path is a catch-all (SPA
 * shell, docs home), not this page: a miss. Validation here is only "is this a
 * markdown response at all"; whether it is good enough to use instead of the
 * HTML is `convert.assessOwner`'s call.
 */

import { ACCEPT } from './http.mjs';

export const PROBE_TIMEOUT_MS = 6000;

const MD_PATH = /\.mdx?$/i;
const PAGE_EXT = /\.(html?|php|aspx?|jsp)$/i;

/**
 * `.md` variant URLs to try for a page, most likely first.
 *
 *   /a/b          → /a/b.md
 *   /a/b/         → /a/b.md, /a/b/index.md, /a/b/index.html.md
 *   /a/b.html     → /a/b.md, /a/b.html.md          (llms.txt proposal: append .md)
 *   /             → /index.md, /index.html.md
 *   /a/b.md       → []                             (the URL is markdown already)
 *
 * Query and fragment are dropped (a static .md file has neither).
 */
export function markdownVariantUrls(url) {
  let u;
  try { u = new URL(url); } catch { return []; }
  if (!/^https?:$/.test(u.protocol)) return [];
  u.hash = '';
  u.search = '';
  const path = u.pathname.replace(/\/{2,}/g, '/');
  if (MD_PATH.test(path)) return [];
  const at = (p) => { const v = new URL(u.href); v.pathname = p; return v.href; };
  if (path === '/' || path === '') return [at('/index.md'), at('/index.html.md')];
  if (path.endsWith('/')) {
    const dir = path.replace(/\/+$/, '');
    return [at(`${dir}.md`), at(`${dir}/index.md`), at(`${dir}/index.html.md`)];
  }
  if (PAGE_EXT.test(path)) return [at(path.replace(PAGE_EXT, '.md')), at(`${path}.md`)];
  return [at(`${path}.md`)];
}

/** Does a URL (by its path) name a markdown file? */
export function isMarkdownUrl(url) {
  try { return MD_PATH.test(new URL(url).pathname); } catch { return false; }
}

const looksHtml = (text) => /^\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(text);

/** Content types that can carry markdown (servers label .md files inconsistently). */
function markdownishType(contentType) {
  const t = (contentType || '').toLowerCase();
  if (!t) return true;
  if (/html|json|xml|javascript|image\/|video\/|audio\/|pdf|zip/.test(t)) return false;
  return /markdown|text\/plain|text\/x-|octet-stream|^text\//.test(t);
}

/**
 * Is `res` (an http.get result) usable markdown for this probe kind?
 * @returns {null | string} null when fine, else why not
 */
export function probeMiss(how, res) {
  if (res.status !== 200) return `HTTP ${res.status}`;
  if (how === 'accept' && !/markdown/i.test(res.contentType)) return `served ${res.contentType || 'no content-type'}`;
  if (how === 'variant') {
    let landed = null;
    try { landed = new URL(res.url).pathname; } catch { /* keep null */ }
    if (landed && !MD_PATH.test(landed)) return `redirected to non-markdown path ${landed}`;
    if (!markdownishType(res.contentType)) return `served ${res.contentType}`;
  }
  const text = res.text ?? '';
  if (!text.trim()) return 'empty body';
  if (looksHtml(text)) return 'body is HTML';
  if (/^\s*[[{]/.test(text) && /[\]}]\s*$/.test(text)) {
    try { JSON.parse(text); return 'body is JSON'; } catch { /* markdown can start with [ */ }
  }
  return null;
}

async function attempt(http, how, url, timeoutMs, signal) {
  const t0 = Date.now();
  const accept = how === 'accept' ? ACCEPT.markdown : 'text/markdown, text/plain;q=0.9, */*;q=0.5';
  try {
    const res = await http.get(url, {
      accept,
      timeoutMs,
      signal,
      retries: 0, // speculative: a miss costs nothing, a retry costs seconds
      want: ({ status, contentType, url: landed }) => probeMiss(how, { status, contentType, url: landed, text: 'x' }) === null,
    });
    const miss = res.skipped ? probeMiss(how, { ...res, text: 'x' }) || 'skipped' : probeMiss(how, res);
    const rec = { how, url, finalUrl: res.url, status: res.status, contentType: res.contentType, ms: Date.now() - t0 };
    if (miss) return { attempt: { ...rec, miss } };
    return { attempt: rec, candidate: { ...rec, headers: res.headers, text: res.text, bytes: res.bytes } };
  } catch (err) {
    return { attempt: { how, url, status: 0, error: err.message, ms: Date.now() - t0 } };
  }
}

/**
 * Probe a page for owner-published markdown.
 * @param {string} url  the page URL
 * @param {{http: {get: Function}, timeoutMs?: number, signal?: AbortSignal, accept?: boolean, variant?: boolean}} opts
 * @returns {Promise<{candidates: Array<{how: 'variant'|'accept', url: string, finalUrl: string, status: number,
 *           contentType: string, headers: object, text: string, bytes: Buffer, ms: number}>,
 *           attempts: object[]}>}
 *   candidates are ordered variant first (an explicit file the owner published),
 *   then accept (may be CDN-generated).
 */
export async function probeOwnerMarkdown(url, { http, timeoutMs = PROBE_TIMEOUT_MS, signal, accept = true, variant = true, parallel = false } = {}) {
  const variants = variant ? markdownVariantUrls(url) : [];
  const acceptP = accept && !isMarkdownUrl(url) ? attempt(http, 'accept', url, timeoutMs, signal) : null;

  // parallel: every variant at once (the probe costs one round trip, not one per guess);
  // the first in order that hit wins, so the result is the same as the sequential form.
  const variantP = parallel ? (async () => {
    const all = await Promise.all(variants.map(v => attempt(http, 'variant', v, timeoutMs, signal)));
    const hit = all.findIndex(r => r.candidate);
    return hit === -1 ? all : all.slice(0, hit + 1);
  })()
  // The first variant runs alongside the Accept probe; alternates (trailing-slash
  // and .html forms) only when it missed, so a normal page costs one request.
  : (async () => {
    const tried = [];
    for (const v of variants) {
      const r = await attempt(http, 'variant', v, timeoutMs, signal);
      tried.push(r);
      if (r.candidate) break;
      // A server that is down or slow for one guess will be for the next too.
      if (r.attempt.status === 0) break;
    }
    return tried;
  })();

  const [acc, vars] = await Promise.all([acceptP, variantP]);
  const results = [...vars, ...(acc ? [acc] : [])];
  return {
    candidates: results.filter(r => r.candidate).map(r => r.candidate),
    attempts: results.map(r => r.attempt),
  };
}
