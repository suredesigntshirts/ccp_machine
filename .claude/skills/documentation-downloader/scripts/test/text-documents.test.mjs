/**
 * A URL that is itself a text file (`.md`, `llms.txt`) is stored as its text, never
 * as one code block holding the whole page — whichever way it was obtained.
 * No network, no browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchPage, soleFence, codeFile } from '../lib/fetch/pipeline.mjs';
import convert from '../lib/convert/index.mjs';

const LLMS = [
  '# Example Platform',
  '',
  '> The Example Platform documentation covers the API, webhooks and migration guides.',
  '',
  ...Array.from({ length: 30 }, (_, i) => `- [Guide ${i}](https://docs.example/guide-${i}.md): How to use feature ${i} of the platform in detail.`),
  '',
].join('\n');

// An API reference page whose markdown is mostly an OpenAPI dump.
const OPENAPI_MD = [
  '# Get remaining credits',
  '',
  '> Get total credits purchased and used for the authenticated user.',
  '',
  '## OpenAPI',
  '',
  '````yaml /openapi/openapi.yaml get /credits',
  ...Array.from({ length: 200 }, (_, i) => `  field${i}:\n    description: Field ${i} of the credits response object`),
  '````',
  '',
].join('\n');

const html404 = { status: 404, headers: {}, contentType: 'text/html', text: 'not found', bytes: Buffer.from('not found') };

function fakeHttp(map) {
  return {
    get: async (url) => {
      const hit = map[url];
      if (!hit) return { ...html404, url };
      return { status: hit.status ?? 200, url, headers: {}, contentType: hit.type, text: hit.body, bytes: Buffer.from(hit.body) };
    },
  };
}
const noRender = async () => { throw new Error('render not expected'); };
const fenced = (md) => /^```/m.test(md.replace(/^---\n[\s\S]*?\n---\n/, '').trim().split('\n').find(l => l.trim() && !l.startsWith('# ')) ?? '');

test('soleFence: a page that is one fenced block (under an optional H1) yields its contents', () => {
  assert.equal(soleFence('# T\n\n```\na\nb\n```\n'), 'a\nb');
  assert.equal(soleFence('---\nSource: x\n---\n\n````\n# a\n```js\nx\n```\n````\n'), '# a\n```js\nx\n```');
  assert.equal(soleFence('# T\n\nintro\n\n```\na\n```\n'), null);
  assert.equal(soleFence('```\na\n```\n\nafter'), null);
  assert.equal(soleFence('# T\n\nno code'), null);
});

test('a requested .md URL is kept as markdown even when one code block is most of it', async () => {
  const url = 'https://docs.example/api/credits.md';
  const ctx = { http: fakeHttp({ [url]: { type: 'text/markdown; charset=utf-8', body: OPENAPI_MD } }), render: noRender, convert, sourcePolicy: 'auto' };
  const r = await fetchPage(url, ctx);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.via, 'markdown');
  assert.ok(!r.route.rendered);
  assert.match(r.markdown, /^# Get remaining credits/m);
  assert.match(r.markdown, /field199:/);
});

test('plain GET refused, browser receives the text file: stored as markdown, not a code block', async () => {
  const url = 'https://docs.example/platform/llms.txt';
  const render = async (u) => ({
    status: 200, finalUrl: u, title: '', contentType: 'text/plain; charset=utf-8', text: LLMS,
    html: `<html><head></head><body><pre style="word-wrap: break-word; white-space: pre-wrap;">${LLMS.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre></body></html>`,
  });
  const ctx = { http: fakeHttp({ [url]: { status: 400, type: 'text/html', body: '<html><title>Error</title></html>' } }), render, convert, sourcePolicy: 'auto' };
  const r = await fetchPage(url, ctx);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.via, 'markdown');
  assert.match(r.markdown, /^# Example Platform/m);
  assert.match(r.markdown, /^- \[Guide 29\]\(https:\/\/docs\.example\/guide-29\.md\)/m);
  assert.equal(fenced(r.markdown), false);
});

test('a site that wraps its llms.txt in an HTML <pre> for browsers: the text is the document', async () => {
  const url = 'https://docs.example/platform/llms.txt';
  const esc = LLMS.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const wrapped = `<!doctype html><html><head><title>Example Platform llms.txt</title><style>pre { white-space: pre-wrap; }</style></head><body><pre>${esc}</pre></body></html>`;
  const render = async (u) => ({ status: 200, finalUrl: u, title: 'Example Platform llms.txt', contentType: 'text/html; charset=utf-8', html: wrapped });
  const ctx = { http: fakeHttp({ [url]: { status: 400, type: 'text/html', body: '<html><title>Error</title></html>' } }), render, convert, sourcePolicy: 'auto' };
  const r = await fetchPage(url, ctx);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.via, 'markdown');
  assert.match(r.markdown, /^> The Example Platform documentation covers/m);
  assert.equal(fenced(r.markdown), false);
});

test('an HTML page that is one code block but not a text-file URL stays a code block', async () => {
  const url = 'https://docs.example/raw/config.json';
  const wrapped = `<!doctype html><html><head><title>config.json</title></head><body><pre>${'{\n  "a": 1,\n  "b": 2\n}\n'.repeat(40)}</pre></body></html>`;
  const render = async (u) => ({ status: 200, finalUrl: u, title: 'config.json', contentType: 'text/html', html: wrapped });
  const ctx = { http: fakeHttp({ [url]: { status: 403, type: 'text/html', body: 'denied' } }), render, convert, sourcePolicy: 'auto' };
  const r = await fetchPage(url, ctx);
  if (r.ok) assert.notEqual(r.via, 'markdown');
});

test('codeFile: one block, a fence longer than any backtick run inside, language from the extension', () => {
  assert.equal(codeFile('a: 1\n', 'docs.yaml'), '```yaml\na: 1\n```\n');
  assert.equal(codeFile('x = """\n```py\ny\n```\n"""', 'mod.py'), '````python\nx = """\n```py\ny\n```\n"""\n````\n');
  assert.equal(codeFile('plain', 'LICENSE'), '```\nplain\n```\n');
});

test('a YAML/JSON/source file is stored verbatim from the plain GET, without a browser', async () => {
  const yaml = 'openapi: 3.0.0\ninfo:\n  title: Example API\n  description: |\n    Use `GET /x`.\n';
  const url = 'https://docs.example/api/docs.yaml';
  const ctx = { http: fakeHttp({ [url]: { type: 'application/x-yaml; charset=utf-8', body: yaml } }), render: noRender, convert, sourcePolicy: 'auto' };
  const r = await fetchPage(url, ctx);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.via, 'text');
  assert.equal(r.title, 'docs.yaml');
  assert.equal(r.markdown, '```yaml\n' + yaml.trimEnd() + '\n```\n');
});

test('an HTML document is never taken as a text file', async () => {
  const url = 'https://docs.example/page';
  const html = `<!doctype html><html><head><title>Page</title></head><body><main><h1>Page</h1>${'<p>Real words about the page here. </p>'.repeat(60)}</main></body></html>`;
  const ctx = { http: fakeHttp({ [url]: { type: 'text/html; charset=utf-8', body: html } }), render: async (u) => ({ status: 200, finalUrl: u, title: 'Page', contentType: 'text/html', html }), convert, sourcePolicy: 'auto' };
  const r = await fetchPage(url, ctx);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.via, 'html');
});
