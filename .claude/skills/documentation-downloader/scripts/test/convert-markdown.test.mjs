/**
 * Unit tests for the markdown conversion core (scripts/lib/convert/markdown.mjs).
 * Small synthetic fixtures, one per rule (DESIGN.md "Markdown rules"); no network.
 * Each fixture mirrors markup seen in the eval corpus (eval/STRUCTURE_NOTES.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHtml } from '../lib/convert/dom.mjs';
import { toMarkdown, normalizeCodeBlock, isHiddenButReal, codeSpan, fenceCode, escapeMarkdown } from '../lib/convert/markdown.mjs';

const BASE = 'https://example.com/docs/guide/page';
const md = (html, opts = {}) => {
  const doc = parseHtml(`<!doctype html><html><head></head><body><main>${html}</main></body></html>`, BASE);
  return toMarkdown(doc.querySelector('main'), { baseUrl: BASE, ...opts });
};
const fenceBody = (out) => {
  const m = /```[^\n]*\n([\s\S]*?)\n```/.exec(out);
  return m ? m[1] : null;
};

// ---------------------------------------------------------------------------
// Code blocks
// ---------------------------------------------------------------------------

test('code: <pre><code> kept byte-exact with language from class', () => {
  const out = md('<pre><code class="language-python">def f(x):\n\tif x:\n\n        return 1\n</code></pre>');
  assert.match(out, /^```python$/m);
  assert.equal(fenceBody(out), 'def f(x):\n\tif x:\n\n        return 1');
});

test('code: language never guessed from content', () => {
  const out = md('<pre><code>import os\nprint(os.getcwd())</code></pre>');
  assert.match(out, /^```\n/m);
});

test('code: CodeMirror line elements rebuilt as lines, gutter dropped', () => {
  const html = `<div class="cm-editor"><div class="cm-gutters" aria-hidden="true"><div>1</div><div>2</div><div>3</div></div>
    <div class="cm-content" role="textbox"><div class="cm-line">{% assign x = 1 %}</div><div class="cm-line"><br></div><div class="cm-line">  {{ x }}</div></div></div>`;
  assert.equal(fenceBody(md(html)), '{% assign x = 1 %}\n\n  {{ x }}');
});

test('code: Prism .token-line lines inside pre (no newline text nodes)', () => {
  const html = '<pre class="prism-code language-js"><div class="token-line"><span>const a = 1;</span></div><div class="token-line"><span></span></div><div class="token-line"><span>  a++;</span></div></pre>';
  const out = md(html);
  assert.equal(fenceBody(out), 'const a = 1;\n\n  a++;');
  assert.match(out, /^```js$/m);
});

test('code: line elements inside a wrapper block (Prism with a flex wrapper)', () => {
  const html = '<pre class="prism-code language-bash"><div class="inline-flex flex-col"><div class="line token-line"><span>╭─ ok ─╮</span></div><div class="line token-line"><span>│    │</span></div></div></pre>';
  assert.equal(fenceBody(md(html)), '╭─ ok ─╮\n│    │');
});

test('code: Shiki span.line separated by newline text nodes — no doubled blank lines', () => {
  const html = '<pre class="shiki"><code><span class="line"><span>uv add x</span></span>\n<span class="line"></span>\n<span class="line"><span># comment</span></span></code></pre>';
  assert.equal(fenceBody(md(html)), 'uv add x\n\n# comment');
});

test('code: line numbers, copy buttons and twoslash popups are dropped', () => {
  const html = `<div class="language-ts"><button class="copy" title="Copy code">Copy</button><span class="lang">ts</span>
    <pre><code><span class="line"><span class="line-number">1</span>let x<span class="twoslash-hover">: number<span class="twoslash-popup-container">let x: number</span></span> = 1</span></code></pre></div>`;
  const out = md(html);
  assert.equal(fenceBody(out), 'let x: number = 1');
  assert.doesNotMatch(out, /Copy/);
  assert.doesNotMatch(out.replace(/```ts/, ''), /^ts$/m, 'language label is UI');
});

test('code: twoslash hover triggers keep their token; the popup is dropped; no line split', () => {
  const html = `<pre class="shiki"><code><span class="line"><span>import </span><span><div class="v-popper v-popper--theme-twoslash"><span>imgUrl</span></div></span><span> from './img.png'</span></span>\n<span class="line"><span><div class="v-popper"><span>document</span></div></span><span>.title</span><div class="v-popper__popper" aria-hidden="true">var document: Document</div></span></code></pre>`;
  assert.equal(fenceBody(md(html)), "import imgUrl from './img.png'\ndocument.title");
});

test('code: Sphinx highlight table — linenos cell dropped', () => {
  const html = '<table class="highlighttable"><tr><td class="linenos"><div class="linenodiv"><pre>1\n2</pre></div></td><td class="code"><div class="highlight"><pre>a = 1\nb = 2</pre></div></td></tr></table>';
  assert.equal(fenceBody(md(html)), 'a = 1\nb = 2');
});

test('code: fence longer than any backtick run inside', () => {
  const out = md('<pre><code>```js\nx\n```</code></pre>');
  assert.match(out, /^````\n```js\nx\n```\n````$/m);
  assert.equal(fenceCode('a ```` b'), '`````\na ```` b\n`````');
});

test('code: nested pre becomes one fence', () => {
  const out = md('<pre><div><pre>{\n  "a": 1\n}</pre></div></pre>');
  assert.equal((out.match(/```/g) || []).length, 2);
  assert.equal(fenceBody(out), '{\n  "a": 1\n}');
});

test('code: doctest prompts are content; leading space and tabs survive', () => {
  const out = md('<pre> leading\n>>> x = 1\n\tTAB</pre>');
  assert.equal(fenceBody(out), ' leading\n>>> x = 1\n\tTAB');
});

test('code: preformatted monospace container without <pre> (white-space: pre utility)', () => {
  const out = md('<div class="font-mono whitespace-pre"><span data-as="p">import lancedb\n\nuri = "x"\n</span></div>');
  assert.equal(fenceBody(out), 'import lancedb\n\nuri = "x"');
});

test('code: code in a list item is nested CommonMark-style (indent on every line, relative indent kept)', () => {
  const out = md('<ol><li><p>Install:</p><pre>npm i x\n  --save</pre></li><li>Run it</li></ol>');
  assert.match(out, /^1\. Install:\n\n {3}```\n {3}npm i x\n {5}--save\n {3}```\n\n2\. Run it$/m);
});

test('normalizeCodeBlock is exported and works on any element', () => {
  const doc = parseHtml('<pre id="p"><span>a</span><br><span>b</span></pre>');
  assert.equal(normalizeCodeBlock(doc.getElementById('p')), 'a\nb');
});

test('inline code with backticks uses a longer delimiter (not quotes)', () => {
  const out = md('<p>Use <code>a`b</code> and <code>`x`</code>.</p>');
  assert.match(out, /Use ``a`b`` and `` `x` ``\./);
  assert.equal(codeSpan('plain'), '`plain`');
});

// ---------------------------------------------------------------------------
// Tabs, details, hidden content
// ---------------------------------------------------------------------------

test('tabs: every ARIA tab panel kept, labelled in bold, tablist not emitted', () => {
  const html = `<div><div role="tablist"><button role="tab" id="t1" aria-controls="p1">Python</button><button role="tab" id="t2" aria-controls="p2">TypeScript</button></div>
    <div role="tabpanel" id="p1" aria-labelledby="t1"><pre>pip install x</pre></div>
    <div role="tabpanel" id="p2" aria-labelledby="t2" hidden><pre>npm i x</pre></div></div>`;
  const out = md(html);
  assert.match(out, /\*\*Python\*\*\n\n```\npip install x\n```/);
  assert.match(out, /\*\*TypeScript\*\*\n\n```\nnpm i x\n```/);
  assert.equal((out.match(/Python/g) || []).length, 1, 'tab label appears once');
});

test('tabs: duplicate ids fall back to position', () => {
  const html = `<div><ul role="tablist"><li role="tab" id="same" aria-controls="panel">Option 1</li><li role="tab" id="same" aria-controls="panel">Option 2</li></ul>
    <div role="tabpanel" id="panel" aria-labelledby="same"><p>first</p></div><div role="tabpanel" id="panel" aria-labelledby="same" class="hidden"><p>second</p></div></div>`;
  const out = md(html);
  assert.match(out, /\*\*Option 1\*\*\n\nfirst/);
  assert.match(out, /\*\*Option 2\*\*\n\nsecond/);
});

test('tabs: CSS-only radio tab sets label each panel', () => {
  const html = `<div class="sd-tab-set"><input type="radio" id="i0" name="s" checked><label for="i0">Linux</label><div class="sd-tab-content"><p>apt</p></div>
    <input type="radio" id="i1" name="s"><label for="i1">macOS</label><div class="sd-tab-content"><p>brew</p></div></div>`;
  const out = md(html);
  assert.match(out, /\*\*Linux\*\*\n\napt\n\n\*\*macOS\*\*\n\nbrew/);
});

test('details: expanded with summary in bold', () => {
  const out = md('<details><summary>Show fields</summary><p>hidden body</p></details>');
  assert.match(out, /\*\*Show fields\*\*\n\nhidden body/);
});

test('details: a heading inside the summary stays a heading', () => {
  const out = md('<details open><summary><span data-markdown-heading="5">Creating subscriptions</span></summary><p>Body.</p></details><details><summary><h3>FAQ</h3></summary><p>A.</p></details>');
  assert.equal(out.trim(), '##### Creating subscriptions\n\nBody.\n\n### FAQ\n\nA.');
});

test('hidden content inside the root is kept', () => {
  const out = md('<div hidden><p>lazy panel text</p></div><div style="display:none"><p>collapsed text</p></div>');
  assert.match(out, /lazy panel text/);
  assert.match(out, /collapsed text/);
});

test('visually-hidden exact duplicate of a visible block is emitted once', () => {
  const html = `<div><div class="notice-caution"><div class="heading">Caution</div><div class="body"><p>Objects can be overridden by variables.</p></div></div>
    <div hidden><strong>Caution:</strong> <p>Objects can be overridden by variables.</p></div></div>`;
  const out = md(html);
  assert.equal((out.match(/overridden by variables/g) || []).length, 1);
});

test('isHiddenButReal: hidden attr / display:none / aria-hidden yes; responsive utility classes no', () => {
  const doc = parseHtml('<div id="a" hidden></div><div id="b" class="hidden md:block"></div><div id="c" class="hidden"></div><div id="d" style="display: none"></div>');
  assert.equal(isHiddenButReal(doc.getElementById('a')), true);
  assert.equal(isHiddenButReal(doc.getElementById('b')), false);
  assert.equal(isHiddenButReal(doc.getElementById('c')), true);
  assert.equal(isHiddenButReal(doc.getElementById('d')), true);
});

// ---------------------------------------------------------------------------
// Callouts
// ---------------------------------------------------------------------------

test('callout: admonition class → GitHub alert with title as bold first line', () => {
  const out = md('<div class="admonition warning"><p class="admonition-title">Warning</p><p>Do not do this.</p></div>');
  assert.equal(out.trim(), '> [!WARNING]\n> **Warning**\n>\n> Do not do this.');
});

test('callout: role=note and aside detected; kinds mapped', () => {
  assert.match(md('<div role="note"><p>Heads up.</p></div>'), /^> \[!NOTE\]\n>\n> Heads up\.$/m);
  assert.match(md('<aside class="callout tip"><p>Try this.</p></aside>'), /\[!TIP\]/);
  assert.match(md('<div class="alert alert-danger"><p>Data loss.</p></div>'), /\[!CAUTION\]/);
  assert.match(md('<div class="note important"><p>Must.</p></div>'), /\[!IMPORTANT\]/);
});

test('callout: code inside stays inside the alert as a quoted fence', () => {
  const out = md('<div class="tip custom-block"><p class="custom-block-title">TIP</p><p>Before:</p><pre><code>x = 1\n  y = 2</code></pre><p>After.</p></div>');
  assert.equal(out.trim(), '> [!TIP]\n> **TIP**\n>\n> Before:\n>\n> ```\n> x = 1\n>   y = 2\n> ```\n>\n> After.');
});

test('callout: footnote <aside> (DPUB role / docutils class) is not a callout', () => {
  const out = md('<aside class="footnote-list brackets"><aside class="footnote brackets" id="id1" role="doc-footnote"><span class="label">[*]</span><p>https://example.org/ref</p></aside></aside>');
  assert.doesNotMatch(out, /\[!/);
  assert.match(out, /https:\/\/example\.org\/ref/);
});

test('callout: parts of a callout (title/content/icon classes) are not callouts themselves', () => {
  const out = md('<div class="callout-content"><p>just text</p></div>');
  assert.doesNotMatch(out, /\[!/);
});

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

test('table: simple → GFM, pipes escaped, <br> kept', () => {
  const out = md('<table><thead><tr><th>Op</th><th>Meaning</th></tr></thead><tbody><tr><td><code>a|b</code></td><td>line1<br>line2</td></tr></tbody></table>');
  assert.equal(out.trim(), '| Op | Meaning |\n| --- | --- |\n| `a\\|b` | line1<br>line2 |');
});

test('table: cells need no line-start escapes', () => {
  const out = md('<table><tr><th>a</th><th>b</th></tr><tr><td>-</td><td>1. x</td></tr></table>');
  assert.match(out, /^\| - \| 1\. x \|$/m);
});

test('table: without header row the first row becomes the header', () => {
  const out = md('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>');
  assert.equal(out.trim(), '| a | b |\n| --- | --- |\n| c | d |');
});

test('table: merged cells or block content → minimal HTML table (only spans kept)', () => {
  const out = md('<table class="x" style="width:1px"><tr><th colspan="2" class="h">Field</th></tr><tr><td>name</td><td><ul><li>one</li><li>two</li></ul></td></tr></table>');
  // plain text stays on one line; markdown inside a cell needs blank lines to render on GitHub
  assert.match(out, /^<table>\n<tr>\n<th colspan="2">Field<\/th>/);
  assert.match(out, /<td>name<\/td>/);
  assert.match(out, /<td>\n\n- one\n- two\n\n<\/td>/);
  assert.doesNotMatch(out, /class=|style=/);
  const withLink = md('<table><tr><th colspan="2">A</th></tr><tr><td><a href="https://x.example/">x</a></td><td>two<br>lines</td></tr></table>');
  assert.match(withLink, /<td>\n\n\[x\]\(https:\/\/x\.example\/\)\n\n<\/td>/);
  assert.match(withLink, /<td>two<br>lines<\/td>/);
});

test('table: a button that is a cell\'s content (interactive data tables) keeps its text', () => {
  const out = md('<table><tr><th>Browser</th><th colspan="2">Support</th></tr><tr><th>Chrome</th><td><button type="button"><div>Full support</div><div>Chrome 42</div></button></td><td>x</td></tr></table>');
  assert.match(out, /Full support<br>Chrome 42/);
});

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

test('headings: permalink anchors (¶, #, zero-width, "Anchor to") are stripped', () => {
  const out = md(`<h2 id="a">Install<a class="headerlink" href="#a">¶</a></h2>
    <h2 id="b"><a class="header-anchor" href="#b" aria-label="Permalink">\u200b</a>Usage</h2>
    <h3 id="c"><a href="#c"><span class="sr-only">Anchor to Fields</span></a>Fields</h3>
    <h3 id="d">Options <a href="#d">#</a></h3>`);
  assert.equal(out.trim(), '## Install\n\n## Usage\n\n### Fields\n\n### Options');
});

test('headings: plain text (code unwrapped, links unwrapped, hidden widgets dropped)', () => {
  const out = md('<h1>Statistical functions (<a href="#m"><code>scipy.stats</code></a>)<a class="headerlink" href="#s">#</a></h1><h2>campaign <span hidden>Stay organized with collections</span></h2>');
  assert.equal(out.trim(), '# Statistical functions (scipy.stats)\n\n## campaign');
});

test('headings: role=heading/aria-level and data-markdown-heading count as headings', () => {
  const out = md('<div role="heading" aria-level="3">Returns</div><div data-markdown-heading="4">value</div>');
  assert.equal(out.trim(), '### Returns\n\n#### value');
});

test('headings: title prepended only when the roots have no H1', () => {
  assert.match(md('<p>Body</p>', { title: 'Page Title' }), /^# Page Title\n\nBody/);
  assert.match(md('<h1>Real</h1><p>Body</p>', { title: 'Page Title' }), /^# Real\n/);
});

test('headings: heading inside a list item is lifted to column 0', () => {
  const out = md('<ul><li><h4>topic/create</h4><p>payload</p></li></ul>');
  assert.match(out, /^#### topic\/create$/m);
});

test('API entries: Sphinx dl.py > dt[id] become headings nested under the current level', () => {
  const html = `<h1>Module</h1><dl class="py class"><dt class="sig sig-object py" id="m.C"><em class="property">class </em><span class="sig-prename descclassname">m.</span><span class="sig-name descname">C</span>(<em class="sig-param">x</em>)<a class="headerlink" href="#m.C">¶</a></dt>
    <dd><p>A class.</p><dl class="py method"><dt class="sig sig-object py" id="m.C.f"><span class="sig-name descname">f</span>()<a class="headerlink" href="#m.C.f">¶</a></dt><dd><p>A method.</p><p class="rubric">Examples</p></dd></dl></dd></dl>`;
  const out = md(html);
  assert.match(out, /^## class m\.C\(x\)$/m);
  assert.match(out, /^### f\(\)$/m);
  assert.match(out, /^\*\*Examples\*\*$/m, 'rubric is a bold label, not a heading');
});

test('API entries: id-anchored dt with a self-link (any generator), div-wrapped dl groups', () => {
  const html = `<h2>Fields</h2><dl><div><dt><div id="f.amount"><a href="/x#f.amount"><span class="visuallyHidden">Anchor to amount</span></a><span>amount</span></div><span>•</span><a href="/t/Money">Money</a></dt><dd><p>Total spent.</p></dd></div>
    <div><dt><div id="f.name"><a href="#f.name"></a>name</div></dt><dd><p>Name.</p></dd></div></dl>`;
  const out = md(html);
  assert.match(out, /^### amount •Money$/m);
  assert.match(out, /^### name$/m);
  assert.match(out, /Total spent\./);
});

test('definition lists: docutils classifier gets its CSS " : "; an already-bold term is not re-wrapped', () => {
  const out = md('<dl class="field-list"><dt>Parameters:</dt><dd><dl><dt><strong>*samples</strong><span class="classifier">1D array_like</span></dt><dd><p>Data.</p></dd></dl></dd></dl>');
  assert.match(out, /^\*\*\\\*samples\*\* : 1D array_like$/m);
});

test('definition lists: dt bold, dd content follows', () => {
  const out = md('<dl class="field-list"><dt>Parameters:</dt><dd><p><strong>x</strong> – input</p></dd></dl>');
  assert.equal(out.trim(), '**Parameters:**\n\n**x** – input');
});

// ---------------------------------------------------------------------------
// Links and images
// ---------------------------------------------------------------------------

test('links: absolute, same-page fragments short, utm_* dropped, empty links dropped', () => {
  const out = md(`<p><a href="../other?utm_source=x&amp;id=2">rel</a> <a href="#sec">frag</a> <a href="${BASE}#sec2">self</a> <a href="/x"></a> <a href="javascript:void(0)">js</a> <a href="tel:123">call</a></p>`);
  assert.equal(out.trim(), '[rel](https://example.com/docs/other?id=2) [frag](#sec) [self](#sec2) js call');
});

test('links: respect <base href>', () => {
  const doc = parseHtml('<html><head><base href="https://cdn.example.org/v2/"></head><body><main><a href="page">x</a></main></body></html>', BASE);
  assert.equal(toMarkdown(doc.querySelector('main'), { baseUrl: BASE }).trim(), '[x](https://cdn.example.org/v2/page)');
});

test('images: absolute; data: URIs dropped (alt kept); icons and pixels dropped', () => {
  const out = md(`<p><img src="img/a.png" alt="Diagram"> <img src="data:image/png;base64,AAAA" alt="Architecture overview">
    <img src="/i.svg" class="icon" alt="i"> <img src="/p.gif" width="1" height="1" alt=""></p>`);
  assert.match(out, /!\[Diagram\]\(https:\/\/example\.com\/docs\/guide\/img\/a\.png\)/);
  assert.match(out, /Architecture overview/);
  assert.doesNotMatch(out, /data:|i\.svg|p\.gif/);
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

test('<wbr> vanishes without a space; <br> is a hard line break', () => {
  const out = md('<h1>Customer<wbr>Segment<wbr>Member</h1><p>one<br>two</p>');
  assert.match(out, /^# CustomerSegmentMember$/m);
  assert.match(out, /^one {2}\ntwo$/m);
});

test('span[data-as=p] and div paragraphs do not glue together', () => {
  const out = md('<span data-as="p">First para.</span><span data-as="p">Second para.</span><div>Third</div><div>Fourth</div>');
  assert.equal(out.trim(), 'First para.\n\nSecond para.\n\nThird\n\nFourth');
});

test('markdown-significant text is escaped minimally', () => {
  const out = md('<p>2 * 3 and *args, snake_case, _private, a &lt;div&gt; tag, [x](y)</p><p>1. not a list</p><p># not a heading</p>');
  assert.match(out, /2 \* 3 and \\\*args, snake_case, \\_private, a &lt;div> tag, \[x\\\]\\\(y\)/);
  assert.match(out, /^1\\\. not a list$/m);
  assert.match(out, /^\\# not a heading$/m);
});

test('math: TeX kept from KaTeX annotation and math/tex scripts', () => {
  const out = md(`<p>Energy <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>E</mi></mrow><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">E=mc2</span></span> holds.</p>
    <script type="math/tex; mode=display">\\int_0^1 x\\,dx</script>`);
  assert.match(out, /Energy \$E=mc\^2\$ holds\./);
  assert.match(out, /\$\$\n\\int_0\^1 x\\,dx\n\$\$/);
});

test('UI residue: buttons, sr-only annotations and "Copy" lines are dropped', () => {
  const out = md('<p>Text <a href="https://x.org">link<span class="sr-only">(opens in a new tab)</span></a></p><button>Copy page</button><p>Copy</p>');
  assert.equal(out.trim(), 'Text [link](https://x.org/)');
});

test('lists: nested and ordered with start; task items', () => {
  const out = md('<ol start="3"><li>three<ul><li>sub</li></ul></li><li>four</li></ol><ul><li><input type="checkbox" checked> done</li></ul>');
  assert.match(out, /^3\. three\n {3}- sub\n4\. four$/m);
  assert.match(out, /^- \[x\] done$/m);
});

test('pathologically deep DOM falls back to plain text instead of throwing', () => {
  const depth = 20000;
  const html = '<div>'.repeat(depth) + 'deep words' + '</div>'.repeat(depth);
  const out = md(html);
  assert.match(out, /deep words/);
});

test('escapeMarkdown escapes line-start syntax and inline markers', () => {
  assert.equal(escapeMarkdown('# not *heading*'), '\\# not \\*heading\\*');
});

test('an example rendered twice in a row is kept once, preferring the labelled fence', async () => {
  const { dropRepeatedFences } = await import('../lib/convert/markdown.mjs');
  const md = 'Intro\n\n```\nconst a = 1;\n```\n\n```js\nconst a = 1;\n```\n\nAfter\n';
  assert.equal(dropRepeatedFences(md), 'Intro\n\n```js\nconst a = 1;\n```\n\nAfter\n');
  const tabs = '**npm**\n\n```sh\nx\n```\n\n**yarn**\n\n```sh\nx\n```\n';
  assert.equal(dropRepeatedFences(tabs), tabs, 'labelled tab panels are never merged');
});

test('math: MathJax 2 rendering is dropped when its TeX script follows (no doubled text)', () => {
  const out = md(`<p>where <span class="math"><span class="MathJax_Preview"></span><span class="MathJax_SVG" id="MathJax-Element-2-Frame"><svg></svg><span class="MJX_Assistive_MathML"><math><mi>p</mi></math></span></span><script type="math/tex" id="MathJax-Element-2">p</script></span> is the dimension.</p>
    <div class="math"><span class="MathJax_Preview"></span><div class="MathJax_SVG_Display"><span class="MathJax_SVG"><span class="MJX_Assistive_MathML"><math><mi>f</mi><mo>=</mo><mn>1</mn></math></span></span></div><script type="math/tex; mode=display">f = 1</script></div>`);
  assert.match(out, /where \$p\$ is the dimension\./);
  assert.match(out, /\$\$\nf = 1\n\$\$/);
  assert.doesNotMatch(out, /p\$p\$|f=1/);
});

test('math: TeX left in MathJax delimiters (server HTML before typesetting) becomes $…$ / $$…$$', () => {
  const out = md(`<p>where <span class="math notranslate nohighlight">\\(\\mathbf{x}\\)</span> is a vector.</p>
    <div class="math notranslate nohighlight">\\[f(x) = \\frac{1}{2}\\]</div><p>A literal \\(not math\\) in prose stays.</p>`);
  assert.match(out, /where \$\\mathbf\{x\}\$ is a vector\./);
  assert.match(out, /\$\$\nf\(x\) = \\frac\{1\}\{2\}\n\$\$/);
  assert.match(out, /literal \\\\?\(not math\\\\?\) in prose/);
});

test('headings: popup widgets attached to a heading (bookmark tooltips, data-nosnippet) are not title text', () => {
  const out = md(`<h1>campaign<devsite-actions data-nosnippet=""><devsite-feature-tooltip><span slot="popout-heading">Stay organized with collections</span><span slot="popout-contents">Save and categorize content based on your preferences.</span></devsite-feature-tooltip></devsite-actions></h1>
    <h2>Fields <span role="tooltip">Hover help</span></h2><p>Body.</p>`);
  assert.match(out, /^# campaign$/m);
  assert.match(out, /^## Fields$/m);
  assert.doesNotMatch(out, /Stay organized|Hover help/);
});
