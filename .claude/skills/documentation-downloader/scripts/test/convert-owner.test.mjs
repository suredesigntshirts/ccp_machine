import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanOwnerMarkdown, cleanWithStats, assessOwnerMarkdown, conversionFingerprints,
  looksLikeMarkdown, parseJsxTag, parseJsString, parseFenceInfo, absolutize,
} from '../lib/convert/owner.mjs';

const URL_ = 'https://docs.example.com/guide/start';
const clean = (md, opts = {}) => cleanOwnerMarkdown(md, { url: URL_, ...opts });
const fencesOf = (md) => [...md.matchAll(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1\2[ \t]*$/gm)].map(m => m[3]);

describe('cleanOwnerMarkdown: MDX', () => {
  test('removes import/export statements, including multi-line ones', () => {
    const md = [
      "import { Tabs } from '@site/components'",
      'import Foo from "./foo.mdx";',
      'export const meta = {',
      '  title: "x",',
      '};',
      '',
      '# Title',
      '',
      'Text.',
    ].join('\n');
    assert.equal(clean(md), '# Title\n\nText.\n');
  });

  test('keeps import/export lines inside code fences byte-for-byte', () => {
    const md = "# T\n\n<Note>\nhi\n</Note>\n\n```js\nimport x from 'y'\nexport const a = 1\n```\n";
    const out = clean(md);
    assert.match(out, /```js\nimport x from 'y'\nexport const a = 1\n```/);
  });

  test('callouts become GitHub alerts, title kept in bold', () => {
    const md = '# T\n\n<Warning title="Careful now">\n  Do not do this.\n\n  Really.\n</Warning>\n\n<Tip>Short tip.</Tip>\n';
    const out = clean(md);
    assert.match(out, /> \[!WARNING\]\n> \*\*Careful now\*\*\n>\n> Do not do this\.\n>\n> Really\./);
    assert.match(out, /> \[!TIP\]\n> Short tip\./);
  });

  test('generic Callout/Admonition takes its kind from an attribute', () => {
    const out = clean('# T\n\n<Callout type="danger">\nx\n</Callout>\n');
    assert.match(out, /> \[!CAUTION\]\n> x/);
  });

  test('tabs become bold-labelled blocks; fences inside lose only the component indentation', () => {
    const md = [
      '# T',
      '',
      '<Tabs>',
      '  <Tab title="Python">',
      '    ```python theme={null}',
      '    def f():',
      '        return 1',
      '    ```',
      '  </Tab>',
      '  <Tab title="JS">',
      '    Use this:',
      '  </Tab>',
      '</Tabs>',
    ].join('\n');
    const out = clean(md);
    assert.match(out, /\*\*Python\*\*\n\n```python\ndef f\(\):\n    return 1\n```/);
    assert.match(out, /\*\*JS\*\*\n\nUse this:/);
    assert.doesNotMatch(out, /<\/?Tab/);
  });

  test('code group: fence titles from the info string become labels', () => {
    const md = '# T\n\n<CodeGroup>\n```bash pip icon="terminal"\npip install x\n```\n\n```bash uv\nuv add x\n```\n</CodeGroup>\n';
    const out = clean(md);
    assert.match(out, /\*\*pip\*\*\n\n```bash\npip install x\n```/);
    assert.match(out, /\*\*uv\*\*\n\n```bash\nuv add x\n```/);
  });

  test('CodeBlock children that reference exported string constants are resolved', () => {
    const md = [
      'export const PyConnect = "import lancedb\\n\\ndb = lancedb.connect(\\"x\\")\\n";',
      '',
      '# T',
      '',
      '<CodeGroup>',
      '  <CodeBlock filename="Python" language="Python" icon="python">',
      '    { "# header\\n" }',
      '',
      '    {PyConnect}',
      '  </CodeBlock>',
      '</CodeGroup>',
    ].join('\n');
    const { markdown, stats } = cleanWithStats(md, { url: URL_ });
    assert.equal(stats.resolved, 1);
    assert.equal(stats.unresolved, 0);
    assert.match(markdown, /\*\*Python\*\*\n\n```python\n# header\nimport lancedb\n\ndb = lancedb.connect\("x"\)\n```/);
  });

  test('unresolved expressions are counted', () => {
    const md = '# T\n\n<CodeBlock language="py">\n  {Missing}\n</CodeBlock>\n\n<Note>\nx\n</Note>\n';
    const { stats } = cleanWithStats(md, { url: URL_ });
    assert.equal(stats.unresolved, 1);
  });

  test('unknown wrappers are unwrapped, self-closing components dropped, inline components keep text', () => {
    const md = [
      '# T',
      '',
      '<Intro>',
      '',
      'Intro text.',
      '',
      '</Intro>',
      '',
      '<InlineToc />',
      '',
      'The <CodeStep step={1}>`subscribe` function</CodeStep> is called. <Badge text="new" />',
    ].join('\n');
    const out = clean(md);
    assert.equal(out, '# T\n\nIntro text.\n\nThe `subscribe` function is called.\n');
  });

  test('cards with href become links; steps and accordions get bold labels', () => {
    const md = '# T\n\n<Columns cols={2}>\n  <Card title="Indexing" href="/indexing/">\n    Build indexes.\n  </Card>\n</Columns>\n\n<Steps>\n  <Step title="Install">\n    Run it.\n  </Step>\n</Steps>\n';
    const out = clean(md);
    assert.match(out, /\*\*\[Indexing\]\(https:\/\/docs\.example\.com\/indexing\/\)\*\*\n\nBuild indexes\./);
    assert.match(out, /\*\*Install\*\*\n\nRun it\./);
  });

  test('API field components render name, type and flags', () => {
    const out = clean('# T\n\n<ParamField path="id" type="string" required>\n  The id.\n</ParamField>\n');
    assert.match(out, /\*\*id\*\* `string` required\n\nThe id\./);
  });

  test('JSX comments and heading ids are removed; ids are reported', () => {
    const ids = [];
    const md = '# T\n\n## State Hooks {/*state-hooks*/}\n\n## Other {#custom-id}\n\n## Config[[transformers.Config]]\n\n{/* a note to editors */}\n\n<Note>x</Note>\n';
    const out = clean(md, { headingIds: ids });
    assert.match(out, /^## State Hooks$/m);
    assert.match(out, /^## Other$/m);
    assert.match(out, /^## Config$/m);
    assert.doesNotMatch(out, /editors/);
    assert.deepEqual(ids.map(i => i.id), ['state-hooks', 'custom-id', 'transformers.Config']);
  });

  test('JSX-looking text inside inline code and fences is untouched', () => {
    const md = '# T\n\n<Note>\nx\n</Note>\n\nReturns `Promise<Foo />` here.\n\n```tsx\n<Tabs>\n  <Tab title="a" />\n</Tabs>\n```\n';
    const out = clean(md);
    assert.match(out, /Returns `Promise<Foo \/>` here\./);
    assert.match(out, /```tsx\n<Tabs>\n  <Tab title="a" \/>\n<\/Tabs>\n```/);
  });

  test('layout wrappers are dropped, their content and images kept', () => {
    const md = '# T\n\n<Note>x</Note>\n\n<div style={{ display: "flex" }}>\n  <img src="/a.png" alt="A cat" width="3" />\n</div>\n\n<span id="anchor" />Text after.\n';
    const out = clean(md);
    assert.doesNotMatch(out, /<div|<\/div>|<span/);
    assert.match(out, /!\[A cat\]\(https:\/\/docs\.example\.com\/a\.png\)/);
    assert.match(out, /^Text after\.$/m);
  });
});

describe('cleanOwnerMarkdown: plain markdown', () => {
  test('::: containers (VitePress/Docusaurus) become alerts; details keep a bold summary', () => {
    const md = '# T\n\n::: warning Does not work with SSR\nThis pattern fails.\n:::\n\n:::tip\nA tip.\n:::\n\n::: details Click me\nHidden.\n:::\n';
    const out = clean(md);
    assert.match(out, /> \[!WARNING\]\n> \*\*Does not work with SSR\*\*\n>\n> This pattern fails\./);
    assert.match(out, /> \[!TIP\]\n> A tip\./);
    assert.match(out, /\*\*Click me\*\*\n\nHidden\./);
    assert.doesNotMatch(out, /:::/);
  });

  test('a fence inside a callout keeps its content, quoted', () => {
    const md = '# T\n\n::: tip\nExample:\n\n```js [vite.config.js]\nexport default {\n  a: 1,\n}\n```\n:::\n';
    const out = clean(md);
    assert.match(out, /> \*\*vite\.config\.js\*\*\n>\n> ```js\n> export default \{\n>   a: 1,\n> \}\n> ```/);
  });

  test('injected llms.txt preamble and postamble are removed', () => {
    const md = [
      '> ## Documentation Index',
      '> Fetch the complete documentation index at: https://docs.example.com/llms.txt',
      '> Use this file to discover all available pages before exploring further.',
      '',
      '# Title',
      '',
      '> A real description blockquote.',
      '',
      'Body.',
      '',
      '---',
      '',
      '## Sitemap',
      '',
      '[Overview of all docs pages](/llms.txt)',
    ].join('\n');
    assert.equal(clean(md), '# Title\n\n> A real description blockquote.\n\nBody.\n');
  });

  test('relative links become absolute; source .md links point at the page; anchors stay', () => {
    const md = '# T\n\nSee [build](./build#public-base-path), [opts](/config/shared-options.md#assetsinclude), [here](#local), ![img](../img/a.png) and [ext](https://x.org/a.md).\n\n[ref]: /docs/ref\n';
    const out = clean(md);
    assert.match(out, /\[build\]\(https:\/\/docs\.example\.com\/guide\/build#public-base-path\)/);
    assert.match(out, /\[opts\]\(https:\/\/docs\.example\.com\/config\/shared-options#assetsinclude\)/);
    assert.match(out, /\[here\]\(#local\)/);
    assert.match(out, /!\[img\]\(https:\/\/docs\.example\.com\/img\/a\.png\)/);
    assert.match(out, /\[ext\]\(https:\/\/x\.org\/a\.md\)/);
    assert.match(out, /^\[ref\]: https:\/\/docs\.example\.com\/docs\/ref$/m);
  });

  test('permalink residue is removed from headings and text', () => {
    const md = '# Title ¶\n\n## Section \\#\n\n## Other [#](#other)\n\n*Figure caption [#](#id4 "Link to this image")*\n\n<dt>f()<a href="#f" title="Link to this definition">¶</a></dt>\n';
    const out = clean(md);
    assert.match(out, /^# Title$/m);
    assert.match(out, /^## Section$/m);
    assert.match(out, /^## Other$/m);
    assert.match(out, /^\*Figure caption\*$/m);
    assert.doesNotMatch(out, /¶|\[#\]/);
  });

  test('front-matter title becomes the H1 when the body has none', () => {
    const out = clean('---\ntitle: "Built-in Hooks"\n---\n\nText.\n');
    assert.equal(out, '---\ntitle: "Built-in Hooks"\n---\n# Built-in Hooks\n\nText.\n');
    assert.equal(clean('---\ntitle: X\n---\n# Real\n'), '---\ntitle: X\n---\n# Real\n');
  });

  test('code fences are byte-for-byte identical (content), whatever they contain', () => {
    const code = '<Note>\n  import x from "y"\n¶ [#](#a) ::: tip\n\t\ttabs\n\n\n  trailing   \n';
    const md = `# T\n\n\`\`\`text\n${code}\`\`\`\n\n~~~~md\n\`\`\`\ninner\n\`\`\`\n~~~~\n`;
    const out = clean(md);
    const fences = fencesOf(out);
    assert.equal(fences[0], code);
    assert.equal(fences[1], '```\ninner\n```\n');
  });

  test('plain markdown without MDX is left alone apart from links', () => {
    const md = '# T\n\nA {curly} thing and <b>bold</b> and a `<Tag>`.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';
    assert.equal(clean(md), md);
  });

  test('double-escaped entities are decoded', () => {
    assert.match(clean("# T\n\ndoesn\\&#39;t\n"), /doesn't/);
  });
});

describe('helpers', () => {
  test('parseJsxTag handles quoted and braced attribute values spanning lines', () => {
    const t = parseJsxTag('<Card\n  title="A > B"\n  style={{ a: "}" }}\n  flag\n>rest');
    assert.equal(t.name, 'Card');
    assert.equal(t.attrs.title, 'A > B');
    assert.equal(t.attrs.flag, true);
    assert.equal(typeof t.attrs.style, 'object');
    assert.equal('<Card\n  title="A > B"\n  style={{ a: "}" }}\n  flag\n>rest'.slice(t.end), 'rest');
    assert.equal(parseJsxTag('<Card title="unterminated'), null);
    assert.equal(parseJsxTag('<X />').selfClosing, true);
  });

  test('parseJsString decodes JS string literals', () => {
    assert.equal(parseJsString('"a\\nb\\"c\\u0041"'), 'a\nb"cA');
    assert.equal(parseJsString("'it\\'s'"), "it's");
    assert.equal(parseJsString('`x ${y}`'), null);
    assert.equal(parseJsString('foo'), null);
  });

  test('parseFenceInfo', () => {
    assert.deepEqual(parseFenceInfo('bash pip icon="terminal" theme={"a":{"b":1}}'), { lang: 'bash', title: '', extra: ['pip'] });
    assert.equal(parseFenceInfo('js twoslash [vite.config.js]').title, 'vite.config.js');
    assert.equal(parseFenceInfo('ts title="a.ts" {1,3}').title, 'a.ts');
  });

  test('absolutize', () => {
    assert.equal(absolutize('/a', 'https://x.com/b/c'), 'https://x.com/a');
    assert.equal(absolutize('#h', 'https://x.com/b'), '#h');
    assert.equal(absolutize('mailto:a@b', 'https://x.com/b'), 'mailto:a@b');
    assert.equal(absolutize('/guide/index.md', 'https://x.com/b'), 'https://x.com/guide/');
    assert.equal(absolutize('other.md', 'https://x.com/raw/page.md'), 'https://x.com/raw/other.md');
  });
});

describe('assessOwnerMarkdown', () => {
  const page = (n = 40) => '# Getting Started\n\n' + Array.from({ length: n }, (_, i) => `Paragraph ${i} explains step number ${i} of the installation in plain words.`).join('\n\n') + '\n';

  test('accepts good markdown that matches the rendered page', () => {
    const md = page();
    const r = assessOwnerMarkdown(md, { url: URL_, how: 'variant', contentType: 'text/markdown', htmlText: md, title: 'Getting Started' });
    assert.equal(r.use, true, r.reason);
    assert.ok(r.quality.recall > 0.99);
    assert.ok(r.markdown.startsWith('# Getting Started'));
  });

  test('rejects HTML, JSON, empty and non-markdown bodies', () => {
    assert.equal(assessOwnerMarkdown('<!doctype html><html><body>x</body></html>', { url: URL_ }).use, false);
    assert.equal(assessOwnerMarkdown('{"error": "not found", "status": 404, "detail": "no such page here at all"}', { url: URL_ }).use, false);
    assert.equal(assessOwnerMarkdown('', { url: URL_ }).use, false);
    assert.equal(assessOwnerMarkdown(page(), { url: URL_, contentType: 'text/html; charset=utf-8' }).use, false);
  });

  test('rejects redirect stubs and bot checks', () => {
    const stub = 'Redirecting… [Continue to ../../2.14/notes/amp\\_examples.html](https://docs.example.com/2.14/notes/amp_examples.html)';
    assert.match(assessOwnerMarkdown(stub, { url: URL_ }).reason, /redirect|tiny|not markdown/);
    const bot = '# Just a moment...\n\nChecking if the site connection is secure. Enable JavaScript and cookies to continue. **Ray ID** abc';
    assert.equal(assessOwnerMarkdown(bot, { url: URL_ }).use, false);
  });

  test('rejects markdown missing much of the rendered page', () => {
    const html = page(40);
    const md = page(15);
    const r = assessOwnerMarkdown(md, { url: URL_, htmlText: html, title: 'Getting Started' });
    assert.equal(r.use, false);
    assert.match(r.reason, /incomplete|not this page/);
  });

  test('a superset of the rendered page is fine (hidden panels the HTML route missed)', () => {
    const r = assessOwnerMarkdown(page(40), { url: URL_, htmlText: page(30), title: 'Getting Started' });
    assert.equal(r.use, true, r.reason);
  });

  test('ignores coverage when the rendered page is itself broken', () => {
    const r = assessOwnerMarkdown(page(40), { url: URL_, htmlText: '## Application error: a client-side exception has occurred', title: 'Getting Started' });
    assert.equal(r.use, true, r.reason);
    assert.equal(r.quality.htmlFailed, true);
  });

  test('rejects a different page (title mismatch)', () => {
    const r = assessOwnerMarkdown(page(), { url: URL_, title: 'Webhook Payload Reference Overview' });
    assert.equal(r.use, false);
    assert.match(r.reason, /title/);
  });

  test('rejects an edge conversion of the HTML page', () => {
    const md = [
      '[Skip to main content](#main-content)', '', 'Back to top', '',
      '- [Home](https://x.org/index.html)', '- [API Reference](https://x.org/ref.html)', '- [fitters](https://x.org/f.html)', '- KaplanMeierFitter', '',
      '# KaplanMeierFitter ¶', '', '<dl><dt>class Foo</dt>', '<dd>', '', 'Body text here.', '', '</dd></dl>', '',
      '## Methods ¶', '', page(10),
    ].join('\n');
    const fp = conversionFingerprints(md);
    assert.ok(fp.score >= 3, JSON.stringify(fp));
    const r = assessOwnerMarkdown(md, { url: URL_ });
    assert.equal(r.use, false);
    assert.match(r.reason, /converted from HTML/);
    assert.equal(conversionFingerprints(page()).score, 0);
  });

  test('rejects a page that is one giant data dump', () => {
    const yaml = '# Create a chat completion\n\n> Sends a request.\n\n````yaml /openapi.yaml post /chat\n' + 'openapi: 3.1.0\n'.repeat(400) + '````\n';
    const r = assessOwnerMarkdown(yaml, { url: URL_ });
    assert.equal(r.use, false);
    assert.match(r.reason, /code block/);
  });

  test('rejects unresolved placeholders', () => {
    const md = page(5) + '\n<CodeBlock language="py">\n  {Missing}\n</CodeBlock>\n\n<Note>x</Note>\n';
    const r = assessOwnerMarkdown(md, { url: URL_ });
    assert.equal(r.use, false);
    assert.match(r.reason, /placeholder/);
  });

  test('looksLikeMarkdown', () => {
    assert.equal(looksLikeMarkdown('# Title\n\nSome text with a [link](https://x.org) and more words to pass.'), true);
    assert.equal(looksLikeMarkdown('just some words without any structure at all, repeated enough to be long'), false);
  });
});

test('owner markdown whose code lost its indentation (CDN conversion) is rejected; the reverse is not', async () => {
  const { codeWhitespaceMismatches } = await import('../lib/convert/owner.mjs');
  const ours = '# T\n\n```python\nwith x:\n    f()\n```\n';
  const collapsed = '# T\n\n```\nwith x:\n f()\n```\n';
  assert.equal(codeWhitespaceMismatches(collapsed, ours), 1);
  assert.equal(codeWhitespaceMismatches(ours, collapsed), 0, 'owner keeps indentation our DOM lost → keep owner');
  assert.equal(codeWhitespaceMismatches(ours, ours), 0);
});

test('owner markdown: code the site HTML-escaped twice is decoded; code with literal quotes is left alone', async () => {
  const { cleanWithStats, unescapeCodeEntities } = await import('../lib/convert/owner.mjs');
  const md = [
    '# Ad', '', 'You can&#039;t perform this operation.', '',
    '```bash', 'curl -F &#039;adset_id=&quot;&lt;AD_SET_ID&gt;&quot;&#039; \\', '  -F &#039;fields=&#123;name&#125;&#039;', '```', '',
    '- In a list:', '', '  ```json', '  &#123;&quot;method&quot;: &quot;DELETE&quot;&#125;', '  ```', '',
    '```html', '<p>Tom &amp; Jerry &quot;quoted&quot;</p>', '```', '',
  ].join('\n');
  const r = cleanWithStats(md, { url: 'https://fb.example/ad' });
  assert.match(r.markdown, /^curl -F 'adset_id="<AD_SET_ID>"' \\$/m);
  assert.match(r.markdown, /^ {2}-F 'fields=\{name\}'$/m);
  assert.match(r.markdown, /^ {2}\{"method": "DELETE"\}$/m);
  assert.match(r.markdown, /^<p>Tom &amp; Jerry &quot;quoted&quot;<\/p>$/m, 'literal < > in the block: entities are the point');
  assert.match(r.markdown, /^You can&#039;t perform/m, 'prose entities render as characters already');
  assert.equal(r.stats.codeUnescaped, 2);
  assert.deepEqual(unescapeCodeEntities(['a &amp; b']), ['a &amp; b'], 'only quote/angle entities mark double escaping');
});
