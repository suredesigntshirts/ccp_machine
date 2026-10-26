/**
 * Fetch one page: URL → verbatim markdown, or a refusal. DESIGN.md → "Fetch pipeline".
 *
 *   const ctx = createFetchContext({ root });
 *   const r = await fetchPage(url, ctx);
 *   // ok:  { ok: true, markdown, finalUrl, via: 'markdown'|'html'|'text', title, raw, timings, route }
 *   // not: { ok: false, reason, finalUrl?, raw, timings, route }
 *   await ctx.close();
 *
 * Steps:
 *   1. In parallel: the plain HTML GET (HTTP redirects and redirect stubs followed)
 *      and the owner-markdown probe (Accept: text/markdown, `<url>.md`).
 *   2. Owner markdown that `convert.assessOwner` accepts → `convert.cleanOwner` →
 *      done, without launching a browser.
 *   3. HTML. When `convert.chooseSource` says the plain GET already looks like the
 *      page, convert it first; with sourcePolicy 'auto' it is used as is only if
 *      this site's server HTML has been verified to convert like the render
 *      (lib/fetch/verdicts.mjs). Otherwise — or when the server HTML's conversion
 *      is refused — render in the browser (lazy, shared; per-render machine slot);
 *      a page rendered for verification also converts the server HTML and
 *      compares the two (lib/convert/compare.mjs). After rendering,
 *      `chooseSource` picks raw vs rendered HTML.
 *   4. `convert.htmlToMarkdown` → markdown. Bot checks, interstitials, error
 *      pages and empty shells are refused (HTML-level checks here + the store's
 *      `detectBadPage` on the markdown) — never returned as a page.
 *   5. With `ctx.root`, the raw bytes used are recorded via `storeRaw` so the
 *      page can be re-converted offline.
 *
 * Nothing here writes a page: the caller (commands/fetch.mjs) does, under the URL lock.
 *
 * ctx:
 *   http        {get(url, opts)} — lib/fetch/http.mjs shape (default: createHttp())
 *   render      (url) => Promise<{status, finalUrl, html, title}> — default: renderPage
 *               with ctx.browser (a lazy browser) and ctx.setupContext
 *   browser     lazy browser from lib/browser.mjs createLazyBrowser (used by the default render)
 *   convert     the conversion interface (lib/convert/index.mjs)
 *   root        cache root for storeRaw (optional)
 *   siblings    async (finalUrl) => Array<{url, html}> for template detection (optional)
 *   sourcePolicy  'auto' | 'render' | 'raw' | 'never' — see SOURCE_POLICIES (default
 *               'render'; `docs fetch` uses 'auto')
 *   verdicts    per-site raw-vs-render memory (lib/fetch/verdicts.mjs), for 'auto'
 *   rawFirst    legacy: true = sourcePolicy 'raw'
 *   keepSources return the raw / rendered HTML seen as `sources` (evals)
 *   verbose     also log owner-markdown probe misses
 *   convertModule  URL of the module exporting `convert` (default: the default
 *               converter's), so pages ≥ WORKER_MIN_BYTES convert in a worker thread;
 *               with a custom ctx.convert and no convertModule, conversion stays in-process
 *   workerMinBytes  override WORKER_MIN_BYTES
 *   log         (msg) => void
 */

import { detectBadPage } from '../store/quality.mjs';
import { storeRaw } from '../store/raw.mjs';
import { createHttp, ACCEPT } from './http.mjs';
import { probeOwnerMarkdown, isMarkdownUrl, PROBE_TIMEOUT_MS } from './probe.mjs';
import { renderPage } from './render.mjs';
import { detectRedirectStub, roughText } from './stub.mjs';
import { pageFeatures, createVerdictStore } from './verdicts.mjs';
import { compareConversions } from '../convert/compare.mjs';
import { chooseDescription } from '../convert/describe.mjs';
import { createLlmsIndex } from './llms-index.mjs';

export const MAX_STUB_HOPS = 3;
/** A converted page under the store's tiny-body limit is kept when its HTML has at least this much text… */
export const SMALL_PAGE_MIN_HTML_TEXT = 400;
/** …and the markdown itself has at least this many non-space characters. */
export const SMALL_PAGE_MIN_CHARS = 40;
export const RAW_TIMEOUT_MS = 30_000;
/** Pages larger than this are not converted twice just to verify a site's server HTML. */
export const VERIFY_MAX_BYTES = 3_000_000;

// ---------------------------------------------------------------------------
// HTML-level refusal checks (before conversion: a converter's content-root
// heuristics can make a challenge page look like prose)
// ---------------------------------------------------------------------------

const CHALLENGE_MARKERS = [
  /window\._cf_chl_opt|_cf_chl_opt\s*=/,            // Cloudflare managed challenge
  /<form[^>]+id=["']challenge-form/i,
  /captcha-delivery\.com|geo\.captcha-delivery/i,   // DataDome
  /<div[^>]+id=["']px-captcha/i,                    // PerimeterX / HUMAN
  /_Incapsula_Resource|incap_ses_/i,                // Imperva
  /awswaf\.com\/.*challenge|AwsWafIntegration/i,    // AWS WAF
];
const CHALLENGE_TITLE = /<title[^>]*>\s*(just a moment|attention required|access denied|security check|verif(?:y|ying) you are human|are you a robot|one more step|ddos-guard|checking your browser|please wait)/i;

/**
 * Is this HTML a bot-check / interstitial rather than the page?
 * @returns {null | {reason: 'interstitial', detail: string}}
 */
export function detectInterstitialHtml(html) {
  if (!html) return null;
  const text = roughText(html);
  if (text.length > 5000) return null; // a real page that merely embeds a widget
  for (const re of CHALLENGE_MARKERS) if (re.test(html)) return { reason: 'interstitial', detail: `HTML matches ${re.source.slice(0, 40)}` };
  if (CHALLENGE_TITLE.test(html)) return { reason: 'interstitial', detail: `title "${CHALLENGE_TITLE.exec(html)[1]}"` };
  return null;
}

// ---------------------------------------------------------------------------
// Raw GET with redirect-stub following
// ---------------------------------------------------------------------------

const looksHtmlType = (ct) => !ct || /html|xml/i.test(ct);

/**
 * Plain GET of a page, following HTTP redirects (fetch does) and redirect stubs
 * (meta refresh / location.replace / canonical on a tiny page), bounded and
 * loop-safe.
 * @returns {Promise<{ok: boolean, status: number, url: string, finalUrl: string, html: string|null,
 *   text: string|null, contentType: string, bytes: Buffer|null, hops: object[], error?: string, ms: number}>}
 */
export async function getRawPage(url, { http, signal, timeoutMs = RAW_TIMEOUT_MS, maxHops = MAX_STUB_HOPS } = {}) {
  const t0 = Date.now();
  const hops = [];
  const seen = new Set([stripHash(url)]);
  let current = url;
  for (;;) {
    let res;
    try {
      res = await http.get(current, { accept: ACCEPT.html, timeoutMs, signal });
    } catch (err) {
      return { ok: false, status: 0, url, finalUrl: current, html: null, text: null, contentType: '', bytes: null, hops, error: err.message, ms: Date.now() - t0 };
    }
    const base = {
      status: res.status, url, finalUrl: res.url || current, contentType: res.contentType || '',
      text: res.text, bytes: res.bytes ?? null, hops,
    };
    const isHtml = looksHtmlType(res.contentType) && !isMarkdownUrl(base.finalUrl);
    const ok = res.status >= 200 && res.status < 300;
    if (ok && isHtml && hops.length < maxHops) {
      const stub = detectRedirectStub(res.text, base.finalUrl);
      if (stub && !seen.has(stripHash(stub.target))) {
        hops.push({ from: base.finalUrl, to: stub.target, how: stub.how, status: res.status });
        seen.add(stripHash(stub.target));
        current = stub.target;
        continue;
      }
    }
    return { ...base, ok, html: isHtml ? res.text : null, ms: Date.now() - t0 };
  }
}

function stripHash(u) {
  try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u; }
}

/** Module URL of the default conversion interface (also loadable in a worker). */
export const DEFAULT_CONVERT_MODULE = new URL('../convert/index.mjs', import.meta.url).href;
/** Pages at least this large are converted in a worker thread (when the converter's module is known). */
export const WORKER_MIN_BYTES = 2_000_000;

/**
 * `htmlToMarkdown`, off the main thread for large pages: a big synchronous
 * conversion otherwise stalls every other page in flight and the timers that
 * keep this process's lock/slot files fresh (a 35 MB page took 6 min with the
 * placeholder converter, and cost another page its browser slot).
 */
export async function convertHtml(convert, args, { module = null, minBytes = WORKER_MIN_BYTES } = {}) {
  if (!module || args.html.length < minBytes) return convert.htmlToMarkdown(args);
  const { Worker } = await import('node:worker_threads');
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./convert-worker.mjs', import.meta.url), {
      workerData: { module, args },
      resourceLimits: { maxOldGenerationSizeMb: 8192 },
    });
    let settled = false;
    worker.once('message', (m) => {
      settled = true;
      if (m.ok) resolve(m.result); else reject(new Error(m.error));
    });
    worker.once('error', (err) => { if (!settled) { settled = true; reject(err); } });
    worker.once('exit', (code) => { if (!settled) { settled = true; reject(new Error(`conversion worker exited with code ${code}`)); } });
  });
}

/** The default converter, imported on first use (it pulls in Turndown). */
let defaultConvertP = null;
export function loadDefaultConvert() {
  defaultConvertP ??= import('../convert/index.mjs').then(m => m.default);
  return defaultConvertP;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Build a pipeline context with the real implementations. The browser is only
 * launched if a page needs rendering; call `close()` when done.
 * @param {{root?: string, http?: object, convert?: object, log?: Function, rawFirst?: boolean,
 *          sourcePolicy?: string, verdicts?: object, siblings?: Function, browser?: object}} [opts]
 */
export function createFetchContext(opts = {}) {
  let browser = opts.browser ?? null;
  const ctx = {
    http: opts.http ?? createHttp(),
    convert: opts.convert ?? null, // null → loadDefaultConvert() on first page
    convertModule: opts.convertModule ?? null,
    root: opts.root ?? null,
    siblings: opts.siblings ?? null,
    rawFirst: opts.rawFirst ?? false,
    sourcePolicy: opts.sourcePolicy ?? null,
    verdicts: opts.verdicts ?? createVerdictStore(opts.root ?? null),
    log: opts.log ?? (() => {}),
    // Page descriptions (lib/convert/describe.mjs); `descriptions: false` turns them off.
    descriptions: opts.descriptions ?? process.env.DD_DESCRIPTIONS !== '0',
    llms: null,
    get browser() {
      if (!browser) browser = lazyPlaywrightBrowser();
      return browser;
    },
    get browserLaunched() { return !!browser?.launched; },
    async close() { await browser?.close(); },
  };
  ctx.llms = opts.llms ?? createLlmsIndex({ http: ctx.http, root: ctx.root, log: (m) => ctx.log(m) });
  return ctx;
}

/** A createLazyBrowser whose playwright import is also deferred until first use. */
function lazyPlaywrightBrowser() {
  let inner = null;
  const load = async () => {
    if (!inner) {
      const [{ chromium }, { createLazyBrowser }] = await Promise.all([import('playwright'), import('../browser.mjs')]);
      inner = createLazyBrowser(chromium);
    }
    return inner;
  };
  return {
    get: async () => (await load()).get(),
    close: async () => { await inner?.close(); },
    get launched() { return !!inner?.launched; },
  };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * @param {string} url
 * @param {object} ctx  see the file header; `createFetchContext()` builds one
 * @returns {Promise<object>} see the file header
 */
export async function fetchPage(url, ctx) {
  const t0 = Date.now();
  const http = ctx.http ?? createHttp();
  const convert = ctx.convert ?? await loadDefaultConvert();
  const log = ctx.log ?? (() => {});
  const timings = {};
  const route = { owner: [], rendered: false, source: null, rawOnly: null, stubHops: 0 };
  const used = []; // raw records to store: {bytes, url, finalUrl, status, contentType, kind}
  const kept = {};  // with ctx.keepSources: the raw / rendered HTML seen (for evals)
  // Description sources: the site's llms.txt entry (looked up while the page downloads)
  // and the page's HTML <head> (server HTML, else the render).
  const describing = ctx.descriptions !== false && !!ctx.llms;
  const llmsP = describing ? ctx.llms.describe(url).catch(() => null) : null;
  let headHtml = null;

  const done = async (result) => {
    if (result.ok && describing) {
      const t = Date.now();
      const llms = await (result.finalUrl && result.finalUrl !== url ? ctx.llms.describe(url, result.finalUrl).catch(() => null) : llmsP);
      const d = await chooseDescription({
        llms, markdown: result.markdown, html: headHtml, title: result.title,
        // The site's default description: its home page's, or one already seen on a page
        // with another title.
        isSiteDefault: async (text) => {
          const page = result.finalUrl || url;
          if (await ctx.llms.isHomeDescription?.(page, text).catch(() => false)) return true;
          return ctx.verdicts?.metaSeen ? ctx.verdicts.metaSeen(page, text, result.title).catch(() => false) : false;
        },
      });
      result = { ...result, description: d.description, descriptionFrom: d.from };
      route.description = { from: d.from, rejected: d.rejected.map(r => `${r.from}: ${r.why}`) };
      timings.describe = Date.now() - t;
    }
    timings.total = Date.now() - t0;
    let raw = used.map(({ bytes, ...rec }) => ({ ...rec, size: bytes?.length ?? 0 }));
    if (result.ok && ctx.root) {
      const t = Date.now();
      raw = [];
      for (const { bytes, ...rec } of used) {
        if (!bytes?.length) continue;
        const sha256 = await storeRaw(ctx.root, bytes, rec);
        raw.push({ ...rec, sha256, size: bytes.length });
      }
      timings.store = Date.now() - t;
    }
    return { ...result, raw, timings, route, ...(ctx.keepSources ? { sources: kept } : {}) };
  };

  // 1. Plain GET and owner probe, in parallel.
  let t = Date.now();
  // Probes this site has shown to be worth sending (lib/fetch/verdicts.mjs probe memory).
  const probeMemory = ctx.verdicts && ctx.probeMemory !== false && process.env.DD_PROBE_MEMORY !== '0';
  const pp = probeMemory ? await ctx.verdicts.probePlan(url).catch(() => null) ?? { variant: true, accept: true } : { variant: true, accept: true };
  route.probePlan = pp.why ?? 'all';
  const rawP = getRawPage(url, { http, signal: ctx.signal }).then(r => { timings.raw = Date.now() - t; return r; });
  const probeP = probeOwnerMarkdown(url, { http, signal: ctx.signal, timeoutMs: ctx.probeTimeoutMs ?? PROBE_TIMEOUT_MS, parallel: ctx.probeParallel, variant: pp.variant, accept: pp.accept })
    .then(r => { timings.probe = Date.now() - t; return r; });
  const noteProbe = (used) => (probeMemory ? ctx.verdicts.recordProbe(url, { tried: { variant: pp.variant, accept: pp.accept }, used }).catch(() => {}) : null);
  const [raw, probe] = await Promise.all([rawP, probeP]);
  route.stubHops = raw.hops.length;
  if (raw.hops.length) log(`[stub] ${url} → ${raw.finalUrl} (${raw.hops.map(h => h.how).join(', ')})`);

  const candidates = [...probe.candidates];
  // The requested URL is itself markdown (e.g. a `.md` link from llms.txt).
  if (raw.ok && !raw.html && raw.text?.trim() && (isMarkdownUrl(raw.finalUrl) || /markdown|text\/plain/i.test(raw.contentType))) {
    candidates.unshift({ how: 'direct', url, finalUrl: raw.finalUrl, status: raw.status, contentType: raw.contentType, headers: {}, text: raw.text, bytes: raw.bytes });
  }
  // A stub pointed elsewhere: the owner markdown to look for is the target's.
  if (raw.hops.length) {
    t = Date.now();
    const again = await probeOwnerMarkdown(raw.finalUrl, { http, signal: ctx.signal, timeoutMs: ctx.probeTimeoutMs ?? PROBE_TIMEOUT_MS, parallel: ctx.probeParallel });
    timings.probe += Date.now() - t;
    candidates.unshift(...again.candidates);
  }

  const rawHtmlOk = raw.ok && !!raw.html;
  if (rawHtmlOk) headHtml = raw.html;
  const pageFinal = (cand) => (rawHtmlOk || raw.hops.length ? raw.finalUrl
    : cand.how === 'accept' || cand.rendered ? cand.finalUrl : url);

  // 2. Owner markdown.
  // The first usable candidate becomes the page (null: none was usable).
  const useOwner = async (cands) => {
    for (const cand of cands) {
      const finalUrl = pageFinal(cand);
      const verdict = await convert.assessOwner({
        url, finalUrl, how: cand.how, markdown: cand.text, contentType: cand.contentType,
        headers: cand.headers ?? {}, html: rawHtmlOk ? raw.html : null,
      });
      route.owner.push({ how: cand.how, url: cand.url, use: !!verdict.use, reason: verdict.reason });
      if (!verdict.use) continue;
      const cleaned = await convert.cleanOwner({ url, finalUrl, how: cand.how, markdown: cand.text });
      const bad = detectBadPage(cleaned.markdown);
      if (bad) {
        route.owner[route.owner.length - 1] = { ...route.owner.at(-1), use: false, reason: `after cleanup: ${bad.reason} (${bad.detail})` };
        continue;
      }
      timings.convert = Date.now() - t;
      used.push({ bytes: cand.bytes ?? Buffer.from(cand.text), url, finalUrl: cand.finalUrl, status: cand.status, contentType: cand.contentType, kind: `markdown-${cand.how}` });
      if (rawHtmlOk) used.push({ bytes: raw.bytes, url, finalUrl: raw.finalUrl, status: raw.status, contentType: raw.contentType, kind: 'html' });
      route.source = `markdown:${cand.how}`;
      await noteProbe(cand.how === 'variant' || cand.how === 'accept' ? cand.how : null);
      return done({ ok: true, markdown: cleaned.markdown, finalUrl, via: 'markdown', title: cleaned.title ?? null });
    }
    return null;
  };
  t = Date.now();
  const owned = await useOwner(candidates);
  if (owned) return owned;
  if (ctx.verbose) for (const a of probe.attempts) if (a.miss || a.error) log(`[probe] ${a.how} ${a.url}: ${a.miss || a.error}`);
  await noteProbe(null);

  // A text file that is not markdown (YAML, JSON, source code): the file itself, as
  // one code block. A browser would only show it in a <pre> — or download it.
  if (raw.ok && !raw.html && raw.text?.trim() && TEXT_FILE_TYPE.test(raw.contentType) && !detectInterstitialHtml(raw.text)) {
    const name = fileName(raw.finalUrl);
    used.push({ bytes: raw.bytes ?? Buffer.from(raw.text), url, finalUrl: raw.finalUrl, status: raw.status, contentType: raw.contentType, kind: 'text' });
    route.source = 'text';
    return done({ ok: true, markdown: codeFile(raw.text, name), finalUrl: raw.finalUrl, via: 'text', title: name });
  }

  // 3. HTML: the plain GET's, the browser render's, or both.
  const rawView = rawHtmlOk ? { html: raw.html, status: raw.status, finalUrl: raw.finalUrl } : null;
  kept.raw = rawView;
  const policy = sourcePolicy(ctx);
  let rendered = null;
  let renderError = null;

  // Raw first: when the server HTML already looks like the page, convert it and
  // decide from the result (and what this site has shown before) whether the
  // browser is needed at all.
  let rawConv = null;
  if (rawView) {
    route.rawOnly = await convert.chooseSource({ url, raw: { ...rawView, requestedUrl: url }, rendered: undefined });
    // Without a browser, the server HTML is all there is: try it whatever it looks like.
    let tryRaw = policy === 'never' || (policy !== 'render' && route.rawOnly?.source === 'raw');
    // 'auto': skip the extra conversion when it cannot be used — the site is known to
    // need the render, or the page is too big to be worth converting twice to verify.
    let pre = null;
    if (tryRaw && policy === 'auto' && ctx.verdicts) {
      pre = await ctx.verdicts.plan(rawView.finalUrl, {});
      route.scope = pre.scope;
      if (pre.plan === 'render') { route.plan = 'render'; tryRaw = false; }
      else if (pre.plan === 'verify' && rawView.html.length > VERIFY_MAX_BYTES) { route.plan = 'render (too large to verify)'; tryRaw = false; }
    }
    if (tryRaw) {
      t = Date.now();
      rawConv = await convertSource(rawView);
      timings.convertRaw = Date.now() - t;
      if (!rawConv.ok) {
        route.rawFallback = rawConv.reason;
        log(`[raw] ${url}: server HTML unusable (${rawConv.reason}); rendering`);
      } else {
        let plan = policy === 'auto' ? 'verify' : 'raw';
        if (pre) {
          // Features only matter for a trusted scope (a first page with code is verified).
          plan = pre.plan === 'raw' ? (await ctx.verdicts.plan(rawView.finalUrl, pageFeatures(rawConv.markdown))).plan : pre.plan;
        }
        route.plan = plan;
        if (plan === 'raw') {
          if (policy === 'auto') await ctx.verdicts?.noteRaw(rawView.finalUrl);
          return (await textDocument(rawView, rawConv)) ?? finishHtml(rawView, rawConv, 'raw');
        }
      }
    }
  }
  if (policy === 'never') {
    return done({ ok: false, reason: rawConv && !rawConv.ok ? `server HTML unusable (${rawConv.reason}); browser disabled`
      : `server HTML not enough without a browser (${route.rawOnly?.reason || raw.error || (raw.status >= 400 ? `HTTP ${raw.status}` : 'no HTML')}); browser disabled`,
    finalUrl: raw.finalUrl });
  }

  t = Date.now();
  // Render where the plain GET landed after stubs (the browser would follow them anyway).
  const target = raw.hops.length ? raw.finalUrl : url;
  try {
    rendered = ctx.render
      ? await ctx.render(target)
      : await renderPage(target, { browser: ctx.browser, setupContext: ctx.setupContext, log });
    route.rendered = true;
    // Page scripts often set a fragment (a scrolled-to section); it is not part of the page's URL.
    if (rendered?.finalUrl) rendered = { ...rendered, finalUrl: stripHash(rendered.finalUrl) };
  } catch (err) {
    renderError = err;
    route.renderError = String(err.message).split('\n')[0];
    log(`[render] ${target}: ${route.renderError}`);
  }
  timings.render = Date.now() - t;
  if (rendered?.phases) timings.renderPhases = rendered.phases;
  if (!headHtml && rendered?.html) headHtml = rendered.html;
  // The browser got a markdown or plain-text document (the plain GET was refused):
  // its body is the page itself, as it would have been from the plain GET — a
  // browser shows it in a <pre>, which would convert to one code block.
  if (rendered?.text?.trim() && rendered.status < 400 && /markdown|text\/plain/i.test(rendered.contentType || '')) {
    t = Date.now();
    const owned = await useOwner([{ how: 'direct', rendered: true, url, finalUrl: rendered.finalUrl, status: rendered.status, contentType: rendered.contentType, headers: {}, text: rendered.text }]);
    if (owned) return owned;
  }
  const renderedView = rendered ? { html: rendered.html, status: rendered.status, finalUrl: rendered.finalUrl } : null;
  kept.rendered = renderedView;
  let choice = await convert.chooseSource({ url, raw: rawView, rendered: renderedView });
  if (choice?.source === 'rendered' && !renderedView) choice = { source: null, reason: 'converter chose a render that failed' };
  if (choice?.source === 'raw' && !rawView) choice = { source: null, reason: 'converter chose missing server HTML' };

  const source = choice?.source === 'raw' ? rawView : choice?.source === 'rendered' ? renderedView : null;
  route.source = choice?.source ?? null;
  if (!source) {
    // Say why in terms of what was seen: a bot check or HTTP error beats "no source".
    const seen = raw.html || raw.text;
    const inter = detectInterstitialHtml(rendered?.html) || detectInterstitialHtml(seen);
    const reason = inter ? `bot check / interstitial (${inter.detail})`
      : renderError && raw.status >= 400 ? `HTTP ${raw.status}; render failed: ${route.renderError}`
      : renderError ? `render failed: ${route.renderError}${raw.error ? `; plain GET failed: ${raw.error}` : raw.status >= 400 ? `; plain GET HTTP ${raw.status}` : ''}`
      : raw.error ? `plain GET failed: ${raw.error}` : raw.status >= 400 ? `HTTP ${raw.status}` : (choice?.reason || 'no usable HTML');
    if (rawConv?.ok && route.plan === 'verify') await ctx.verdicts?.record(rawView.finalUrl, { inconclusive: true });
    return done({ ok: false, reason, finalUrl: rendered?.finalUrl ?? raw.finalUrl });
  }

  // 4. Convert (the server HTML's conversion is reused when it was already made).
  t = Date.now();
  const conv = source === rawView && rawConv ? rawConv : await convertSource(source);
  timings.convert = Date.now() - t;

  // Verification: did the server HTML convert to the same page as the render?
  if (rawConv?.ok && route.plan === 'verify' && ctx.verdicts) {
    if (source === renderedView && conv.ok) {
      const cmp = compareConversions(rawConv.markdown, conv.markdown);
      route.verify = { same: cmp.same, reason: cmp.reason };
      await ctx.verdicts.record(rawView.finalUrl, { agree: cmp.same, reason: cmp.reason, features: pageFeatures(rawConv.markdown) });
      if (!cmp.same) log(`[raw] ${route.scope}: server HTML differs from the render (${cmp.reason}); this site will be rendered`);
    } else {
      // The render itself was unusable (error page, failed): says nothing about the server HTML.
      route.verify = { inconclusive: true };
      await ctx.verdicts.record(rawView.finalUrl, { inconclusive: true });
    }
  }
  return (await textDocument(source, conv)) ?? finishHtml(source, conv, source === rawView ? 'raw' : 'rendered');

  /** Refusal checks + conversion of one HTML source → {ok, markdown, title} | {ok: false, reason}. */
  async function convertSource(src) {
    const inter = detectInterstitialHtml(src.html);
    if (inter) return { ok: false, reason: `bot check / interstitial (${inter.detail})` };
    if (src.status >= 400) return { ok: false, reason: `HTTP ${src.status}` };
    const residualStub = detectRedirectStub(src.html, src.finalUrl);
    if (residualStub) return { ok: false, reason: `redirect stub to ${residualStub.target} not resolved` };
    let siblings = [];
    if (ctx.siblings) {
      try { siblings = (await ctx.siblings(src.finalUrl)) ?? []; } catch (err) { log(`[siblings] ${err.message}`); }
    }
    let out;
    try {
      const module = ctx.convertModule ?? (ctx.convert ? null : DEFAULT_CONVERT_MODULE);
      out = await convertHtml(convert, { url, finalUrl: src.finalUrl, html: src.html, siblings },
        { module, minBytes: ctx.workerMinBytes ?? WORKER_MIN_BYTES });
    } catch (err) {
      return { ok: false, reason: `conversion failed: ${err.message}` };
    }
    const markdown = typeof out === 'string' ? out : out?.markdown;
    let bad = markdown ? detectBadPage(markdown) : { reason: 'empty', detail: 'converter returned nothing' };
    // A genuinely small page (an index that is a heading and a few links) on an
    // otherwise full HTML page is content; "tiny" means an empty shell only when
    // the page itself has next to no text.
    let smallPage = null;
    if (bad?.reason === 'tiny-body' && roughText(src.html).length >= SMALL_PAGE_MIN_HTML_TEXT
        && markdown.replace(/^---[\s\S]*?\n---\s*\n/, '').replace(/\s+/g, '').length >= SMALL_PAGE_MIN_CHARS) {
      smallPage = bad.detail;
      bad = null;
    }
    if (bad) return { ok: false, reason: `${bad.reason}: ${bad.detail}` };
    return { ok: true, markdown, title: out?.title ?? null, smallPage };
  }

  /**
   * A text file served as an HTML page that is only that text in a <pre> (a site
   * wrapping its `llms.txt` / `.md` for browsers): the text is the document. Its
   * conversion would be one code block holding the whole page.
   */
  async function textDocument(src, c) {
    if (!c.ok || !TEXT_FILE_PATH.test(pathOf(src.finalUrl))) return null;
    const text = soleFence(c.markdown);
    if (!text?.trim()) return null;
    return useOwner([{ how: 'direct', rendered: true, url, finalUrl: src.finalUrl, status: src.status, contentType: 'text/markdown', headers: {}, text }]);
  }

  /** 5. The result, with the raw bytes used recorded for offline re-conversion. */
  function finishHtml(src, c, which) {
    route.source = which;
    if (!c.ok) return done({ ok: false, reason: c.reason, finalUrl: src.finalUrl });
    if (c.smallPage) route.smallPage = c.smallPage;
    if (rawHtmlOk) used.push({ bytes: raw.bytes ?? Buffer.from(raw.html), url, finalUrl: raw.finalUrl, status: raw.status, contentType: raw.contentType, kind: 'html' });
    // The render is kept only when it is what the page was made from: the server
    // HTML is already stored, and a second full copy doubles the raw store.
    if (rendered && which === 'rendered') used.push({ bytes: Buffer.from(rendered.html), url, finalUrl: rendered.finalUrl, status: rendered.status, contentType: 'text/html', kind: 'rendered-html' });
    return done({ ok: true, markdown: c.markdown, finalUrl: src.finalUrl, via: 'html', title: c.title });
  }
}

/** Content types of files kept verbatim as a code block (HTML and markdown are converted). */
const TEXT_FILE_TYPE = /^\s*(text\/(?!html|markdown|x-markdown)|application\/(json|[\w.+-]*\+json|(x-)?yaml|xml|[\w.+-]*\+xml|(x-)?javascript|ecmascript|toml|x-sh|x-python|graphql|sql))/i;
const FENCE_LANG = { yaml: 'yaml', yml: 'yaml', json: 'json', jsonl: 'json', py: 'python', ts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', xml: 'xml', toml: 'toml', sh: 'bash', bash: 'bash', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', sql: 'sql', graphql: 'graphql', gql: 'graphql', css: 'css', ini: 'ini', cfg: 'ini', rst: 'rst', proto: 'protobuf' };
const fileName = (u) => { try { return decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || new URL(u).hostname); } catch { return u; } };
/** A file's text as one fenced block, fenced longer than any backtick run inside it. */
export function codeFile(text, name = '') {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(r => r.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${FENCE_LANG[ext] ?? ''}\n${text.replace(/\n+$/, '')}\n${fence}\n`;
}

const TEXT_FILE_PATH = /\.(mdx?|markdown|txt)$/i;
const pathOf = (u) => { try { return new URL(u).pathname; } catch { return ''; } };

/**
 * The contents of a markdown document that is a single fenced code block,
 * optionally under one H1 (the converter's title): else null.
 */
export function soleFence(markdown) {
  const lines = markdown.replace(/^---\n[\s\S]*?\n---\s*\n/, '').split('\n');
  let i = 0;
  const skipBlank = () => { while (i < lines.length && !lines[i].trim()) i++; };
  skipBlank();
  if (/^# /.test(lines[i] ?? '')) { i++; skipBlank(); }
  const open = /^(`{3,}|~{3,})[^`]*$/.exec(lines[i] ?? '');
  if (!open) return null;
  const fence = open[1];
  const start = ++i;
  while (i < lines.length && !(lines[i].startsWith(fence[0].repeat(fence.length)) && !lines[i].replace(/[`~]/g, '').trim())) i++;
  if (i >= lines.length) return null;
  const inner = lines.slice(start, i).join('\n');
  i++;
  skipBlank();
  return i >= lines.length ? inner : null;
}

/**
 * Where a page's HTML may come from:
 *   'render'  always the browser render (server HTML only when the render is broken)
 *   'auto'    the plain GET when it looks like the page AND this site's server HTML has
 *             been verified against the render (lib/fetch/verdicts.mjs); else render
 *   'raw'     the plain GET whenever it looks like the page, unverified
 *   'never'   never launch a browser
 */
export const SOURCE_POLICIES = ['auto', 'render', 'raw', 'never'];
function sourcePolicy(ctx) {
  if (ctx.sourcePolicy) return ctx.sourcePolicy;
  return ctx.rawFirst ? 'raw' : 'render';
}
