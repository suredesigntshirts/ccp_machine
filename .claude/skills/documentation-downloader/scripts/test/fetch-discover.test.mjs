/**
 * Discovery (`--discover`): parsing, scoping and the whole walk against a fake
 * HTTP server. No network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import {
  discoveryScope, scopeMiss, ancestorDirs, parseLlmsTxt, parseRobotsSitemaps, sitemapText,
  mergeCandidates, discoverUrls, parseSitemapXml,
} from '../lib/fetch/discover.mjs';

/** A fake http.get serving a URL → body/bytes map (404 otherwise). */
function fakeHttp(routes) {
  const requested = [];
  return {
    requested,
    get: async (url) => {
      requested.push(url);
      const hit = routes[url];
      if (hit === undefined) return { status: 404, url, headers: {}, contentType: 'text/html', text: 'not found', bytes: Buffer.from('not found') };
      const bytes = Buffer.isBuffer(hit) ? hit : Buffer.from(hit);
      const contentType = url.endsWith('.gz') ? 'application/x-gzip' : url.endsWith('.xml') ? 'application/xml'
        : /^\s*<html/i.test(bytes.toString('utf-8', 0, 64)) ? 'text/html' : 'text/plain';
      return { status: 200, url, headers: {}, contentType, text: bytes.toString('utf-8'), bytes };
    },
  };
}

const urlset = (...locs) => `<?xml version="1.0"?><urlset>${locs.map(l => `<url><loc>${l}</loc></url>`).join('')}</urlset>`;
const index = (...locs) => `<?xml version="1.0"?><sitemapindex>${locs.map(l => `<sitemap><loc>${l}</loc></sitemap>`).join('')}</sitemapindex>`;

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

test('discoveryScope: prefix from the path; a file-like last segment scopes to its directory', () => {
  assert.deepEqual(discoveryScope('https://www.x.com/docs/python'), { origin: 'https://www.x.com', host: 'x.com', prefix: '/docs/python/' });
  assert.equal(discoveryScope('https://x.com/docs/python/').prefix, '/docs/python/');
  assert.equal(discoveryScope('https://x.com/docs/intro.html').prefix, '/docs/');
  assert.equal(discoveryScope('https://x.com').prefix, '/');
  assert.equal(discoveryScope('https://lifelines.readthedocs.io/en/latest/').prefix, '/en/latest/');
});

test('scopeMiss: same site with www folded, segment-aware prefix, off-site rejected', () => {
  const scope = discoveryScope('https://x.com/docs/python');
  assert.equal(scopeMiss('https://x.com/docs/python', scope), null);
  assert.equal(scopeMiss('https://x.com/docs/python/', scope), null);
  assert.equal(scopeMiss('https://www.x.com/docs/python/api/a', scope), null);
  assert.equal(scopeMiss('https://x.com/docs/python.md', scope), null, 'the directory page as markdown');
  assert.equal(scopeMiss('https://x.com/docs/pythonic', scope), 'out-of-prefix');
  assert.equal(scopeMiss('https://x.com/docs/java/a', scope), 'out-of-prefix');
  assert.equal(scopeMiss('https://x.com/blog', scope), 'out-of-prefix');
  assert.equal(scopeMiss('https://docs.x.com/docs/python/a', scope), 'offsite', 'a subdomain is another site');
  assert.equal(scopeMiss('https://github.com/x/docs/python', scope), 'offsite');
  assert.equal(scopeMiss('mailto:a@x.com', scope), 'not-http');
  assert.equal(scopeMiss('https://y.com/', discoveryScope('https://x.com/')), 'offsite');
});

test('ancestorDirs walks from the prefix to the root', () => {
  assert.deepEqual(ancestorDirs('/a/b/'), ['/a/b/', '/a/', '/']);
  assert.deepEqual(ancestorDirs('/'), ['/']);
});

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

test('parseLlmsTxt: markdown links and bare URLs, resolved, de-duplicated, fragments dropped', () => {
  const text = [
    '# Project', '', '> summary', '',
    '- [Guide](https://x.com/docs/guide.md): the guide',
    '- [Relative](/docs/api.md "API")',
    '- [Again](https://x.com/docs/guide.md#intro)',
    'https://x.com/docs/bare.md',
    '- [Mail](mailto:a@x.com)',
  ].join('\n');
  assert.deepEqual(parseLlmsTxt(text, 'https://x.com/llms.txt'), [
    'https://x.com/docs/guide.md', 'https://x.com/docs/api.md', 'https://x.com/docs/bare.md',
  ]);
});

test('parseRobotsSitemaps reads every Sitemap line, case-insensitively', () => {
  const robots = 'User-agent: *\nDisallow: /x\nSitemap: https://x.com/s1.xml\nsitemap:/s2.xml.gz\n';
  assert.deepEqual(parseRobotsSitemaps(robots, 'https://x.com'), ['https://x.com/s1.xml', 'https://x.com/s2.xml.gz']);
});

test('sitemapText inflates gzip by magic bytes and passes plain XML through', () => {
  const xml = urlset('https://x.com/a');
  assert.equal(sitemapText(gzipSync(Buffer.from(xml))), xml);
  assert.equal(sitemapText(Buffer.from(xml)), xml);
});

test('parseSitemapXml handles namespace-prefixed tags', () => {
  const xml = '<ns:urlset xmlns:ns="x"><ns:url><ns:loc>https://x.com/a</ns:loc></ns:url></ns:urlset>';
  assert.deepEqual(parseSitemapXml(xml).locs, ['https://x.com/a']);
});

test('mergeCandidates: one URL per cache file, the HTML URL wins over .md, rejects counted', () => {
  const scope = discoveryScope('https://x.com/docs/');
  const { urls, rejected } = mergeCandidates([
    ['https://x.com/docs/'],
    ['https://x.com/docs/a.md', 'https://evil.com/docs/b', 'https://x.com/blog/c', 'https://x.com/docs/sitemap.xml'],
    ['https://x.com/docs/a', 'https://x.com/docs/b/', 'https://x.com/docs/b'],
  ], scope);
  assert.deepEqual(urls, ['https://x.com/docs/', 'https://x.com/docs/a', 'https://x.com/docs/b/']);
  assert.equal(rejected.offsite, 1);
  assert.equal(rejected['out-of-prefix'], 1);
  assert.equal(rejected['not-a-page'], 1);
});

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

test('discoverUrls prefers the path-scoped llms.txt and never queues off-site/out-of-prefix links', async () => {
  const http = fakeHttp({
    'https://x.com/llms.txt': '- [Other](https://x.com/blog/post.md)\n- [Py](https://x.com/docs/python/a.md)\n',
    'https://x.com/docs/python/llms.txt': [
      '- [A](https://x.com/docs/python/a.md)',
      '- [B](/docs/python/b.md)',
      '- [Java](https://x.com/docs/java/j.md)',
      '- [GitHub](https://github.com/x/repo)',
    ].join('\n'),
  });
  const r = await discoverUrls('https://x.com/docs/python', { http, max: 50 });
  assert.deepEqual(r.urls, ['https://x.com/docs/python', 'https://x.com/docs/python/a.md', 'https://x.com/docs/python/b.md']);
  assert.deepEqual(r.sources, ['https://x.com/docs/python/llms.txt']);
  assert.equal(r.rejected.offsite, 1);
  assert.equal(r.rejected['out-of-prefix'], 1);
  assert.ok(!http.requested.some(u => /llms-full/.test(u)), 'llms-full.txt is not fetched when llms.txt exists');
});

test('discoverUrls uses llms-full.txt for links only when no llms.txt exists', async () => {
  const http = fakeHttp({
    'https://x.com/llms-full.txt': '# Everything\n\nSee [A](https://x.com/docs/a) and\nhttps://x.com/docs/b\n\n' + 'body text '.repeat(50),
  });
  const r = await discoverUrls('https://x.com/docs/', { http, sitemaps: false });
  assert.deepEqual(r.urls, ['https://x.com/docs/', 'https://x.com/docs/a', 'https://x.com/docs/b']);
});

test('discoverUrls: robots Sitemap → index → gzipped child; path-scoped; cap reported', async () => {
  const pages = Array.from({ length: 30 }, (_, i) => `https://x.com/docs/p${i}`);
  const http = fakeHttp({
    'https://x.com/robots.txt': 'Sitemap: https://x.com/sitemap-index.xml\n',
    'https://x.com/sitemap-index.xml': index('https://x.com/sitemap-blog.xml', 'https://x.com/sitemap-docs.xml.gz'),
    'https://x.com/sitemap-blog.xml': urlset('https://x.com/blog/1', 'https://x.com/blog/2'),
    'https://x.com/sitemap-docs.xml.gz': gzipSync(Buffer.from(urlset(...pages, 'https://cdn.other.com/docs/x'))),
  });
  const r = await discoverUrls('https://x.com/docs/', { http, max: 10 });
  assert.equal(r.total, 31, 'start URL + 30 pages');
  assert.equal(r.capped, true);
  assert.equal(r.urls.length, 10);
  assert.ok(r.urls.every(u => u.startsWith('https://x.com/docs/')));
  assert.equal(r.rejected['out-of-prefix'], 2);
  assert.equal(r.rejected.offsite, 1);
  assert.ok(r.sources.includes('https://x.com/sitemap-docs.xml.gz'));
  // Declared sitemap produced pages: the conventional guesses are skipped.
  assert.ok(!http.requested.includes('https://x.com/sitemap_index.xml'));
});

test('discoverUrls falls back to conventional sitemap paths, including a path-scoped one', async () => {
  const http = fakeHttp({
    'https://x.com/en/latest/sitemap.xml': urlset('https://x.com/en/latest/a.html', 'https://x.com/en/stable/a.html'),
  });
  const r = await discoverUrls('https://x.com/en/latest/', { http });
  assert.deepEqual(r.urls, ['https://x.com/en/latest/', 'https://x.com/en/latest/a.html']);
});

test('discoverUrls puts English first before capping an i18n sitemap', async () => {
  const locs = [];
  for (const l of ['ar', 'de', 'es', 'fr', 'ja']) for (let i = 0; i < 5; i++) locs.push(`https://x.com/${l}/p${i}`);
  for (let i = 0; i < 5; i++) locs.push(`https://x.com/en/p${i}`);
  const http = fakeHttp({ 'https://x.com/sitemap.xml': urlset(...locs) });
  const r = await discoverUrls('https://x.com/', { http, max: 6 });
  assert.deepEqual(r.urls.slice(1), ['https://x.com/en/p0', 'https://x.com/en/p1', 'https://x.com/en/p2', 'https://x.com/en/p3', 'https://x.com/en/p4']);
});

test('discoverUrls falls back to the start page links when no llms.txt/sitemap covers the prefix', async () => {
  // Read the Docs: the root sitemap lists only versions, and there is no per-version sitemap.
  const html = `<html><body><nav><a href="/en/stable/">stable</a><a href="https://github.com/x">GitHub</a></nav>
    <a href="Quickstart.html">Quickstart</a> <a href="api/fitters.html#top">Fitters</a> <a href="genindex.html">Index</a>
    <a href="_modules/x.html">source</a> <a href="#section">here</a></body></html>`;
  const http = fakeHttp({
    'https://x.com/sitemap.xml': urlset('https://x.com/en/latest/', 'https://x.com/en/stable/'),
    'https://x.com/en/latest/': html,
  });
  const r = await discoverUrls('https://x.com/en/latest/', { http });
  assert.deepEqual(r.urls, ['https://x.com/en/latest/', 'https://x.com/en/latest/Quickstart.html', 'https://x.com/en/latest/api/fitters.html']);
  assert.ok(r.sources.some(s => s.endsWith('(links)')));
  assert.equal(r.rejected['not-a-page'], 2, 'genindex and _modules source pages');
});

test('discoverUrls does not narrow a docs.* host to "doc-like" paths', async () => {
  // docs.lancedb.com: 235 pages, only 9 under a /tutorials/-style path.
  const locs = Array.from({ length: 150 }, (_, i) => `https://docs.x.com/topic${i}`);
  locs.push('https://docs.x.com/api/a', 'https://docs.x.com/guides/b');
  const http = fakeHttp({ 'https://docs.x.com/sitemap.xml': urlset(...locs) });
  const r = await discoverUrls('https://docs.x.com/', { http, max: 500 });
  assert.equal(r.total, 153);
});
