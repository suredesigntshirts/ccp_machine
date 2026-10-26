import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  splitLargePage, findHeadings, assignAnchors, githubSlug, fileSlug, headingPlainText, estimateTokens,
} from '../lib/convert/split.mjs';
import { splitFrontMatter, parseFrontMatter } from '../lib/store/frontmatter.mjs';

const URL_ = 'https://docs.example.com/api/reference';
const para = (words, tag = 'x') => Array.from({ length: words }, (_, i) => `${tag}${i}`).join(' ');
/** A section of about `tokens` tokens (estimateTokens = chars / 3.5). */
const section = (level, title, tokens) => `${'#'.repeat(level)} ${title}\n\n${para(Math.ceil(tokens * 3.5 / 6), title.replace(/\W/g, '').slice(0, 3))}\n\n`;

const concatBodies = (r) => r.parts.map(p => p.body).join('');
const bodyOf = (md) => splitFrontMatter(md).body;

describe('splitLargePage', () => {
  test('returns null for a page that fits', () => {
    assert.equal(splitLargePage('# T\n\nsmall\n', { url: URL_ }), null);
  });

  test('verbatim: the parts\' bodies concatenate to the original body, byte for byte', () => {
    const md = '---\nSource: https://docs.example.com/api/reference\ntitle: Ref\n---\n\n# Ref\n\nIntro.\n\n'
      + section(2, 'Alpha', 900) + section(3, 'Alpha one', 700) + section(3, 'Alpha two', 700)
      + section(2, 'Beta', 1200) + '```py\n# not a heading\nx = 1\n```\n\n' + section(2, 'Gamma', 300)
      + 'trailing text without newline';
    const r = splitLargePage(md, { url: URL_, maxTokens: 1500, targetTokens: 1000 });
    assert.ok(r && r.parts.length >= 3);
    assert.equal(concatBodies(r), bodyOf(md));
    for (const p of r.parts) {
      assert.equal(bodyOf(p.markdown), p.body, 'part markdown = front matter + body');
      assert.ok(p.oversized || p.tokens <= 1500, `${p.slug} ${p.tokens}`);
    }
  });

  test('verbatim holds with CRLF-free edge cases: blank lines, no trailing newline, unicode', () => {
    const md = '\n\n# Título\n\n' + section(2, 'Ünïcödé', 900) + section(2, 'Ünïcödé', 900) + '\n\n\n' + section(2, '日本語', 900).trimEnd();
    const r = splitLargePage(md, { url: URL_, maxTokens: 1200 });
    assert.ok(r);
    assert.equal(concatBodies(r), md);
  });

  test('verbatim on randomized documents (fences, HTML, tables, lists, odd headings)', () => {
    let seed = 42;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const pieces = [
      () => `${'#'.repeat(1 + rnd(6))} Heading ${rnd(50)}\n`,
      () => `${para(20 + rnd(200))}\n`,
      () => '```js\n# inside\n' + para(rnd(300)) + '\n```\n',
      () => '~~~\n```\n## x\n```\n~~~\n',
      () => '<table>\n<tr><td>\n\n## in table\n\n</td></tr>\n</table>\n',
      () => '| a | b |\n| - | - |\n| 1 | 2 |\n',
      () => `* item ${rnd(9)}\n\n  #### nested ${rnd(9)}\n\n  text\n`,
      () => '#\n', () => '\n', () => '   ### indented heading\n', () => '<div>\nunclosed\n\n## after\n',
      () => 'line without newline',
    ];
    for (let doc = 0; doc < 40; doc++) {
      let md = '';
      const n = 20 + rnd(200);
      for (let i = 0; i < n; i++) md += pieces[rnd(pieces.length)]() + (rnd(3) ? '\n' : '');
      const r = splitLargePage(md, { url: URL_, maxTokens: 300 + rnd(2000), targetTokens: rnd(2) ? 1 : undefined });
      if (!r) continue;
      assert.equal(concatBodies(r), bodyOf(md), `doc ${doc}`);
      assert.equal(new Set(r.parts.map(p => p.slug)).size, r.parts.length);
    }
  });

  test('uses the shallowest level first and recurses into oversized sections only', () => {
    const md = '# Page\n\n' + section(2, 'Small', 300)
      + section(2, 'Big', 200) + section(3, 'Big A', 900) + section(3, 'Big B', 900)
      + section(2, 'Tail', 300);
    const r = splitLargePage(md, { url: URL_, maxTokens: 1200, targetTokens: 1 });
    const titles = r.parts.map(p => p.title);
    assert.ok(titles.includes('Small'));
    assert.ok(titles.includes('Tail'));
    assert.ok(titles.includes('Big A') && titles.includes('Big B'), titles.join(' | '));
    // The H3s of the small H2s are not split out.
    assert.equal(r.parts.find(p => p.title === 'Big B').path.join(' > '), 'Page > Big > Big B');
  });

  test('never cuts inside a code fence, an HTML block or a table', () => {
    const fenced = '```md\n' + Array.from({ length: 50 }, (_, i) => `## fake ${i}\n${para(40)}`).join('\n') + '\n```\n';
    const html = '<details>\n<summary>More</summary>\n\n## inside details\n\n' + para(400) + '\n\n</details>\n';
    const md = '# Page\n\n' + section(2, 'One', 800) + '## Two\n\n' + fenced + '\n' + html + '\n' + section(2, 'Three', 800);
    const r = splitLargePage(md, { url: URL_, maxTokens: 1000, targetTokens: 1 });
    assert.equal(concatBodies(r), md);
    for (const p of r.parts) {
      assert.doesNotMatch(p.body.split('\n')[0], /fake|inside details/, 'no part starts inside a fence/HTML block');
      const ticks = (p.body.match(/^```/gm) || []).length;
      assert.equal(ticks % 2, 0, `balanced fences in ${p.slug}`);
      assert.equal((p.body.match(/<details>/g) || []).length, (p.body.match(/<\/details>/g) || []).length);
    }
    const two = r.parts.find(p => p.title === 'Two');
    assert.ok(two.oversized, 'the uncuttable section is flagged');
    assert.match(r.index.markdown, /too large to split/);
    assert.match(r.index.markdown, /line windows: 1–\d+/);
  });

  test('headings inside a top-level list item are cut before the item', () => {
    const items = Array.from({ length: 6 }, (_, i) => `* #### topic${i}/update: Sample Payload\n\n  \`\`\`json\n  ${para(300, 'j')}\n  \`\`\`\n`).join('\n');
    const md = '# Webhooks\n\n## Examples\n\n' + items;
    const r = splitLargePage(md, { url: URL_, maxTokens: 800, targetTokens: 1 });
    assert.equal(concatBodies(r), md);
    const itemParts = r.parts.filter(p => p.body.startsWith('* ####'));
    assert.equal(itemParts.length, 6);
    assert.ok(r.parts.every(p => /^(#|\* ####)/.test(p.body)), 'every part starts at a heading or a titled item');
    assert.equal(itemParts[0].anchor, 'topic0update-sample-payload');
  });

  test('an empty heading whose text follows on the next lines is still a boundary (v1 caches)', () => {
    const md = '# T\n\n##\n\n[​\n\n](#installation)\n\nInstallation\n\ntext\n';
    const hs = assignAnchors(findHeadings(md.split('\n')));
    assert.deepEqual(hs.map(h => [h.line, h.title, h.anchor]), [[0, 'T', 't'], [2, 'Installation', 'installation']]);
  });

  test('indented headings in list items are not cut points of their own', () => {
    const md = '# P\n\n* item\n\n  ### nested title\n\n  ' + para(3000) + '\n\n## Next\n\n' + para(3000) + '\n';
    const hs = findHeadings(md.split('\n'));
    assert.deepEqual(hs.map(h => [h.line, h.text]), [[0, 'P'], [2, 'nested title'], [8, 'Next']]);
  });

  test('small sections are packed; a shallower heading never hides in a deeper part', () => {
    let md = '# API\n\n';
    for (let g = 0; g < 3; g++) {
      md += `## Group ${g}\n\n`;
      for (let k = 0; k < 20; k++) md += section(3, `g${g} entry ${k}`, 100);
    }
    const r = splitLargePage(md, { url: URL_, maxTokens: 2500, targetTokens: 1200 });
    assert.equal(concatBodies(r), md);
    assert.ok(r.parts.length < 20, `packed into ${r.parts.length}`);
    for (const p of r.parts) {
      const levels = p.sections.map(s => s.level);
      if (levels.length) assert.ok(levels.every(l => l >= levels[0]), `${p.slug}: ${levels}`);
      assert.ok(p.tokens <= 2500);
    }
  });

  test('part front matter: Source with the anchor, title, part number', () => {
    const md = '# Ref\n\n' + section(2, 'Create a table', 900) + section(2, 'Drop a table', 900);
    const r = splitLargePage(md, { url: URL_, maxTokens: 1000, targetTokens: 1 });
    const p = r.parts.find(x => x.title === 'Drop a table');
    const { data } = parseFrontMatter(p.markdown);
    assert.equal(data.Source, `${URL_}#drop-a-table`);
    assert.equal(data.title, 'Drop a table');
    assert.match(data.Part, /^\d+ of \d+$/);
    assert.equal(p.slug, 'drop-a-table');
  });

  test('index lists every part with path, size and URL#anchor, and keeps the page front matter', () => {
    const md = '---\nSource: https://docs.example.com/api/reference\ntitle: Ref\ndescription: The reference.\n---\n\n# Ref\n\n'
      + section(2, 'One', 900) + section(3, 'One sub', 100) + section(2, 'Two', 900);
    const r = splitLargePage(md, { url: URL_, maxTokens: 1500, targetTokens: 1 });
    const idx = r.index.markdown;
    const { data } = parseFrontMatter(idx);
    assert.equal(data.description, 'The reference.');
    assert.equal(data.Parts, r.parts.length);
    for (const p of r.parts) {
      assert.ok(idx.includes(`](${p.slug}.md)`), p.slug);
      assert.match(idx, new RegExp(`${p.lines} lines`));
    }
    assert.match(idx, /Ref › One — \d+ lines, ~[\d.k]+ tokens — https:\/\/docs\.example\.com\/api\/reference#one/);
    assert.match(idx, /- One sub — line \d+ — #one-sub/);
    assert.ok(estimateTokens(idx) < 1500);
  });

  test('slugs are filesystem-safe and unique', () => {
    const md = '# P\n\n' + section(2, 'Setup / Install?', 900) + section(2, 'Setup / Install?', 900) + section(2, '日本語', 900) + section(2, '_index', 900);
    const r = splitLargePage(md, { url: URL_, maxTokens: 1000, targetTokens: 1 });
    const slugs = r.parts.map(p => p.slug);
    assert.equal(new Set(slugs).size, slugs.length);
    for (const s of slugs) assert.match(s, /^[a-z0-9][a-z0-9_-]*$/);
    assert.ok(!slugs.includes('_index'));
    assert.ok(slugs.includes('setup-install') && slugs.includes('setup-install-1'), slugs.join(','));
  });

  test('a page with no headings cannot be cut: null', () => {
    assert.equal(splitLargePage(para(20000), { url: URL_, maxTokens: 1000 }), null);
  });
});

describe('anchors', () => {
  test('githubSlug', () => {
    assert.equal(githubSlug('Hello, World!'), 'hello-world');
    assert.equal(githubSlug('`useState(initial)`'), 'usestateinitial');
    assert.equal(githubSlug('[Link text](https://x.org) and **bold**'), 'link-text-and-bold');
    assert.equal(githubSlug('snake_case & more'), 'snake_case--more');
    assert.equal(githubSlug('Ünïcödé 日本'), 'ünïcödé-日本');
  });

  test('duplicates get -1, -2; explicit ids and site permalinks win', () => {
    const hs = assignAnchors([
      { text: 'Intro' }, { text: 'Intro' }, { text: 'Intro' },
      { text: 'Custom {#my-id}' },
      { text: 'lancedb.connect [¶](https://x.org/p#lancedb.connect "Permanent link")' },
      { text: 'Supplied' },
    ], [{ text: 'Supplied', id: 'from-source' }]);
    assert.deepEqual(hs.map(h => h.anchor), ['intro', 'intro-1', 'intro-2', 'my-id', 'lancedb.connect', 'from-source']);
    assert.equal(hs[3].title, 'Custom');
    assert.equal(hs[4].title, 'lancedb.connect');
  });

  test('headingPlainText strips markup and permalink residue', () => {
    assert.equal(headingPlainText('**Bold** `code` [link](#x) ¶'), 'Bold code link');
  });

  test('fileSlug', () => {
    assert.equal(fileSlug('Crème brûlée / Setup'), 'creme-brulee-setup');
    assert.equal(fileSlug('日本語'), 'section');
    assert.ok(fileSlug('a'.repeat(200)).length <= 60);
  });
});
