/**
 * Unit tests for lib/descriptions.mjs — the llms.txt description generator.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanInlineMarkup,
  generateDescription,
  isBadDescription,
  truncate,
  MAX_DESCRIPTION_LENGTH,
} from '../lib/descriptions.mjs';

test('cleanInlineMarkup strips permalink anchors', () => {
  // Observed in llms.txt from docs.python.org: the heading's ¶ permalink, with
  // its quoted title attribute, was written straight into the index.
  const raw = '`venv` — Creation of virtual environments[¶](#module-venv "Link to this heading")';
  assert.equal(cleanInlineMarkup(raw), 'venv — Creation of virtual environments');
});

test('cleanInlineMarkup keeps link text but drops URLs', () => {
  assert.equal(cleanInlineMarkup('See [the guide](https://x/y) for more'), 'See the guide for more');
  assert.equal(cleanInlineMarkup('![diagram](img.png) Overview'), 'diagram Overview');
});

test('cleanInlineMarkup removes HTML and collapses whitespace', () => {
  assert.equal(cleanInlineMarkup('A <span class="x">tagged</span>   title'), 'A tagged title');
});

test('isBadDescription flags leaked markup', () => {
  assert.equal(isBadDescription('Thing[¶](#anchor)', 'docs/x/y.md'), 'raw_markup');
  assert.equal(isBadDescription('Astro — Markdown in Astro', 'docs/x/y.md'), null);
});

test('isBadDescription keeps its existing rejections', () => {
  assert.equal(isBadDescription('', 'docs/x/y.md'), 'empty');
  assert.equal(isBadDescription('/docs/a/b', 'docs/x/y.md'), 'url_path');
  assert.equal(isBadDescription('Overview', 'docs/x/y.md'), 'single_word');
  assert.equal(isBadDescription('getting started', 'docs/x/y.md'), 'too_generic');
  assert.equal(isBadDescription('my page', 'docs/x/my-page.md'), 'filename_derived');
  assert.equal(isBadDescription('x'.repeat(MAX_DESCRIPTION_LENGTH + 1), 'docs/x/y.md'), 'too_long');
});

test('generateDescription reads a folded YAML block scalar', () => {
  // VitePress/Docusaurus emit `description: >-` with the text on following
  // lines; a single-line regex captured the literal ">-" and dropped the text.
  const doc = [
    '---',
    'Source: https://vitepress.dev/guide/markdown',
    'url: /guide/markdown.md',
    'description: >-',
    '  VitePress built-in Markdown extensions including custom containers and',
    '  code blocks with syntax highlighting.',
    '---',
    '',
    '# Markdown Extensions',
    '',
    'VitePress comes with built in Markdown Extensions.',
  ].join('\n');

  const desc = generateDescription('docs/vitepress.dev/guide/markdown.md', doc);
  assert.ok(desc, 'expected a description');
  assert.match(desc, /VitePress built-in Markdown extensions/);
  assert.ok(desc.length <= MAX_DESCRIPTION_LENGTH);
});

test('generateDescription prefers upstream metadata over a bare heading', () => {
  const doc = [
    '---',
    'Source: https://x/y',
    'title: Configuring retries',
    'description: Retry policies, backoff coefficients and non-retryable errors',
    '---',
    '',
    '# Retries',
    '',
    'Body text.',
  ].join('\n');

  const desc = generateDescription('docs/x/retries.md', doc);
  assert.match(desc, /Retry policies/);
});

test('generateDescription never emits raw markup', () => {
  const doc = '---\nSource: https://x/y\n---\n\n# `venv` — Creation[¶](#m "Link")\n\nBody.';
  const desc = generateDescription('docs/docs.python.org/3/library/venv.md', doc);
  assert.ok(desc, 'expected a description');
  assert.ok(!desc.includes(']('), `markup leaked: ${desc}`);
  assert.equal(isBadDescription(desc, 'docs/docs.python.org/3/library/venv.md'), null);
});

test('generateDescription returns null when nothing usable exists', () => {
  assert.equal(generateDescription('docs/x/index.md', '---\nSource: https://x/y\n---\n\n# Index\n'), null);
});

test('truncate respects the max length', () => {
  assert.equal(truncate('abcdef', 5), 'ab...');
  assert.equal(truncate('abc', 5), 'abc');
});
