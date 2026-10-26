import { fenceOpen, isFenceClose } from './mdscan.mjs';
/**
 * DOM → GitHub-flavoured markdown: the conversion core.
 *
 * Input: the content root element(s) of a page (already chosen by the root
 * selection stage) on the shared domino DOM (./dom.mjs). Output: body markdown
 * (no front matter). Everything here is generic: HTML semantics, ARIA, and
 * markup families that documentation generators share (Sphinx `dl.py`,
 * CodeMirror/Prism line elements, admonition class names, …) — never per-site
 * rules. See DESIGN.md "Markdown rules".
 *
 * A custom walker (not Turndown) because the rules need document-order state
 * (heading levels for API entries, tab labels, hidden duplicates), exact code
 * text, and speed on 35 MB pages. The walker is a single recursive pass that
 * builds blocks; code blocks travel as line placeholders so no later pass
 * (whitespace collapse, list/quote prefixing) can touch their bytes.
 */

// ---------------------------------------------------------------------------
// Sentinels (private-use / control chars that never appear in real text)
// ---------------------------------------------------------------------------
const CODE_OPEN = '\u0002';      // \u0002<n>\u0002 on its own line = code block n
const HARD_BREAK = '\u0003';     // <br> inside a paragraph
const CODE_LINE_RE = /^([^\n\u0002]*)\u0002(\d+)\u0002$/;

// ---------------------------------------------------------------------------
// Element classes
// ---------------------------------------------------------------------------
const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed',
  'audio', 'video', 'map', 'head', 'meta', 'link', 'select', 'textarea', 'dialog', 'source',
  'track', 'param', 'option', 'datalist', 'progress', 'meter', 'title', 'base', 'area', 'slot',
  'frame', 'frameset', 'picture-source',
]);
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'center', 'dd', 'details', 'dir', 'div',
  'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hgroup', 'hr', 'html', 'legend', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'caption',
  'search', 'colgroup', 'col', 'optgroup',
]);
const HEADING_RE = /^h([1-6])$/;

// Class names that mark line-number gutters inside code.
const GUTTER_CLASS_RE = /(?:^|[\s_-])(?:line-?numbers?|linenos?|lineno|line-number|gutters?|rouge-gutter|hljs-ln-numbers?|code-line-number)(?:$|[\s_-])/i;
// Popups/tooltips nested inside code (twoslash, hover info).
// (Only the popup itself: its trigger — e.g. twoslash `div.v-popper` — wraps the code token.)
const CODE_POPUP_CLASS_RE = /(?:popup|tooltip|__popper|twoslash-(?:meta|completion|error|tag))/i;
// Elements that are one line of code each (line-per-element highlighters).
const LINE_CLASS_RE = /(?:^|\s)(?:cm-line|token-line|code-line|line|ec-line|highlight-line|view-line)(?:$|\s)/;
// Code editors that are not <pre> (CodeMirror 6 content, Monaco view-lines).
const EDITOR_CLASS_RE = /(?:^|\s)(?:cm-content|view-lines)(?:$|\s)/;
// Permalink anchors next to headings.
const PERMALINK_CLASS_RE = /(?:^|[\s_-])(?:headerlink|header-anchor|heading-anchor|anchor-link|hash-link|anchorjs-link|permalink|anchor|autolink-header|md-header-anchor|headinganchor|linkhashtarget)(?:$|[\s_-])/i;
const PERMALINK_TEXT_RE = /^(?:[¶#§🔗⚓∞]|link|permalink)$/i;
const PERMALINK_LABEL_RE = /^(?:anchor to|permalink to|link to|link for|direct link to|copy link|link to this)\b/i;

// Callout vocabulary → GitHub alert kind.
const CALLOUT_WORDS = {
  note: 'NOTE', notes: 'NOTE', info: 'NOTE', information: 'NOTE', seealso: 'NOTE', todo: 'NOTE',
  admonition: 'NOTE', callout: 'NOTE', notice: 'NOTE', aside: 'NOTE', remark: 'NOTE', versionadded: 'NOTE',
  versionchanged: 'NOTE',
  tip: 'TIP', tips: 'TIP', hint: 'TIP', success: 'TIP', check: 'TIP',
  important: 'IMPORTANT', key: 'IMPORTANT',
  warning: 'WARNING', warn: 'WARNING', attention: 'WARNING', deprecated: 'WARNING',
  caution: 'CAUTION', danger: 'CAUTION', error: 'CAUTION', alert: 'WARNING',
};
// Specific kinds win over generic container words.
const GENERIC_CALLOUT = new Set(['admonition', 'callout', 'notice', 'aside', 'alert']);
const CALLOUT_EXCLUDE_WORDS = new Set(['title', 'icon', 'label', 'header', 'heading', 'badge', 'button', 'btn', 'text', 'content', 'body', 'wrapper', 'container', 'toggle', 'link', 'tooltip', 'popover', 'banner', 'bar', 'dismiss', 'close', 'message', 'inline', 'dot', 'color', 'bg', 'border']);
const CALLOUT_TITLE_WORDS = new Set(['title', 'heading', 'header', 'label']);

const MATH_CLASS_RE = /(?:^|\s)(?:katex|katex-display|MathJax_Preview|MathJax|mwe-math-element)(?:$|\s)/;
const MATHJAX2_FRAME_RE = /(?:^|\s)MathJax(?:_(?:SVG|CHTML|HTML|MathML))?(?:_Display)?(?:$|\s)/;

/** A MathJax 2 frame whose TeX source follows it (skipping other frames/previews). */
function texScriptFollows(el) {
  for (let n = el.nextElementSibling; n; n = n.nextElementSibling) {
    const t = n.nodeName.toLowerCase();
    if (t === 'script') return /^math\/tex/i.test(n.getAttribute('type') || '');
    if (!/(?:^|\s)MathJax/.test(n.getAttribute('class') || '')) return false;
  }
  return false;
}

// Images that are decoration, not content.
const DECORATIVE_IMG_RE = /(?:^|[\s_-])(?:icon|icons|logo|avatar|emoji|emoticon|spinner|loader|sprite|favicon|octicon)(?:$|[\s_-])/i;

// UI text left inside content roots (lines that are only this are dropped).
const UI_LINE_RE = /^(?:Copy|Copied!?|Copy code|Copy to clipboard|Copy page|Copy for LLM|View as Markdown|Edit this page|Edit on GitHub|Was this (?:page |section )?helpful\??|Ask AI|Open in \w+|Try it|Reload|Clear|Fork|Download)$/i;

// Sphinx-family API object types (dl.<domain>.<objtype>) — also autodoc_pydantic.
const API_DL_CLASS_RE = /(?:^|\s)(?:py|cpp|c|js|rst|std|rb|php|java|cs|go|http|class|function|method|attribute|property|data|exception|classmethod|staticmethod|decorator|module|pydantic_model|pydantic_field|pydantic_validator|pydantic_config|pydantic_settings|enum|type|macro|member|var|struct|union|typedef|namespace|object)(?:$|\s)/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const tagOf = (el) => (el.localName || el.nodeName || '').toLowerCase();
const attr = (el, n) => (el.getAttribute ? el.getAttribute(n) : null);
const classOf = (el) => (el.getAttribute && el.getAttribute('class')) || '';

function classWords(el) {
  const c = classOf(el);
  return c ? c.toLowerCase().split(/[\s_\-]+/).filter(Boolean) : [];
}
const tokenRes = new Map();
function hasClassToken(el, token) {
  const c = classOf(el);
  if (!c) return false;
  let re = tokenRes.get(token);
  if (!re) { re = new RegExp(`(?:^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s)`); tokenRes.set(token, re); }
  return re.test(c);
}

/** Text of an element as the browser would render it (without markup), whitespace collapsed. */
function plainText(el) {
  return (el.textContent || '').replace(/[\s ]+/g, ' ').trim();
}

/** Words-only fingerprint used to compare blocks for duplication. */
function fingerprint(s) {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function styleOf(el) {
  return (attr(el, 'style') || '').toLowerCase();
}

/**
 * Hidden by the page (hidden attribute, aria-hidden, display:none, a bare
 * `hidden` class) — but, inside a content root, still real content: inactive
 * tab panels, collapsed sections, lazy panes. Exported for other stages.
 * Responsive utility classes (`hidden md:block`) are *visible* on desktop.
 */
export function isHiddenButReal(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.hasAttribute('hidden')) return true;
  if (attr(el, 'aria-hidden') === 'true') return true;
  const st = styleOf(el);
  if (st && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/.test(st)) return true;
  const c = classOf(el);
  if (c && /(?:^|\s)(?:hidden|is-hidden|d-none|hide|invisible|collapsed|zippy-hidden)(?:$|\s)/.test(c)
    && !/(?:^|\s)[a-z0-9]+:(?:block|flex|inline|inline-block|inline-flex|grid|table|contents|table-cell)(?:$|\s)/.test(c)) return true;
  return false;
}

/** Visually-hidden accessibility text (screen-reader-only). */
function isScreenReaderOnly(el) {
  const c = classOf(el);
  return !!c && /(?:^|\s)(?:sr-only|visually-hidden|visuallyhidden|screen-reader-text|screen-reader-only|a11y-hidden|assistive-text|u-visually-hidden)(?:$|\s)/i.test(c);
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/** Escape text so markdown shows it literally (minimal: only what would change meaning). */
function escapeText(s) {
  if (!/[\\`*_\[\]<>&~|#+\-!=]/.test(s)) return s;
  return s
    .replace(/\\(?=[!-\/:-@\[-`{-~])/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, (m, i, str) => ((i === 0 || /\s/.test(str[i - 1])) && (i + 1 >= str.length || /\s/.test(str[i + 1])) ? m : '\\*'))
    .replace(/_/g, (m, i, str) => (/[\p{L}\p{N}]/u.test(str[i - 1] || '') && /[\p{L}\p{N}]/u.test(str[i + 1] || '') ? m : '\\_'))
    .replace(/\]([(\[])/g, '\\]\\$1')
    .replace(/\[(?=[!^])/g, '\\[')
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '&amp;')
    .replace(/<(?=[A-Za-z\/!?])/g, '&lt;')
    .replace(/~~/g, '\\~\\~');
}

/** Escape what would become block syntax at the start of a line. */
function escapeLineStart(line) {
  return line
    .replace(/^(#{1,6})(?=\s|$)/, '\\$1')
    .replace(/^>/, '\\>')
    .replace(/^([-+*])(?=\s|$)/, '\\$1')
    .replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2')
    .replace(/^(=+|-{2,})\s*$/, (m) => '\\' + m)
    .replace(/^(`{3,}|~{3,})/, (m) => '\\' + m)
    .replace(/^\|/, '\\|');
}

/** Inline code span with a delimiter longer than any backtick run inside. */
export function codeSpan(text) {
  const t = text.replace(/[\r\n\t  ]+/g, ' ');
  if (!t.trim()) return '';
  let max = 0;
  for (const m of t.matchAll(/`+/g)) max = Math.max(max, m[0].length);
  const fence = '`'.repeat(max + 1);
  const pad = t.startsWith('`') || t.endsWith('`') || (t.startsWith(' ') && t.endsWith(' ') && t.trim()) ? ' ' : '';
  return fence + pad + t + pad + fence;
}

/** Fenced code block with a fence longer than any backtick run inside. */
export function fenceCode(code, lang = '') {
  let max = 0;
  for (const m of code.matchAll(/^[ \t]*(`{3,})/gm)) max = Math.max(max, m[1].length);
  for (const m of code.matchAll(/`{3,}/g)) max = Math.max(max, m[0].length);
  const fence = '`'.repeat(Math.max(3, max + 1));
  return `${fence}${lang || ''}\n${code}\n${fence}`;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------
function makeUrlTools(baseUrl, doc) {
  let base = baseUrl || '';
  try {
    const b = doc && doc.querySelector && doc.querySelector('base[href]');
    if (b) base = new URL(b.getAttribute('href'), baseUrl || undefined).href;
  } catch { /* keep */ }
  let pageNoHash = '';
  try { const u = new URL(baseUrl); u.hash = ''; pageNoHash = u.href; } catch { /* none */ }

  function resolve(href, { allowFragment = true } = {}) {
    if (href == null) return null;
    const v = String(href).trim();
    if (!v) return null;
    if (v.startsWith('#')) return allowFragment && v.length > 1 ? v : null;
    if (/^(?:javascript|data|blob|about|vbscript):/i.test(v)) return null;
    let u;
    try { u = base ? new URL(v, base) : new URL(v); } catch { return null; }
    if (!/^(?:https?|mailto):$/.test(u.protocol)) return null;
    if (u.search && /[?&]utm_/i.test(u.search)) {
      for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
    }
    let out = u.href;
    if (allowFragment && u.hash && pageNoHash) {
      const nh = out.slice(0, out.length - u.hash.length);
      if (nh === pageNoHash) return u.hash;
    }
    return out;
  }
  return { resolve };
}

/** Make a URL safe as a markdown link destination (balanced, no spaces). */
function mdUrl(u) {
  return u.replace(/[()\s<>]/g, (c) => ({ '(': '%28', ')': '%29', ' ': '%20', '<': '%3C', '>': '%3E' }[c] || encodeURIComponent(c)));
}

// ---------------------------------------------------------------------------
// Code blocks
// ---------------------------------------------------------------------------

/** Language from markup only (never guessed). */
function languageOf(pre) {
  const cand = [pre];
  const code = firstElementChildByTag(pre, 'code');
  if (code) cand.unshift(code);
  let p = pre.parentNode;
  for (let i = 0; i < 3 && p && p.nodeType === 1; i++, p = p.parentNode) cand.push(p);
  for (const el of cand) {
    const d = attr(el, 'data-language') || attr(el, 'data-lang') || attr(el, 'data-code-language') || attr(el, 'language');
    if (d && /^[\w+#.\-]{1,30}$/.test(d)) return cleanLang(d);
    const c = classOf(el);
    if (!c) continue;
    const m = /(?:^|\s)(?:language|lang|highlight(?:-source)?|brush:?)-([\w+#.\-]{1,30})(?:$|\s)/i.exec(c);
    if (m) return cleanLang(m[1]);
    const m2 = /(?:^|\s)brush:\s*([\w+#.\-]{1,30})/i.exec(c);
    if (m2) return cleanLang(m2[1]);
  }
  return '';
}
function cleanLang(l) {
  const x = l.toLowerCase();
  if (['none', 'default', 'text', 'plain', 'plaintext', 'nohighlight', 'txt', 'undefined', 'null', 'source'].includes(x)) return '';
  return l;
}
function firstElementChildByTag(el, tag) {
  for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && tagOf(c) === tag) return c;
  return null;
}

function isCodeUi(el, tag) {
  if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea' || SKIP_TAGS.has(tag)) return true;
  if (attr(el, 'aria-hidden') === 'true') return true;
  const c = classOf(el);
  if (c && (GUTTER_CLASS_RE.test(c) || CODE_POPUP_CLASS_RE.test(c))) return true;
  if (attr(el, 'data-line-number') != null && !el.firstElementChild && /^\s*\d+\s*$/.test(el.textContent || '')) return true;
  const st = styleOf(el);
  if (st && /user-select\s*:\s*none/.test(st) && /^\s*(?:\d+|\$|>|#|%|PS>)?\s*$/.test(el.textContent || '')) return true;
  if (isScreenReaderOnly(el)) return true;
  return false;
}

/**
 * Exact text of a code element: text nodes verbatim, <br> → newline, one line
 * per line element (CodeMirror .cm-line, Prism .token-line, block children),
 * without gutters, buttons, popups. Tabs, blank lines, indentation kept.
 */
export function normalizeCodeBlock(el) {
  const out = [];
  let atLineStart = true;
  let pendingNL = false;
  const push = (s) => {
    if (!s) return;
    if (pendingNL) {
      if (s[0] !== '\n') out.push('\n');
      pendingNL = false;
    }
    out.push(s);
    atLineStart = s.endsWith('\n');
  };
  const walk = (node, inLine) => {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) { push(n.data); continue; }
      if (n.nodeType !== 1) continue;
      const tag = tagOf(n);
      if (tag === 'br') {
        if (pendingNL) { out.push('\n'); pendingNL = false; }
        out.push('\n'); atLineStart = true; continue;
      }
      if (isCodeUi(n, tag)) continue;
      const c = classOf(n);
      // Line elements: explicit line classes, or leaf block elements (a block that
      // holds other blocks is a wrapper). Inside a line, nested blocks are inline
      // wrappers (hover triggers etc.).
      let isLine = false;
      if (!inLine) {
        if (c && LINE_CLASS_RE.test(c)) isLine = true;
        else if (BLOCK_TAGS.has(tag) && tag !== 'pre') isLine = !hasLineChild(n);
      }
      if (isLine) {
        if (pendingNL) { out.push('\n'); pendingNL = false; atLineStart = true; } else if (!atLineStart) { out.push('\n'); atLineStart = true; }
        const before = out.length;
        walk(n, true);
        // A line element always ends its line — even an empty one (a blank line).
        if (out.length === before || !atLineStart) pendingNL = true;
        continue;
      }
      walk(n, inLine);
    }
  };
  walk(el, false);
  let code = out.join('').replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  // Trim blank edges (whole blank lines only; first line keeps its indentation).
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const c = l.charCodeAt(l.length - 1);
    if (c === 32 || c === 9) lines[i] = l.replace(/[ \t]+$/, '');
  }
  let a = 0, b = lines.length;
  while (a < b && !lines[a]) a++;
  while (b > a && !lines[b - 1]) b--;
  return lines.slice(a, b).join('\n');
}

/** Custom elements that name themselves as a popup (devsite-feature-tooltip, x-popover). */
const POPUP_TAG_RE = /^[a-z][\w]*-[\w-]*(?:tooltip|popout|popover)\b/;

/** Cell text with nothing for a markdown renderer to do (and nothing to escape in HTML). */
const PLAIN_CELL_CHARS_RE = /^[^`*_[\]<>&\\|$#!~\u0000-\u001f]*$/;
const isPlainCellBlock = (b) => PLAIN_CELL_CHARS_RE.test(b.replace(/ {2}\n/g, ''))
  && !/\n/.test(b.replace(/ {2}\n/g, '')) && !/^\s*(?:[-+*]|\d{1,9}[.)])\s/.test(b);

/** Inside a table data/header cell. */
function inTableCell(el) {
  for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) {
    const t = tagOf(p);
    if (t === 'td' || t === 'th') return true;
    if (t === 'table' || t === 'body') return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------
function texOf(el) {
  const ann = el.querySelector && el.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="TeX"]');
  if (ann) return ann.textContent.trim();
  const alt = attr(el, 'alttext') || attr(el, 'data-tex') || attr(el, 'data-latex');
  if (alt) return alt.trim();
  return null;
}
function mathMd(el, tag) {
  let tex = null;
  let display = false;
  if (tag === 'script') {
    tex = (el.textContent || '').trim();
    display = /mode\s*=\s*display/i.test(attr(el, 'type') || '');
  } else {
    tex = texOf(el);
    display = attr(el, 'display') === 'block' || attr(el, 'display') === 'true'
      || /(?:^|\s)(?:katex-display|math-display|MathJax_Display)(?:$|\s)/.test(classOf(el.parentNode || el) + ' ' + classOf(el));
    if (!tex) {
      // MathJax 3 CHTML keeps no TeX; its assistive MathML has the linear text.
      const mml = tag === 'math' ? el : el.querySelector && el.querySelector('math');
      const t = (mml || el).textContent || '';
      const lin = t.replace(/[⁡⁢⁣]/g, '').replace(/\s+/g, ' ').trim();
      return lin ? { text: lin, display } : null;
    }
  }
  if (!tex) return null;
  return { tex, display };
}

// ---------------------------------------------------------------------------
// The converter
// ---------------------------------------------------------------------------

class Run {
  constructor() { this.blocks = []; this.inl = []; }
  flush(conv) {
    if (!this.inl.length) return;
    const p = conv.finishParagraph(this.inl.join(''));
    this.inl = [];
    if (p) this.blocks.push(p);
  }
  push(conv, block) {
    this.flush(conv);
    if (block) this.blocks.push(block);
  }
  pushAll(conv, blocks) {
    this.flush(conv);
    for (const b of blocks) if (b) this.blocks.push(b);
  }
}

class Converter {
  constructor(roots, opts = {}) {
    this.roots = roots;
    this.opts = opts;
    this.doc = roots[0]?.ownerDocument || null;
    this.url = makeUrlTools(opts.baseUrl, this.doc);
    this.codes = [];
    this.lastHeadingLevel = 1;
    this.sawH1 = false;
    this.tabLabels = new Map();   // tabpanel element → label
    this.tabPanels = new Set();
    this.skipEls = new Set();
    this.prepareTabs();
  }

  // ---------- tabs ----------
  prepareTabs() {
    const tablists = [];
    const tabsById = new Map();
    for (const root of this.roots) {
      const lists = root.querySelectorAll('[role="tablist"]');
      for (let i = 0; i < lists.length; i++) tablists.push(lists[i]);
      if (root.getAttribute && root.getAttribute('role') === 'tablist') tablists.push(root);
    }
    if (!tablists.length) return;
    for (const list of tablists) {
      const tabs = [];
      const found = list.querySelectorAll('[role="tab"]');
      for (let i = 0; i < found.length; i++) tabs.push(found[i]);
      if (!tabs.length) continue;
      for (const t of tabs) {
        const id = t.getAttribute('id');
        if (id) tabsById.set(id, tabsById.has(id) ? null : t);
      }
      // Panels: top-level tabpanels of the nearest ancestor that has any.
      let c = list.parentNode;
      let panels = [];
      for (let depth = 0; c && c.nodeType === 1 && depth < 5; depth++, c = c.parentNode) {
        const all = c.querySelectorAll('[role="tabpanel"]');
        if (all.length) {
          for (let i = 0; i < all.length; i++) {
            const p = all[i];
            if (this.tabPanels.has(p)) continue;
            // Skip panels nested in another panel inside c (they belong to an inner group).
            let q = p.parentNode, nested = false;
            while (q && q !== c) { if (q.getAttribute && q.getAttribute('role') === 'tabpanel') { nested = true; break; } q = q.parentNode; }
            if (!nested) panels.push(p);
          }
          if (panels.length) break;
        }
      }
      const byIndex = panels.length === tabs.length;
      panels.forEach((p, i) => {
        let tab = null;
        const lb = p.getAttribute('aria-labelledby');
        if (lb && tabsById.get(lb) && tabs.includes(tabsById.get(lb)) && !byIndex) tab = tabsById.get(lb);
        if (!tab && byIndex) tab = tabs[i];
        if (!tab && lb && tabsById.get(lb)) tab = tabsById.get(lb);
        this.tabPanels.add(p);
        if (tab) {
          const label = plainText(tab);
          if (label) this.tabLabels.set(p, label);
        }
      });
    }
  }

  // ---------- paragraphs ----------
  finishParagraph(s) {
    if (!s) return '';
    let t = s.replace(/[ \t\n\r\f ]+/g, ' ');
    t = t.replace(/ ?\u0003 ?/g, HARD_BREAK);
    t = t.replace(/^[\u0003 ]+|[\u0003 ]+$/g, '');
    if (!t) return '';
    const lines = t.split(HARD_BREAK).map(l => escapeLineStart(l.trim()));
    return lines.filter((l, i) => l || i === 0).join('  \n');
  }

  // ---------- main walk ----------
  convertRoots() {
    const run = new Run();
    const st = { inHeading: false, inCode: false, inCallout: 0, apiDepth: 0, apiBase: null, inTable: false, inLink: false, hidden: false, listDepth: 0 };
    for (const root of this.roots) {
      this.walkNode(root, run, st);
      run.flush(this);
    }
    return run.blocks;
  }

  walkChildren(el, run, st) {
    for (let n = el.firstChild; n; n = n.nextSibling) this.walkNode(n, run, st);
  }

  /** Convert el's children into a fresh run; returns its blocks and trailing inline text. */
  sub(el, st, childrenOnly = true) {
    const r = new Run();
    if (childrenOnly) this.walkChildren(el, r, st); else this.walkNode(el, r, st);
    return r;
  }

  /** Convert a node to inline markdown if it contains no block content; else null + blocks. */
  inlineOf(el, st) {
    const r = this.sub(el, st);
    if (r.blocks.length) { r.flush(this); return { blocks: r.blocks }; }
    return { inline: r.inl.join('') };
  }

  walkNode(node, run, st) {
    if (node.nodeType === 3) {
      const d = node.data;
      if (!d) return;
      if (st.inCode) { run.inl.push(d); return; }
      run.inl.push(escapeText(d.replace(/[\t\n\r\f ]+/g, ' ')));
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    if (this.skipEls.has(el)) return;
    const tag = tagOf(el);
    if (SKIP_TAGS.has(tag)) {
      if (tag === 'script' && /^math\/tex/i.test(attr(el, 'type') || '')) return this.math(el, tag, run);
      if (tag === 'svg' || tag === 'video' || tag === 'audio' || tag === 'iframe' || tag === 'canvas') return;
      return;
    }
    const role = attr(el, 'role');

    // --- UI and accessibility-only elements ---
    if (tag === 'button') return this.button(el, run, st);
    if (tag === 'input') {
      const type = (attr(el, 'type') || '').toLowerCase();
      if (type === 'checkbox' && st.listDepth > 0) run.inl.push(el.hasAttribute('checked') ? '[x] ' : '[ ] ');
      return;
    }
    if (role === 'tablist' || role === 'toolbar' || role === 'menubar' || role === 'menu' || role === 'progressbar' || role === 'tooltip' || role === 'status') {
      if (role === 'status' && plainText(el).length > 60) { /* real content */ } else return;
    }
    if (role === 'tab') return;
    // Inside a heading: widgets attached to it (bookmark/share popouts, tooltips)
    // are not part of the title.
    if (st.inHeading && (attr(el, 'data-nosnippet') != null || role === 'tooltip' || POPUP_TAG_RE.test(tag))) return;
    if (isScreenReaderOnly(el)) {
      // Accessibility annotations ("(opens in new tab)", "Anchor to …", "Copy").
      if (plainText(el).length < 60) return;
    }
    if (attr(el, 'aria-hidden') === 'true') {
      // Icons, gutters, decorative glyphs; keep long collapsed content (accordions).
      const len = plainText(el).length;
      if (len < 40 && !el.querySelector('pre, table, p, li, img')) return;
    }
    if (/(?:^|\s)(?:viewcode-link|viewcode-back|copybtn|copy-button|clipboard-copy)(?:$|\s)/.test(classOf(el))) return;

    // --- Math ---
    const mcls = tag === 'math' || tag === 'mjx-container' ? 'x' : classOf(el);
    // MathJax 2 output: the rendering (SVG/HTML-CSS/CommonHTML frame with hidden
    // MathML) sits before a <script type="math/tex"> holding the TeX — keep the TeX only.
    if (mcls && MATHJAX2_FRAME_RE.test(mcls) && texScriptFollows(el)) return;
    if (mcls && (tag === 'math' || tag === 'mjx-container' || MATH_CLASS_RE.test(mcls))) {
      if (/(?:^|\s)MathJax_Preview(?:$|\s)/.test(mcls)) return;
      return this.math(el, tag, run);
    }
    // TeX with MathJax delimiters, typeset in the browser (Sphinx, many generators):
    // <span class="math">\(x\)</span>, <div class="math">\[ … \]</div>.
    if (mcls && /(?:^|\s)math(?:$|\s)/.test(mcls) && !el.firstElementChild) {
      const m = /^\s*\\([([])([\s\S]*?)\\([)\]])\s*$/.exec(el.textContent || '');
      if (m && (m[1] === '(') === (m[3] === ')')) {
        const tex = m[2].trim();
        if (m[1] === '[') run.push(this, `$$\n${tex}\n$$`);
        else run.inl.push(`$${tex}$`);
        return;
      }
    }

    // --- Inline formatting ---
    switch (tag) {
      case 'br':
        if (st.inCode) { run.inl.push('\n'); return; }
        run.inl.push(st.inHeading ? ' ' : HARD_BREAK); return;
      case 'wbr': return;
      case 'img': return this.image(el, run, st);
      case 'a': return this.link(el, run, st);
      case 'code': case 'kbd': case 'samp': case 'tt':
        if (st.inCode || st.plainCode) return this.walkChildren(el, run, st);
        return this.inlineCode(el, run, st);
      case 'strong': case 'b':
        return this.emphasis(el, run, st, '**');
      case 'em': case 'i': case 'cite': case 'dfn':
        return this.emphasis(el, run, st, '*');
      case 'del': case 's': case 'strike':
        return this.emphasis(el, run, st, '~~');
      case 'sup': case 'sub':
        return this.supsub(el, run, st, tag);
      case 'hr':
        run.push(this, '---'); return;
      case 'pre':
        return this.pre(el, run, st);
      case 'table':
        return this.table(el, run, st);
      case 'ul': case 'ol': case 'menu': case 'dir':
        return this.list(el, run, st, tag === 'ol');
      case 'dl':
        return this.dl(el, run, st);
      case 'blockquote':
        return this.blockquote(el, run, st);
      case 'details':
        return this.details(el, run, st);
      case 'label':
        return this.label(el, run, st);
      case 'q':
        run.inl.push('"'); this.walkChildren(el, run, st); run.inl.push('"'); return;
      default: break;
    }

    // --- Headings ---
    let hm = HEADING_RE.exec(tag);
    let level = hm ? Number(hm[1]) : 0;
    if (!level && role === 'heading') level = Math.min(6, Math.max(1, parseInt(attr(el, 'aria-level') || '2', 10) || 2));
    // Explicit markdown-heading annotations some generators leave for their own exporters.
    if (!level) { const mh = attr(el, 'data-markdown-heading'); if (mh && /^[1-6]$/.test(mh)) level = Number(mh); }
    if (level) return this.heading(el, level, run, st);

    if (tag === 'p' && hasClassToken(el, 'rubric')) return this.boldBlock(el, run, st);
    // docutils/Sphinx: a term's classifier is separated by CSS-generated " : ".
    if (tag === 'span' && hasClassToken(el, 'classifier')) {
      const prev = el.previousSibling;
      const pt = prev && prev.nodeType === 1 ? classOf(prev) : '';
      if (!/classifier-delimiter/.test(pt) && !(prev && prev.nodeType === 3 && /:\s*$/.test(prev.data))) run.inl.push(' : ');
      return this.walkChildren(el, run, st);
    }

    // --- Code editors that are not <pre> ---
    const cls = classOf(el);
    if (cls && EDITOR_CLASS_RE.test(cls) && !st.inCode) return this.codeFromElement(el, run, st, '');
    // Preformatted monospace containers without <pre> (utility-class CSS: white-space: pre).
    if (!st.inHeading && isPreformatted(el, cls) && !el.querySelector('pre')) return this.codeFromElement(el, run, st, languageOf(el));

    // --- Tab panels ---
    if (this.tabPanels.has(el) || role === 'tabpanel') return this.tabPanel(el, run, st);

    // Hidden things inside a heading are widgets (bookmark buttons, tooltips), never its text.
    if (st.inHeading && isHiddenButReal(el)) return;

    // --- Hidden duplicates ---
    if (!st.hidden && !st.inHeading && isHiddenButReal(el) && BLOCK_TAGS.has(tag)) {
      if (this.isHiddenDuplicate(el)) return;
      const st2 = { ...st, hidden: true };
      return this.container(el, run, st2, tag);
    }

    // --- Callouts ---
    if (!st.inCallout && !st.inHeading && !st.inTable && (BLOCK_TAGS.has(tag) || tag.includes('-'))) {
      const kind = this.calloutKind(el, tag, role);
      if (kind) return this.callout(el, kind, run, st);
    }

    // --- Paragraph-like polymorphic elements (<span data-as="p">) ---
    const as = attr(el, 'data-as');
    if (as && /^(?:p|div|li|h[1-6])$/.test(as) && !BLOCK_TAGS.has(tag)) {
      const m = HEADING_RE.exec(as);
      if (m) return this.heading(el, Number(m[1]), run, st);
      return this.container(el, run, st, 'p');
    }

    if (BLOCK_TAGS.has(tag)) return this.container(el, run, st, tag);
    // Inline / unknown / custom elements: transparent.
    this.walkChildren(el, run, st);
  }

  container(el, run, st, tag) {
    if (st.inHeading) { run.inl.push(' '); this.walkChildren(el, run, st); run.inl.push(' '); return; }
    if (tag === 'figcaption' || tag === 'caption') {
      const r = this.sub(el, st); r.flush(this);
      run.pushAll(this, r.blocks);
      return;
    }
    run.flush(this);
    const r = this.sub(el, st);
    r.flush(this);
    run.pushAll(this, r.blocks);
  }

  // ---------- inline pieces ----------
  emphasis(el, run, st, delim) {
    if (st.inHeading || st.inCode) return this.walkChildren(el, run, st);
    const r = this.inlineOf(el, st);
    if (r.blocks) { run.pushAll(this, r.blocks); return; }
    const inner = r.inline;
    if (!inner.trim()) { run.inl.push(inner); return; }
    // Don't double-wrap (<b><strong>x</strong></b>).
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
    let body = m[2];
    if (body.startsWith(delim) && body.endsWith(delim) && body.length > 2 * delim.length) { run.inl.push(inner); return; }
    if (body.includes(HARD_BREAK)) { run.inl.push(inner); return; }
    run.inl.push(m[1] + delim + body + delim + m[3]);
  }

  supsub(el, run, st, tag) {
    if (st.inHeading) return this.walkChildren(el, run, st);
    const r = this.inlineOf(el, st);
    if (r.blocks) { run.pushAll(this, r.blocks); return; }
    const inner = r.inline.trim();
    if (!inner) return;
    run.inl.push(`<${tag}>${inner}</${tag}>`);
  }

  inlineCode(el, run, st) {
    // A code element containing block structure (rare) → code block.
    const text = inlineCodeText(el);
    if (text.trim().includes('\n') && !st.inHeading && !st.inTable && isStandalone(el)) {
      return this.codeFromElement(el, run, st, languageOf(el));
    }
    const span = codeSpan(text);
    if (!span) return;
    const lead = /^\s/.test(text) ? ' ' : '';
    const trail = /\s$/.test(text) ? ' ' : '';
    run.inl.push(lead + span + trail);
  }

  link(el, run, st) {
    const href = attr(el, 'href');
    const cls = classOf(el);
    const r = this.inlineOf(el, st);
    if (r.blocks) { run.pushAll(this, r.blocks); return; }
    const inner = r.inline;
    const text = inner.replace(/[​‌‍﻿\s]/g, '');
    const label = attr(el, 'aria-label') || attr(el, 'title') || '';
    // Permalink anchors (¶, #, zero-width, "Anchor to …").
    const isFrag = !!href && href.trim().startsWith('#');
    const permaClass = !!cls && PERMALINK_CLASS_RE.test(cls);
    if (isFrag || permaClass) {
      const plain = plainText(el).replace(/[​‌‍﻿]/g, '');
      if (!plain || PERMALINK_TEXT_RE.test(plain) || PERMALINK_LABEL_RE.test(plain)) return;
      if (permaClass && (plain.length <= 2 || PERMALINK_LABEL_RE.test(label))) return;
    }
    if (!text) return;   // empty link
    if (st.inHeading || st.inLink) { run.inl.push(inner); return; }
    if (UI_LINE_RE.test(plainText(el))) return;   // "View as Markdown", "Edit this page", …
    const url = this.url.resolve(href);
    if (!url) { run.inl.push(inner); return; }
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
    let body = m[2].replace(new RegExp(HARD_BREAK, 'g'), ' ');
    run.inl.push(`${m[1]}[${body}](${mdUrl(url)})${m[3]}`);
  }

  image(el, run, st) {
    const alt = (attr(el, 'alt') || '').replace(/\s+/g, ' ').trim();
    const altMd = alt.replace(/[\[\]\\]/g, (c) => '\\' + c);
    if (this.isDecorativeImage(el)) return;
    let src = attr(el, 'src');
    if (!src || /^(?:data|blob):/i.test(src)) {
      src = attr(el, 'data-src') || attr(el, 'data-original') || attr(el, 'data-lazy-src') || null;
      if (!src) {
        const ss = attr(el, 'srcset') || attr(el, 'data-srcset');
        if (ss) src = ss.split(',')[0].trim().split(/\s+/)[0];
      }
    }
    const url = src && !/^(?:data|blob):/i.test(src) ? this.url.resolve(src, { allowFragment: false }) : null;
    if (!url) {
      if (alt && alt.length > 2 && !/^(?:image|img|icon|logo|picture|photo|screenshot)$/i.test(alt)) run.inl.push(escapeText(alt));
      return;
    }
    if (st.inHeading) { if (alt) run.inl.push(escapeText(alt)); return; }
    run.inl.push(`![${altMd}](${mdUrl(url)})`);
  }

  isDecorativeImage(el) {
    if (attr(el, 'role') === 'presentation' || attr(el, 'role') === 'none' || attr(el, 'aria-hidden') === 'true') return true;
    const w = parseInt(attr(el, 'width') || '', 10);
    const h = parseInt(attr(el, 'height') || '', 10);
    if ((w && w <= 2) || (h && h <= 2)) return true;       // tracking pixels
    if (w && h && w <= 24 && h <= 24) return true;          // icons
    const c = classOf(el) + ' ' + (attr(el, 'alt') || '');
    if (DECORATIVE_IMG_RE.test(classOf(el))) return true;
    const src = attr(el, 'src') || '';
    if (/(?:^|\/)(?:pixel|spacer|blank|tracking|beacon)\.(?:gif|png)(?:$|\?)/i.test(src)) return true;
    void c;
    return false;
  }

  button(el, run, st) {
    if (st.inHeading) return this.walkChildren(el, run, st);
    // A table cell whose content is a button (interactive data tables): the text is the cell's data.
    if (inTableCell(el)) return this.walkChildren(el, run, st);
    // WAI-ARIA accordion header: a button that expands a region; its text is a label.
    if (attr(el, 'aria-controls') && attr(el, 'aria-expanded') != null && !attr(el, 'aria-haspopup')) {
      const r = this.inlineOf(el, { ...st, inHeading: true });
      const t = (r.inline || '').trim();
      if (t && t.length > 2) run.push(this, `**${t}**`);
    }
  }

  label(el, run, st) {
    // <label for=radio> in CSS-only tab sets (sphinx-design, many themes): a tab label.
    const f = attr(el, 'for');
    if (f && this.doc) {
      const input = this.doc.getElementById(f);
      if (input && /^(?:radio|checkbox)$/i.test(attr(input, 'type') || '')) {
        const r = this.inlineOf(el, { ...st, inHeading: true });
        const t = (r.inline || '').trim();
        if (t) run.push(this, `**${t}**`);
        return;
      }
    }
    this.walkChildren(el, run, st);
  }

  math(el, tag, run) {
    const m = mathMd(el, tag);
    if (!m) return;
    if (m.text) { run.inl.push(escapeText(m.text)); return; }
    if (m.display) run.push(this, `$$\n${m.tex}\n$$`);
    else run.inl.push(`$${m.tex}$`);
  }

  boldBlock(el, run, st) {
    const r = this.inlineOf(el, { ...st, inHeading: true });
    if (r.blocks) { run.pushAll(this, r.blocks); return; }
    const t = r.inline.replace(/\s+/g, ' ').trim();
    if (t) run.push(this, `**${t}**`);
  }

  // ---------- headings ----------
  /** Heading text: one line of plain text (links unwrapped, no code/emphasis markup —
   *  headings are identifiers for outlines and search, and signatures would otherwise
   *  split into per-token code spans). */
  headingText(el, st) {
    const r = this.sub(el, { ...st, inHeading: true, plainCode: true });
    r.flush(this);
    let t = r.blocks.join(' ').replace(/\s+/g, ' ').trim();
    t = t.replace(/(?:\s*[¶#§]\s*)+$/u, '').replace(/[​‌‍﻿]+/g, (m, i, s) => (i === 0 || i + m.length === s.length ? '' : m)).trim();
    t = t.replace(/\s#+$/, (m) => m.replace(/#/g, '\\#'));
    return t;
  }

  heading(el, level, run, st) {
    if (st.inHeading) return this.walkChildren(el, run, st);
    const t = this.headingText(el, st);
    if (!t) return;
    if (st.inTable && false) return;
    if (st.apiDepth === 0) this.lastHeadingLevel = level;
    if (level === 1) this.sawH1 = true;
    run.push(this, `${'#'.repeat(level)} ${t}`);
  }

  // ---------- code ----------
  pre(el, run, st) {
    if (st.inCode) return this.walkChildren(el, run, st);
    // Nested <pre> (pre > div > pre): the outermost wins, as one fence.
    return this.codeFromElement(el, run, st, languageOf(el));
  }

  codeFromElement(el, run, st, lang) {
    const code = normalizeCodeBlock(el);
    if (!code.trim()) return;
    if (st.inHeading) { run.inl.push(codeSpan(code)); return; }
    const n = this.codes.push(fenceCode(code, lang)) - 1;
    // A language label shown above the code ("js") is UI, not content.
    if (lang) {
      const pending = run.inl.join('').replace(/[\s\u00a0]+/g, ' ').trim();
      if (pending && pending.toLowerCase() === lang.toLowerCase()) run.inl = [];
      else if (!pending && run.blocks.length && run.blocks[run.blocks.length - 1].toLowerCase() === lang.toLowerCase()) run.blocks.pop();
    }
    run.push(this, `${CODE_OPEN}${n}${CODE_OPEN}`);
  }

  // ---------- lists ----------
  list(el, run, st, ordered) {
    if (st.inHeading) { this.walkChildren(el, run, st); return; }
    let n = parseInt(attr(el, 'start') || '1', 10);
    if (!Number.isFinite(n)) n = 1;
    const items = [];
    const st2 = { ...st, listDepth: st.listDepth + 1 };
    let cur = null;
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        if (!c.data.trim()) continue;
        cur = new Run(); items.push({ run: cur, value: null });
        this.walkNode(c, cur, st2);
        continue;
      }
      if (c.nodeType !== 1) continue;
      const t = tagOf(c);
      if (t === 'li') {
        cur = new Run();
        const v = attr(c, 'value');
        items.push({ run: cur, value: v && /^\d+$/.test(v) ? parseInt(v, 10) : null });
        this.walkChildren(c, cur, st2);
      } else if ((t === 'ul' || t === 'ol') && cur) {
        this.walkNode(c, cur, st2);   // invalid nesting: sublist belongs to the previous item
      } else {
        cur = new Run(); items.push({ run: cur, value: null });
        this.walkNode(c, cur, st2);
      }
    }
    const rendered = [];
    let loose = false;
    for (const it of items) {
      it.run.flush(this);
      const blocks = it.run.blocks;
      if (!blocks.length) continue;
      const nonList = blocks.filter(b => !isListBlock(b)).length;
      if (nonList > 1) loose = true;
      rendered.push({ blocks, value: it.value });
    }
    if (!rendered.length) return;
    const out = [];
    for (const it of rendered) {
      if (it.value != null) n = it.value;
      const marker = ordered ? `${n}.` : '-';
      n++;
      let body = '';
      it.blocks.forEach((b, i) => { body += (i === 0 ? '' : (isListBlock(b) && !loose ? '\n' : '\n\n')) + b; });
      out.push(indentBlock(body, marker + ' ', ' '.repeat(marker.length + 1)));
    }
    run.push(this, out.join(loose ? '\n\n' : '\n'));
  }

  // ---------- definition lists ----------
  /** dt/dd items of a dl, looking through <div> groups (allowed by HTML). */
  dlItems(el) {
    const out = [];
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1 && tagOf(c) === 'div' && !this.skipEls.has(c)) {
        let hasDt = false;
        for (let d = c.firstChild; d; d = d.nextSibling) if (d.nodeType === 1 && (tagOf(d) === 'dt' || tagOf(d) === 'dd')) { hasDt = true; break; }
        if (hasDt) { for (let d = c.firstChild; d; d = d.nextSibling) out.push(d); continue; }
      }
      out.push(c);
    }
    return out;
  }

  /**
   * API definition lists: entries whose terms are anchored signatures —
   * Sphinx-family `dl.py.class > dt.sig[id]`, or any dt carrying an id and a
   * self-link to it (the "¶"/"Anchor to" permalink pattern).
   */
  isApiDl(el) {
    const c = classOf(el);
    const firstDt = this.dlItems(el).find(d => d.nodeType === 1 && tagOf(d) === 'dt');
    if (!firstDt) return false;
    const idEl = firstDt.getAttribute('id') ? firstDt : firstDt.querySelector('[id]');
    if (!idEl) return false;
    if (c && API_DL_CLASS_RE.test(c)
      && (hasClassToken(firstDt, 'sig') || hasClassToken(firstDt, 'sig-object') || firstDt.querySelector('.descname, .sig-name, code.descname'))) return true;
    const id = idEl.getAttribute('id');
    const links = firstDt.querySelectorAll('a[href]');
    for (let i = 0; i < links.length; i++) {
      const h = links[i].getAttribute('href') || '';
      const k = h.indexOf('#');
      if (k >= 0 && h.slice(k + 1) === id) return true;
    }
    return false;
  }

  dl(el, run, st) {
    if (st.inHeading) { this.walkChildren(el, run, st); return; }
    const api = this.isApiDl(el);
    let st2 = st;
    if (api) {
      const base = st.apiBase ?? this.lastHeadingLevel;
      st2 = { ...st, apiDepth: st.apiDepth + 1, apiBase: base };
    }
    run.flush(this);
    for (const c of this.dlItems(el)) {
      if (c.nodeType !== 1) { if (c.nodeType === 3 && c.data.trim()) this.walkNode(c, run, st2); continue; }
      const t = tagOf(c);
      if (t === 'dt') {
        if (api) {
          const level = Math.min(6, st2.apiBase + st2.apiDepth);
          const text = this.headingText(c, st2);
          if (text) run.push(this, `${'#'.repeat(level)} ${text}`);
        } else {
          const r = this.inlineOf(c, st2);
          let t2 = '';
          if (r.blocks) {
            // A term split over block wrappers (name, type chips): one line if short and plain.
            if (r.blocks.every(isInlineBlock) && r.blocks.join(' ').length <= 200) t2 = r.blocks.join(' ');
            else { run.pushAll(this, r.blocks); continue; }
          } else t2 = this.finishParagraph(r.inline);
          // Bold the term unless it already carries its own bold (would nest `**`).
          if (t2) run.push(this, t2.includes('**') || t2.includes('\n') ? t2 : `**${t2}**`);
        }
      } else if (t === 'dd') {
        const r = this.sub(c, st2); r.flush(this);
        run.pushAll(this, r.blocks);
      } else {
        this.walkNode(c, run, st2);
        run.flush(this);
      }
    }
  }

  // ---------- quotes, callouts, details, tabs ----------
  blockquote(el, run, st) {
    if (st.inHeading) { this.walkChildren(el, run, st); return; }
    const kind = !st.inCallout ? this.calloutKind(el, 'blockquote', attr(el, 'role')) : null;
    if (kind) return this.callout(el, kind, run, st);
    const r = this.sub(el, st); r.flush(this);
    if (!r.blocks.length) return;
    run.push(this, indentBlock(r.blocks.join('\n\n'), '> ', '> ', 'quote'));
  }

  calloutKind(el, tag, role) {
    let kind = null;
    if (role === 'note') kind = 'NOTE';
    else if (role === 'alert') kind = 'WARNING';
    const words = classWords(el);
    const extra = (attr(el, 'data-callout-type') || attr(el, 'data-callout') || attr(el, 'data-admonition') || attr(el, 'data-variant') || '').toLowerCase();
    if (extra) words.push(...extra.split(/[\s_\-]+/));
    if (!kind && tag !== 'aside' && !words.length) return null;
    if (words.some(w => CALLOUT_EXCLUDE_WORDS.has(w))) {
      // "callout-content", "note-title", … are parts of a callout, not the callout.
      const hasKindWord = words.some(w => CALLOUT_WORDS[w]);
      if (!hasKindWord) return null;
      if (words.some(w => CALLOUT_TITLE_WORDS.has(w) || w === 'icon' || w === 'content' || w === 'body' || w === 'text')) return null;
    }
    let generic = null;
    for (const w of words) {
      const k = CALLOUT_WORDS[w];
      if (!k) continue;
      if (GENERIC_CALLOUT.has(w)) { generic = generic || k; continue; }
      kind = kind && kind !== 'NOTE' ? kind : k;
      if (k !== 'NOTE') break;
    }
    if (!kind && generic) kind = generic;
    // A bare <aside> is a note — unless it's a footnote/citation/sidebar (DPUB-ARIA roles, docutils classes).
    if (!kind && tag === 'aside' && !(role && /^doc-/.test(role))
      && !words.some(w => /^(?:footnote|footnotes|citation|citations|sidebar|toc|nav|navigation|related|share|social|ad|ads|promo)$/.test(w))) kind = 'NOTE';
    if (!kind) return null;
    // Sanity: a callout is a short box of prose, not a page section.
    if (el.querySelector('h1, h2')) return null;
    const len = plainText(el).length;
    if (!len || len > 6000) return null;
    return kind;
  }

  callout(el, kind, run, st) {
    const title = this.findCalloutTitle(el);
    let titleMd = '';
    if (title) {
      this.skipEls.add(title);
      const r = this.inlineOf(title, { ...st, inHeading: true });
      titleMd = (r.inline || (r.blocks || []).join(' ')).replace(/\s+/g, ' ').trim();
    }
    const r = this.sub(el, { ...st, inCallout: st.inCallout + 1 }); r.flush(this);
    if (title) this.skipEls.delete(title);
    const parts = [`[!${kind}]`];
    let body = r.blocks.join('\n\n');
    if (titleMd) {
      const tt = titleMd.replace(/^\*\*([\s\S]*)\*\*$/, '$1').replace(/:$/, '');
      parts.push(`**${tt}**`);
    }
    if (!body.trim() && !titleMd) return;
    const text = parts.join('\n') + (body ? '\n\n' + body : '');
    run.push(this, indentBlock(text, '> ', '> ', 'quote'));
  }

  findCalloutTitle(el) {
    // First element child (descending through first children, max 3 levels) that is a title.
    let cur = el;
    for (let depth = 0; depth < 3 && cur; depth++) {
      let first = null;
      for (let c = cur.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3 && c.data.trim()) return null;
        if (c.nodeType === 1) {
          const t = tagOf(c);
          if (t === 'svg' || t === 'button' || (attr(c, 'aria-hidden') === 'true') || (!plainText(c) && !c.querySelector('img'))) continue;
          first = c; break;
        }
      }
      if (!first) return null;
      const t = tagOf(first);
      const words = classWords(first);
      if (t === 'summary' || /^h[1-6]$/.test(t) || words.some(w => CALLOUT_TITLE_WORDS.has(w))) {
        const txt = plainText(first);
        if (txt && txt.length <= 120) return first;
        return null;
      }
      // A lone <strong>/<b> title line.
      if ((t === 'p' || t === 'div') && first.children && first.children.length === 1 && /^(?:strong|b)$/.test(tagOf(first.children[0]))
        && plainText(first) === plainText(first.children[0]) && plainText(first).length <= 80 && first.nextElementSibling) return first;
      cur = first;
    }
    return null;
  }

  details(el, run, st) {
    if (st.inHeading) { this.walkChildren(el, run, st); return; }
    run.flush(this);
    let summary = null;
    for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && tagOf(c) === 'summary') { summary = c; break; }
    if (summary) {
      const hasHeading = summary.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"], [data-markdown-heading]');
      if (hasHeading) {
        const r = this.sub(summary, st); r.flush(this);
        run.pushAll(this, r.blocks);
      } else {
        const r = this.inlineOf(summary, { ...st, inHeading: true });
        const t = (r.inline || (r.blocks || []).join(' ')).replace(/\s+/g, ' ').trim();
        if (t) run.push(this, /^\*\*[^*]*\*\*$/.test(t) ? t : `**${t}**`);
      }
    }
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c === summary) continue;
      this.walkNode(c, run, st);
    }
    run.flush(this);
  }

  tabPanel(el, run, st) {
    run.flush(this);
    const r = this.sub(el, { ...st, hidden: st.hidden || isHiddenButReal(el) }); r.flush(this);
    if (!r.blocks.length) return;
    const label = this.tabLabels.get(el);
    if (label) {
      const first = r.blocks[0];
      const flat = first.replace(/^#+\s+|\*\*/g, '').trim();
      if (flat !== label) run.push(this, `**${label.replace(/\*/g, '\\*')}**`);
    }
    run.pushAll(this, r.blocks);
  }

  isHiddenDuplicate(el) {
    const own = fingerprint(el.textContent || '');
    if (!own) return true;
    if (own.length < 20 || own.length > 4000) return false;
    // Hidden SSR / a11y copies of a visible block sit right next to it: compare
    // with the visible siblings, then with the parent's visible siblings.
    let p = el.parentNode;
    for (let depth = 0; depth < 2 && p && p.nodeType === 1; depth++, p = p.parentNode) {
      for (let s = p.firstChild; s; s = s.nextSibling) {
        if (s.nodeType !== 1 || s === el || s.contains(el) || isHiddenButReal(s)) continue;
        const t = s.textContent || '';
        if (t.length < own.length * 0.8) continue;
        if (fingerprint(t).includes(own)) return true;
      }
    }
    return false;
  }

  // ---------- tables ----------
  table(el, run, st) {
    if (st.inHeading) { this.walkChildren(el, run, st); return; }
    const rows = [];
    let caption = null;
    const collect = (node, inHead) => {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        const t = tagOf(c);
        if (t === 'tr') rows.push({ tr: c, inHead });
        else if (t === 'thead') collect(c, true);
        else if (t === 'tbody' || t === 'tfoot') collect(c, false);
        else if (t === 'caption') caption = c;
      }
    };
    collect(el, false);
    if (!rows.length) return;
    const hasPre = !!el.querySelector('pre');
    // Cells, skipping line-number gutters of highlight tables.
    const grid = rows.map(({ tr, inHead }) => {
      const cells = [];
      for (let c = tr.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        const t = tagOf(c);
        if (t !== 'td' && t !== 'th') continue;
        if (hasPre && GUTTER_CLASS_RE.test(classOf(c))) continue;
        cells.push(c);
      }
      return { cells, inHead };
    }).filter(r => r.cells.length);
    if (!grid.length) return;
    run.flush(this);
    if (caption) {
      const r = this.sub(caption, st); r.flush(this);
      run.pushAll(this, r.blocks);
    }
    const role = attr(el, 'role');
    const ncols = Math.max(...grid.map(r => r.cells.length));
    // Layout tables: a single cell, or explicitly presentational → just the content.
    if ((grid.length === 1 && ncols === 1) || role === 'presentation' || role === 'none') {
      for (const r of grid) for (const c of r.cells) { const s2 = this.sub(c, st); s2.flush(this); run.pushAll(this, s2.blocks); }
      return;
    }
    const st2 = { ...st, inTable: true };
    const conv = grid.map(r => r.cells.map(c => {
      const s2 = this.sub(c, st2); s2.flush(this);
      return {
        el: c, blocks: s2.blocks, th: tagOf(c) === 'th' || r.inHead,
        cs: Math.max(1, parseInt(attr(c, 'colspan') || '1', 10) || 1),
        rs: Math.max(1, parseInt(attr(c, 'rowspan') || '1', 10) || 1),
      };
    }));
    // One column of block content (a table used to stack sections): unwrap.
    if (ncols === 1 && conv.some(r => !cellIsInline(r[0]))) {
      for (const r of conv) {
        const x = r[0];
        if (x.th && cellIsInline(x) && x.blocks.length) run.push(this, `**${x.blocks.join(' ').replace(/^\*\*|\*\*$/g, '')}**`);
        else run.pushAll(this, x.blocks);
      }
      return;
    }
    // Rows that are only a spanning heading split the table into titled sections,
    // so the headings stay real (addressable) headings.
    let seg = [];
    for (const r of conv) {
      if (r.length === 1 && ncols > 1 && r[0].blocks.length === 1 && /^#{1,6} /.test(r[0].blocks[0])) {
        if (seg.length) this.renderGrid(seg, run);
        seg = [];
        run.push(this, r[0].blocks[0]);
        continue;
      }
      seg.push(r);
    }
    if (seg.length) this.renderGrid(seg, run);
  }

  renderGrid(rows, run) {
    const ncols = Math.max(...rows.map(r => r.reduce((n, x) => n + x.cs, 0)));
    const complex = rows.some(r => r.some(x => x.cs > 1 || x.rs > 1 || !cellIsInline(x)));
    if (!complex) {
      // Several plain paragraphs in a cell are kept apart with <br><br>.
      // (Line-start escapes are not needed inside a cell: `-` is not a list there.)
      const cellText = (x) => x.blocks.map(b => b.replace(/^\\([-+#>=])/, '$1').replace(/^(\d{1,9})\\([.)])/, '$1$2'))
        .join('<br><br>').replace(/ {2}\n/g, '<br>').replace(/\n/g, ' ')
        .replace(/(^|[^\\])\|/g, '$1\\|').replace(/(^|[^\\])\|/g, '$1\\|').trim();
      const rowsTxt = rows.map(r => { const a = r.map(cellText); while (a.length < ncols) a.push(''); return a; });
      const lines = ['| ' + rowsTxt[0].join(' | ') + ' |', '|' + ' --- |'.repeat(ncols)];
      for (const r of rowsTxt.slice(1)) lines.push('| ' + r.join(' | ') + ' |');
      run.push(this, lines.join('\n'));
      return;
    }
    // Minimal HTML table; cell content as markdown between blank lines (GitHub renders it).
    const out = ['<table>'];
    for (const r of rows) {
      out.push('<tr>');
      for (const x of r) {
        const t = x.th ? 'th' : 'td';
        let a = '';
        if (x.cs > 1) a += ` colspan="${x.cs}"`;
        if (x.rs > 1) a += ` rowspan="${x.rs}"`;
        const body = x.blocks.join('\n\n');
        if (!body.trim()) out.push(`<${t}${a}></${t}>`);
        // Plain text needs no markdown rendering: keep it on one line (<br> between
        // paragraphs). Markdown inside HTML needs the blank lines to render on GitHub.
        else if (x.blocks.every(isPlainCellBlock)) out.push(`<${t}${a}>${x.blocks.map(b => b.replace(/ {2}\n|\n/g, '<br>')).join('<br>')}</${t}>`);
        else out.push(`<${t}${a}>\n\n${body}\n\n</${t}>`);
      }
      out.push('</tr>');
    }
    out.push('</table>');
    run.push(this, out.join('\n'));
  }

  // ---------- assembly ----------
  toMarkdown() {
    let blocks = this.convertRoots();
    const title = this.opts.title;
    if (title && !this.sawH1) blocks.unshift(`# ${escapeText(title.replace(/\s+/g, ' ').trim())}`);
    let md = blocks.join('\n\n');
    // Drop UI residue lines (outside code — code is still in placeholders).
    md = md.split('\n').filter(l => !UI_LINE_RE.test(l.trim().replace(/^[>\s]+/, ''))).join('\n');
    md = md.replace(/\n{3,}/g, '\n\n');
    // Expand code placeholders, applying the line prefix they sit behind.
    const codes = this.codes;
    md = md.split('\n').map(line => {
      if (!line.includes(CODE_OPEN)) return line;
      const m = CODE_LINE_RE.exec(line);
      if (!m) return line.replace(/\u0002(\d+)\u0002/g, (x, n) => codes[Number(n)]);
      const prefix = m[1];
      const code = codes[Number(m[2])];
      if (!prefix) return code;
      const pBlank = prefix.replace(/\s+$/, '');
      return code.split('\n').map(l => (l ? prefix + l : pBlank)).join('\n');
    }).join('\n');
    return md.trim() + '\n';
  }
}

function inlineCodeText(el) {
  const out = [];
  const walk = (n) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out.push(c.data);
      else if (c.nodeType === 1) {
        const t = tagOf(c);
        if (t === 'br') { out.push('\n'); continue; }
        if (t === 'wbr') continue;
        if (isCodeUi(c, t)) continue;
        walk(c);
      }
    }
  };
  walk(el);
  return out.join('');
}

function hasLineChild(el) {
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType !== 1) continue;
    const t = tagOf(c);
    if (BLOCK_TAGS.has(t) || LINE_CLASS_RE.test(classOf(c))) return true;
  }
  return false;
}

/** white-space: pre / pre-wrap (inline style or utility class) on a monospace or multi-line element. */
function isPreformatted(el, cls) {
  const st = styleOf(el);
  const pre = /white-space\s*:\s*pre(?:-wrap)?\b/.test(st) || (!!cls && /(?:^|\s)(?:whitespace-pre|whitespace-pre-wrap|ws-pre|pre-wrap)(?:$|\s)/.test(cls));
  if (!pre) return false;
  if ((cls && /(?:^|\s)(?:font-mono|monospace|mono|code)(?:$|\s)/.test(cls)) || /font-family\s*:[^;]*mono/.test(st)) return true;
  return (el.textContent || '').trim().includes('\n');
}

/** The element is the only content of its parent (no sibling text): a block, not a word in prose. */
function isStandalone(el) {
  const p = el.parentNode;
  if (!p) return true;
  for (let c = p.firstChild; c; c = c.nextSibling) {
    if (c === el) continue;
    if (c.nodeType === 3 && c.data.trim()) return false;
    if (c.nodeType === 1 && !/^(?:button|br)$/.test(tagOf(c)) && (c.textContent || '').trim()) return false;
  }
  return true;
}

function isListBlock(b) {
  return /^(?:[-*+]|\d{1,9}[.)]) /.test(b);
}
function isInlineBlock(b) {
  // A plain paragraph (no block syntax) can live in a GFM table cell.
  if (b.includes(CODE_OPEN)) return false;
  if (/^(?:#{1,6} |> |[-*+] |\d{1,9}[.)] |\||<table|\$\$)/.test(b)) return false;
  return !b.replace(/ {2}\n/g, '').includes('\n');
}
function cellIsInline(x) {
  return x.blocks.every(isInlineBlock);
}

/**
 * Prefix every line of a block: `first` on line one, `rest` after.
 *
 * Fenced code is nested the CommonMark way (the fence and its lines carry the
 * list indent / `> ` quote prefix; relative indentation is untouched), the same
 * shape owner-published markdown has, so both routes produce one structure.
 * In lists, a heading line is lifted to column 0 (with everything after it in
 * the item): headings must start a line for outlines and the search index.
 */
function indentBlock(text, first, rest, mode = 'list') {
  const lines = text.split('\n');
  const out = [];
  let lifted = false;
  const restBlank = rest.replace(/\s+$/, '');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (mode === 'list' && (lifted || /^#{1,6} /.test(l))) { out.push(l); lifted = true; continue; }
    const p = i === 0 ? first : rest;
    out.push(l ? p + l : (i === 0 ? p.replace(/\s+$/, '') : restBlank));
  }
  return out.join('\n');
}

/**
 * Convert content root element(s) to GitHub-flavoured markdown.
 * @param {Element|Element[]} roots
 * @param {{baseUrl?: string, title?: string}} [opts]  `title` is emitted as `# title` when the roots have no H1.
 * @returns {string}
 */
export function toMarkdown(roots, opts = {}) {
  const list = Array.isArray(roots) ? roots : (roots && typeof roots.length === 'number' && !roots.nodeType ? Array.from(roots) : [roots]);
  const clean = list.filter(Boolean);
  if (!clean.length) return opts.title ? `# ${opts.title}\n` : '';
  try {
    return dropRepeatedFences(new Converter(clean, opts).toMarkdown());
  } catch (err) {
    // Pathologically deep DOMs can exhaust the stack: fall back to plain block text
    // (every word kept) rather than failing the page.
    if (!(err instanceof RangeError)) throw err;
    const text = clean.map(blockTextIterative).join('\n\n');
    const head = opts.title ? `# ${opts.title}\n\n` : '';
    return head + text.split(/\n{2,}/).map(p => escapeLineStart(escapeText(p.replace(/[ \t]+/g, ' ').trim()))).filter(Boolean).join('\n\n') + '\n';
  }
}

/**
 * Two identical code blocks with nothing but blank lines between them are one
 * example rendered twice (e.g. an interactive editor component and the page's
 * own <pre>); keep one — the one with a language label. Tab panels are never
 * merged: their labels sit between the blocks.
 */
export function dropRepeatedFences(md) {
  const lines = md.split('\n');
  const blocks = []; // {start, end, info, body}
  for (let i = 0; i < lines.length; i++) {
    const open = fenceOpen(lines[i]);
    if (!open) continue;
    let j = i + 1;
    while (j < lines.length && !isFenceClose(lines[j], open)) j++;
    blocks.push({ start: i, end: Math.min(j, lines.length - 1), info: open.info.trim(), indent: open.indent, body: lines.slice(i + 1, j).join('\n') });
    i = j;
  }
  const drop = new Set();
  for (let k = 1; k < blocks.length; k++) {
    const a = blocks[k - 1], b = blocks[k];
    if (drop.has(k - 1) || a.body !== b.body || a.indent !== b.indent || !a.body.trim()) continue;
    if (lines.slice(a.end + 1, b.start).some(l => l.trim())) continue;
    drop.add(!a.info && b.info ? k - 1 : k);
  }
  if (!drop.size) return md;
  const kill = new Set();
  for (const k of drop) {
    const b = blocks[k];
    for (let i = b.start; i <= b.end; i++) kill.add(i);
    // and the blank line(s) that separated it from its twin
    for (let i = b.end + 1; i < lines.length && !lines[i].trim() && !kill.has(i); i++) kill.add(i);
  }
  return lines.filter((_, i) => !kill.has(i)).join('\n');
}

/** Text with blank lines at block boundaries, without recursion. */
function blockTextIterative(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n === null) { out.push('\n\n'); continue; }
    if (n.nodeType === 3) { out.push(n.data.replace(/\s+/g, ' ')); continue; }
    if (n.nodeType !== 1 || SKIP_TAGS.has(tagOf(n)) || tagOf(n) === 'button') continue;
    const block = BLOCK_TAGS.has(tagOf(n)) || tagOf(n) === 'br';
    if (block) { out.push('\n\n'); stack.push(null); }
    const kids = [];
    for (let c = n.firstChild; c; c = c.nextSibling) kids.push(c);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out.join('');
}

/** Escape text so markdown shows it literally (for other stages building markdown). */
export function escapeMarkdown(text) {
  return escapeLineStart(escapeText(text));
}
