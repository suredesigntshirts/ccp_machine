/**
 * Browser render expansion (lib/fetch/render.mjs) on a synthetic page served
 * by a route (no network). Needs a real browser, so it only runs with
 * DD_BROWSER_TESTS=1 (CI installs no browser):
 *
 *   DD_BROWSER_TESTS=1 node --test scripts/test/render.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const enabled = process.env.DD_BROWSER_TESTS === '1';

const PAGE = `<!doctype html><html><body><main><h1>Tabs</h1>
<div role="tablist">
  <button role="tab" id="t1" aria-selected="true" aria-controls="p1">Python</button>
  <button role="tab" id="t2" aria-selected="false" aria-controls="p2">JavaScript</button>
  <button role="tab" id="t3" aria-selected="false" aria-controls="p3">Go</button>
</div>
<div role="tabpanel" id="p1" aria-labelledby="t1"><pre>print("py")</pre></div>
<div role="tabpanel" id="p2" aria-labelledby="t2" hidden></div>
<div role="tabpanel" id="p3" aria-labelledby="t3" hidden></div>
<div role="tablist">
  <button role="tab" id="s1" aria-selected="true" aria-controls="sp">npm</button>
  <button role="tab" id="s2" aria-selected="false" aria-controls="sp">yarn</button>
</div>
<div role="tabpanel" id="sp" aria-labelledby="s1"><pre>npm i x</pre></div>
<div role="tablist">
  <button role="tab" id="k1" aria-selected="true" aria-controls="kp1">A</button>
  <button role="tab" id="k2" aria-selected="false" aria-controls="kp2">B</button>
</div>
<div role="tabpanel" id="kp1"><p>static A</p></div><div role="tabpanel" id="kp2" hidden><p>static B</p></div>
<details><summary>More</summary><p>Hidden details text</p></details>
<script>
const code = { p1: 'print("py")', p2: 'console.log("js")', p3: 'fmt.Println("go")' };
for (const t of document.querySelectorAll('[aria-controls^=p]')) t.addEventListener('click', () => {
  for (const o of document.querySelectorAll('[aria-controls^=p]')) {
    const sel = o === t; o.setAttribute('aria-selected', String(sel));
    const p = document.getElementById(o.getAttribute('aria-controls'));
    p.hidden = !sel; p.innerHTML = sel ? '<pre>' + code[p.id] + '</pre>' : '';   // unmounts inactive panels
  }
});
const sh = { s1: 'npm i x', s2: 'yarn add x' };
for (const t of document.querySelectorAll('[aria-controls=sp]')) t.addEventListener('click', () => {
  setTimeout(() => {   // one shared panel, rendered asynchronously
    for (const o of document.querySelectorAll('[aria-controls=sp]')) o.setAttribute('aria-selected', String(o === t));
    document.getElementById('sp').innerHTML = '<pre>' + sh[t.id] + '</pre>';
  }, 50);
});
</script></main></body></html>`;

test('render expands lazy ARIA tabs (unmounting and shared panels) and <details>', { skip: !enabled && 'set DD_BROWSER_TESTS=1' }, async () => {
  const { chromium } = await import('playwright');
  const { createLazyBrowser } = await import('../lib/browser.mjs');
  const { renderPage } = await import('../lib/fetch/render.mjs');
  const browser = createLazyBrowser(chromium);
  try {
    const r = await renderPage('https://expand.test/page', {
      browser, network: 'browser', slot: false,
      setupContext: (ctx) => ctx.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE })),
    });
    const dom = r.html.replace(/<script[\s\S]*?<\/script>/g, '');
    for (const s of ['print("py")', 'console.log("js")', 'fmt.Println("go")', 'npm i x', 'yarn add x', 'static A', 'static B', 'Hidden details text']) {
      assert.ok(dom.includes(s), `missing ${s}`);
    }
    assert.match(r.html, /<details open/);
    assert.equal(r.expanded.tabs, 3, 'only tabs without their own content are clicked');
  } finally {
    await browser.close();
  }
});

test('pooled contexts: a retired context closes only after the renders using it are done', async () => {
  const { pooledContext, POOL_MAX_USES } = await import('../lib/fetch/render.mjs');
  const made = [];
  const browser = {
    newContext: async () => { const c = { closed: 0, close: async () => { c.closed++; } }; made.push(c); return c; },
  };
  const url = 'https://pool.example/a';
  const leases = [];
  for (let i = 0; i < POOL_MAX_USES; i++) leases.push(await pooledContext(browser, url, {}));
  assert.equal(made.length, 1);
  assert.ok(leases.every(l => l.context === made[0]));
  // Use 41 retires the first context while 40 renders still hold it.
  const next = await pooledContext(browser, url, {});
  assert.equal(made.length, 2);
  assert.equal(next.context, made[1]);
  assert.equal(made[0].closed, 0);
  for (const l of leases.slice(1)) await l.release();
  assert.equal(made[0].closed, 0);
  await leases[0].release();
  await leases[0].release(); // idempotent
  assert.equal(made[0].closed, 1);
  await next.release();
  assert.equal(made[1].closed, 0, 'the current context stays open for the next page');
  // A context that fails to open is not kept.
  const failing = { n: 0, newContext: async () => { failing.n++; if (failing.n === 1) throw new Error('boom'); return { close: async () => {} }; } };
  await assert.rejects(pooledContext(failing, url, {}), /boom/);
  assert.ok((await pooledContext(failing, url, {})).context);
});
