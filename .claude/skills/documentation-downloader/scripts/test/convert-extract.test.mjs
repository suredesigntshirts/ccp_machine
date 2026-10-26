/**
 * Unit tests for lib/convert/extract.mjs (content roots) and lib/convert/profile.mjs
 * (LLM site profiles). Synthetic HTML only; the model is always a stub.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseHtml } from '../lib/convert/dom.mjs';
import {
  extractContent, chooseHtmlSource, classifyHtml, buildSkeleton, blockText, findTitleHeading, repeatedPieces,
} from '../lib/convert/extract.mjs';
import {
  parseProfileAnswer, validateProfile, extractPage, deriveProfile, ProfileMismatch, loadProfile, buildProfilePrompt,
} from '../lib/convert/profile.mjs';

const text = (res) => res.roots.map(r => blockText(r)).join('\n').replace(/\s+/g, ' ');
const para = (n, w = 'content') => Array.from({ length: n }, (_, i) => `<p>This is ${w} paragraph ${i}, with real sentences, commas, and full stops.</p>`).join('');
const nav = (n) => `<ul>${Array.from({ length: n }, (_, i) => `<li><a href="/p${i}">Sidebar page ${i}</a></li>`).join('')}</ul>`;

function page({ title = 'Widget API', main, extraBody = '' } = {}) {
  return `<!doctype html><html><head><title>${title} | Example Docs</title></head><body>
    <header><a href="/">Example Docs</a><nav>${nav(5)}</nav></header>
    <div class="layout">
      <aside class="sidebar"><nav>${nav(40)}</nav></aside>
      ${main}
    </div>
    <footer><p>Copyright 2026 Example Inc. All rights reserved.</p>${nav(6)}</footer>
    ${extraBody}
  </body></html>`;
}

test('picks the main content and drops nav, sidebar, footer', () => {
  const html = page({ main: `<main><article><h1>Widget API</h1>${para(8)}<pre><code>widget.run()</code></pre></article></main>` });
  const res = extractContent(parseHtml(html), { url: 'https://example.com/docs/widget' });
  const t = text(res);
  assert.match(t, /Widget API/);
  assert.match(t, /content paragraph 7/);
  assert.match(t, /widget\.run\(\)/);
  assert.doesNotMatch(t, /Sidebar page/);
  assert.doesNotMatch(t, /Copyright 2026/);
  assert.equal(res.title, 'Widget API');
  assert.ok(res.confidence > 0 && res.confidence <= 1);
});

test('template inside the content root is removed: breadcrumbs, TOC, feedback, copy buttons, pager', () => {
  const html = page({ main: `<main><article>
    <nav aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/docs">Docs</a></li></ol></nav>
    <h1>Widget API</h1><button>Copy page</button>
    <div class="toc"><p>On this page</p>${nav(4)}</div>
    ${para(8)}
    <div class="feedback"><p>Was this page helpful?</p><button>Yes</button><button>No</button></div>
    <nav class="pagination"><a href="/prev">Previous: Gadgets</a><a href="/next">Next: Gizmos</a></nav>
  </article></main>` });
  const doc = parseHtml(html);
  const res = extractContent(doc, {});
  const t = text(res);
  assert.match(t, /content paragraph 3/);
  for (const bad of ['Breadcrumb', 'Copy page', 'On this page', 'Was this page helpful', 'Previous: Gadgets']) {
    assert.ok(!t.includes(bad), `leaked ${bad}`);
  }
  assert.ok(res.removed.length >= 4);
});

test('a title heading outside the body container is pulled in with its subtitle', () => {
  const html = page({ main: `<main><div id="content-area">
      <header id="header"><div class="eyebrow">Guides</div><h1 id="page-title">Widget API</h1><button>Copy page</button>
        <div class="description"><p>Build widgets from your own code.</p></div></header>
      <div id="content">${para(10)}</div>
    </div><div class="toc-column"><p>On this page</p>${nav(8)}</div></main>` });
  const res = extractContent(parseHtml(html), {});
  const t = text(res);
  assert.match(t, /Widget API/);
  assert.match(t, /Build widgets from your own code/);
  assert.match(t, /content paragraph 9/);
  assert.doesNotMatch(t, /Copy page/);
  assert.doesNotMatch(t, /Sidebar page/);
});

test('content starts at the title: a promo box beside the title branch is dropped', () => {
  const html = page({ main: `<main><div class="wrap">
      <div class="promo"><p>Join the community and get access to extra features.</p></div>
      <div class="doc"><h1>Widget API</h1>${para(40)}</div></div></main>` });
  const t = text(extractContent(parseHtml(html), {}));
  assert.match(t, /content paragraph 39/);
  assert.doesNotMatch(t, /Join the community/);
});

test('hidden tab panels, details and table cells saying Yes/No are content', () => {
  const html = page({ main: `<main><h1>Widget API</h1>${para(4)}
    <div role="tablist"><button role="tab">Python</button><button role="tab">Node</button></div>
    <div role="tabpanel"><pre>pip install widget</pre></div>
    <div role="tabpanel" hidden><pre>npm install widget</pre></div>
    <details><summary>Show fields</summary><p>The hidden field list.</p></details>
    <table><tr><th>Option</th><th>Required</th></tr><tr><td>name</td><td>Yes</td></tr><tr><td>size</td><td>No</td></tr></table>
  </main>` });
  const t = text(extractContent(parseHtml(html), {}));
  assert.match(t, /npm install widget/);
  assert.match(t, /Python/);
  assert.match(t, /The hidden field list/);
  assert.match(t, /name Yes/);
  assert.match(t, /size No/);
});

test('an AI-generated summary panel is not the page content', () => {
  const html = page({ main: `<main><article><h1>Widget API</h1>
    <div class="key-takeaways" role="region"><h2 data-tooltip="Generated with AI">Page Summary</h2><ul><li>Widgets are small.</li><li>They run.</li></ul></div>
    ${para(10)}</article></main>` });
  const t = text(extractContent(parseHtml(html), {}));
  assert.doesNotMatch(t, /Page Summary|Widgets are small/);
  assert.match(t, /content paragraph 9/);
});

test('cross-page template: a block repeated on sibling pages is removed only with siblings', () => {
  const banner = '<div class="note"><p>As of January 2020 this library no longer supports Python 2 on the latest release.</p></div>';
  const mk = (title, w) => page({ title, main: `<div class="body" role="main">${banner}<h1>${title}</h1>${para(3, w)}</div>` });
  const html = mk('Widget API', 'widget');
  const siblings = [{ url: 'https://example.com/docs/gadget', html: mk('Gadget API', 'gadget') }];
  const withSib = text(extractContent(parseHtml(html), { siblings }));
  assert.doesNotMatch(withSib, /no longer supports Python 2/);
  assert.match(withSib, /widget paragraph 2/);
  const without = extractContent(parseHtml(html), {});
  assert.match(text(without), /widget paragraph 2/);
  assert.ok(without.confidence < extractContent(parseHtml(html), { siblings }).confidence);
  assert.ok(repeatedPieces(siblings).has('as of january 2020 this library no longer supports python 2 on the latest release.'));
});

test('title heading: the h1 matching <title>, not a logo h1 in a sidebar', () => {
  const html = `<html><head><title>Types for Data API — data-lib documentation</title></head><body>
    <div class="sphinxsidebar"><h1 class="logo"><a href="/">data-lib</a></h1>${nav(5)}</div>
    <div class="body" role="main"><section><h1>Types for Data API</h1>${para(3)}</section></div></body></html>`;
  const { el, text: t } = findTitleHeading(parseHtml(html));
  assert.equal(t, 'Types for Data API');
  assert.equal(el.parentNode.nodeName, 'SECTION');
});

test('chooseHtmlSource: normal, broken render, bot check, JS shell, redirect stub', () => {
  const good = page({ main: `<main><h1>Widget API</h1>${para(6)}</main>` });
  assert.equal(chooseHtmlSource({ rendered: good, raw: good }).source, 'rendered');
  const crashed = '<html><body><h2>Application error: a client-side exception has occurred while loading example.com (see the browser console for more information).</h2></body></html>';
  const r1 = chooseHtmlSource({ rendered: crashed, raw: good });
  assert.equal(r1.source, 'raw');
  assert.match(r1.reason, /Application error/);
  const errInChrome = page({ main: `<main><p>500 Internal Error</p></main>` });
  assert.equal(chooseHtmlSource({ rendered: errInChrome, raw: page({ main: `<main><h1>Widget API</h1>${para(30)}</main>` }) }).source, 'raw');
  const cf = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script><p>Enable JavaScript and cookies to continue</p></body></html>';
  const r2 = chooseHtmlSource({ rendered: null, raw: cf });
  assert.equal(r2.source, 'fail');
  assert.match(r2.reason, /bot check/);
  assert.equal(classifyHtml('<html><body><div id="root"></div><script>app()</script></body></html>').kind, 'shell');
  const stub = '<html><head><meta http-equiv="refresh" content="0; url=../2.14/notes/amp.html"></head><body>Redirecting…</body></html>';
  const c = classifyHtml(stub);
  assert.equal(c.kind, 'redirect');
  assert.equal(c.redirectTo, '../2.14/notes/amp.html');
  assert.equal(chooseHtmlSource({ rendered: good, raw: stub }).source, 'rendered');
  // a docs page that merely mentions HTTP 500 is fine
  assert.equal(chooseHtmlSource({ rendered: page({ main: `<main><h1>Errors</h1><p>The API returns 500 Internal Server Error when it fails.</p>${para(20)}</main>` }) }).source, 'rendered');
});

test('buildSkeleton is bounded and never contains raw HTML', () => {
  const big = page({ main: `<main><h1>Widget API</h1>${Array.from({ length: 3000 }, (_, i) => `<section id="s${i}"><h2>Member ${i}</h2>${para(2)}</section>`).join('')}</main>` });
  const sk = buildSkeleton(parseHtml(big), { maxLines: 80 });
  assert.ok(sk.split('\n').length <= 82, `lines ${sk.split('\n').length}`);
  assert.ok(sk.length < 20000);
  assert.doesNotMatch(sk, /<p>|<section/);
  assert.match(sk, /\[TITLE H1\]/);
  assert.match(sk, /more section\. siblings/);
});

// ─── profiles ──────────────────────────────────────────────────────────────

test('parseProfileAnswer accepts fenced JSON and normalises fields', () => {
  const p = parseProfileAnswer('Here you go:\n```json\n{"contentSelectors": "article.doc", "removeSelectors": [".feedback", ""], "titleSelector": "h1"}\n```');
  assert.deepEqual(p.contentSelectors, ['article.doc']);
  assert.deepEqual(p.removeSelectors, ['.feedback']);
  assert.equal(p.titleSelector, 'h1');
  assert.throws(() => parseProfileAnswer('{"removeSelectors": []}'), /no contentSelectors/);
  assert.throws(() => parseProfileAnswer('no json here'), /no JSON/);
});

test('validateProfile checks matching, the title, and link density', () => {
  const html = page({ main: `<main><article class="doc"><h1>Widget API</h1>${para(6)}<div class="feedback">Was this helpful?</div></article></main>` });
  const ok = validateProfile(parseHtml(html), { contentSelectors: ['article.doc'], removeSelectors: ['.feedback'] });
  assert.equal(ok.ok, true, ok.problems.join());
  assert.doesNotMatch(ok.roots.map(r => r.textContent).join(), /Was this helpful/);
  assert.equal(validateProfile(parseHtml(html), { contentSelectors: ['.nope'] }).ok, false);
  const navy = validateProfile(parseHtml(html), { contentSelectors: ['aside.sidebar'] });
  assert.equal(navy.ok, false);
  assert.ok(navy.problems.some(p => /title heading|link text/.test(p)));
  assert.equal(validateProfile(parseHtml(html), { contentSelectors: ['article[[['] }).ok, false);
});

// A page layer 1–2 are unsure about: no main landmark, content split in two blocks.
const unsure = (title, w) => `<html><head><title>${title}</title></head><body>
  <div id="top">${nav(4)}</div>
  <div id="page"><div class="left"><div class="head"><h1>${title}</h1></div>${para(3, w)}</div>
  <div class="right"><h3>Tools</h3><p>Some tool text that is long enough to count here, really.</p><p>Another tool paragraph, still not content.</p>${para(2, 'tool')}</div></div>
</body></html>`;

test('extractPage: low confidence → stub LLM profile → saved → reused on the next page', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'dd-prof-')), '_profiles');
  const calls = [];
  const llm = async (prompt) => {
    calls.push(prompt);
    return { text: '{"contentSelectors": ["#page .left"], "removeSelectors": [], "titleSelector": "h1"}', costUsd: 0.001, ms: 5, model: 'stub' };
  };
  const r1 = await extractPage({ html: unsure('Widget API', 'widget'), url: 'https://ex.com/a', profilesDir: dir, llm, minConfidence: 0.99 });
  assert.equal(r1.method, 'profile-new');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /TITLE H1/);
  assert.doesNotMatch(calls[0], /<div/);
  assert.doesNotMatch(text(r1), /tool paragraph/);
  const saved = await loadProfile(dir, 'ex.com');
  assert.deepEqual(saved.contentSelectors, ['#page .left']);
  const r2 = await extractPage({ html: unsure('Gadget API', 'gadget'), url: 'https://ex.com/b', profilesDir: dir, llm, minConfidence: 0.99 });
  assert.equal(r2.method, 'profile');
  assert.equal(calls.length, 1, 'profile reused without a model call');
  assert.match(text(r2), /gadget paragraph 2/);
});

test('extractPage: a stale saved profile fails loudly, and is re-derived with the failure as context', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'dd-prof-')), '_profiles');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'ex.com.json'), JSON.stringify({ version: 1, host: 'ex.com', contentSelectors: ['.old-layout'], removeSelectors: [] }));
  await assert.rejects(extractPage({ html: unsure('Widget API', 'w'), url: 'https://ex.com/a', profilesDir: dir, llm: null }), ProfileMismatch);
  let seen = '';
  const llm = async (prompt) => { seen = prompt; return { text: '{"contentSelectors": [".left"], "titleSelector": "h1"}' }; };
  const r = await extractPage({ html: unsure('Widget API', 'w'), url: 'https://ex.com/a', profilesDir: dir, llm });
  assert.equal(r.method, 'profile-rederived');
  assert.match(seen, /failed on this page/);
  assert.match(seen, /old-layout/);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'ex.com.json'), 'utf-8')).contentSelectors, ['.left']);
});

test('extractPage without a model hands the prompt back to the caller', async () => {
  const r = await extractPage({ html: unsure('Widget API', 'w'), url: 'https://ex.com/a', llm: null, minConfidence: 0.99 });
  assert.ok(r.needsProfile);
  assert.match(r.needsProfile.prompt, /contentSelectors/);
  assert.ok(r.roots.length >= 1, 'heuristic roots are still returned');
});

test('deriveProfile reports an invalid answer instead of throwing', async () => {
  const d = await deriveProfile(unsure('Widget API', 'w'), { url: 'https://ex.com/a', llm: async () => ({ text: 'sorry' }) });
  assert.equal(d.ok, false);
  assert.match(d.problems[0], /no JSON/);
  const p = buildProfilePrompt('body text=1', { url: 'u', failure: 'matched nothing', previous: { contentSelectors: ['.x'] } });
  assert.match(p.prompt, /matched nothing/);
});

test('page title comes from the converted H1, not the heading element\'s UI text', async () => {
  const { convertHtmlPage, markdownTitle } = await import('../lib/convert/page.mjs');
  const body = '<p>' + 'Data quality docs explain the tiers and the requirements for each one. '.repeat(20) + '</p>';
  const html = `<html><head><title>Data quality | Docs</title></head><body><main><article>
    <div class="devsite-article-meta"><h1>Data quality <span class="devsite-bookmark"><button>Stay organized with collections</button>
    <div class="popout" hidden>Save and categorize content based on your preferences.</div><button>Dismiss</button><button>Got it</button></span></h1></div>
    ${body}<h2>Tiers</h2>${body}</article></main></body></html>`;
  const c = await convertHtmlPage({ url: 'https://docs.example/data-quality', rendered: html });
  assert.equal(c.ok, true);
  assert.equal(c.title, markdownTitle(c.markdown));
  assert.doesNotMatch(c.title, /Stay organized|Dismiss|Got it/);
  assert.equal(markdownTitle('# `JSON.stringify()` [¶](#x)\n'), 'JSON.stringify()');
  assert.equal(markdownTitle('# Real *T* **bold** \\*lit\\*'), 'Real T bold *lit*');
  assert.equal(markdownTitle('```\n# not a heading\n```\n\n# After'), 'After');
});

// Pages generated from one template share real text (API boilerplate, a section's
// link list that is also the sidebar): siblings must not turn it into "template".
const genPage = (name, { index = false } = {}) => {
  const nav = `<nav class="sidebar"><ul>${['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map(n => `<li><a href="/ref/${n}.html">${n} distribution</a></li>`).join('')}</ul></nav>`;
  const boiler = `<p>As an instance of the rv_continuous class, the ${name} object inherits from it a collection of generic methods, and completes them with details specific for this particular distribution.</p>
    <table><tr><td>rvs(loc=0, scale=1, size=1)</td><td>Random variates.</td></tr><tr><td>pdf(x, loc=0, scale=1)</td><td>Probability density function.</td></tr>
    <tr><td>cdf(x, loc=0, scale=1)</td><td>Cumulative distribution function.</td></tr><tr><td>ppf(q, loc=0, scale=1)</td><td>Percent point function (inverse of cdf, percentiles).</td></tr></table>
    <p>The probability density above is defined in the standardized form. To shift and/or scale the distribution use the loc and scale parameters. Specifically, the density is identical to the standardized density divided by scale.</p>`;
  const body = index
    ? `<p>The reference for every distribution in this module.</p><ul class="toc">${['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map(n => `<li><a href="/ref/${n}.html">${n} distribution</a></li>`).join('')}</ul>`
    : `${boiler}<div class="examples"><h2>Examples</h2><pre>&gt;&gt;&gt; from stats import ${name}\n&gt;&gt;&gt; ${name}.rvs(size=3)</pre><p>Draw a few samples.</p></div>`;
  return `<html><head><title>${name} | Stats</title></head><body><header><a href="/">Stats docs</a></header>${nav}
    <main><section id="${name}"><h1>${name}</h1>${body}</section></main><footer>Copyright Stats developers. Built with a doc generator.</footer></body></html>`;
};

test('siblings sharing generated boilerplate do not narrow the content root', () => {
  const siblings = ['beta', 'gamma', 'delta'].map(n => ({ url: `https://s.example/ref/${n}.html`, html: genPage(n) }));
  const res = extractContent(parseHtml(genPage('alpha')), { url: 'https://s.example/ref/alpha.html', siblings });
  const t = text(res);
  assert.match(t, /inherits from it a collection of generic methods/);
  assert.match(t, /Probability density function/);
  assert.match(t, /Draw a few samples/);
  assert.doesNotMatch(t, /Copyright Stats developers/);
});

test('an index page whose content is the sidebar\'s link list keeps it', () => {
  const siblings = ['beta', 'gamma', 'delta'].map(n => ({ url: `https://s.example/ref/${n}.html`, html: genPage(n) }));
  const res = extractContent(parseHtml(genPage('Reference', { index: true })), { url: 'https://s.example/ref/', siblings });
  const t = text(res);
  assert.match(t, /The reference for every distribution/);
  assert.match(t, /epsilon distribution/);
});

test('repeated text between content blocks is shared content; at the root\'s edges it is template', () => {
  const para = (s) => `<p>${`${s} explains how this endpoint validates its parameters and what it returns. `.repeat(4)}</p>`;
  const page = (name) => `<html><head><title>${name}</title></head><body><main><article>
    <div class="crumbs-x">Home › Tutorial › Guides › ${'Section '.repeat(3)}</div>
    <h1>${name}</h1>${para(`${name} intro`)}
    <div class="admonition"><p>Tip: prefer the Annotated version whenever you can, it is clearer and works in more places.</p></div>
    ${para(`${name} body`)}${para(`${name} more`)}
    </article></main></body></html>`;
  const siblings = ['b', 'c', 'd'].map(n => ({ url: `https://t.example/${n}`, html: page(`Page ${n}`) }));
  const res = extractContent(parseHtml(page('Page a')), { url: 'https://t.example/a', siblings });
  const t = text(res);
  assert.match(t, /prefer the Annotated version/, 'shared tip in the middle stays');
  assert.doesNotMatch(t, /Home › Tutorial/, 'shared breadcrumb at the top goes');
});

test('an index page: <main> holding the title is the content, however text-heavy the sidebar is', () => {
  const toc = ['Models', 'Queries', 'Aggregation', 'Search', 'Managers', 'Raw SQL', 'Transactions', 'Multiple databases']
    .map(n => `<li><a href="/en/topics/db/${n.toLowerCase().replace(/ /g, '-')}/">${n}</a></li>`).join('');
  const prose = (s) => `<p>${`${s} — answers to common questions, the forum, the chat and the ticket tracker. `.repeat(5)}</p>`;
  const page = `<html><head><title>Models and databases</title></head><body><header><nav><a href="/">Home</a></nav></header>
    <div class="container"><main id="main-content"><article><section><h1>Models and databases</h1>
      <p>A model is the single, definitive source of information about your data.</p><ul>${toc}</ul></section></article></main>
    <div role="complementary"><section><h2>Getting help</h2>${prose('FAQ')}${prose('Forum')}</section>
      <section><h2>Support us</h2>${prose('Donate')}${prose('Members')}</section></div></div></body></html>`;
  for (const siblings of [[], [{ url: 'https://d.example/en/topics/db/models/', html: page.replace('Models and databases', 'Models') }]]) {
    const t = text(extractContent(parseHtml(page), { url: 'https://d.example/en/topics/db/', siblings }));
    assert.match(t, /single, definitive source/);
    assert.match(t, /Transactions/);
    assert.doesNotMatch(t, /Getting help/);
  }
});

test('a print-only copy of the title and contents (Jupyter Book onlyprint) is template', async () => {
  const { convertHtmlPage } = await import('../lib/convert/page.mjs');
  const para = (s) => `<p>${`${s} words that make this a real paragraph of documentation content. `.repeat(8)}</p>`;
  const html = `<!doctype html><html><head><title>Inference testing</title></head><body>
    <div class="onlyprint" id="jb-print-docs-body"><h1>Inference testing</h1><div id="jb-print-toc"><h2>Contents</h2>
      <nav><ul><li><a href="#models">Supported models</a></li><li><a href="#bench">Benchmarking</a></li></ul></nav></div></div>
    <article class="bd-article"><section id="inference-testing"><h1>Inference testing</h1>${para('Intro')}
      <h2 id="models">Supported models</h2>${para('Models')}<h2 id="bench">Benchmarking</h2>${para('Bench')}</section></article>
  </body></html>`;
  const c = await convertHtmlPage({ url: 'https://docs.example/inference.html', rendered: html });
  assert.equal(c.ok, true, c.reason);
  assert.equal((c.markdown.match(/^# Inference testing$/gm) || []).length, 1);
  assert.doesNotMatch(c.markdown, /^## Contents/m);
  assert.match(c.markdown, /^## Benchmarking/m);
});

test('siblings sharing a reference template do not cut its section headings', async () => {
  const { convertHtmlPage } = await import('../lib/convert/page.mjs');
  const ref = (name, body) => `<!doctype html><html><head><title>${name}</title></head><body>
    <nav class="sidebar"><ul>${['Ad', 'Ad Set', 'Campaign', 'Creative'].map(x => `<li><a href="/ref/${x}">${x}</a></li>`).join('')}</ul></nav>
    <div class="doc"><div class="head"><h1>${name}</h1></div><div class="sections">
      <div class="sec"><h2>Reading</h2><p>If you want to learn how to use the Graph API, read our guide.</p>
        <div class="body">${body}</div></div>
      <div class="sec"><h2>Creating</h2><p>You can't perform this operation on this endpoint.</p></div>
      <div class="sec"><h2>Updating</h2><p>You can't perform this operation on this endpoint.</p></div>
      <div class="sec"><h2>Deleting</h2><p>You can't perform this operation on this endpoint.</p></div>
    </div></div><footer>Meta © 2026</footer></body></html>`;
  const para = (s) => `<p>${`${s} is a field of this endpoint with its own long description of behaviour. `.repeat(10)}</p>`;
  const page = ref('Branded Content Search', '<h3>Parameters</h3>' + para('creator_username') + '<h3>Fields</h3>' + para('data'));
  const siblings = [
    { url: 'https://dev.example/ref/ad', html: ref('Ad', '<h3>Parameters</h3>' + para('adset_id')) },
    { url: 'https://dev.example/ref/campaign', html: ref('Campaign', '<h3>Fields</h3>' + para('objective')) },
  ];
  const c = await convertHtmlPage({ url: 'https://dev.example/ref/branded-content-search', rendered: page, siblings });
  assert.equal(c.ok, true, c.reason);
  for (const h of ['## Reading', '## Creating', '## Updating', '## Deleting', '### Parameters']) assert.match(c.markdown, new RegExp(`^${h}$`, 'm'), h);
  assert.doesNotMatch(c.markdown, /Meta © 2026/);
});

test('a sibling that is this page under another URL is not a sibling', async () => {
  const { parseHtml } = await import('../lib/convert/dom.mjs');
  const { extractContent } = await import('../lib/convert/extract.mjs');
  const sentences = Array.from({ length: 6 }, (_, i) => `<p>Sentence number ${i} of the page body that is long enough to count as real content.</p>`).join('');
  const html = `<!doctype html><html><body><nav><a href="/a">A</a></nav><main><h1>Page</h1>${sentences}</main></body></html>`;
  const r = extractContent(parseHtml(html, 'https://x.example/page'), { url: 'https://x.example/page', siblings: [{ url: 'https://x.example/page/', html }] });
  assert.equal(r.signals.sameDocumentSiblings, 1);
  assert.equal(r.signals.siblings, 0);
});
