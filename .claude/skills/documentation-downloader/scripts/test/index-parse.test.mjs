/**
 * Unit tests for the index's markdown parsing and tokenization
 * (lib/index/markdown.mjs, tokenize.mjs, stem.mjs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDocument, cleanHeading } from '../lib/index/markdown.mjs';
import { tokenize, queryTerms, extractSymbols } from '../lib/index/tokenize.mjs';
import { stem } from '../lib/index/stem.mjs';

const doc = text => parseDocument(text);
const heads = d => d.sections.map(s => [s.level, s.text, s.start, s.spanEnd]);

test('line ranges are 1-based and count the front matter', () => {
  const d = doc('---\nSource: https://x.dev/a\ntitle: A page\n---\n\n# A page\n\nIntro.\n\n## Part\n\nBody.\n');
  assert.equal(d.frontMatterEnd, 4);
  assert.equal(d.frontMatter.source, 'https://x.dev/a');
  assert.equal(d.title, 'A page');
  assert.deepEqual(heads(d), [[1, 'A page', 6, 12], [2, 'Part', 10, 12]]);
});

test('# lines inside fenced code (``` and ~~~) are not headings', () => {
  const d = doc('# T\n\n```bash\n# comment\n```\n\n~~~\n## also code\n~~~\n\n````md\n```\n# nested\n```\n````\n\n## Real\n');
  assert.deepEqual(d.sections.map(s => s.text), ['T', 'Real']);
  assert.deepEqual(d.fences, [[3, 5], [7, 9], [11, 15]]);
});

test('an unclosed fence runs to the end of the file (as GitHub renders it)', () => {
  const d = doc('# T\n\n```\n# not a heading\n');
  assert.deepEqual(d.sections.map(s => s.text), ['T']);
});

test('heading text is cleaned but identifiers survive', () => {
  assert.equal(cleanHeading('`use_edges_state()`[¶](#x "Permalink")'), 'use_edges_state()');
  assert.equal(cleanHeading('Partnership ads label &#123;#partnership-ads-label&#125;'), 'Partnership ads label');
  assert.equal(cleanHeading('Reference {/*reference*/}'), 'Reference');
  assert.equal(cleanHeading('DINOv3ViTConfig[[transformers.DINOv3ViTConfig]]'), 'DINOv3ViTConfig');
  assert.equal(cleanHeading('[Anchor to Rate limits](/x#rate-limits)Rate limits'), 'Rate limits');
  assert.equal(cleanHeading('bulk​Operation​Run​Query'), 'bulkOperationRunQuery');
});

test('an empty heading followed by a split permalink takes the title from the next line', () => {
  // What an HTML→markdown converter made of Mintlify headings in a real v1 cache.
  const d = doc('# Sessions\n\n##\n\n[​\n\n](#choose-an-approach)\n\nChoose an approach\n\nText.\n');
  assert.deepEqual(heads(d), [[1, 'Sessions', 1, 11], [2, 'Choose an approach', 3, 11]]);
});

test('HTML headings, headings in list items and Sphinx permalinked definitions are sections', () => {
  const d = doc([
    '# Page',
    '<tr><th colspan="2"><h2 tabindex="-1">metrics.<wbr>cost_<wbr>micros</h2></th></tr>',
    '<tr><td>Field description</td></tr>',
    '* #### orders/paid: Sample Payload',
    '  payload',
    '*class* pkg.mod.Thing(*a*, *b\\=None*)[\\[source\\]](x.html)[¶](#pkg.mod.Thing "Permalink to this definition")',
    'Docs for Thing.',
    'size[¶](#pkg.mod.Thing.size "Permalink to this definition")',
    'The size.',
  ].join('\n'));
  assert.deepEqual(d.sections.map(s => [s.level, s.text]), [
    [1, 'Page'], [2, 'metrics.cost_micros'], [4, 'orders/paid: Sample Payload'],
    [5, 'class pkg.mod.Thing()'], [6, 'size'],
  ]);
});

test('long sections are windowed into overlapping ranges; short ones are one unit', () => {
  const rows = Array.from({ length: 300 }, (_, i) => `| row${i} | value |`);
  const text = ['# T', '', '## Table', '', '| name | v |', '| --- | --- |', ...rows, '', '## After', '', 'x'].join('\n');
  const d = doc(text);
  const table = d.units.filter(u => u.path.at(-1) === 'Table');
  assert.ok(table.length >= 5, 'table section is windowed');
  assert.ok(table.every(u => u.window && u.end - u.start + 1 <= 60));
  for (let i = 1; i < table.length; i++) {
    assert.ok(table[i].start <= table[i - 1].end, 'windows overlap');
    assert.ok(table[i].start > table[i - 1].start, 'windows advance');
  }
  assert.equal(table.at(-1).end, 306, 'last window reaches the section end');
  assert.equal(table[1].tableHeader, '| name | v |', 'mid-table windows carry the header row');
  assert.ok(d.units.some(u => u.path.at(-1) === 'After' && !u.window));
});

test('windows also close on a character budget (60 kB table lines exist)', () => {
  const big = 'x'.repeat(10000);
  const d = doc(['# T', ...Array.from({ length: 20 }, () => big)].join('\n'));
  assert.ok(d.units.length > 5);
  assert.ok(d.units.every(u => u.end - u.start + 1 <= 3));
});

test('a heading with no content of its own is folded into its first subsection', () => {
  const d = doc('# T\n\nIntro one.\nIntro two.\nIntro three.\n\n## Config\n\n### Locations\n\nWhere files live.\n');
  const u = d.units.find(x => x.path.at(-1) === 'Locations');
  assert.equal(u.start, 7, 'unit starts at the parent heading');
  assert.deepEqual(u.heads.map(h => h.line), [7, 9]);
  assert.ok(!d.units.some(x => x.path.at(-1) === 'Config'));
});

test('identifiers are indexed whole and in parts; prose is stemmed', () => {
  assert.deepEqual(tokenize('onConflictDoUpdate'), ['onconflictdoupd', 'conflict', 'updat']);
  assert.deepEqual(tokenize('use_edges_state'), ['use_edges_state', 'edg', 'state']);
  assert.deepEqual(tokenize('google.genai.types.GenerateContentConfig').slice(0, 2), ['google.genai.types.generatecontentconfig', 'googl']);
  assert.deepEqual(tokenize('Selecting the rows'), ['select', 'row']);
  // Case and compoundness must not change a term: `PageSpeed` in text, `pagespeed` in a query.
  assert.equal(tokenize('PageSpeed')[0], tokenize('pagespeed')[0]);
  // Zero-width spaces inside identifiers (shopify.dev) are ignored.
  assert.deepEqual(tokenize('bulk​Operation'), tokenize('bulkOperation'));
});

test('query terms drop stop words and keep identifiers for symbol lookup', () => {
  const q = queryTerms('how do I use the onConflictDoUpdate method');
  assert.ok(!q.terms.includes('how') && !q.terms.includes('the'));
  assert.deepEqual(q.identifiers, ['onConflictDoUpdate']);
  assert.ok(!queryTerms('how many ads can one set contain').terms.includes('on'));
});

test('symbol extraction keeps API-shaped names only', () => {
  const s = [...extractSymbols('const x = db.select().from(users); onConflictDoUpdate({}); plain words here; my_var')];
  assert.ok(s.includes('db.select'));
  assert.ok(s.includes('onConflictDoUpdate'));
  assert.ok(s.includes('my_var'));
  assert.ok(!s.includes('plain'));
});

test('Porter stemmer basics', () => {
  for (const [w, s] of [['caresses', 'caress'], ['ponies', 'poni'], ['running', 'run'], ['relational', 'relat'], ['generalization', 'gener'], ['agreed', 'agre']]) {
    assert.equal(stem(w), s, w);
  }
});
