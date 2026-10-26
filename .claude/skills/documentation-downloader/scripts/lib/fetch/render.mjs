/**
 * Browser render: the DOM of a page after its JavaScript ran, with lazy content
 * expanded, as HTML. Conversion happens later, in Node, on this HTML.
 *
 *   const r = await renderPage(url, { browser: createLazyBrowser(chromium) });
 *   // → { status, finalUrl, contentType, text?, html, title, ms, expanded: {details, tabs, restored} }
 *
 * - One shared, lazily launched browser (lib/browser.mjs); a machine-wide browser
 *   slot (store/limits.mjs) is held only for the duration of each render.
 * - Images, media and fonts are blocked (the DOM is what we need).
 * - `goto` waits for DOMContentLoaded (the `load` event never fires on pages whose
 *   trackers hang behind a proxy), then until no request has been in flight for a
 *   moment (settle), then the page's clock is run ahead so timer-driven animations
 *   finish (fastForward). Transient
 *   navigation errors seen in practice (ERR_TOO_MANY_RETRIES from the egress proxy,
 *   connection resets, timeouts) are retried.
 * - JS / meta-refresh redirects are followed by the browser; capture waits for
 *   them to settle rather than reading a DOM mid-navigation.
 * - Expansion (generic, standards-based — DESIGN.md "Tabs"): every `<details>` is
 *   opened; ARIA tabs whose panel is missing or empty are clicked so the panel
 *   renders, and the panel HTML is kept even if the framework unmounts it when the
 *   next tab is clicked. Nothing is "restored" to the original selection.
 *
 * `setupContext(context)` lets a caller install routing first — the replay eval
 * serves the network from a recorded HAR this way.
 */

import { acquireBrowserSlot } from '../store/limits.mjs';
import { IS_CLOUD, launchedNetwork } from '../browser.mjs';
import { loadBlocker } from './blocklist.mjs';
import { chromeUserAgent } from './http.mjs';

export const RENDER_DEFAULTS = {
  navTimeoutMs: 45_000,
  idleMs: 5_000,
  // After DOMContentLoaded: no tracked request in flight for quietMs (requests open
  // longer than stuckMs stop counting), at most idleMs. Measured against Playwright's
  // 'networkidle' (fixed 500 ms window, counts every connection) on 59 live pages:
  // median −0.3 s per render, same output (eval/bench/render-ab.mjs).
  settle: 'net',
  quietMs: 250,
  stuckMs: 2_000,
  // Then run the page's timers ahead so timer-driven animations (typed-out
  // terminals) have finished: capture no longer depends on when it happens.
  fastForwardMs: 60_000,
  // Ads/analytics blocked by maintained filter lists (lib/fetch/blocklist.mjs): they
  // keep the network busy and never carry content. 82 corpus pages, twice: median
  // −176 ms (CI −322..−65), 0 outputs differ. DD_BLOCK_TRACKERS=0 turns it off.
  blockTrackers: true,
  // One browser context per host, reused (its HTTP cache keeps the site's CSS/JS
  // between pages): corpus median −348 ms per render; whole batches 82–105 s →
  // 65–67 s with identical output. DD_REUSE_CONTEXT=0 turns it off.
  reuseContext: true,
  navRetries: 2,
  expandBudgetMs: 6_000,
  maxTabClicks: 150,
  // Code samples switched by a <select> ("Select language") are expanded like tabs.
  expandSelects: true,
};

const TRANSIENT_NAV = /ERR_TOO_MANY_RETRIES|ERR_CONNECTION_(?:RESET|CLOSED|REFUSED|ABORTED)|ERR_NETWORK_CHANGED|ERR_TIMED_OUT|ERR_EMPTY_RESPONSE|ERR_HTTP2_PROTOCOL_ERROR|ERR_PROXY_CONNECTION_FAILED|Timeout \d+ms exceeded/;
const MID_NAVIGATION = /Execution context was destroyed|navigating|Target page, context or browser has been closed|frame was detached/i;

/**
 * Where the page's requests go. 'browser': Chromium's own network stack.
 * 'node': every request is re-issued by Playwright from Node (`route.fetch`) and
 * fulfilled into the page. Behind the Claude Code cloud egress proxy Chromium's
 * subresource requests fail slowly with ERR_TOO_MANY_RETRIES (measured on
 * docs.scipy.org: DOMContentLoaded after 34 s, vs 1.9 s via Node), so 'node' is
 * the fallback there. A full Chrome/Chromium launched with the TLS 1.2 pin goes
 * through the proxy itself at 1–3 s per page, so that is used whenever it
 * launched (lib/browser.mjs candidate `network`); a certificate error on the
 * browser's own network retries the page via Node.
 * Override with DD_RENDER_NETWORK=browser|node.
 */
export function defaultNetwork(env = process.env, launched = launchedNetwork()) {
  if (env.DD_RENDER_NETWORK === 'browser' || env.DD_RENDER_NETWORK === 'node') return env.DD_RENDER_NETWORK;
  if (!IS_CLOUD) return 'browser';
  // In the cloud it depends on the browser that launched (lib/browser.mjs): a full
  // browser with the TLS 1.2 pin goes through the egress proxy itself; the headless
  // shell cannot (it ignores the pin) and its requests are re-issued from Node.
  return launched ?? 'node';
}

export class RenderError extends Error {
  constructor(message, { url, cause } = {}) {
    super(message);
    this.name = 'RenderError';
    this.url = url;
    if (cause) this.cause = cause;
  }
}

/**
 * In-page expansion. Runs inside the browser (serialised by Playwright), so it
 * must be self-contained.
 */
async function expandInPage({ budgetMs, maxClicks, selects = true }) {
  const started = Date.now();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const stats = { details: 0, tabs: 0, restored: 0, ms: {} };
  let lap = Date.now();
  const time = (k) => { const n = Date.now(); stats.ms[k] = (stats.ms[k] || 0) + n - lap; lap = n; };

  // Every <details> is opened: some pages render a section's content only on open
  // (Shopify's webhooks page: 24% of its text). That can cost a lot on a huge page
  // (the same page: ~95 s of the page's own toggle handlers) — measured, and kept
  // for the content (eval/results/SPEED_LOG.md, H8).
  for (const d of document.querySelectorAll('details:not([open])')) {
    d.setAttribute('open', '');
    stats.details++;
  }
  time('details');

  const hasContent = (el) => !!el && ((el.textContent || '').trim().length > 0 ||
    !!el.querySelector('img,svg,video,iframe,pre,code,table,input,canvas'));
  const panelFor = (tab) => {
    const ids = (tab.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) return el;
    }
    if (tab.id) {
      const el = document.querySelector(`[role="tabpanel"][aria-labelledby~="${CSS.escape(tab.id)}"]`);
      if (el) return el;
    }
    return null;
  };
  const navigatesAway = (tab) => {
    const a = tab.closest('a[href]');
    if (!a) return false;
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#') || href.startsWith('javascript:')) return false;
    try {
      const u = new URL(href, location.href);
      return u.pathname !== location.pathname || u.search !== location.search;
    } catch { return true; }
  };

  // Which tabs show their own content right now. A panel element shared by
  // several tabs (one panel, content swapped on click) belongs to the selected one.
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const selected = (t) => t.getAttribute('aria-selected') === 'true';
  const owners = new Map(); // panel → tabs pointing at it
  for (const t of tabs) {
    const p = panelFor(t);
    if (p) owners.set(p, [...(owners.get(p) ?? []), t]);
  }
  const showsOwn = (t, p) => hasContent(p) && ((owners.get(p)?.length ?? 0) < 2 || selected(t));

  // Snapshot what is populated before anything is clicked (a framework that
  // unmounts inactive panels would otherwise lose the initially selected one),
  // then click each tab that does not show its own content yet. Most sites keep
  // every panel in the DOM (hidden): then nothing is clicked.
  const snapshots = new Map(); // tab → {panel, html}
  for (const t of tabs) {
    const p = panelFor(t);
    if (showsOwn(t, p)) snapshots.set(t, { panel: p, html: p.innerHTML });
  }
  time('snapshot');
  let clicks = 0;
  for (const tab of tabs) {
    if (Date.now() - started > budgetMs || clicks >= maxClicks) break;
    if (snapshots.has(tab) || selected(tab)) continue;
    if (tab.getAttribute('aria-disabled') === 'true' || tab.hasAttribute('disabled')) continue;
    if (navigatesAway(tab)) continue;
    const before = panelFor(tab)?.innerHTML ?? null;
    tab.click();
    clicks++;
    // Let the framework render the panel (a microtask for most, a frame or a
    // timer for some): wait for content that differs from what was there.
    for (let i = 0; i < 8; i++) {
      await sleep(i === 0 ? 30 : 80);
      const p = panelFor(tab);
      if (hasContent(p) && p.innerHTML !== before) break;
    }
    const panel = panelFor(tab);
    if (hasContent(panel) && panel.innerHTML !== before) snapshots.set(tab, { panel, html: panel.innerHTML });
  }
  stats.tabs = clicks;
  time('clicks');

  // Put back what clicking threw away: fill an emptied panel, or add a sibling
  // panel for a tab whose panel now shows another tab's content.
  for (const [tab, s] of snapshots) {
    const current = panelFor(tab);
    if (current && current.innerHTML === s.html) continue;
    if (current && !hasContent(current)) {
      current.innerHTML = s.html;
      stats.restored++;
      continue;
    }
    const anchor = current || s.panel;
    if (!anchor || !anchor.parentNode) continue;
    const el = document.createElement(anchor.tagName.toLowerCase() === 'section' ? 'section' : 'div');
    el.setAttribute('role', 'tabpanel');
    if (!tab.id) tab.id = `dd-tab-${Math.random().toString(36).slice(2, 10)}`;
    el.setAttribute('aria-labelledby', tab.id);
    el.setAttribute('hidden', '');
    el.setAttribute('data-dd-restored', '');
    el.innerHTML = s.html;
    anchor.parentNode.insertBefore(el, anchor.nextSibling);
    stats.restored++;
  }
  time('restore');
  stats.tabsFound = tabs.length;

  // Code samples switched by a <select> ("Select language": PHP / Python / cURL)
  // instead of tabs: the page shows one language; the others render on change.
  // Each option is selected in turn and the code it shows is kept, then the code
  // area is replaced by one ARIA tab panel per option (labelled with the option)
  // so the converter treats them like tabs. Only a select whose own block holds
  // code, outside site chrome, with options that are not links (version pickers
  // navigate away), and only when changing it changed the code.
  stats.selects = 0;
  const preIn = (el) => el.querySelector('pre');
  // The select's own block: the nearest ancestor holding code. A code switcher's block
  // is small (one sample, maybe a response); a version or page picker's block is the
  // whole article — those are left alone (changing them rewrites the page).
  const scopeOf = (sel) => {
    let a = sel.parentElement;
    for (let d = 0; a && d < 6; d++, a = a.parentElement) {
      if (!preIn(a)) continue;
      const small = a.querySelectorAll('pre').length <= 3 && !a.querySelector('h1,h2,h3,h4,h5,h6,article,main') &&
        a.querySelectorAll('select').length === 1;
      return small ? a : null;
    }
    return null;
  };
  const codeArea = (scope, sel) => {
    const pre = preIn(scope);
    if (!pre) return null;
    let c = pre;
    while (c.parentElement && c.parentElement !== scope && !c.parentElement.contains(sel)) c = c.parentElement;
    return c;
  };
  const setValue = (sel, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, value);
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // Frameworks re-render the whole block on change (the select and code area are new
  // elements), so both are looked up again, by the select's position, at every step.
  const nthSelect = (i) => document.querySelectorAll('select')[i] ?? null;
  const areaOf = (i) => { const s = nthSelect(i); const sc = s && scopeOf(s); return sc ? codeArea(sc, s) : null; };
  const selectCount = selects ? document.querySelectorAll('select').length : 0;
  const done = [];
  for (let i = 0; i < selectCount; i++) {
    if (Date.now() - started > budgetMs || clicks >= maxClicks) break;
    const sel = nthSelect(i);
    if (!sel || sel.disabled || sel.multiple || sel.closest('nav,header,footer,aside,form[action]')) continue;
    const options = [...sel.options].filter(o => !o.disabled && o.value !== '');
    if (options.length < 2 || options.length > 15) continue;
    if (options.some(o => /^(?:https?:|\/|\.\.?\/)/.test(o.value))) continue;
    if (!scopeOf(sel)) continue;
    const start = sel.value;
    const shown = new Map(); // option label → code-area HTML
    let lastHtml = areaOf(i)?.innerHTML ?? null;
    if (lastHtml == null) continue;
    const startLabel = (sel.selectedOptions[0]?.textContent || '').trim();
    if (startLabel) shown.set(startLabel, lastHtml);
    let changed = false;
    const selStarted = Date.now();
    for (const o of options.map(x => ({ value: x.value, label: (x.textContent || '').trim() }))) {
      if (o.value === start) continue;
      if (Date.now() - started > budgetMs || clicks >= maxClicks || Date.now() - selStarted > 1500) break;
      const s = nthSelect(i);
      if (!s) break;
      setValue(s, o.value);
      clicks++;
      let html = null;
      for (let k = 0; k < 8; k++) {
        await sleep(k === 0 ? 30 : 80);
        html = areaOf(i)?.innerHTML ?? null;
        if (html != null && html !== lastHtml) break;
      }
      if (html != null && html !== lastHtml) { changed = true; lastHtml = html; }
      if (o.label && html != null) shown.set(o.label, html);
    }
    if (!changed || shown.size < 2) { const s = nthSelect(i); if (s && s.value !== start) setValue(s, start); continue; }
    done.push({ i, shown });
  }
  // Replace each code area only after every select was visited (positions stay valid).
  for (const { i, shown } of done.reverse()) {
    const area = areaOf(i);
    if (!area || !area.parentNode) continue;
    const box = document.createElement('div');
    box.setAttribute('data-dd-select-tabs', '');
    const list = document.createElement('div');
    list.setAttribute('role', 'tablist');
    list.setAttribute('hidden', '');
    box.appendChild(list);
    for (const [label, html] of shown) {
      const id = `dd-sel-${Math.random().toString(36).slice(2, 10)}`;
      const t = document.createElement('span');
      t.setAttribute('role', 'tab');
      t.id = id;
      t.textContent = label;
      list.appendChild(t);
      const p = document.createElement('div');
      p.setAttribute('role', 'tabpanel');
      p.setAttribute('aria-labelledby', id);
      p.innerHTML = html;
      box.appendChild(p);
    }
    area.replaceWith(box);
    stats.selects++;
  }
  stats.tabs = clicks;
  time('selects');
  return stats;
}

/**
 * Replace each open shadow host's children with its rendered (composed) content:
 * the shadow tree with every <slot> swapped for the light nodes assigned to it
 * (or its fallback content). Deepest hosts first, so nested components are
 * already flat when their parent's shadow tree is copied. Runs in the page.
 */
function flattenShadowDom() {
  const hosts = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { hosts.push(el); walk(el.shadowRoot); }
    }
  };
  walk(document);
  let flattened = 0;
  for (const host of hosts.reverse()) {
    const sr = host.shadowRoot;
    if (!sr || !sr.childNodes.length) continue;
    const frag = document.createDocumentFragment();
    for (const c of Array.from(sr.childNodes)) {
      if (c.nodeName === 'STYLE' || c.nodeName === 'LINK' || c.nodeName === 'SCRIPT') continue;
      frag.appendChild(c.cloneNode(true));
    }
    const light = Array.from(host.childNodes);
    for (const slot of Array.from(frag.querySelectorAll('slot'))) {
      const name = slot.getAttribute('name');
      const assigned = light.filter(n => (name
        ? n.nodeType === 1 && n.getAttribute('slot') === name
        : !(n.nodeType === 1 && n.hasAttribute('slot')) && !(n.nodeType === 3 && !n.textContent.trim())));
      if (assigned.length) slot.replaceWith(...assigned);
      else slot.replaceWith(...Array.from(slot.childNodes));
    }
    host.replaceChildren(frag);
    flattened++;
  }
  return flattened;
}

/**
 * Render one page.
 * @param {string} url
 * @param {object} opts
 * @param {{get: () => Promise<import('playwright').Browser>}} opts.browser  lazy browser (lib/browser.mjs)
 * @param {(context: import('playwright').BrowserContext, url: string) => Promise<void>} [opts.setupContext]
 * @param {boolean|Function} [opts.slot=true]  hold a machine-wide browser slot (or pass an acquire function)
 * @param {'browser'|'node'} [opts.network]  see defaultNetwork(); use 'browser' when setupContext routes the network
 * @param {boolean} [opts.expand=true]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{status: number, finalUrl: string, contentType: string, text?: string, html: string, title: string, ms: number, expanded: object|null, navAttempts: number}>}
 * @throws {RenderError}
 */
export async function renderPage(url, opts) {
  // The network to use depends on which browser launched: launch (lazily) first.
  if (!opts.network) await opts.browser.get();
  const network = opts.network ?? defaultNetwork();
  let first;
  try {
    first = await renderOnce(url, { ...opts, network });
  } catch (err) {
    // A certificate the browser does not trust on its own network (a proxy that
    // intercepts TLS despite the pin): Node trusts the environment's CA bundle.
    if (network !== 'browser' || opts.network || !CERT_ERROR.test(String(err.message))) throw err;
    (opts.log ?? (() => {}))(`[render] ${String(err.message).match(CERT_ERROR)[0]} on the browser's network; retrying via node networking: ${url}`);
    const second = await renderOnce(url, { ...opts, network: 'node' });
    return { ...second, networkFallback: true };
  }
  // Some sites answer requests re-issued from Node (different TLS/header
  // fingerprint) with 400/403/429 while the browser's own request succeeds —
  // measured on developers.facebook.com (400) and github.com (403). Keep the
  // fast Node route by default and retry such pages once with browser networking.
  if (network === 'node' && REFUSED_FROM_NODE.has(first.status)) {
    (opts.log ?? (() => {}))(`[render] HTTP ${first.status} via node networking; retrying with browser networking: ${url}`);
    try {
      const second = await renderOnce(url, { ...opts, network: 'browser' });
      return { ...second, navAttempts: first.navAttempts + second.navAttempts, networkFallback: true };
    } catch {
      return first;
    }
  }
  return first;
}

const REFUSED_FROM_NODE = new Set([400, 401, 403, 429]);

/**
 * One browser context per host, reused across renders (its HTTP cache keeps the
 * site's CSS/JS between pages), recycled after POOL_MAX_USES pages. A retired
 * context closes once the renders still using it are done (pages of one host
 * render concurrently); the rest close with the browser.
 * @returns {Promise<{context: import('playwright').BrowserContext, release: () => Promise<void>}>}
 */
export const POOL_MAX_USES = 40;
const pools = new WeakMap(); // browser → Map(host → {context: Promise, uses, active, retired})
const closeEntry = (entry) => entry.context.then(c => c.close()).catch(() => {});
export async function pooledContext(browser, url, options) {
  let byHost = pools.get(browser);
  if (!byHost) pools.set(browser, byHost = new Map());
  let host;
  try { host = new URL(url).host; } catch { host = ''; }
  let entry = byHost.get(host);
  if (entry && entry.uses >= POOL_MAX_USES) {
    byHost.delete(host);
    entry.retired = true;
    if (entry.active === 0) closeEntry(entry);
    entry = null;
  }
  if (!entry) {
    entry = { context: browser.newContext(options), uses: 0, active: 0, retired: false };
    // A context that failed to open is not kept for the next render.
    entry.context.catch(() => { if (byHost.get(host) === entry) byHost.delete(host); });
    byHost.set(host, entry);
  }
  entry.uses++;
  entry.active++;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    entry.active--;
    if (entry.retired && entry.active === 0) await closeEntry(entry);
  };
  try {
    return { context: await entry.context, release };
  } catch (err) {
    await release();
    throw err;
  }
}
/** Resource types never loaded: the DOM is what is captured. */
const BLOCK_TYPES = ['image', 'media', 'font'];
/** Same registrable-ish site: the last two labels of the host (a.docs.x.com ~ x.com). */
function sameSite(a, b) {
  try {
    const s = (u) => new URL(u).hostname.split('.').slice(-2).join('.');
    return s(a) === s(b);
  } catch { return true; }
}

/**
 * Run the page's timers ahead (page.clock) so time-driven animations finish:
 * steps of stepMs of page time, until a step changes nothing in the DOM, the
 * page time reaches fastForwardMs, ffBudgetMs of real time is spent, or one step
 * took more than ffHeavyStepMs (busy interval timers make every step expensive
 * without an animation to finish). Cheap steps get the whole budget, so a typed
 * terminal completes even when the machine is loaded.
 */
async function fastForward(page, cfg) {
  const stepMs = cfg.ffStepMs ?? 2000, budget = cfg.ffBudgetMs ?? 1500, heavyStep = cfg.ffHeavyStepMs ?? 400;
  const started = Date.now();
  await page.evaluate(() => {
    window.__ddMut = 0;
    new MutationObserver((l) => { window.__ddMut += l.length; })
      .observe(document, { subtree: true, childList: true, characterData: true });
  }).catch(() => {});
  for (let t = 0; t < cfg.fastForwardMs && Date.now() - started < budget; t += stepMs) {
    const before = await page.evaluate(() => window.__ddMut).catch(() => null);
    const t = Date.now();
    await page.clock.runFor(stepMs).catch(() => {});
    const stepWall = Date.now() - t;
    const after = await page.evaluate(() => window.__ddMut).catch(() => null);
    if (before === null || after === before) break;
    // A step this slow is busy timers, not an animation near its end: stop.
    if (stepWall > heavyStep) break;
  }
}

/**
 * Wait for the page to finish building itself after DOMContentLoaded.
 *   'networkidle'  no requests for 500 ms (Playwright), at most idleMs
 *   'dom'          no DOM mutations for quietMs, at most idleMs
 *   'none'         capture at DOMContentLoaded
 */
async function settle(page, cfg) {
  const mode = cfg.settle ?? RENDER_DEFAULTS.settle;
  if (mode === 'none' || !(cfg.idleMs > 0)) return;
  if (mode === 'networkidle') {
    await page.waitForLoadState('networkidle', { timeout: cfg.idleMs }).catch(() => {});
    return;
  }
  if (mode === 'net') {
    // In-flight requests tracked since before navigation (page.__ddNet); settled when
    // none has been in flight for quietMs. A request open longer than stuckMs
    // (long-polling, a hung beacon) stops counting.
    const net = page.__ddNet;
    if (!net) return;
    const quietMs = cfg.quietMs ?? 250, stuckMs = cfg.stuckMs ?? 2000;
    const start = Date.now();
    // Quiet counts from when settling starts, never from before: scripts that run at
    // DOMContentLoaded (or timers fast-forwarded just now) start their requests next.
    await new Promise((resolve) => {
      const tick = () => {
        const now = Date.now();
        let live = 0;
        for (const t of net.inflight.values()) if (now - t < stuckMs) live++;
        if (live === 0 && now - Math.max(net.lastChange, start) >= quietMs) return resolve();
        if (now - start >= cfg.idleMs) return resolve();
        setTimeout(tick, 25);
      };
      tick();
    });
    return;
  }
  await page.evaluate(({ quietMs, maxMs }) => new Promise((resolve) => {
    const start = Date.now();
    let last = Date.now();
    const obs = new MutationObserver(() => { last = Date.now(); });
    obs.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    const tick = () => {
      const now = Date.now();
      if (now - last >= quietMs || now - start >= maxMs) { obs.disconnect(); resolve(); } else setTimeout(tick, 50);
    };
    setTimeout(tick, 50);
  }), { quietMs: cfg.quietMs ?? 300, maxMs: cfg.idleMs }).catch(() => {});
}
const CERT_ERROR = /ERR_CERT_[A-Z_]+|ERR_SSL_[A-Z_]+/;

async function renderOnce(url, opts) {
  const cfg = { ...RENDER_DEFAULTS, ...opts };
  const log = opts.log ?? (() => {});
  const t0 = Date.now();
  const acquire = cfg.slot === false ? null : (typeof cfg.slot === 'function' ? cfg.slot : acquireBrowserSlot);
  const held = acquire ? await acquire() : null;
  const phases = { slot: Date.now() - t0 };
  let tp = Date.now();
  const mark = (k) => { const n = Date.now(); phases[k] = (phases[k] || 0) + n - tp; tp = n; };
  let context;
  let releaseContext = null;
  let page;
  const pooled = !!cfg.reuseContext && process.env.DD_REUSE_CONTEXT !== '0' && !opts.setupContext;
  try {
    const browser = await opts.browser.get();
    // A desktop Chrome UA with the launched browser's own version: Chrome derives its
    // client-hint headers (sec-ch-ua) from its real version, and a UA that disagrees
    // with them looks like a bot. (Headless Chrome's default UA says "HeadlessChrome".)
    const major = /^(\d+)\./.exec(browser.version?.() ?? '')?.[1];
    const contextOptions = {
      userAgent: chromeUserAgent(major ? Number(major) : undefined),
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
      locale: 'en-US',
      viewport: { width: 1280, height: 1600 },
      // No ignoreHTTPSErrors: behind an intercepting proxy it turns a fast, clear
      // certificate error (which retries via Node) into loads of 30 s+.
    };
    if (pooled) ({ context, release: releaseContext } = await pooledContext(browser, url, contextOptions));
    else context = await browser.newContext(contextOptions);
    if (opts.setupContext) await opts.setupContext(context, url);
    page = await context.newPage();
    const viaNode = (cfg.network ?? defaultNetwork()) === 'node';
    if ((cfg.settle ?? RENDER_DEFAULTS.settle) === 'net') {
      const net = { inflight: new Map(), lastChange: Date.now(), started: 0 };
      const done = (r) => { if (net.inflight.delete(r)) net.lastChange = Date.now(); };
      page.on('request', (r) => {
        const type = r.resourceType();
        if (type === 'websocket' || type === 'eventsource' || (cfg.blockTypes ?? BLOCK_TYPES).includes(type)) return;
        net.inflight.set(r, Date.now()); net.lastChange = Date.now(); net.started++;
      });
      page.on('requestfinished', done);
      page.on('requestfailed', done);
      page.__ddNet = net;
    }
    const blocked = cfg.blockTrackers ? await loadBlocker() : null;
    await page.route('**/*', async (route) => {
      const type = route.request().resourceType();
      if ((cfg.blockTypes ?? BLOCK_TYPES).includes(type)) return route.abort();
      // Ads/analytics by maintained filter lists (never the page itself).
      if (blocked && type !== 'document' && blocked(route.request().url(), url, type)) return route.abort();
      // Experiment switch (eval/bench/render-ab.mjs): scripts/requests from another site.
      if (cfg.blockThirdParty && ['script', 'xhr', 'fetch', 'other'].includes(type) && !sameSite(route.request().url(), url)) return route.abort();
      // fallback() (not continue()) so routes installed by setupContext still apply.
      if (!viaNode) return route.fallback();
      try {
        // Redirects are passed back to the browser (maxRedirects 0) so it follows
        // them itself and page.url() is the real landing URL.
        const response = await route.fetch({ maxRedirects: 0, timeout: cfg.navTimeoutMs });
        return await route.fulfill({ response });
      } catch {
        return route.abort('failed').catch(() => {});
      }
    });

    // The last main-frame document response: after a JS redirect this is the
    // landing page's status, not the stub's.
    let lastDoc = null;
    page.on('response', (r) => {
      try {
        if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) lastDoc = r;
      } catch { /* frame gone */ }
    });

    // Timer-driven animations (typed-out terminals, carousels) remove and re-add text
    // over seconds: with a controllable clock they are fast-forwarded before capture.
    if (cfg.fastForwardMs) await page.clock.install().catch(() => {});
    mark('setup');
    let response = null;
    let navAttempts = 0;
    for (;;) {
      navAttempts++;
      try {
        response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
        break;
      } catch (err) {
        const msg = String(err.message);
        if (navAttempts > cfg.navRetries || !TRANSIENT_NAV.test(msg)) {
          throw new RenderError(`navigation failed: ${msg.split('\n')[0]}`, { url, cause: err });
        }
        log(`[render] retry ${navAttempts}/${cfg.navRetries} ${url}: ${msg.split('\n')[0]}`);
        await new Promise(r => setTimeout(r, 1500 * navAttempts));
      }
    }
    mark('nav');
    await settle(page, cfg);
    mark('idle');
    if (cfg.fastForwardMs) {
      const before = page.__ddNet?.started;
      await fastForward(page, cfg);
      mark('fastforward');
      // Timers just run may have started requests (data loaded after a delay):
      // settle again — only when they did (always, without request tracking).
      if (cfg.resettleAlways || !page.__ddNet || page.__ddNet.started !== before) {
        await settle(page, cfg);
        mark('idle');
      }
    }

    let expanded = null;
    let html = null;
    let title = '';
    // A JS/meta redirect may still be navigating: capture once the DOM is stable.
    for (let i = 0; i < 4; i++) {
      try {
        if (cfg.expand !== false && expanded === null) {
          expanded = await page.evaluate(expandInPage, { budgetMs: cfg.expandBudgetMs, maxClicks: cfg.maxTabClicks, selects: cfg.expandSelects });
          mark('expand');
        }
        // Web components render into shadow DOM, which page.content() omits
        // (MDN's code examples vanished once its scripts loaded). Flatten open
        // shadow roots into the light DOM first — the composed tree a reader sees.
        await page.evaluate(flattenShadowDom).catch(() => 0);
        html = await page.content();
        title = await page.title();
        mark('capture');
        break;
      } catch (err) {
        if (!MID_NAVIGATION.test(String(err.message)) || i === 3) throw err;
        expanded = null;
        await page.waitForLoadState('domcontentloaded', { timeout: cfg.navTimeoutMs }).catch(() => {});
        await settle(page, cfg);
      }
    }
    const doc = lastDoc ?? response;
    // A markdown or plain-text document (an `.md` / `llms.txt` URL): the browser shows it
    // in a <pre>; its body, byte for byte, is what the caller wants.
    let contentType = '';
    try { contentType = (await doc?.headerValue('content-type')) || ''; } catch { /* no headers */ }
    let text;
    if (/markdown|text\/plain/i.test(contentType)) text = await doc.text().catch(() => undefined);
    return {
      status: doc ? doc.status() : 0,
      finalUrl: page.url(),
      contentType,
      ...(text !== undefined ? { text } : {}),
      html,
      title,
      ms: Date.now() - t0,
      phases,
      expanded,
      navAttempts,
    };
  } catch (err) {
    if (err instanceof RenderError) throw err;
    throw new RenderError(`render failed: ${String(err.message).split('\n')[0]}`, { url, cause: err });
  } finally {
    if (pooled) {
      await page?.close().catch(() => {});
      await releaseContext?.();
    } else await context?.close().catch(() => {});
    await held?.release();
  }
}
