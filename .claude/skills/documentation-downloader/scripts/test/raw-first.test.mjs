/**
 * Raw-first with per-site verification (`sourcePolicy: 'auto'`): the comparison,
 * the verdict rules, and the pipeline's routing. No network, no browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchPage } from '../lib/fetch/pipeline.mjs';
import { compareConversions } from '../lib/convert/compare.mjs';
import { planFor, applyResult, sourceScope, pageFeatures, createVerdictStore, AGREE_TO_TRUST, SPOT_CHECK_EVERY, MAX_AGE_DAYS } from '../lib/fetch/verdicts.mjs';
import convert from '../lib/convert/index.mjs';

const para = (s) => `<p>${`${s} is documented here in enough words to be a real paragraph of content. `.repeat(12)}</p>`;
const page = (title, body) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><nav>Home Docs API</nav><main><h1>${title}</h1>${body}</main></body></html>`;
const BIG = (t) => page(t, para(`${t} alpha`) + '<h2>Usage</h2>' + para(`${t} beta`) + para(`${t} gamma`) + para(`${t} delta`));
const WITH_CODE = (t, code) => page(t, para(`${t} alpha`) + `<h2>Example</h2><pre><code>${code}</code></pre>` + para(`${t} beta`) + para(`${t} gamma`) + para(`${t} delta`));

function fakeHttp(pages) {
  return {
    get: async (url, opts = {}) => {
      const html = pages[url];
      if (/markdown/.test(opts.accept || '') && !/html/.test(opts.accept || '')) return { status: 404, url, headers: {}, contentType: 'text/html', text: 'no', bytes: Buffer.from('no') };
      if (html == null) return { status: 404, url, headers: {}, contentType: 'text/html', text: 'not found', bytes: Buffer.from('not found') };
      return { status: 200, url, headers: {}, contentType: 'text/html; charset=utf-8', text: html, bytes: Buffer.from(html) };
    },
  };
}
function fakeRender(map) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const html = map[url];
    if (!html) throw new Error('navigation failed: net::ERR_NAME_NOT_RESOLVED');
    return { status: 200, finalUrl: url, title: '', html };
  };
  fn.calls = calls;
  return fn;
}

// ── compare ────────────────────────────────────────────────────────────────

test('compareConversions: identical pages are the same; link targets do not matter', () => {
  const md = '# T\n\nSome [text](https://a.example/x) here.\n\n```js\nconst a = 1;\n```\n';
  assert.equal(compareConversions(md, md).same, true);
  assert.equal(compareConversions(md.replace('https://a.example/x', '/x'), md).same, true);
});

test('compareConversions: missing text, changed code, missing headings and another language are differences', () => {
  const ren = `# T\n\n${'word '.repeat(200)}\n\n## Usage\n\n${'more '.repeat(100)}\n\n\`\`\`js\nconst a = 1;\nconst b = 2;\n\`\`\`\n`;
  const shorter = compareConversions(`# T\n\n${'word '.repeat(100)}\n\n\`\`\`js\nconst a = 1;\nconst b = 2;\n\`\`\`\n`, ren);
  assert.equal(shorter.same, false);
  assert.match(shorter.reason, /misses/);
  assert.match(shorter.reason, /headings/);
  const code = compareConversions(ren.replace('const b = 2;', ''), ren);
  assert.equal(code.same, false);
  assert.match(code.reason, /code differs/);
  const locale = compareConversions(`# T\n\n${'palavra '.repeat(200)}\n\n## Uso\n\n${'mais '.repeat(100)}\n`, ren);
  assert.equal(locale.same, false);
  assert.match(locale.reason, /not in the render/);
});

// ── verdict rules ──────────────────────────────────────────────────────────

test('verdicts: verify until AGREE_TO_TRUST pages agree, then raw; one disagreement → render', () => {
  let s;
  for (let i = 0; i < AGREE_TO_TRUST; i++) {
    assert.equal(planFor(s, {}), 'verify');
    s = applyResult(s, { agree: true, features: {} });
  }
  assert.equal(planFor(s, {}), 'raw');
  s = applyResult(s, { agree: false, reason: 'x' });
  assert.equal(planFor(s, {}), 'render');
  assert.equal(planFor(applyResult(s, { agree: true }), {}), 'render', 'render-only is sticky');
});

test('verdicts: an inconclusive check changes nothing; unverified features and spot checks are verified', () => {
  let s = applyResult(applyResult(undefined, { agree: true, features: {} }), { agree: true, features: {} });
  assert.deepEqual(applyResult(s, { inconclusive: true }), s);
  assert.equal(planFor(s, { code: true }), 'verify', 'first page with code blocks');
  s = applyResult(s, { agree: true, features: { code: true } });
  assert.equal(planFor(s, { code: true }), 'raw');
  assert.equal(planFor(s, { table: true }), 'verify');
  assert.equal(planFor({ ...s, rawSince: SPOT_CHECK_EVERY - 1 }, {}), 'verify');
});

test('verdicts: expire after MAX_AGE_DAYS', () => {
  const old = new Date(Date.now() - (MAX_AGE_DAYS + 1) * 86_400_000).toISOString();
  assert.equal(planFor({ verdict: 'render', at: old }, {}), 'verify');
  assert.equal(planFor({ verdict: 'raw', agreed: 5, verified: {}, at: old }, {}), 'verify');
});

test('sourceScope: host + first path segment; www ignored', () => {
  assert.equal(sourceScope('https://www.a.example/docs/x/y').key, 'a.example/docs');
  assert.equal(sourceScope('https://a.example/index.html').key, 'a.example/');
  assert.equal(sourceScope('https://a.example/').key, 'a.example/');
  assert.deepEqual(pageFeatures('x\n\n```js\na\n```\n'), { code: true, table: false });
  assert.deepEqual(pageFeatures('| a | b |\n|---|---|\n| 1 | 2 |\n'), { code: false, table: true });
});

// ── pipeline ───────────────────────────────────────────────────────────────

test("auto: a site's first pages are rendered and compared, later pages skip the browser", async () => {
  const urls = ['p1', 'p2', 'p3', 'p4'].map(p => `https://a.example/docs/${p}`);
  const pages = Object.fromEntries(urls.map((u, i) => [u, BIG(`Page${i}`)]));
  const render = fakeRender(pages);
  const ctx = { http: fakeHttp(pages), render, convert, sourcePolicy: 'auto', verdicts: createVerdictStore() };
  const routes = [];
  for (const u of urls) {
    const r = await fetchPage(u, ctx);
    assert.equal(r.ok, true, r.reason);
    routes.push([r.route.plan, r.route.source, r.route.rendered]);
  }
  assert.deepEqual(routes, [
    ['verify', 'rendered', true], ['verify', 'rendered', true],
    ['raw', 'raw', false], ['raw', 'raw', false],
  ]);
  assert.equal(render.calls.length, AGREE_TO_TRUST);
});

test('auto: server HTML that differs from the render keeps the site rendered', async () => {
  const urls = ['p1', 'p2', 'p3'].map(p => `https://b.example/docs/${p}`);
  const raw = Object.fromEntries(urls.map((u, i) => [u, BIG(`Page${i}`)]));
  // The browser shows more: content added by scripts.
  const rendered = Object.fromEntries(urls.map((u, i) => [u, BIG(`Page${i}`).replace('</main>', `<h2>Loaded later</h2>${para('lazy')}${para('lazier')}</main>`)]));
  const render = fakeRender(rendered);
  const ctx = { http: fakeHttp(raw), render, convert, sourcePolicy: 'auto', verdicts: createVerdictStore() };
  for (const u of urls) {
    const r = await fetchPage(u, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.route.source, 'rendered');
    assert.match(r.markdown, /Loaded later/);
  }
  assert.equal(render.calls.length, 3);
  const first = await ctx.verdicts.plan(urls[0], {});
  assert.equal(first.plan, 'render');
});

test('auto: a trusted site still verifies its first page with code blocks', async () => {
  const pages = {
    'https://c.example/docs/a': BIG('A'), 'https://c.example/docs/b': BIG('B'),
    'https://c.example/docs/code': WITH_CODE('Code', 'const answer = 42;\nconsole.log(answer);'),
  };
  const render = fakeRender(pages);
  const ctx = { http: fakeHttp(pages), render, convert, sourcePolicy: 'auto', verdicts: createVerdictStore() };
  for (const u of Object.keys(pages)) await fetchPage(u, ctx);
  assert.deepEqual(render.calls, Object.keys(pages));
});

test('raw-first: server HTML whose conversion is refused falls back to the render instead of failing', async () => {
  const url = 'https://d.example/docs/x';
  // Enough server text to pass the gate, but it is an error page.
  const errorPage = page('Error', `<p>${'Sorry, something went wrong. '.repeat(90)}</p>`).replace('<h1>Error</h1>', '<h1>Page not found</h1>');
  const render = fakeRender({ [url]: BIG('Real') });
  const r = await fetchPage(url, { http: fakeHttp({ [url]: errorPage }), render, convert, sourcePolicy: 'raw' });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.route.source, 'rendered');
  assert.ok(r.route.rawFallback);
});

test('never: no browser; a thin server page fails with a clear reason', async () => {
  const good = 'https://e.example/docs/good';
  const shell = 'https://e.example/docs/app';
  const render = fakeRender({});
  const http = fakeHttp({ [good]: page('Small', para('small page')), [shell]: '<html><body><div id="root"></div></body></html>' });
  const r1 = await fetchPage(good, { http, render, convert, sourcePolicy: 'never' });
  assert.equal(r1.ok, true, r1.reason);
  const r2 = await fetchPage(shell, { http, render, convert, sourcePolicy: 'never' });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /browser disabled/);
  assert.equal(render.calls.length, 0);
});

test('chooseSource: a server redirect that adds query parameters (?hl=…) is not trusted before rendering', () => {
  const c = convert.chooseSource({ raw: { html: BIG('X'), status: 200, requestedUrl: 'https://f.example/p', finalUrl: 'https://f.example/p?hl=pt-br' }, rendered: undefined });
  assert.equal(c.source, 'render');
  assert.match(c.reason, /hl/);
});

test('verdict store persists per host under the cache root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dd-verdicts-'));
  try {
    const a = createVerdictStore(root);
    await a.record('https://g.example/docs/1', { agree: true, features: { code: true } });
    await a.record('https://g.example/docs/2', { agree: true, features: {} });
    const b = createVerdictStore(root);
    assert.equal((await b.plan('https://g.example/docs/3', { code: true })).plan, 'raw');
    assert.equal((await b.plan('https://g.example/blog/3', {})).plan, 'verify', 'another scope');
    const saved = JSON.parse(readFileSync(join(root, '.cache', 'sources', 'g.example.json'), 'utf-8'));
    assert.equal(saved.scopes['g.example/docs'].verdict, 'raw');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('auto: a render-only site does not convert the server HTML at all', async () => {
  const url = 'https://h.example/docs/x';
  const verdicts = createVerdictStore();
  await verdicts.record(url, { agree: false, reason: 'differs' });
  const r = await fetchPage(url, { http: fakeHttp({ [url]: BIG('X') }), render: fakeRender({ [url]: BIG('X') }), convert, sourcePolicy: 'auto', verdicts });
  assert.equal(r.ok, true);
  assert.equal(r.route.plan, 'render');
  assert.equal(r.timings.convertRaw, undefined);
});

// ── owner-markdown probe memory ──────────────────────────────────────────────

test('probe memory: learn for PROBE_LEARN pages, then skip kinds that never helped, spot-check every PROBE_SPOT-th', async () => {
  const { probePlanFor, applyProbe, PROBE_LEARN, PROBE_SPOT } = await import('../lib/fetch/verdicts.mjs');
  let p;
  for (let i = 0; i < PROBE_LEARN; i++) {
    assert.deepEqual([probePlanFor(p).variant, probePlanFor(p).accept], [true, true]);
    p = applyProbe(p, { tried: { variant: true, accept: true }, used: null });
  }
  const plans = [];
  for (let i = 0; i < PROBE_SPOT; i++) {
    const plan = probePlanFor(p);
    plans.push(plan.variant || plan.accept);
    p = applyProbe(p, { tried: { variant: plan.variant, accept: plan.accept }, used: null });
  }
  assert.deepEqual(plans, [...Array(PROBE_SPOT - 1).fill(false), true], 'only the spot check probes');
  // a site whose .md variants are used keeps that probe
  let q;
  for (let i = 0; i < PROBE_LEARN; i++) q = applyProbe(q, { tried: { variant: true, accept: true }, used: i === 1 ? 'variant' : null });
  assert.deepEqual([probePlanFor(q).variant, probePlanFor(q).accept], [true, false]);
});

test('probe memory in the pipeline: a site without owner markdown stops being probed', async () => {
  const urls = [1, 2, 3, 4].map(i => `https://p.example/docs/page${i}`);
  const pages = Object.fromEntries(urls.map((u, i) => [u, BIG(`P${i}`)]));
  const calls = [];
  const inner = fakeHttp(pages);
  const http = { get: async (url, o) => { calls.push(`${/markdown/.test(o?.accept || '') ? 'md' : 'html'} ${url}`); return inner.get(url, o); } };
  const ctx = { http, render: fakeRender(pages), convert, sourcePolicy: 'render', verdicts: createVerdictStore() };
  for (const u of urls) {
    calls.length = 0;
    const r = await fetchPage(u, ctx);
    assert.equal(r.ok, true);
    if (u === urls[3]) assert.deepEqual(calls, [`html ${u}`], 'fourth page: plain GET only');
    else assert.ok(calls.length > 1, 'learning pages are probed');
  }
});
