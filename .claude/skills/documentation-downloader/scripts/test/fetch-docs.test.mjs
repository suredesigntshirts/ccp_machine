/**
 * Unit tests for the pure helpers in fetch-docs.js.
 *
 * Every case here is a regression that was observed in real output, not a
 * hypothetical. Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapOutsideFences,
  cleanMarkdown,
  applyFrontMatter,
  parseSitemapXml,
  urlToOutputPath,
  preferDefaultLocale,
  isSoft404,
  looksLikeMarkdown,
  isRelevantContent,
  sameSource,
  convertToRawUrl,
  parseIndex,
  renderIndex,
  parseIndexPaths,
  runPool,
  globalBudgetMs,
  TIMEOUTS,
} from '../fetch-docs.js';

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
// Front matter
// ============================================================================

test('applyFrontMatter prepends a block when the document has none', () => {
  const out = applyFrontMatter('# Title\n\nBody', 'https://example.com/a');
  assert.match(out, /^---\nSource: https:\/\/example\.com\/a\n/);
  assert.equal(out.match(/^---$/gm).length, 2, 'expected exactly one front-matter block');
});

test('applyFrontMatter merges into upstream front matter instead of stacking', () => {
  // Observed on vitepress.dev: the upstream `description:` was buried under a
  // second block, so llms.txt fell back to a weaker heading-derived description.
  const upstream = '---\nurl: /guide/markdown.md\ndescription: VitePress markdown extensions\n---\n\n# Markdown Extensions\n';
  const out = applyFrontMatter(upstream, 'https://vitepress.dev/guide/markdown');

  assert.equal(out.match(/^---$/gm).length, 2, 'front matter was stacked, not merged');
  assert.match(out, /description: VitePress markdown extensions/);
  assert.match(out, /Source: https:\/\/vitepress\.dev\/guide\/markdown/);
  assert.match(out, /\n---\n\n# Markdown Extensions/);
});

test('applyFrontMatter preserves the original Generated date on refresh', () => {
  const out = applyFrontMatter('# T\n', 'https://example.com/a', { generated: '2020-01-01' });
  assert.match(out, /Generated: 2020-01-01/);
  assert.doesNotMatch(out, /Updated: 2020-01-01/);
});

test('applyFrontMatter replaces stale provenance keys rather than duplicating them', () => {
  const prior = '---\nSource: https://old.example/x\nGenerated: 2020-01-01\nUpdated: 2020-01-01\ntitle: Keep me\n---\n\nBody\n';
  const out = applyFrontMatter(prior, 'https://new.example/x', { generated: '2020-01-01' });
  assert.equal(out.match(/^Source:/gm).length, 1);
  assert.match(out, /Source: https:\/\/new\.example\/x/);
  assert.match(out, /title: Keep me/);
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

test('isSoft404 catches short not-found bodies and 404 headings', () => {
  assert.equal(isSoft404('---\nSource: x\n---\n\n# Page Not Found\n'), true);
  assert.equal(isSoft404('# 404\n\n' + 'Real content. '.repeat(40)), true);
  assert.equal(isSoft404('# Real Page\n\n' + 'Genuine documentation body. '.repeat(20)), false);
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

test('isRelevantContent ignores structural URL segments', () => {
  // Observed: the real upstream source of /en/guides/markdown-content/ was
  // rejected because "en" and "guides" never appear in the prose.
  const body = '# Markdown in Astro\n\nAstro has built-in support for markdown content in your project.';
  assert.equal(isRelevantContent(body, 'https://docs.astro.build/en/guides/markdown-content/'), true);
});

test('isRelevantContent still rejects an unrelated page', () => {
  const body = '# Sphinx Theme\n\nThis theme provides styling for documentation sites.';
  assert.equal(isRelevantContent(body, 'https://example.com/reference/array-broadcasting'), false);
});

test('sameSource allows same host and known raw mirrors, rejects off-site', () => {
  assert.equal(sameSource('https://www.example.com/a.md', 'https://example.com/b'), true);
  assert.equal(sameSource('https://github.com/o/r/blob/main/a.md', 'https://example.com/b'), true);
  assert.equal(sameSource('https://gitlab.com/o/r/-/blob/main/a.md', 'https://example.com/b'), true);
  assert.equal(sameSource('https://sphinx-doc.org/theme', 'https://docs.scipy.org/x'), false);
});

test('convertToRawUrl rewrites VCS blob/edit/tree URLs', () => {
  assert.equal(
    convertToRawUrl('https://github.com/withastro/docs/edit/main/src/a.mdx'),
    'https://raw.githubusercontent.com/withastro/docs/main/src/a.mdx');
  assert.equal(
    convertToRawUrl('https://gitlab.com/g/p/-/blob/main/a.md'),
    'https://gitlab.com/g/p/-/raw/main/a.md');
  assert.equal(convertToRawUrl('https://example.com/a'), 'https://example.com/a');
});

// ============================================================================
// llms.txt index structure
// ============================================================================

test('parseIndex folds a repeated domain header into one section', () => {
  // Racy appends from parallel agents left duplicate `## domain` headers.
  const content = '## example.com\n\n- docs/example.com/a.md: A\n\n## example.com\n\n- docs/example.com/b.md: B\n';
  const index = parseIndex(content);
  assert.equal(index.sections.length, 1);
  assert.equal(index.sections[0].name, 'example.com');
  assert.equal(renderIndex(index).match(/^## example\.com$/gm).length, 1);
});

test('parseIndexPaths matches whole paths, not substrings', () => {
  const paths = parseIndexPaths('- docs/example.com/api.md: API\n');
  assert.ok(paths.has('docs/example.com/api.md'));
  assert.ok(!paths.has('docs/example.com/api-reference.md'));
});

test('renderIndex preserves the preamble', () => {
  const out = renderIndex(parseIndex('# Docs index\n\n## a.com\n\n- docs/a.com/x.md: X\n'));
  assert.match(out, /^# Docs index/);
  assert.match(out, /## a\.com/);
});

// ============================================================================
// Scheduling
// ============================================================================

test('runPool runs everything and honours the concurrency ceiling', async () => {
  let inFlight = 0;
  let peak = 0;
  const done = [];
  await runPool([...Array(12).keys()], async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 5));
    done.push(n);
    inFlight--;
  }, 3);

  assert.equal(done.length, 12);
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded limit`);
});

test('globalBudgetMs scales the watchdog with the amount of work', () => {
  // A fixed 2-minute budget killed large --discover runs before the index
  // update, discarding it and exiting 1.
  assert.equal(globalBudgetMs(1, 1), TIMEOUTS.GLOBAL + TIMEOUTS.PER_URL);
  assert.ok(globalBudgetMs(50, 3) > globalBudgetMs(3, 3));
  assert.ok(globalBudgetMs(50, 3) > 10 * 60 * 1000);
});
