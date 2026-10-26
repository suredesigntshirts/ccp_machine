/**
 * Pipeline routing with fake http / browser / converter, and the batch layer
 * (skip-if-cached, per-URL dedupe, raw store, index hook). No network, no browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchPage, detectInterstitialHtml, getRawPage, convertHtml, DEFAULT_CONVERT_MODULE } from '../lib/fetch/pipeline.mjs';
import { fetchUrls, CacheLookup } from '../lib/fetch/batch.mjs';
import { readRawMap } from '../lib/store/raw.mjs';
import { writePage } from '../lib/store/pages.mjs';
import { splitPageIfLarge } from '../lib/store/split.mjs';
import placeholder from '../lib/convert/index.mjs';

const LONG = 'This paragraph is real documentation content that explains the API in detail. '.repeat(8);
const PAGE_HTML = `<!doctype html><html><head><title>Guide</title></head><body><nav>Home Docs</nav><main><h1>Guide</h1><p>${LONG}</p></main></body></html>`;
const OWNER_MD = `# Guide\n\n${LONG}\n\n- one\n- two\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n`;

/** Fake http: `pages` maps URL → {html} | {md} | {status, html} ; Accept decides markdown negotiation. */
function fakeHttp(pages) {
  const calls = [];
  return {
    calls,
    get: async (url, opts = {}) => {
      calls.push(url);
      const wantsMd = /markdown/.test(opts.accept || '') && !/html/.test(opts.accept || '');
      const p = pages[url];
      let res;
      if (!p) res = { status: 404, contentType: 'text/html', text: 'not found' };
      else if (p.throws) throw new Error(p.throws);
      else if (wantsMd && p.acceptMd) res = { status: 200, contentType: 'text/markdown', text: p.acceptMd };
      else if (p.md) res = { status: 200, contentType: 'text/markdown', text: p.md };
      else res = { status: p.status ?? 200, contentType: 'text/html; charset=utf-8', text: p.html, url: p.redirectTo };
      const out = { url: res.url ?? url, headers: {}, bytes: Buffer.from(res.text ?? ''), ...res };
      if (opts.want && !opts.want({ status: out.status, contentType: out.contentType, url: out.url })) return { ...out, text: '', skipped: true };
      return out;
    },
  };
}

function fakeRender(map) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = map[url];
    if (!r) throw new Error('navigation failed: net::ERR_NAME_NOT_RESOLVED');
    return { status: 200, finalUrl: url, title: '', ...r };
  };
  fn.calls = calls;
  return fn;
}

test('owner markdown accepted → no render, via markdown', async () => {
  const http = fakeHttp({
    'https://a.example/guide': { html: PAGE_HTML },
    'https://a.example/guide.md': { md: OWNER_MD },
  });
  const render = fakeRender({});
  const r = await fetchPage('https://a.example/guide', { http, render, convert: placeholder });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'markdown');
  assert.equal(r.route.source, 'markdown:variant');
  assert.equal(render.calls.length, 0, 'browser must not be used');
  // Owner markdown is kept verbatim apart from the cleanup's trailing-whitespace trim.
  assert.equal(r.markdown, OWNER_MD.replace(/[ \t]+$/gm, ''));
  assert.equal(r.title, 'Guide');
});

test('owner markdown rejected by assessOwner → rendered HTML is converted', async () => {
  const http = fakeHttp({ 'https://a.example/guide': { html: PAGE_HTML, acceptMd: OWNER_MD } });
  const render = fakeRender({ 'https://a.example/guide': { html: PAGE_HTML } });
  const convert = { ...placeholder, assessOwner: () => ({ use: false, reason: 'CDN-generated' }) };
  const r = await fetchPage('https://a.example/guide', { http, render, convert });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'html');
  assert.deepEqual(r.route.owner.map(o => [o.how, o.use]), [['accept', false]]);
  assert.equal(render.calls.length, 1);
  assert.match(r.markdown, /^# Guide/);
  assert.match(r.markdown, /real documentation content/);
  assert.equal(r.route.rawOnly.source, 'render', 'the raw-first counterfactual is recorded');
});

test('raw-first: the browser is skipped when chooseSource says the plain GET suffices', async () => {
  const http = fakeHttp({ 'https://a.example/guide': { html: PAGE_HTML } });
  const render = fakeRender({});
  const convert = { ...placeholder, chooseSource: ({ rendered }) => (rendered === undefined ? { source: 'raw', reason: 'static' } : { source: 'rendered', reason: '' }) };
  const r = await fetchPage('https://a.example/guide', { http, render, convert, rawFirst: true });
  assert.equal(r.ok, true);
  assert.equal(render.calls.length, 0);
  assert.equal(r.route.source, 'raw');
});

test('raw-first with the placeholder policy: substantial server HTML skips the browser, a shell does not', async () => {
  const big = PAGE_HTML.replace(`<p>${LONG}</p>`, `<p>${LONG}</p>`.repeat(5));
  const shell = '<html><body><div id="root"></div></body></html>';
  const http = fakeHttp({ 'https://a.example/big': { html: big }, 'https://a.example/app': { html: shell } });
  const render = fakeRender({ 'https://a.example/app': { html: big } });
  const r1 = await fetchPage('https://a.example/big', { http, render, convert: placeholder, rawFirst: true });
  assert.equal(r1.route.source, 'raw');
  assert.equal(render.calls.length, 0);
  const r2 = await fetchPage('https://a.example/app', { http, render, convert: placeholder, rawFirst: true });
  assert.equal(r2.ok, true);
  assert.equal(r2.route.source, 'rendered');
  assert.deepEqual(render.calls, ['https://a.example/app']);
});

test('render failure falls back to good server HTML', async () => {
  const http = fakeHttp({ 'https://a.example/guide': { html: PAGE_HTML } });
  const r = await fetchPage('https://a.example/guide', { http, render: fakeRender({}), convert: placeholder });
  assert.equal(r.ok, true);
  assert.equal(r.route.source, 'raw');
  assert.match(r.route.renderError, /ERR_NAME_NOT_RESOLVED/);
});

test('a broken client-side render loses to the server HTML (placeholder chooseSource)', async () => {
  const http = fakeHttp({ 'https://a.example/guide': { html: PAGE_HTML } });
  const broken = '<html><body><h2>Application error: a client-side exception has occurred</h2></body></html>';
  const r = await fetchPage('https://a.example/guide', { http, render: fakeRender({ 'https://a.example/guide': { html: broken } }), convert: placeholder });
  assert.equal(r.ok, true);
  assert.equal(r.route.source, 'raw');
});

test('bot-check pages are refused, never returned as content', async () => {
  const challenge = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cvId:"3"}</script>Enable JavaScript and cookies to continue</body></html>';
  const http = fakeHttp({ 'https://a.example/tok': { status: 403, html: challenge } });
  const r = await fetchPage('https://a.example/tok', { http, render: fakeRender({ 'https://a.example/tok': { html: challenge, status: 403 } }), convert: placeholder });
  assert.equal(r.ok, false);
  assert.match(r.reason, /bot check|interstitial/);

  // Render fails too (as for platform.openai.com in the corpus): still a bot-check refusal.
  const r2 = await fetchPage('https://a.example/tok', { http, render: fakeRender({}), convert: placeholder });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /bot check/);
});

test('HTTP errors and empty shells are refused', async () => {
  const http = fakeHttp({ 'https://a.example/gone': { status: 404, html: '<html><body><h1>Not Found</h1></body></html>' } });
  const r = await fetchPage('https://a.example/gone', { http, render: fakeRender({ 'https://a.example/gone': { status: 404, html: '<html><body><h1>Not Found</h1></body></html>' } }), convert: placeholder });
  assert.equal(r.ok, false);
  assert.match(r.reason, /404|not found/i);

  const shell = '<html><body><div id="root"></div><script>window.__DATA__={}</script></body></html>';
  const http2 = fakeHttp({ 'https://a.example/app': { html: shell } });
  const r2 = await fetchPage('https://a.example/app', { http: http2, render: fakeRender({ 'https://a.example/app': { html: shell } }), convert: placeholder });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /tiny-body|empty|no visible text|JS shell/);
});

test('a genuinely small page on a full HTML page is kept (not "tiny-body")', async () => {
  // googleapis.dev "Services" index: a heading and one link, inside a normal Sphinx page.
  const nav = `<nav>${'<a href="/x">Navigation entry for another page</a>'.repeat(40)}</nav>`;
  const html = `<html><body>${nav}<main><h1>Services</h1><ul><li><a href="/services/beta-analytics-data">BetaAnalyticsData service client</a></li></ul></main></body></html>`;
  const http = fakeHttp({ 'https://a.example/services': { html } });
  const r = await fetchPage('https://a.example/services', { http, render: fakeRender({ 'https://a.example/services': { html } }), convert: placeholder });
  assert.equal(r.ok, true, r.reason);
  assert.match(r.route.smallPage, /non-space/);
});

test('a redirect stub is followed by the plain GET; the target is probed and rendered', async () => {
  const stub = '<!doctype html><title>Redirecting…</title><meta http-equiv="refresh" content="0; url=../2.14/x.html">';
  const http = fakeHttp({
    'https://a.example/stable/x.html': { html: stub, md: undefined },
    'https://a.example/2.14/x.html': { html: PAGE_HTML },
  });
  const render = fakeRender({ 'https://a.example/2.14/x.html': { html: PAGE_HTML } });
  const r = await fetchPage('https://a.example/stable/x.html', { http, render, convert: placeholder });
  assert.equal(r.ok, true);
  assert.equal(r.finalUrl, 'https://a.example/2.14/x.html');
  assert.equal(r.route.stubHops, 1);
  assert.deepEqual(render.calls, ['https://a.example/2.14/x.html']);
  assert.ok(http.calls.includes('https://a.example/2.14/x.md'), 'owner markdown probed at the stub target');
});

test('getRawPage stops at a stub loop', async () => {
  const a = '<meta http-equiv="refresh" content="0; url=/b">';
  const b = '<meta http-equiv="refresh" content="0; url=/a">';
  const http = fakeHttp({ 'https://a.example/a': { html: a }, 'https://a.example/b': { html: b } });
  const r = await getRawPage('https://a.example/a', { http });
  assert.equal(r.hops.length, 1);
  assert.equal(r.finalUrl, 'https://a.example/b');
});

test('a URL that is itself markdown is used directly (llms.txt .md links)', async () => {
  const http = fakeHttp({ 'https://a.example/guide.md': { md: OWNER_MD } });
  const render = fakeRender({});
  const r = await fetchPage('https://a.example/guide.md', { http, render, convert: placeholder });
  assert.equal(r.ok, true);
  assert.equal(r.route.source, 'markdown:direct');
  assert.equal(render.calls.length, 0);
});

test('large pages convert in a worker thread with the same result', async () => {
  const args = { url: 'https://a.example/guide', finalUrl: 'https://a.example/guide', html: PAGE_HTML, siblings: [] };
  const inProcess = await placeholder.htmlToMarkdown(args);
  const inWorker = await convertHtml(placeholder, args, { module: DEFAULT_CONVERT_MODULE, minBytes: 0 });
  assert.deepEqual(inWorker, { markdown: inProcess.markdown, title: inProcess.title });

  const failing = 'data:text/javascript,export default { htmlToMarkdown() { throw new Error("boom") } }';
  await assert.rejects(convertHtml(placeholder, args, { module: failing, minBytes: 0 }), /boom/);
  // Below the threshold (or without a module) it stays in-process.
  assert.deepEqual(await convertHtml(placeholder, args, { module: failing }), inProcess);
});

test('detectInterstitialHtml: vendor markers, but not on a long real page', () => {
  assert.ok(detectInterstitialHtml('<html><head><title>Attention Required! | Cloudflare</title></head><body>blocked</body></html>'));
  assert.ok(detectInterstitialHtml('<div id="px-captcha"></div>'));
  assert.equal(detectInterstitialHtml(`<html><body>${'<p>Real text about Turnstile and captcha widgets.</p>'.repeat(200)}</body></html>`), null);
  assert.equal(detectInterstitialHtml(PAGE_HTML), null);
});

// ---------------------------------------------------------------------------
// Batch: cache checks, dedupe, raw store, hook
// ---------------------------------------------------------------------------

function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'dd-fetch-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('fetchUrls writes pages, stores raw bytes, calls the hook, then skips cached URLs', async () => {
  const ws = tempRoot();
  try {
    const http = fakeHttp({ 'https://a.example/guide': { html: PAGE_HTML } });
    const render = fakeRender({ 'https://a.example/guide': { html: PAGE_HTML } });
    const ctx = { http, render, convert: placeholder, root: ws.dir };
    const written = [];
    const r1 = await fetchUrls(['https://a.example/guide'], { root: ws.dir, ctx, onWritten: (paths) => written.push(...paths), lib: 'alib', version: '1.2' });
    assert.equal(r1[0].status, 'fetched');
    assert.deepEqual(written, [join(ws.dir, 'a.example/guide.md')]);
    const text = readFileSync(written[0], 'utf-8');
    assert.match(text, /^---\nSource: https:\/\/a\.example\/guide\n/);
    assert.match(text, /Via: html/);
    assert.match(text, /Library: alib/);
    assert.match(text, /DocsVersion: "?1\.2"?/);
    const kinds = (await readRawMap(ws.dir)).map(x => x.kind).sort();
    assert.deepEqual(kinds, ['html', 'rendered-html']);

    const r2 = await fetchUrls(['https://a.example/guide'], { root: ws.dir, ctx });
    assert.equal(r2[0].status, 'cached');
    assert.equal(render.calls.length, 1, 'second run fetched nothing');

    const r3 = await fetchUrls(['https://a.example/guide'], { root: ws.dir, ctx, force: true });
    assert.equal(r3[0].status, 'fetched');
  } finally { ws.cleanup(); }
});

test('a redirected URL is cached at its final path and found again by its Source', async () => {
  const ws = tempRoot();
  try {
    const stub = '<!doctype html><title>Redirecting…</title><meta http-equiv="refresh" content="0; url=/v2/page">';
    const http = fakeHttp({ 'https://a.example/stable/page': { html: stub }, 'https://a.example/v2/page': { html: PAGE_HTML } });
    const render = fakeRender({ 'https://a.example/v2/page': { html: PAGE_HTML } });
    const ctx = { http, render, convert: placeholder, root: ws.dir };
    const [r] = await fetchUrls(['https://a.example/stable/page'], { root: ws.dir, ctx });
    assert.equal(r.relPath, 'a.example/v2/page.md');
    assert.match(readFileSync(r.path, 'utf-8'), /Final: https:\/\/a\.example\/v2\/page/);
    const [again] = await fetchUrls(['https://a.example/stable/page'], { root: ws.dir, ctx });
    assert.equal(again.status, 'cached');
    assert.equal(again.path, r.path);
  } finally { ws.cleanup(); }
});

test('CacheLookup finds a page by Source: when the raw cache is gone', async () => {
  const ws = tempRoot();
  try {
    await writePage(ws.dir, 'https://a.example/new/place', OWNER_MD, { source: 'https://a.example/old/place' });
    assert.ok(!existsSync(join(ws.dir, '.cache', 'raw-map.jsonl')));
    const hit = await new CacheLookup(ws.dir).find('https://a.example/old/place');
    assert.equal(hit, join(ws.dir, 'a.example/new/place.md'));
    assert.equal(await new CacheLookup(ws.dir).find('https://a.example/other'), null);
  } finally { ws.cleanup(); }
});

test('CacheLookup: URLs mapping to one file are one page; a different query string is not', async () => {
  const ws = tempRoot();
  try {
    await writePage(ws.dir, 'https://a.example/guide/features.md', OWNER_MD);
    const lookup = new CacheLookup(ws.dir);
    const path = join(ws.dir, 'a.example/guide/features.md');
    assert.equal(await lookup.find('https://a.example/guide/features'), path, 'llms.txt .md link vs page URL');
    assert.equal(await lookup.find('https://a.example/guide/features/'), path);
    await writePage(ws.dir, 'https://a.example/list?page=1', OWNER_MD);
    assert.equal(await lookup.find('https://a.example/list?page=2'), null);
    assert.equal(await lookup.find('https://a.example/list?page=1&utm_source=x'), join(ws.dir, 'a.example/list.md'));
  } finally { ws.cleanup(); }
});

test('concurrent requests for one URL fetch it once (URL lock + re-check)', async () => {
  const ws = tempRoot();
  try {
    let renders = 0;
    const http = fakeHttp({ 'https://a.example/guide': { html: PAGE_HTML } });
    const render = async (url) => { renders++; await new Promise(r => setTimeout(r, 50)); return { status: 200, finalUrl: url, html: PAGE_HTML }; };
    const ctx = { http, render, convert: placeholder, root: ws.dir };
    const [a, b] = await Promise.all([
      fetchUrls(['https://a.example/guide'], { root: ws.dir, ctx }),
      fetchUrls(['https://a.example/guide'], { root: ws.dir, ctx }),
    ]);
    assert.deepEqual([a[0].status, b[0].status].sort(), ['cached', 'fetched']);
    assert.equal(renders, 1);
  } finally { ws.cleanup(); }
});

test('a failed fetch writes nothing', async () => {
  const ws = tempRoot();
  try {
    const http = fakeHttp({ 'https://a.example/x': { throws: 'ECONNRESET' } });
    const ctx = { http, render: fakeRender({}), convert: placeholder, root: ws.dir };
    const [r] = await fetchUrls(['https://a.example/x'], { root: ws.dir, ctx });
    assert.equal(r.status, 'failed');
    assert.ok(!existsSync(join(ws.dir, 'a.example')));
    assert.deepEqual(await readRawMap(ws.dir), []);
  } finally { ws.cleanup(); }
});

test('two URLs landing on one file: write + split are one critical section (no dangling index)', async () => {
  // `/guide` and `/guide/` hold different url locks but map to one file. Without
  // a lock over write AND split, W1 write, W2 write, W1 split, W2 split lets W2
  // read W1's index as "a small page" and delete every part it links to.
  const ws = tempRoot();
  try {
    const big = (word) => `<!doctype html><html><head><title>Guide</title></head><body><main><h1>Guide</h1>${
      Array.from({ length: 12 }, (_, i) => `<h2>Section ${i + 1}</h2><p>${`${word} `.repeat(3000)}</p>`).join('')}</main></body></html>`;
    const A = 'https://a.example/guide', B = 'https://a.example/guide/';
    const http = fakeHttp({ [A]: { html: big('alpha') }, [B]: { html: big('beta') } });
    const render = fakeRender({ [A]: { html: big('alpha') }, [B]: { html: big('beta') } });
    const ctx = { http, render, convert: placeholder, root: ws.dir };
    const events = [];
    let otherWrote;
    const secondWrite = new Promise(r => { otherWrote = r; });
    let writes = 0;
    const hooks = {
      // The first writer waits (bounded) for the second one to write before splitting —
      // the interleaving that corrupted the page, unless the lock keeps it out.
      afterWrite: async ({ url }) => {
        events.push(`write ${url}`);
        if (++writes === 1) await Promise.race([secondWrite, new Promise(r => setTimeout(r, 400))]);
        else otherWrote();
      },
      afterSplit: ({ url, split }) => { events.push(`split ${url} ${split.split}`); },
    };
    const [[ra], [rb]] = await Promise.all([
      fetchUrls([A], { root: ws.dir, ctx, hooks }),
      fetchUrls([B], { root: ws.dir, ctx, hooks }),
    ]);
    assert.equal(ra.status, 'fetched', ra.reason);
    assert.equal(rb.status, 'fetched', rb.reason);
    assert.equal(ra.path, rb.path);
    // Each write is followed by its own split before the other writer gets in.
    assert.match(events[0], /^write /);
    assert.equal(events[1].split(' ')[1], events[0].split(' ')[1], `interleaved: ${events.join(' | ')}`);
    assert.equal(events[1].split(' ')[2], 'true');
    assert.equal(events[3].split(' ')[2], 'true', 'the second writer split its own page, not an index');
    // The page on disk is a whole index: every part it links to exists.
    const index = readFileSync(ra.path, 'utf-8');
    const links = [...index.matchAll(/\]\((guide\.parts\/[^)]+)\)/g)].map(m => m[1]);
    assert.ok(links.length >= 2, index.slice(0, 400));
    for (const l of links) assert.ok(existsSync(join(ws.dir, 'a.example', l)), `dangling link ${l}`);
  } finally { ws.cleanup(); }
});

test('CacheLookup never returns a split part as the cached page', async () => {
  // Parts carry `Source: <url>#<anchor>`, which canonicalises to the page's URL.
  const ws = tempRoot();
  try {
    const big = `# Big\n\n${Array.from({ length: 12 }, (_, i) => `## Section ${i + 1}\n\n${'word '.repeat(3000)}\n\n`).join('')}`;
    const path = await writePage(ws.dir, 'https://a.example/new/big', big, { source: 'https://a.example/old/big' });
    // Split with the requested URL (as migrate's post-step did), so every part's
    // Source is https://a.example/old/big#… — the URL being looked up.
    const r = await splitPageIfLarge(path, { url: 'https://a.example/old/big', maxTokens: 5000 });
    assert.equal(r.split, true);
    const hit = await new CacheLookup(ws.dir).find('https://a.example/old/big');
    assert.equal(hit, path);
  } finally { ws.cleanup(); }
});

test('isTransientFailure: retry timeouts and burst refusals, never content refusals', async () => {
  const { isTransientFailure } = await import('../lib/fetch/batch.mjs');
  for (const r of ['plain GET failed: timed out after 30000 ms: https://x', 'HTTP 400', 'render failed: navigation failed: net::ERR_TOO_MANY_RETRIES', 'HTTP 429', 'HTTP 503'])
    assert.equal(isTransientFailure(r), true, r);
  for (const r of ['bot-check: Just a moment...', 'HTTP 404', 'almost no visible text (0 chars) — JS shell or blank render', 'tiny-body: 12 chars'])
    assert.equal(isTransientFailure(r), false, r);
});
