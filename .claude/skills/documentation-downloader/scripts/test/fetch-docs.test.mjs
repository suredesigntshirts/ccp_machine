/**
 * The v1 entry point (`fetch-docs.js`, now a wrapper over the v2 pipeline) and
 * the v1 helpers that moved: conversion helpers into lib/convert/v1.mjs (the
 * placeholder converter), sitemap/locale helpers into lib/fetch/discover.mjs,
 * cache paths into lib/paths.mjs, the pool into lib/fetch/batch.mjs.
 *
 * Every case here is a regression that was observed in real output, not a
 * hypothetical. Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { translateArgs, documentFor } from '../fetch-docs.js';
import { mapOutsideFences, cleanMarkdown, looksLikeMarkdown } from '../lib/convert/v1.mjs';
import { parseSitemapXml, preferDefaultLocale } from '../lib/fetch/discover.mjs';
import { urlToOutputPath } from '../lib/paths.mjs';
import { runPool } from '../lib/fetch/batch.mjs';
import { detectBadPage } from '../lib/store/quality.mjs';

// ============================================================================
// Code fences must survive cleanup
// ============================================================================

test('cleanMarkdown leaves a bash code fence byte-identical', () => {
  // Observed: 17 fences corrupted in a single fetched VitePress page, because
  // the heading rule inserted a blank line before every `#` comment.
  const fence = '```bash\n# install the CLI\nnpm i -g vitepress\n\n# then run it\nvitepress dev\n```';
  const out = cleanMarkdown(`Intro paragraph.\n\n${fence}\n\nOutro.\n`);
  assert.ok(out.includes(fence), 'fenced block was modified');
});

test('cleanMarkdown does not collapse deliberate blank lines inside a fence', () => {
  const fence = '```python\nx = 1\n\n\n\n\ny = 2\n```';
  const out = cleanMarkdown(`Text.\n\n${fence}\n`);
  assert.ok(out.includes(fence));
});

test('cleanMarkdown does not rewrite dashed rules inside a fence', () => {
  const fence = '```sql\n----------\nSELECT 1;\n```';
  const out = cleanMarkdown(`Text.\n\n${fence}\n`);
  assert.ok(out.includes(fence));
});

test('cleanMarkdown still adds heading spacing in prose', () => {
  const out = cleanMarkdown('Some text.\n## Heading\nMore.\n');
  assert.match(out, /Some text\.\n\n## Heading/);
});

test('mapOutsideFences: ``` does not close a ~~~ fence', () => {
  const md = '~~~md\n# not a heading\n```\nstill inside\n~~~\nafter\n';
  const seen = [];
  mapOutsideFences(md, (prose) => { seen.push(prose); return prose; });
  assert.ok(seen.every(p => !p.includes('still inside')), 'tilde fence closed early');
});

test('mapOutsideFences: an unterminated fence is treated as code', () => {
  const md = 'intro\n\n```js\n# looks like a heading\nconst a = 1;\n';
  const out = cleanMarkdown(md);
  assert.ok(out.includes('```js\n# looks like a heading\nconst a = 1;'));
});

test('mapOutsideFences: round-trips content unchanged with an identity function', () => {
  const md = 'a\n\n```\nb\n```\n\nc\n```\nd\n```\n';
  assert.equal(mapOutsideFences(md, s => s), md);
});

test('mapOutsideFences: handles a document that opens with a fence', () => {
  const md = '```js\nconst a = 1;\n```\ntail\n';
  assert.equal(mapOutsideFences(md, s => s), md);
});

// ============================================================================
// Front matter of -o / stdout output
// ============================================================================

test('documentFor prepends a block when the document has none', async () => {
  const out = await documentFor('# Title\n\nBody', 'https://example.com/a');
  assert.match(out, /^---\nSource: https:\/\/example\.com\/a\n/);
  assert.equal(out.match(/^---$/gm).length, 2, 'expected exactly one front-matter block');
});

test('documentFor merges into upstream front matter instead of stacking', async () => {
  // Observed on vitepress.dev: the upstream `description:` was buried under a
  // second block, so the index fell back to a weaker heading-derived description.
  const upstream = '---\nurl: /guide/markdown.md\ndescription: VitePress markdown extensions\n---\n\n# Markdown Extensions\n';
  const out = await documentFor(upstream, 'https://vitepress.dev/guide/markdown', { via: 'markdown' });
  assert.equal(out.match(/^---$/gm).length, 2, 'front matter was stacked, not merged');
  assert.match(out, /description: VitePress markdown extensions/);
  assert.match(out, /Source: https:\/\/vitepress\.dev\/guide\/markdown/);
  assert.match(out, /Via: markdown/);
  assert.match(out, /\n---\n\n# Markdown Extensions/);
});

test('documentFor replaces stale provenance keys rather than duplicating them', async () => {
  const prior = '---\nSource: https://old.example/x\nGenerated: 2020-01-01\nUpdated: 2020-01-01\ntitle: Keep me\n---\n\nBody\n';
  const out = await documentFor(prior, 'https://new.example/x');
  assert.equal(out.match(/^Source:/gm).length, 1);
  assert.match(out, /Source: https:\/\/new\.example\/x/);
  assert.match(out, /title: Keep me/);
});

test('documentFor records where a redirect landed', async () => {
  const out = await documentFor('# T\n\nBody', 'https://a.example/stable/x', { finalUrl: 'https://a.example/2.14/x' });
  assert.match(out, /Final: https:\/\/a\.example\/2\.14\/x/);
});

test('documentFor --no-front-matter drops upstream front matter too', async () => {
  const out = await documentFor('---\ntitle: T\n---\n\n# T\n', 'https://a.example/x', { frontMatter: false });
  assert.equal(out, '# T\n');
});

// ============================================================================
// v1 flag translation
// ============================================================================

test('translateArgs: a lone URL prints to stdout, -o writes a file', () => {
  assert.equal(translateArgs(['https://a.example/x']).mode, 'stdout');
  const t = translateArgs(['https://a.example/x', '-o', 'out.md', '--no-front-matter']);
  assert.equal(t.mode, 'file');
  assert.equal(t.output, 'out.md');
  assert.equal(t.frontMatter, false);
});

test('translateArgs: -d becomes the cache root; v1 no-op flags are accepted', () => {
  const t = translateArgs(['https://a.example/x', '-d', 'docs/', '--skip-existing', '--update-index', '-c', '5']);
  assert.equal(t.mode, 'cache');
  assert.deepEqual(t.docsArgv, ['https://a.example/x', '--root', 'docs/', '--concurrency', '5']);
});

test('translateArgs: --discover, --refresh with and without days, -u', () => {
  const t = translateArgs(['--discover', 'https://a.example/docs', '--max-discover', '10', '--refresh', '-u', 'urls.txt']);
  assert.equal(t.mode, 'cache');
  assert.deepEqual(t.docsArgv, ['--urls', 'urls.txt', '--discover', 'https://a.example/docs', '--refresh', '30', '--max-discover', '10']);
  assert.deepEqual(translateArgs(['--refresh', '7', '-d', 'd']).docsArgv, ['--root', 'd', '--refresh', '7']);
});

test('translateArgs: errors and warnings', () => {
  assert.match(translateArgs(['https://a/x', '-o']).error, /requires a value/);
  assert.match(translateArgs(['https://a/x', 'https://a/y', '-o', 'f.md']).error, /exactly one URL/);
  assert.match(translateArgs(['https://a/x', '--bogus']).error, /Unknown option/);
  assert.match(translateArgs(['https://a/x', '-s', 'main', '-d', 'd']).warnings[0], /ignored/);
  assert.equal(translateArgs(['https://a/x', 'https://a/y']).mode, 'cache', 'several URLs go to the default root');
});

// ============================================================================
// Sitemap discovery
// ============================================================================

test('parseSitemapXml distinguishes a sitemap index from a urlset', () => {
  // Observed: docs.astro.build serves /sitemap-index.xml and 404s /sitemap.xml,
  // so discovery returned zero URLs and the command exited 0.
  const index = '<?xml version="1.0"?><sitemapindex xmlns="x"><sitemap><loc>https://d/sitemap-0.xml</loc></sitemap></sitemapindex>';
  const urlset = '<?xml version="1.0"?><urlset xmlns="x"><url><loc>https://d/page</loc></url></urlset>';

  assert.equal(parseSitemapXml(index).isIndex, true);
  assert.deepEqual(parseSitemapXml(index).locs, ['https://d/sitemap-0.xml']);
  assert.equal(parseSitemapXml(urlset).isIndex, false);
  assert.deepEqual(parseSitemapXml(urlset).locs, ['https://d/page']);
});

test('parseSitemapXml unwraps CDATA and decodes entities', () => {
  const xml = '<urlset><url><loc><![CDATA[https://d/a?x=1&amp;y=2]]></loc></url></urlset>';
  assert.deepEqual(parseSitemapXml(xml).locs, ['https://d/a?x=1&y=2']);
});

test('parseSitemapXml ignores non-http locs', () => {
  const xml = '<urlset><url><loc>ftp://d/a</loc></url><url><loc>https://d/b</loc></url></urlset>';
  assert.deepEqual(parseSitemapXml(xml).locs, ['https://d/b']);
});

test('preferDefaultLocale puts English/unprefixed URLs first on an i18n site', () => {
  // Astro's sitemap lists /ar/ before /en/, so a capped discovery run fetched
  // only Arabic pages.
  const urls = ['https://d/ar/a', 'https://d/de/b', 'https://d/es/c', 'https://d/en/x', 'https://d/guides/y'];
  const out = preferDefaultLocale(urls);
  assert.deepEqual(out.slice(0, 2), ['https://d/en/x', 'https://d/guides/y']);
  assert.equal(out.length, urls.length);
});

test('preferDefaultLocale leaves a non-i18n site untouched', () => {
  // `/go/` and `/js/` are sections, not languages.
  const urls = ['https://d/go/a', 'https://d/js/b', 'https://d/docs/c'];
  assert.deepEqual(preferDefaultLocale(urls), urls);
});

// ============================================================================
// Output paths
// ============================================================================

test('urlToOutputPath maps URLs to stable cache paths', () => {
  const cases = [
    ['https://example.com/docs/intro', 'docs', 'docs/example.com/docs/intro.md'],
    ['https://www.example.com/a/', 'docs', 'docs/example.com/a.md'],
    ['https://example.com/a/b.html', 'docs', 'docs/example.com/a/b.md'],
    ['https://example.com/a/b.md', 'docs', 'docs/example.com/a/b.md'],
    ['https://example.com/a', 'cache/docs/', 'cache/docs/example.com/a.md'],
  ];
  for (const [url, dir, expected] of cases) {
    assert.equal(urlToOutputPath(url, dir), expected, url);
  }
});

// ============================================================================
// Content validation
// ============================================================================

test('soft 404s are refused (detectBadPage, which replaced isSoft404)', () => {
  assert.ok(detectBadPage('---\nSource: x\n---\n\n# Page Not Found\n'));
  assert.ok(detectBadPage('# 404\n\n' + 'Real content. '.repeat(40)));
  assert.equal(detectBadPage('# Real Page\n\n' + 'Genuine documentation body. '.repeat(20)), null);
});

test('looksLikeMarkdown rejects HTML, PDFs and JSON error bodies', () => {
  // The .md-variant probe used to accept any non-HTML body of 100+ chars, so a
  // JSON error payload could be cached as documentation.
  const json = JSON.stringify({ error: 'not_found', message: 'No such document exists on this server', code: 404, requestId: 'abc123def456' });
  assert.ok(json.length > 100);
  assert.equal(looksLikeMarkdown(json), false);
  assert.equal(looksLikeMarkdown('<!DOCTYPE html><html><body>' + 'x'.repeat(200) + '</body></html>'), false);
  assert.equal(looksLikeMarkdown('%PDF-1.4 ' + 'x'.repeat(200)), false);
  assert.equal(looksLikeMarkdown('# Title\n\n- a\n- b\n\n```js\nconst x = 1;\n```\n\n**bold** and [link](http://a)'), true);
});

// ============================================================================
// Scheduling
// ============================================================================

test('runPool runs everything, honours the concurrency ceiling, keeps input order', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await runPool([...Array(12).keys()], async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 5 + (n % 3)));
    inFlight--;
    return n * 2;
  }, 3);

  assert.deepEqual(out, [...Array(12).keys()].map(n => n * 2));
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded limit`);
});
