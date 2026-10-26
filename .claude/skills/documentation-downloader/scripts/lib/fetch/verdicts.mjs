/**
 * Per-site memory of "does the plain GET convert to the same page as the browser
 * render?" — what lets `docs fetch` skip the browser safely (DESIGN.md "Fetch
 * pipeline" → raw-first).
 *
 * A docs site is built by one generator, so what holds for a couple of its pages
 * holds for the rest. The unit is a *scope*: host + first path segment
 * (`developers.google.com/google-ads`), because one host can serve different
 * generators under different top-level paths.
 *
 * For each page whose server HTML already looks like content, the pipeline asks
 * `plan(scope, features)`:
 *
 *   'verify'  render too, convert both, compare (lib/convert/compare.mjs), `record` it
 *   'raw'     use the plain GET's conversion, no browser
 *   'render'  the scope's server HTML was shown to differ: always render
 *
 * Rules:
 *   - a scope is trusted after AGREE_TO_TRUST agreeing pages and no disagreement;
 *   - one disagreement makes it render-only (until the verdict expires);
 *   - a page with a feature no verified page of the scope had (code blocks,
 *     tables) is verified first — "same on prose pages" says nothing about code;
 *   - every SPOT_CHECK_EVERY-th raw page of a trusted scope is verified again;
 *   - verdicts expire after MAX_AGE_DAYS (sites change generators).
 *   A render that was itself unusable (error page, failed) is inconclusive.
 *
 * Stored per host in `<root>/.cache/sources/<host>.json` (derived, gitignored),
 * read-modify-written under a per-host lock; without a root, in memory only.
 */

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../store/atomic.mjs';
import { withGlobalLock } from '../store/locks.mjs';

export const AGREE_TO_TRUST = 2;
export const SPOT_CHECK_EVERY = 20;
export const MAX_AGE_DAYS = 30;
const FEATURES = ['code', 'table'];

/*
 * Owner-markdown probe memory, per scope. Most sites publish no markdown, and each
 * probe is a request to the site (Accept: text/markdown, up to 3 `.md` guesses)
 * against its per-host request budget. After PROBE_LEARN pages a probe kind that
 * never produced the markdown used for a page is skipped, except on every
 * PROBE_SPOT-th page (a site that starts publishing is noticed); the memory expires
 * with the source verdicts (MAX_AGE_DAYS).
 */
export const PROBE_LEARN = 3;
export const PROBE_SPOT = 10;

export function probePlanFor(p, now = Date.now()) {
  if (!p || p.seen < PROBE_LEARN || !fresh(p, now)) return { variant: true, accept: true, why: 'learning' };
  const spot = (p.skipped ?? 0) + 1 >= PROBE_SPOT;
  return { variant: spot || p.used.variant > 0, accept: spot || p.used.accept > 0, why: spot ? 'spot check' : 'learned' };
}

export function applyProbe(p, { tried, used }, now = Date.now()) {
  const s = p && fresh(p, now) ? { ...p, used: { ...p.used } } : { seen: 0, used: { variant: 0, accept: 0 }, skipped: 0, at: new Date(now).toISOString() };
  if (used === 'variant' || used === 'accept') s.used[used]++;
  if (tried.variant && tried.accept) { s.seen++; s.skipped = 0; } else s.skipped = (s.skipped ?? 0) + 1;
  return s;
}

export function sourceScope(url) {
  try {
    const u = new URL(url);
    const host = u.host.toLowerCase().replace(/^www\./, '');
    const first = u.pathname.split('/').filter(Boolean)[0] ?? '';
    // A last segment with an extension is a page, not a section (`/index.html`).
    const seg = first && !(u.pathname.split('/').filter(Boolean).length === 1 && /\.\w{2,5}$/.test(first)) ? first : '';
    return { host, key: `${host}/${seg}` };
  } catch { return null; }
}

/** Which verifiable features a converted page has. */
export function pageFeatures(markdown = '') {
  return {
    code: /^\s{0,3}(```|~~~)/m.test(markdown),
    table: /^\s*\|.*\|\s*$\n^\s*\|?\s*:?-{3,}/m.test(markdown) || /<table[\s>]/i.test(markdown),
  };
}

const fresh = (s, now) => s && (!s.at || now - Date.parse(s.at) < MAX_AGE_DAYS * 86_400_000);

/** Pure decision (exported for tests). */
export function planFor(state, features = {}, now = Date.now()) {
  if (!fresh(state, now)) return 'verify';
  if (state.verdict === 'render') return 'render';
  if (state.verdict !== 'raw') return 'verify';
  for (const f of FEATURES) if (features[f] && !state.verified?.[f]) return 'verify';
  if ((state.rawSince ?? 0) + 1 >= SPOT_CHECK_EVERY) return 'verify';
  return 'raw';
}

/** Pure update after a comparison (exported for tests). */
export function applyResult(state, { agree, inconclusive, features = {}, reason = null, url = null }, now = Date.now()) {
  const s = fresh(state, now) ? { ...state, verified: { ...(state.verified || {}) } } : { verdict: null, agreed: 0, verified: {}, rawSince: 0 };
  if (inconclusive) return s;
  s.at = new Date(now).toISOString();
  s.rawSince = 0;
  if (!agree) {
    return { ...s, verdict: 'render', reason, disagreedOn: url };
  }
  s.agreed = (s.agreed ?? 0) + 1;
  for (const f of FEATURES) if (features[f]) s.verified[f] = true;
  if (s.verdict !== 'render' && s.agreed >= AGREE_TO_TRUST) s.verdict = 'raw';
  return s;
}

/**
 * @param {string|null} root  cache root, or null for an in-memory store
 */
const DEFAULT_META = '*';
const MAX_META = 2000; // remembered descriptions per host (oldest page-specific ones go first)

export function createVerdictStore(root = null) {
  const mem = new Map(); // host → {scopes}
  const file = (host) => join(root, '.cache', 'sources', `${host.replace(/[^\w.-]/g, '_')}.json`);

  async function load(host) {
    if (!root) return mem.get(host) ?? { scopes: {} };
    try { return JSON.parse(await fsp.readFile(file(host), 'utf-8')); } catch { return { scopes: {} }; }
  }
  async function update(host, fn) {
    const run = async () => {
      const data = await load(host);
      data.scopes ??= {};
      fn(data.scopes, data);
      if (root) {
        await fsp.mkdir(join(root, '.cache', 'sources'), { recursive: true });
        await writeFileAtomic(file(host), JSON.stringify(data, null, 1) + '\n');
      } else mem.set(host, data);
    };
    if (!root) return run();
    // Lost updates only cost an extra verification; a short wait is plenty.
    try { return await withGlobalLock(root, `sources-${host}`, run, { waitMs: 5000 }); } catch { /* busy: skip */ }
  }

  return {
    async plan(url, features) {
      const sc = sourceScope(url);
      if (!sc) return { plan: 'render', scope: null };
      const data = await load(sc.host);
      const state = data.scopes?.[sc.key];
      return { plan: planFor(state, features), scope: sc.key, state: state ?? null };
    },
    async record(url, result) {
      const sc = sourceScope(url);
      if (!sc) return;
      await update(sc.host, (scopes) => { scopes[sc.key] = applyResult(scopes[sc.key], { ...result, url }); });
    },
    /** Which owner-markdown probes to send for a page of this scope. */
    async probePlan(url) {
      const sc = sourceScope(url);
      if (!sc) return { variant: true, accept: true, why: 'no scope' };
      const data = await load(sc.host);
      return probePlanFor(data.probes?.[sc.key]);
    },
    /** What the probes sent for a page found: `used` = 'variant' | 'accept' | null. */
    async recordProbe(url, { tried, used }) {
      const sc = sourceScope(url);
      if (!sc) return;
      await update(sc.host, (_scopes, data) => {
        data.probes ??= {};
        data.probes[sc.key] = applyProbe(data.probes[sc.key], { tried, used });
      });
    },
    /**
     * Description defaults: is this meta description one the site puts on pages with
     * other titles (its default, not this page's)? Remembers each description with the
     * title it was seen on; a second title marks it as the site's default for good.
     */
    async metaSeen(url, text, title) {
      const host = sourceScope(url)?.host;
      if (!host) return false;
      const key = String(text).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);
      const t = String(title ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
      const prior = (await load(host)).meta?.[key];
      if (prior === DEFAULT_META) return true;
      if (prior !== undefined && prior !== t) {
        await update(host, (_s, data) => { (data.meta ??= {})[key] = DEFAULT_META; });
        return true;
      }
      if (prior === undefined) {
        await update(host, (_s, data) => {
          data.meta ??= {};
          const keys = Object.keys(data.meta);
          if (keys.length >= MAX_META) for (const k of keys.slice(0, keys.length - MAX_META + 1)) if (data.meta[k] !== DEFAULT_META) delete data.meta[k];
          data.meta[key] ??= t;
        });
      }
      return false;
    },
    async noteRaw(url) {
      const sc = sourceScope(url);
      if (!sc) return;
      await update(sc.host, (scopes) => {
        const s = scopes[sc.key];
        if (s) scopes[sc.key] = { ...s, rawSince: (s.rawSince ?? 0) + 1 };
      });
    },
  };
}
