/**
 * HTTP client (retries, Retry-After, body skipping), redirect-stub detection
 * and the owner-markdown probe. No network: fake transports only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHttp, retryAfterMs, USER_AGENT, CHROME_MAJOR, chromeHeaders, chromeUserAgent } from '../lib/fetch/http.mjs';
import { detectRedirectStub } from '../lib/fetch/stub.mjs';
import { markdownVariantUrls, probeOwnerMarkdown, probeMiss, isMarkdownUrl } from '../lib/fetch/probe.mjs';

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

function scriptedFetch(steps) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    const res = new Response(step.body ?? '', { status: step.status ?? 200, headers: step.headers ?? {} });
    Object.defineProperty(res, 'url', { value: step.url ?? url });
    return res;
  };
  fn.calls = calls;
  return fn;
}

test('http.get returns status, final URL, headers and decoded text', async () => {
  const fetch = scriptedFetch([{ body: 'héllo', headers: { 'content-type': 'text/plain; charset=utf-8' }, url: 'https://a.example/final' }]);
  const http = createHttp({ fetch, polite: false });
  const r = await http.get('https://a.example/start', { accept: 'text/plain' });
  assert.equal(r.status, 200);
  assert.equal(r.url, 'https://a.example/final');
  assert.equal(r.text, 'héllo');
  assert.equal(r.contentType, 'text/plain; charset=utf-8');
  assert.equal(fetch.calls[0].init.headers.Accept, 'text/plain');
  assert.match(fetch.calls[0].init.headers['User-Agent'], /Mozilla/);
});

test('http.get honours Retry-After on 429, then succeeds', async () => {
  const waits = [];
  const fetch = scriptedFetch([{ status: 429, headers: { 'retry-after': '2' } }, { body: 'ok' }]);
  const http = createHttp({ fetch, polite: false, sleep: async (ms) => { waits.push(ms); } });
  const r = await http.get('https://a.example/x');
  assert.equal(r.status, 200);
  assert.deepEqual(waits, [2000]);
});

test('http.get does not wait out a Retry-After longer than the cap', async () => {
  const fetch = scriptedFetch([{ status: 429, headers: { 'retry-after': '3600' } }, { body: 'ok' }]);
  const http = createHttp({ fetch, polite: false, sleep: async () => {} });
  const r = await http.get('https://a.example/x');
  assert.equal(r.status, 429);
  assert.equal(fetch.calls.length, 1);
});

test('http.get retries transient network errors, a bounded number of times', async () => {
  const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  const ok = scriptedFetch([reset, { body: 'ok' }]);
  assert.equal((await createHttp({ fetch: ok, polite: false, sleep: async () => {} }).get('https://a.example/x')).status, 200);

  const never = scriptedFetch([reset]);
  await assert.rejects(createHttp({ fetch: never, polite: false, retries: 2, sleep: async () => {} }).get('https://a.example/x'),
    (err) => err.name === 'HttpError' && /ECONNRESET/.test(err.message));
  assert.equal(never.calls.length, 3);
});

test('http.get returns a 404 as data and does not retry it', async () => {
  const fetch = scriptedFetch([{ status: 404, body: 'nope' }]);
  const r = await createHttp({ fetch, polite: false }).get('https://a.example/x');
  assert.equal(r.status, 404);
  assert.equal(fetch.calls.length, 1);
});

test('http.get skips the body when `want` says no', async () => {
  const fetch = scriptedFetch([{ body: '<html>big</html>', headers: { 'content-type': 'text/html' } }]);
  const r = await createHttp({ fetch, polite: false }).get('https://a.example/x', { want: ({ contentType }) => /markdown/.test(contentType) });
  assert.equal(r.skipped, true);
  assert.equal(r.text, '');
});

test('retryAfterMs parses seconds and HTTP dates', () => {
  assert.equal(retryAfterMs('5'), 5000);
  assert.equal(retryAfterMs(new Date(Date.UTC(2030, 0, 1, 0, 0, 10)).toUTCString(), Date.UTC(2030, 0, 1)), 10000);
  assert.equal(retryAfterMs('soon'), null);
  assert.equal(retryAfterMs(undefined), null);
});

// ---------------------------------------------------------------------------
// Redirect stubs
// ---------------------------------------------------------------------------

const PYTORCH_STUB = `<!DOCTYPE html>
<meta charset="utf-8">
<title>Redirecting&hellip;</title>
<script>location.replace("../../2.14/generated/torch.nn.attention.sdpa_kernel.html" + location.hash + location.search);</script>
<meta http-equiv="refresh" content="0; url=../../2.14/generated/torch.nn.attention.sdpa_kernel.html">
<link rel="canonical" href="../../2.14/generated/torch.nn.attention.sdpa_kernel.html">
<a href="../../2.14/generated/torch.nn.attention.sdpa_kernel.html">Continue to ../../2.14/generated/torch.nn.attention.sdpa_kernel.html</a>
<script>(function(){var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';})();</script>`;

test('detectRedirectStub follows the pytorch stable/ stub (meta refresh, resolved relative)', () => {
  const base = 'https://docs.pytorch.org/docs/stable/generated/torch.nn.attention.sdpa_kernel.html';
  assert.deepEqual(detectRedirectStub(PYTORCH_STUB, base), {
    target: 'https://docs.pytorch.org/docs/2.14/generated/torch.nn.attention.sdpa_kernel.html', how: 'meta-refresh',
  });
});

test('detectRedirectStub: location.replace alone, and canonical + "redirecting" wording', () => {
  const js = '<html><head><script>window.location.replace(\'/new/place\')</script></head><body>Moving…</body></html>';
  assert.deepEqual(detectRedirectStub(js, 'https://a.example/old'), { target: 'https://a.example/new/place', how: 'script' });
  const js2 = '<script>location.href = "https://b.example/x";</script>';
  assert.equal(detectRedirectStub(js2, 'https://a.example/old').target, 'https://b.example/x');
  const canon = '<link rel="canonical" href="/v2/page"><p>This page has moved.</p>';
  assert.deepEqual(detectRedirectStub(canon, 'https://a.example/v1/page'), { target: 'https://a.example/v2/page', how: 'canonical' });
});

test('detectRedirectStub ignores real pages, SPA shells and self-canonicals', () => {
  const real = `<html><head><link rel="canonical" href="/elsewhere"><script>if(x) location.href="/login"</script></head><body>${'<p>Real documentation content paragraph.</p>'.repeat(40)}</body></html>`;
  assert.equal(detectRedirectStub(real, 'https://a.example/page'), null, 'too much text to be a stub');
  const shell = '<html><head><link rel="canonical" href="/other"></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
  assert.equal(detectRedirectStub(shell, 'https://a.example/page'), null, 'canonical without redirect wording is not followed');
  const self = '<meta http-equiv="refresh" content="0; url=/page#top">';
  assert.equal(detectRedirectStub(self, 'https://a.example/page'), null, 'refresh to itself');
  const noscript = '<html><head><noscript><meta http-equiv="refresh" content="0; URL=/page?_fb_noscript=1"></noscript></head><body><div id="app"></div></body></html>';
  assert.equal(detectRedirectStub(noscript, 'https://a.example/page'), null, 'a <noscript> refresh is the no-JS fallback');
  const slow = '<meta http-equiv="refresh" content="300; url=/page2">';
  assert.equal(detectRedirectStub(slow, 'https://a.example/page'), null, 'an auto-reload is not a redirect');
});

// ---------------------------------------------------------------------------
// Owner-markdown probe
// ---------------------------------------------------------------------------

test('markdownVariantUrls: trailing slash, extensions, root, query/fragment', () => {
  assert.deepEqual(markdownVariantUrls('https://a.example/guide/assets'), ['https://a.example/guide/assets.md']);
  assert.deepEqual(markdownVariantUrls('https://a.example/guide/?x=1#y'), [
    'https://a.example/guide.md', 'https://a.example/guide/index.md', 'https://a.example/guide/index.html.md']);
  assert.deepEqual(markdownVariantUrls('https://a.example/a/b.html'), ['https://a.example/a/b.md', 'https://a.example/a/b.html.md']);
  assert.deepEqual(markdownVariantUrls('https://a.example/'), ['https://a.example/index.md', 'https://a.example/index.html.md']);
  assert.deepEqual(markdownVariantUrls('https://a.example/a/b.md'), []);
  assert.equal(isMarkdownUrl('https://a.example/a/b.mdx'), true);
});

test('probeMiss: a variant redirected to a non-.md path, HTML or JSON bodies are misses', () => {
  const ok = { status: 200, url: 'https://a.example/x.md', contentType: 'text/markdown', text: '# X\n\nbody' };
  assert.equal(probeMiss('variant', ok), null);
  assert.match(probeMiss('variant', { ...ok, url: 'https://a.example/x' }), /non-markdown path/);
  assert.match(probeMiss('variant', { ...ok, contentType: 'text/html' }), /text\/html/);
  assert.match(probeMiss('variant', { ...ok, contentType: 'text/plain', text: '<!DOCTYPE html><html>' }), /HTML/);
  assert.match(probeMiss('variant', { ...ok, contentType: '', text: '{"error":"not found"}' }), /JSON/);
  assert.match(probeMiss('accept', { ...ok, url: 'https://a.example/x', contentType: 'text/html' }), /served text\/html/);
  assert.equal(probeMiss('accept', { ...ok, url: 'https://a.example/x' }), null);
  assert.match(probeMiss('accept', { ...ok, status: 404 }), /404/);
});

function routeHttp(handler) {
  const calls = [];
  return {
    calls,
    get: async (url, opts) => {
      calls.push({ url, accept: opts.accept });
      const r = handler(url, opts) ?? { status: 404 };
      const res = { status: r.status ?? 200, url: r.url ?? url, headers: r.headers ?? {}, contentType: r.contentType ?? '', text: r.text ?? '', bytes: Buffer.from(r.text ?? '') };
      if (opts.want && !opts.want({ status: res.status, contentType: res.contentType, url: res.url })) return { ...res, text: '', skipped: true };
      return res;
    },
  };
}

test('probeOwnerMarkdown: variant first, Accept second; misses recorded, not returned', async () => {
  const md = '# Page\n\nSome **owner** markdown with a [link](https://a.example).\n';
  const http = routeHttp((url, { accept }) => {
    if (url === 'https://a.example/page.md') return { contentType: 'text/markdown', text: md };
    if (url === 'https://a.example/page' && /markdown/.test(accept)) return { contentType: 'text/markdown; charset=utf-8', text: md };
    return null;
  });
  const r = await probeOwnerMarkdown('https://a.example/page', { http });
  assert.deepEqual(r.candidates.map(c => c.how), ['variant', 'accept']);
  assert.equal(r.candidates[0].text, md);
});

test('probeOwnerMarkdown: a server that ignores Accept (HTML) and a catch-all .md redirect are misses', async () => {
  const http = routeHttp((url) => {
    if (url === 'https://a.example/page') return { contentType: 'text/html', text: '<!doctype html><html></html>' };
    if (url === 'https://a.example/page.md') return { url: 'https://a.example/', contentType: 'text/html', text: '<!doctype html>' };
    return null;
  });
  const r = await probeOwnerMarkdown('https://a.example/page', { http });
  assert.equal(r.candidates.length, 0);
  assert.equal(r.attempts.length, 2);
});

test('probeOwnerMarkdown tries the alternate variants of a trailing-slash URL only after a miss', async () => {
  const http = routeHttp((url) => (url === 'https://a.example/guide/index.md' ? { contentType: 'text/markdown', text: '# Guide\n\n- a\n- b\n' } : null));
  const r = await probeOwnerMarkdown('https://a.example/guide/', { http, accept: false });
  assert.deepEqual(http.calls.map(c => c.url), ['https://a.example/guide.md', 'https://a.example/guide/index.md']);
  assert.equal(r.candidates[0].url, 'https://a.example/guide/index.md');
});

test('http: requests carry a desktop Chrome UA and the headers Chrome sends with it, versions agreeing', async () => {
  const seen = [];
  const fetch = async (url, init) => { seen.push(init.headers); const r = new Response('ok'); Object.defineProperty(r, 'url', { value: url }); return r; };
  const http = createHttp({ fetch, polite: false });
  await http.get('https://a.example/x', { accept: 'text/markdown' });
  const h = seen[0];
  assert.equal(h['User-Agent'], USER_AGENT);
  assert.match(h['User-Agent'], new RegExp(`Chrome/${CHROME_MAJOR}\\.`));
  assert.match(h['sec-ch-ua'], new RegExp(`"Google Chrome";v="${CHROME_MAJOR}"`));
  assert.equal(h['sec-ch-ua-platform'], '"Windows"');
  assert.equal(h['Sec-Fetch-Mode'], 'navigate');
  assert.equal(h['Upgrade-Insecure-Requests'], '1');
  assert.equal(h.Accept, 'text/markdown');
  assert.deepEqual(Object.keys(chromeHeaders(chromeUserAgent(150))).length, Object.keys(h).length - 1);
  assert.match(chromeHeaders(chromeUserAgent(150))['sec-ch-ua'], /v="150"/);
});
