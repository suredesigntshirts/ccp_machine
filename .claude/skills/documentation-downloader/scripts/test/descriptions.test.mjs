/**
 * Page descriptions: the validity checks (lib/descriptions.mjs) and how a page's
 * description is chosen from what its site published (lib/convert/describe.mjs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isBadDescription, descriptionProblem, MAX_DESCRIPTION_LENGTH } from '../lib/descriptions.mjs';
import {
  cleanDescription, cutAtSentence, htmlDescriptions, frontMatterDescription, leadDescription,
  aboutThisPage, candidateProblem, chooseDescription,
} from '../lib/convert/describe.mjs';
import { pageKey, llmsCandidates, parseLlmsEntries, createLlmsIndex } from '../lib/fetch/llms-index.mjs';
import { mergeFrontMatter } from '../lib/store/frontmatter.mjs';

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

test('descriptionProblem: isBadDescription plus v1 index failure modes', () => {
  assert.equal(descriptionProblem('Agent SDK reference - TypeScript', 'x/typescript.md'), null);
  assert.equal(descriptionProblem('[\u200b', 'x/a.md'), 'invisible_chars');
  assert.equal(descriptionProblem('0.3.160', 'x/a.md'), 'no_words');
  assert.equal(descriptionProblem('Props (see list', 'x/a.md'), 'unbalanced_brackets');
  assert.equal(descriptionProblem('/docs/api/thing', 'x/a.md'), 'url_path');
  const long = 'A deliberately written, detailed description of the page. '.repeat(4).trim();
  assert.equal(descriptionProblem(long, 'x/a.md'), 'too_long', 'default: isBadDescription semantics');
  assert.equal(descriptionProblem(long, 'x/a.md', { handWritten: true }), null, 'hand-written, complete: kept');
  assert.equal(descriptionProblem(`${long.slice(0, 150)}...`, 'x/a.md', { handWritten: true }), 'too_long', 'truncated: rejected');
});

// ── cleaning ────────────────────────────────────────────────────────────────

test('cleanDescription: plain one-line text from markup and entities', () => {
  // docs.python.org: a heading permalink with its quoted title attribute.
  assert.equal(cleanDescription('`venv` — Creation of virtual environments[¶](#module-venv "Link to this heading")'), '`venv` — Creation of virtual environments');
  assert.equal(cleanDescription('See [the guide](https://x/y) for **more**'), 'See the guide for more');
  assert.equal(cleanDescription('A <span class="x">tagged</span>\n  title &amp; more'), 'A tagged title & more');
  assert.equal(cleanDescription('An annotation for a shop&#x27;s timeline'), "An annotation for a shop's timeline");
  assert.equal(cleanDescription('"Quoted whole"'), 'Quoted whole');
});

test('cutAtSentence: at a sentence end, else at a word marked …', () => {
  const two = 'The first sentence is here and long enough to count. The second one goes on and on past the limit.';
  assert.equal(cutAtSentence(two, 70), 'The first sentence is here and long enough to count.');
  assert.equal(cutAtSentence('one two three four five six seven eight', 20), 'one two three four…');
  assert.equal(cutAtSentence('short.', 20), 'short.');
});

// ── sources ─────────────────────────────────────────────────────────────────

test('htmlDescriptions: meta, og, twitter, JSON-LD in that order, de-duplicated', () => {
  const html = `<html><head>
    <meta property="og:description" content="OG text about the page">
    <meta name="description" content='Meta text &amp; more'>
    <meta name="twitter:description" content="OG text about the page">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"TechArticle","description":"LD text"}]}</script>
    </head><body><meta name="description" content="in body: ignored"></body></html>`;
  assert.deepEqual(htmlDescriptions(html), ['Meta text & more', 'OG text about the page', 'LD text']);
  assert.deepEqual(htmlDescriptions(null), []);
});

test('frontMatterDescription: plain and block scalars', () => {
  assert.equal(frontMatterDescription('---\ntitle: X\ndescription: The page in one line.\n---\n# X'), 'The page in one line.');
  assert.equal(frontMatterDescription('---\ndescription: >-\n  Folded over\n  two lines.\ntitle: X\n---\nbody'), 'Folded over two lines.');
  assert.equal(frontMatterDescription('# no front matter'), null);
});

test('leadDescription: the summary under the title, else the first real paragraph', () => {
  assert.equal(leadDescription('# Basic Table Operations\n\n> Create tables, search vectors, and append data in LanceDB.\n\nBody.'),
    'Create tables, search vectors, and append data in LanceDB.');
  // A byline / badge line is skipped; a callout is not a summary.
  assert.equal(leadDescription('# JSON.stringify()\n\nBaseline Widely available\n\n> [!NOTE]\n> Deprecated in 2020 and kept for old browsers only, see below.\n\nThe **JSON.stringify()** static method converts a JavaScript value to a JSON string.'),
    'The JSON.stringify() static method converts a JavaScript value to a JSON string.');
  // A sentence that introduces code ends with a full stop.
  assert.equal(leadDescription('# Assets\n\nImporting a static asset will return the resolved public URL when it is served:\n\n```js\nimport x\n```'),
    'Importing a static asset will return the resolved public URL when it is served.');
  // Code, tables and lists are never a lead.
  assert.equal(leadDescription('# API\n\n```\ncode only here, nothing else at all\n```\n\n| a | b |\n|---|---|\n\n- a list item that is long enough to count as text'), null);
});

test('aboutThisPage: a site tagline on every page is not about the page', () => {
  assert.equal(aboutThisPage('Next Generation Frontend Tooling', 'Importing a static asset will return its resolved public URL.'), false);
  assert.equal(aboutThisPage("We're on a journey to advance and democratize artificial intelligence through open source and open science.", 'GR-Lite is a vision encoder. Usage: load the model with transformers.'), false);
  assert.equal(aboutThisPage('Calculate the t-test on two related samples of scores.', 'scipy.stats.ttest_rel calculates the t-test on two related samples of scores a and b'), true);
});

test('candidateProblem: too short, only the title, or a broken entry', () => {
  assert.equal(candidateProblem('Advantage+ Creative', { title: 'Advantage+ Creative' }), 'too short');
  assert.equal(candidateProblem('Schema and Data Evolution guide', { title: 'Schema and Data Evolution guide' }), 'only the title');
  assert.equal(candidateProblem('Props for the component (see list', {}), 'unbalanced_brackets');
  assert.equal(candidateProblem('Learn how to manage table schemas in LanceDB, including adding columns.', { title: 'Schema' }), null);
  assert.equal(candidateProblem('A long sentence that we cut ourselves at a word because it…', { cut: true }), null);
});

// ── choice ──────────────────────────────────────────────────────────────────

const PAGE = '---\ndescription: From the front matter of the page source.\n---\n# Static Asset Handling\n\nImporting a static asset will return the resolved public URL when it is served.\n';
const HTML = '<head><meta name="description" content="How static assets such as images and fonts are imported and served."></head>';

test('chooseDescription: llms.txt, then front matter, then meta, then the lead', async () => {
  const base = { markdown: PAGE, html: HTML, title: 'Static Asset Handling' };
  assert.deepEqual((await chooseDescription({ ...base, llms: 'Handle static assets: imports, public URLs and the public directory.' })).from, 'llms.txt');
  assert.equal((await chooseDescription(base)).from, 'front-matter');
  const noFm = { ...base, markdown: PAGE.replace(/^---[\s\S]*?---\n/, '') };
  const m = await chooseDescription(noFm);
  assert.equal(m.from, 'meta');
  assert.equal(m.description, 'How static assets such as images and fonts are imported and served.');
  const l = await chooseDescription({ ...noFm, html: '<head><meta name="description" content="Next Generation Frontend Tooling"></head>' });
  assert.equal(l.from, 'lead');
  assert.match(l.rejected[0].why, /not about this page/);
  const d = await chooseDescription({ ...noFm, isSiteDefault: async () => true });
  assert.equal(d.from, 'lead');
  assert.match(d.rejected[0].why, /default/);
  assert.equal((await chooseDescription({ markdown: '# T\n\n```\nx\n```\n', title: 'T' })).description, null);
});

// ── the site's llms.txt ─────────────────────────────────────────────────────

test('llms.txt entries: link forms, relative links, match keys', () => {
  const txt = `# Site\n\n> About.\n\n## Docs\n\n- [Schema](https://www.docs.example/tables/schema.md): Manage table schemas.\n- [Index](/tables/): Basic table operations — create and append.\n* [Plain](https://docs.example/plain) - Dash separated.\n- [No description](https://docs.example/none)\n`;
  const e = parseLlmsEntries(txt, 'https://docs.example/llms.txt');
  assert.equal(e[pageKey('https://docs.example/tables/schema')], 'Manage table schemas.');
  assert.equal(e[pageKey('https://docs.example/tables/index.html')], 'Basic table operations — create and append.');
  assert.equal(e[pageKey('http://docs.example/plain/')], 'Dash separated.');
  assert.equal(e[pageKey('https://docs.example/none')], undefined);
  assert.deepEqual(llmsCandidates('https://d.example/docs/python/api/x'), ['https://d.example/llms.txt', 'https://d.example/docs/llms.txt', 'https://d.example/docs/python/llms.txt']);
  assert.deepEqual(llmsCandidates('https://d.example/page'), ['https://d.example/llms.txt']);
});

test('createLlmsIndex: deepest list first, each fetched once, HTML soft-404s ignored', async () => {
  const calls = [];
  const files = {
    'https://d.example/llms.txt': '- [X](https://d.example/docs/x): Origin entry.\n',
    'https://d.example/docs/llms.txt': '- [X](/docs/x.md): Section entry for X.\n',
  };
  const http = { get: async (url, o) => {
    calls.push(url);
    const body = files[url];
    const head = body ? { status: 200, contentType: 'text/plain' } : { status: 200, contentType: 'text/html' };
    if (o.want && !o.want({ ...head, url })) return { ...head, url, text: '', skipped: true };
    return { ...head, url, text: body };
  } };
  const idx = createLlmsIndex({ http });
  assert.equal(await idx.describe('https://d.example/docs/x'), 'Section entry for X.');
  assert.equal(await idx.describe('https://d.example/docs/y', 'https://d.example/docs/x'), 'Section entry for X.');
  assert.equal(await idx.describe('https://d.example/docs/none'), null);
  assert.deepEqual([...new Set(calls)].length, calls.length, 'each llms.txt fetched once');
});

// ── refresh: a description from a better source is never replaced ───────────

test('mergeFrontMatter: descriptions only move to an equal or better source', () => {
  const m = (previous, supplied) => { const r = mergeFrontMatter({ url: 'https://a/x', previous, upstream: { description: 'upstream' }, supplied }); return [r.description, r.DescriptionFrom]; };
  assert.deepEqual(m({}, { description: 'lead', DescriptionFrom: 'lead' }), ['lead', 'lead']);
  assert.deepEqual(m({ description: 'old lead', DescriptionFrom: 'lead' }, { description: 'site llms', DescriptionFrom: 'llms.txt' }), ['site llms', 'llms.txt']);
  assert.deepEqual(m({ description: 'old llms', DescriptionFrom: 'llms.txt' }, { description: 'meta', DescriptionFrom: 'meta' }), ['old llms', 'llms.txt']);
  assert.deepEqual(m({ description: 'written by hand' }, { description: 'site llms', DescriptionFrom: 'llms.txt' }), ['written by hand', undefined]);
  assert.deepEqual(m({ description: 'old lead', DescriptionFrom: 'lead' }, { description: null, DescriptionFrom: null }), ['old lead', 'lead']);
  assert.deepEqual(m({}, { description: null, DescriptionFrom: null }), [undefined, undefined], 'a rejected upstream description is not written');
});

test('rules from the rated sample: escapes, placeholders, restated titles, openers, open brackets', () => {
  assert.equal(cleanDescription('A shipment of one or more items from an\\n`Order`. &amp;#x27;x&amp;#x27;'), "A shipment of one or more items from an `Order`. 'x'");
  assert.equal(candidateProblem('moonrise-replace9ffc7d39c08149d489307f4b mo developer quickstart tutorial.', { title: 'Quickstart' }), 'template placeholder');
  assert.equal(candidateProblem('Learn about the Webhooks API', { title: 'Webhooks API' }), 'only the title');
  assert.equal(candidateProblem('This page describes how to create, train and tune recommendation models for each serving config.', { title: 'Create recommendation models' }), null, 'a longer sentence says more than the title');
  assert.equal(leadDescription("# Quickstart\n\nLet's start by importing some data into a dataframe for later.\n\nThe lifelines library fits survival models to duration data in Python."),
    'The lifelines library fits survival models to duration data in Python.');
  assert.equal(leadDescription('# Member\n\nRequires `read_customers` access scope. Also needs a user.\n\nA member of a customer segment, with the customer\'s details.'),
    "A member of a customer segment, with the customer's details.");
  const sdpa = 'Computes scaled dot product attention on query, key and value tensors, using an optional attention mask if passed, and applying dropout if a probability greater than 0.0 is specified (the optional scale argument can only be given as a keyword, see the notes below for details on how it is used) and more.';
  const cut = cutAtSentence(sdpa, 250);
  assert.ok(!cut.includes('('), cut);
  assert.match(cut, /is specified…$/);
});

test('leads: signatures and legal notices are skipped; a failed lead falls through to the next', async () => {
  const md = '# sdpa\n\n## torch.nn.functional.sdpa()\n\nis_causal=False, scale=None, enable_gqa=False) -> Tensor:\n\nComputes scaled dot product attention on query, key and value tensors.\n';
  assert.equal(leadDescription(md), 'Computes scaled dot product attention on query, key and value tensors.');
  assert.equal(leadDescription('# Model\n\nThe information you provide will be collected, stored, processed and shared in accordance with the privacy policy.\n\nA vision transformer pretrained on 1.7B images for dense features.'),
    'A vision transformer pretrained on 1.7B images for dense features.');
  const d = await chooseDescription({ markdown: '# T\n\nShort but broken (see.\n\nThe second paragraph describes what this page covers in full.', title: 'T' });
  assert.equal(d.description, 'The second paragraph describes what this page covers in full.');
});
