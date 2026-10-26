/**
 * Owner-published markdown: decide whether the markdown a site serves for a
 * page (`Accept: text/markdown`, or the `<url>.md` variant) can stand in for
 * the rendered page, and clean it up lightly when it can.
 *
 * Two kinds of "markdown" come back from those probes:
 *   - owner-written source (Vite, React, Shopify, Mintlify sites, HF doc-builder…):
 *     usually complete and better than anything we can convert, but written for
 *     the site's renderer — MDX imports/exports, JSX components (<Note>, <Tabs>,
 *     <CodeGroup>…), `:::` containers, heading-id syntax, source-relative links,
 *     injected "see llms.txt" notes.
 *   - edge conversions of the HTML (a CDN "markdown for agents" feature) and
 *     stubs (a "Redirecting…" page, an error, a bot check) served as markdown.
 *     These carry the site template (breadcrumbs, "Skip to main content", `¶`
 *     permalinks, raw <dl> blocks) or none of the page.
 *
 * Every signal here is generic — the shape of the text, its agreement with the
 * rendered page — never a list of sites. Thresholds were set on the eval corpus
 * (eval/results/OWNER_LOG.md).
 */

import { splitFrontMatter } from '../store/frontmatter.mjs';
import { detectBadPage } from '../store/quality.mjs';
import { fenceOpen, isFenceClose, protectCodeSpans } from './mdscan.mjs';

// ─── cleanup ─────────────────────────────────────────────────────────────────

/** Component/container name → GitHub alert kind. Lower-cased, non-letters removed. */
const CALLOUT_KIND = {
  note: 'NOTE', info: 'NOTE', information: 'NOTE', check: 'NOTE', success: 'NOTE', notice: 'NOTE',
  callout: 'NOTE', admonition: 'NOTE', alert: 'NOTE', aside: 'NOTE', deepdive: 'NOTE', seealso: 'NOTE',
  tip: 'TIP', hint: 'TIP', recommended: 'TIP',
  important: 'IMPORTANT', primary: 'IMPORTANT',
  warning: 'WARNING', warn: 'WARNING', pitfall: 'WARNING', attention: 'WARNING',
  caution: 'CAUTION', danger: 'CAUTION', error: 'CAUTION', deprecated: 'CAUTION',
};
/** Generic callout wrappers whose kind comes from an attribute. */
const CALLOUT_GENERIC = new Set(['callout', 'admonition', 'alert', 'notice', 'aside']);
const CALLOUT_TYPE_ATTRS = ['type', 'kind', 'variant', 'severity', 'intent', 'status'];

/** Attributes that carry a human-visible label for a tab / step / accordion / card / code block. */
const LABEL_ATTRS = ['title', 'label', 'filename', 'fileName', 'file', 'name', 'summary', 'heading', 'header'];
/** API-field components (ParamField path="id" type="string" required …). */
const FIELD_ATTRS = ['path', 'query', 'body', 'header', 'param', 'field', 'cookie', 'post'];

/** Containers whose fenced children are alternatives shown as tabs (their label is in the fence meta). */
const CODE_GROUP = /^(codegroup|codetabs|codeswitcher|codeblocks|requestexample|responseexample|sandpack|codegroupitem)$/;

const COMPONENT_OPEN = /^<([A-Z][\w]*(?:\.[A-Za-z]\w*)*)(?=[\s/>]|$)/;
const CONTAINER_OPEN = /^(:{3,})[ \t]*([A-Za-z][\w-]*)?(?:\[([^\]]*)\])?[ \t]*(.*)$/;
const CONTAINER_CLOSE = /^:{3,}[ \t]*$/;

const lead = (s) => /^[ \t]*/.exec(s)[0];
const isBlank = (s) => !s || !s.trim();
const simpleName = (name) => name.split('.').pop().toLowerCase().replace(/[^a-z]/g, '');

/**
 * Parse a JSX opening tag at the start of `text`. Handles quoted and `{…}`
 * attribute values (which may contain `>`), and tags spanning lines.
 * @returns {{name: string, attrs: object, selfClosing: boolean, end: number} | null}
 *   null when the tag is not complete within `text`.
 */
export function parseJsxTag(text) {
  const m = COMPONENT_OPEN.exec(text);
  if (!m) return null;
  const attrs = {};
  let i = m[0].length;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) return null;
    if (text[i] === '>') return { name: m[1], attrs, selfClosing: false, end: i + 1 };
    if (text[i] === '/' && text[i + 1] === '>') return { name: m[1], attrs, selfClosing: true, end: i + 2 };
    if (text[i] === '{') { // spread {...props}
      const e = skipBraces(text, i);
      if (e < 0) return null;
      i = e;
      continue;
    }
    const km = /^[A-Za-z_:][\w:.-]*/.exec(text.slice(i, i + 200));
    if (!km) return null; // not a JSX tag after all
    const key = km[0];
    i += key.length;
    while (i < n && /[ \t]/.test(text[i])) i++;
    if (text[i] !== '=') { attrs[key] = true; continue; }
    i++;
    while (i < n && /\s/.test(text[i])) i++;
    const q = text[i];
    if (q === '"' || q === "'") {
      const e = text.indexOf(q, i + 1);
      if (e < 0) return null;
      attrs[key] = text.slice(i + 1, e);
      i = e + 1;
    } else if (q === '{') {
      const e = skipBraces(text, i);
      if (e < 0) return null;
      const expr = text.slice(i + 1, e - 1).trim();
      const lit = parseJsString(expr);
      attrs[key] = lit !== null ? lit : { expr };
      i = e;
    } else {
      return null;
    }
  }
  return null;
}

/** Index just past the `}` matching the `{` at `start`; -1 if unbalanced. Strings are skipped. */
function skipBraces(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const e = skipString(text, i);
      if (e < 0) return -1;
      i = e - 1;
    } else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** Index just past the string literal starting at `start` (quote char at start). */
function skipString(text, start) {
  const q = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === q) return i + 1;
    if (q !== '`' && text[i] === '\n') return -1;
  }
  return -1;
}

/** Value of a JS string literal (single, double or substitution-free template); null otherwise. */
export function parseJsString(src) {
  const s = src.trim();
  if (s.length < 2) return null;
  const q = s[0];
  if (!(q === '"' || q === "'" || q === '`') || s[s.length - 1] !== q) return null;
  if (skipString(s, 0) !== s.length) return null;
  const inner = s.slice(1, -1);
  if (q === '`' && /\$\{/.test(inner)) return null;
  return inner.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[0-7]{1,3}|\r?\n|.)/g, (m, e) => {
    if (e[0] === 'u') return String.fromCodePoint(parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16));
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]+$/.test(e)) return e === '0' ? '\0' : String.fromCharCode(parseInt(e, 8));
    if (e === '\n' || e === '\r\n') return '';
    return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' }[e] ?? e;
  });
}

/**
 * Evaluate an MDX expression that is a string constant, a known exported
 * constant, or a `+` concatenation of those. null when it is anything else.
 */
function evalStringExpr(expr, consts) {
  const parts = [];
  let i = 0;
  const s = expr.trim();
  if (!s) return null;
  while (i < s.length) {
    while (/\s/.test(s[i] || '')) i++;
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      const e = skipString(s, i);
      if (e < 0) return null;
      const v = parseJsString(s.slice(i, e));
      if (v === null) return null;
      parts.push(v);
      i = e;
    } else {
      const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
      if (!m || !(m[0] in consts)) return null;
      parts.push(consts[m[0]]);
      i += m[0].length;
    }
    while (/\s/.test(s[i] || '')) i++;
    if (i >= s.length) break;
    if (s[i] !== '+') return null;
    i++;
  }
  return parts.join('');
}

/**
 * Remove top-level MDX `import`/`export` statements (which may span lines) and
 * collect `export const NAME = <string>` values, used by the page's own
 * expressions (`{NAME}` inside a code block).
 */
function stripEsm(lines, stats) {
  const out = [];
  const consts = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = fenceOpen(line);
    if (open) { // copy fenced blocks verbatim
      out.push(line);
      let j = i + 1;
      while (j < lines.length && !isFenceClose(lines[j], open)) out.push(lines[j++]);
      if (j < lines.length) out.push(lines[j]);
      i = j;
      continue;
    }
    if (!/^(import|export)\s+(?:[\w$*{]|type\s|default\s)/.test(line) || /^(import|export)\s+\w+\s*$/.test(line)) {
      out.push(line);
      continue;
    }
    // Scan the statement: it ends at a newline with balanced brackets, outside
    // a string, not after a dangling operator.
    const text = lines.slice(i).join('\n');
    let depth = 0;
    let end = text.length;
    for (let k = 0; k < text.length; k++) {
      const c = text[k];
      if (c === '"' || c === "'" || c === '`') {
        const e = skipString(text, k);
        if (e < 0) break;
        k = e - 1;
      } else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === '\n' && depth <= 0) {
        const before = text.slice(0, k).trimEnd();
        if (!/[=,(+\-*/:?&|{[]$/.test(before) && !/\b(from|import|export|const|let|var)$/.test(before)) { end = k; break; }
      }
    }
    const stmt = text.slice(0, end);
    const cm = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?)\s*;?\s*$/.exec(stmt);
    if (cm) {
      const v = parseJsString(cm[2]);
      if (v !== null) consts[cm[1]] = v;
    }
    stats.esm++;
    i += stmt.split('\n').length - 1;
  }
  return { lines: out, consts };
}

/** Split lines into prose-line and fence items; fences are opaque from here on. */
function toItems(lines) {
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const open = fenceOpen(lines[i]);
    if (open) {
      const body = [];
      let j = i + 1;
      while (j < lines.length && !isFenceClose(lines[j], open)) body.push(lines[j++]);
      const closed = j < lines.length;
      items.push({ t: 'fence', indent: open.indent, marker: open.marker, info: open.info, body, close: closed ? lines[j] : null });
      i = closed ? j : lines.length;
    } else {
      items.push({ t: 'line', s: lines[i] });
    }
  }
  return items;
}

/**
 * Build a tree of JSX components and `:::` containers over the items. Anything
 * that is not a recognisable block opening/closing tag stays a line.
 */
function parseTree(items, isMdx) {
  const root = { t: 'root', children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.t !== 'line') { top().children.push(it); continue; }
    const trimmed = it.s.trim();

    // ::: containers (VitePress, Docusaurus, remark-directive)
    if (trimmed.startsWith(':::')) {
      if (CONTAINER_CLOSE.test(trimmed)) {
        const idx = stack.findLastIndex(n => n.container && trimmed.length >= n.colons);
        if (idx > 0) { stack.length = idx; continue; }
      } else {
        const cm = CONTAINER_OPEN.exec(trimmed);
        if (cm && cm[2]) {
          const node = { t: 'comp', container: true, colons: cm[1].length, name: cm[2], attrs: {}, children: [] };
          const title = (cm[3] ?? cm[4] ?? '').trim().replace(/^\{.*\}$/, '');
          if (title) node.attrs.title = title;
          top().children.push(node);
          stack.push(node);
          continue;
        }
      }
    }

    if (!isMdx) { top().children.push(it); continue; }

    const close = /^<\/([A-Z][\w]*(?:\.[A-Za-z]\w*)*)\s*>\s*$/.exec(trimmed);
    if (close) {
      const idx = stack.findLastIndex(n => n.name === close[1] && !n.container);
      if (idx > 0) { stack.length = idx; continue; }
      top().children.push(it); // stray closer: rendered (and dropped) as a line
      continue;
    }
    if (COMPONENT_OPEN.test(trimmed)) {
      let text = trimmed;
      let j = i;
      let tag = parseJsxTag(text);
      while (!tag && j + 1 < items.length && items[j + 1].t === 'line' && j - i < 40) {
        j++;
        text += '\n' + items[j].s;
        tag = parseJsxTag(text);
      }
      if (tag) {
        const rest = text.slice(tag.end);
        const closeTag = `</${tag.name}>`;
        const closeAt = rest.indexOf(closeTag);
        // `<CodeStep>x</CodeStep> more text` is inline: leave the line to inline cleanup.
        if (!tag.selfClosing && closeAt >= 0 && rest.slice(closeAt + closeTag.length).trim()) {
          top().children.push(it);
          continue;
        }
        i = j;
        const node = { t: 'comp', name: tag.name, attrs: tag.attrs, children: [], selfClosing: tag.selfClosing };
        top().children.push(node);
        if (tag.selfClosing) {
          if (rest.trim()) top().children.push({ t: 'line', s: rest.trim() });
          continue;
        }
        if (closeAt >= 0) {
          const inner = rest.slice(0, closeAt);
          for (const l of inner.split('\n')) node.children.push({ t: 'line', s: l });
          continue;
        }
        if (rest.trim()) for (const l of rest.split('\n')) node.children.push({ t: 'line', s: l });
        stack.push(node);
        continue;
      }
    }
    top().children.push(it);
  }
  return root;
}

/** Remove up to `n` leading whitespace characters. */
const unindent = (s, n) => s.slice(Math.min(n, lead(s).length));

/**
 * Dedent a run of items by their common indentation. Fence content loses at
 * most the same amount — the CommonMark rule for an indented fence, so the
 * code's own indentation is unchanged.
 */
function dedentItems(items) {
  let n = Infinity;
  for (const it of items) {
    if (it.t === 'line') { if (!isBlank(it.s)) n = Math.min(n, lead(it.s).length); }
    else if (it.t === 'fence') n = Math.min(n, it.indent.length);
  }
  if (!Number.isFinite(n) || n === 0) return items;
  return items.map(it => {
    if (it.t === 'line') return { ...it, s: unindent(it.s, n) };
    if (it.t === 'fence') {
      return {
        ...it,
        indent: it.indent.slice(n),
        body: it.body.map(l => unindent(l, Math.min(n, it.indent.length))),
        close: it.close == null ? null : unindent(it.close, n),
      };
    }
    return it;
  });
}

function trimBlankItems(items) {
  let a = 0, b = items.length;
  while (a < b && items[a].t === 'line' && isBlank(items[a].s)) a++;
  while (b > a && items[b - 1].t === 'line' && isBlank(items[b - 1].s)) b--;
  return items.slice(a, b);
}

const BLANK = () => ({ t: 'line', s: '' });

function attrText(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function labelOf(attrs) {
  for (const k of LABEL_ATTRS) {
    const v = attrText(attrs[k]);
    if (v) return v;
  }
  return '';
}

/** Split a fence info string into language and a visible title, if any. */
export function parseFenceInfo(info) {
  let s = info.trim();
  let title = '';
  const tm = /(?:^|\s)(?:title|filename|file|name)=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(s);
  if (tm) title = tm[1] ?? tm[2] ?? tm[3];
  const bm = /\[([^\]]+)\]/.exec(s); // VitePress: ```js [vite.config.js]
  if (!title && bm) title = bm[1];
  // drop attributes (key=value, key={…}) and {1,3-5} line highlights
  let rest = s.replace(/\[[^\]]*\]/g, ' ');
  rest = rest.replace(/[\w-]+=(?:"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\}|\S+)/g, ' ').replace(/\{[^}]*\}/g, ' ');
  const words = rest.split(/\s+/).filter(Boolean);
  const lang = words.length && /^[\w#+.-]+$/.test(words[0]) ? words[0] : '';
  const extra = words.slice(1);
  return { lang, title, extra };
}

/** A fence with its info reduced to the language; returns [label items…, fence]. */
function renderFence(it, { inGroup }) {
  const { lang, title, extra } = parseFenceInfo(it.info);
  // In a code group every word after the language is the tab's title; elsewhere
  // only a path-like word is (bare flags like `lines`/`wrap` are renderer options).
  let label = title;
  if (!label && extra.length) {
    if (inGroup) label = extra.filter(w => !/^(lines|wrap|expandable|twoslash|showLineNumbers|copy|noCopy|highlight|live|numberLines)$/i.test(w)).join(' ');
    else label = extra.find(w => /[./]/.test(w) && /^[\w@~./-]+$/.test(w)) || '';
  }
  const out = [];
  if (label) out.push(BLANK(), { t: 'line', s: `${it.indent}**${label}**` }, BLANK());
  out.push({ ...it, info: lang });
  return out;
}

/** Lines of a component's children that are only MDX expressions like `{Name}` or `{ "text" }`. */
function codeFromExpressions(children, consts, stats) {
  const parts = [];
  for (const c of children) {
    if (c.t !== 'line') return null;
    const t = c.s.trim();
    if (!t) continue;
    const m = /^\{([\s\S]*)\}$/.exec(t);
    if (!m) return null;
    const v = evalStringExpr(m[1], consts);
    if (v === null) { stats.unresolved++; parts.push(t); continue; }
    parts.push(v);
  }
  return parts.length ? parts.join('') : null;
}

function renderChildren(children, ctx) {
  const out = [];
  for (const c of children) {
    if (c.t === 'line') out.push(c);
    else if (c.t === 'fence') out.push(...(ctx.inGroup ? renderFence(c, ctx) : renderFence(c, { inGroup: false })));
    else if (c.t === 'comp') out.push(...renderComp(c, ctx));
  }
  return out;
}

function quoteItems(items) {
  const out = [];
  for (const it of items) {
    if (it.t === 'line') { out.push({ t: 'line', s: it.s.trim() ? `> ${it.s}` : '>', quoted: true }); continue; }
    // A fence inside a callout: keep it a fence, prefixed. Its content is untouched.
    out.push({ t: 'line', s: `> ${it.indent}${it.marker}${it.info}`, quoted: true, raw: true });
    for (const l of it.body) out.push({ t: 'line', s: l ? `> ${l}` : '>', quoted: true, raw: true });
    out.push({ t: 'line', s: `> ${it.close ?? it.indent + it.marker}`, quoted: true, raw: true });
  }
  return out;
}

function renderComp(node, ctx) {
  const key = simpleName(node.name);
  const { stats, consts, url } = ctx;
  stats.components++;
  const inGroup = CODE_GROUP.test(key) || (node.container && key === 'codegroup');
  const childCtx = { ...ctx, inGroup };

  // <CodeBlock language="py" filename="x">{Name}</CodeBlock>: resolve the expression.
  const exprCode = node.children.length ? codeFromExpressions(node.children, consts, stats) : null;
  if (exprCode !== null) {
    const lang = attrText(node.attrs.language || node.attrs.lang).toLowerCase().replace(/[^\w#+.-]/g, '');
    const label = labelOf(node.attrs);
    const out = [BLANK()];
    if (label) out.push({ t: 'line', s: `**${label}**` }, BLANK());
    const code = exprCode.replace(/\n$/, '');
    out.push({ t: 'fence', indent: '', marker: code.includes('```') ? '~~~~' : '```', info: lang, body: code.split('\n'), close: code.includes('```') ? '~~~~' : '```' });
    out.push(BLANK());
    stats.resolved++;
    return out;
  }

  let body = trimBlankItems(dedentItems(renderChildren(node.children, childCtx)));
  if (node.selfClosing || body.length === 0) {
    // Self-closing or empty components render UI (a TOC, a button); a link card keeps its link.
    const label = labelOf(node.attrs);
    const href = attrText(node.attrs.href);
    if (label && href) return [BLANK(), { t: 'line', s: `**[${label}](${absolutize(href, url)})**` }, BLANK()];
    if (label && !node.selfClosing) return [BLANK(), { t: 'line', s: `**${label}**` }, BLANK()];
    stats.dropped++;
    return [];
  }

  // Callouts → GitHub alerts.
  let kind = CALLOUT_KIND[key];
  if (CALLOUT_GENERIC.has(key) || (node.container && kind)) {
    for (const a of CALLOUT_TYPE_ATTRS) {
      const v = simpleName(attrText(node.attrs[a]) || '_');
      if (CALLOUT_KIND[v]) { kind = CALLOUT_KIND[v]; break; }
    }
  }
  if (kind && !(key === 'alert' && node.container)) {
    const title = labelOf(node.attrs);
    const inner = title ? [{ t: 'line', s: `**${title}**` }, BLANK(), ...body] : body;
    stats.callouts++;
    return [BLANK(), { t: 'line', s: `> [!${kind}]`, quoted: true }, ...quoteItems(inner), BLANK()];
  }

  // `::: details Title` / <details>-like components: summary in bold, content kept.
  // Labelled items (tabs, steps, accordions, cards, code blocks): bold label first.
  let label = labelOf(node.attrs);
  const field = FIELD_ATTRS.map(k => attrText(node.attrs[k])).find(Boolean);
  if (field) {
    const type = attrText(node.attrs.type);
    const bits = [`**${field}**`];
    if (type) bits.push(`\`${type}\``);
    for (const flag of ['required', 'optional', 'deprecated']) if (node.attrs[flag] === true) bits.push(flag);
    const dflt = attrText(node.attrs.default);
    if (dflt) bits.push(`(default: \`${dflt}\`)`);
    return [BLANK(), { t: 'line', s: bits.join(' ') }, BLANK(), ...body, BLANK()];
  }
  if (label) {
    const href = attrText(node.attrs.href);
    const head = href ? `**[${label}](${absolutize(href, url)})**` : `**${label}**`;
    return [BLANK(), { t: 'line', s: head }, BLANK(), ...body, BLANK()];
  }
  // Wrappers (Tabs, Steps, Columns, Frame, Intro, unknown components): unwrapped.
  return [BLANK(), ...body, BLANK()];
}

// ─── inline cleanup ──────────────────────────────────────────────────────────

const HEADING = /^(#{1,6})([ \t]+)(.*?)[ \t]*$/;

/** Resolve a link target against the page URL; source-relative `.md` targets point at the page. */
export function absolutize(dest, pageUrl) {
  if (!pageUrl || !dest) return dest;
  const d = dest.trim();
  if (!d || d.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(d)) return dest;
  let u;
  try { u = new URL(d, pageUrl); } catch { return dest; }
  let page;
  try { page = new URL(pageUrl); } catch { return dest; }
  if (u.origin === page.origin && /\.mdx?$/i.test(u.pathname) && !/\.mdx?$/i.test(page.pathname)) {
    u.pathname = u.pathname.replace(/\/index\.mdx?$/i, '/').replace(/\.mdx?$/i, '');
  }
  return u.href;
}

// [text](dest "title") and ![alt](dest) — dest without spaces, one level of parens.
const LINK_DEST = /(\]\()(\s*<?)([^()\s<>]*(?:\([^()\s]*\)[^()\s<>]*)*)(>?(?:\s+"[^"\n]*")?\s*\))/g;

function fixLinks(s, url, stats) {
  let out = s.replace(LINK_DEST, (m, a, b, dest, c) => {
    const abs = absolutize(dest, url);
    if (abs !== dest) stats.links++;
    return a + b + abs + c;
  });
  out = out.replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/, (m, a, dest) => a + absolutize(dest, url));
  out = out.replace(/\b(href|src)=(["'])([^"']*)\2/g, (m, k, q, v) => `${k}=${q}${absolutize(v, url)}${q}`);
  return out;
}

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

const PERMALINK = /[ \t]*\[(?:¶|#|\u200b|\s*)\]\(#[^)\s]*(?:\s+"[^"\n]*")?\)/g;

function cleanInline(s, ctx) {
  const { stats, isMdx, url } = ctx;
  // Code spans are set aside so nothing below edits them, while patterns may
  // still span them (`<CodeStep>`x` function</CodeStep>`).
  let { text: x, restore } = protectCodeSpans(s.replace(/\u0000/g, ''));
  if (isMdx) {
    x = x.replace(/\{\/\*[\s\S]*?\*\/\}/g, () => { stats.comments++; return ''; });
    // Inline components: <X a="b">text</X> → text; <X … /> → ''.
    let prev;
    do {
      prev = x;
      x = x.replace(/<([A-Z][\w]*(?:\.[A-Za-z]\w*)*)(?:\s(?:[^<>{}]|\{[^{}]*\})*)?>([^<]*?)<\/\1\s*>/g, (m, n, inner) => { stats.inline++; return inner; });
    } while (x !== prev);
    x = x.replace(/<([A-Z][\w]*(?:\.[A-Za-z]\w*)*)(?:\s(?:[^<>{}]|\{[^{}]*\})*)?\/>/g, () => { stats.inline++; return ''; });
  }
  // Empty anchors (`<span id="x" />`, `<a name="x"></a>`) are invisible link targets.
  x = x.replace(/<(a|span|div)\b[^<>]*\b(?:id|name)=["'][^"']*["'][^<>]*?(?:\/>|>\s*<\/\1>)/gi, () => { stats.permalinks++; return ''; });
  // Permalink residue: `[¶](#id)`, `[#](#id "Link to…")`, zero-width anchors, headerlink <a>, bare ¶.
  x = x.replace(PERMALINK, () => { stats.permalinks++; return ''; });
  x = x.replace(/<a\b[^>]*>\s*(?:¶|#|\u200b)?\s*<\/a>/gi, () => { stats.permalinks++; return ''; });
  x = x.replace(/[ \t]*¶/g, () => { stats.permalinks++; return ''; });
  // A lone <img> → markdown image.
  x = x.replace(/<img\b([^<>]*?)\/?>/gi, (m, a) => {
    const src = /\bsrc=["']([^"']+)["']/i.exec(a)?.[1];
    if (!src || /^data:/i.test(src)) return m;
    const alt = /\balt=["']([^"']*)["']/i.exec(a)?.[1] ?? '';
    return `![${alt}](${src})`;
  });
  // An escaped ampersand in front of an entity is a double-encoding slip: `\&#39;`.
  x = x.replace(/\\&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (ENTITY[k]) return ENTITY[k];
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    return String.fromCodePoint(parseInt(k.slice(1), 10));
  });
  return restore(fixLinks(x, url, stats));
}

/** Heading text with id syntax and permalink residue removed; collects explicit ids. */
function cleanHeading(line, ctx) {
  const m = HEADING.exec(line);
  if (!m) return null;
  let text = m[3];
  let id = null;
  const idPatterns = [
    /[ \t]*\{\/\*\s*([\w:.-]+)\s*\*\/\}[ \t]*$/, // MDX comment id (React docs)
    /[ \t]*\{#([\w:.-]+)(?:[ \t][^}]*)?\}[ \t]*$/, // {#id} (kramdown, pandoc, VitePress, Docusaurus)
    /\[\[([\w:.-]+)\]\][ \t]*$/, // [[id]] (HF doc-builder)
  ];
  for (const re of idPatterns) {
    const im = re.exec(text);
    if (im) { id = im[1]; text = text.slice(0, im.index); break; }
  }
  text = text.replace(/[ \t]+\\?#+[ \t]*$/, '').replace(/[ \t]*\[(?:¶|#|\u200b|\s*)\]\(#[^)\s]*\)[ \t]*$/, '');
  text = cleanInline(text, ctx).replace(/[ \t]+$/, '');
  if (id) {
    ctx.stats.headingIds++;
    ctx.headingIds?.push({ level: m[1].length, text, id });
  }
  return `${m[1]}${m[2]}${text}`;
}

/** Leading/trailing blocks that only point the reader at an llms.txt index. */
function stripIndexNotes(lines, stats) {
  const isIndexPointer = (text) => /llms(?:-full)?\.txt/i.test(text);
  const blocks = []; // [start, end) runs of non-blank lines
  for (let i = 0; i < lines.length;) {
    if (isBlank(lines[i])) { i++; continue; }
    let j = i;
    while (j < lines.length && !isBlank(lines[j])) j++;
    blocks.push([i, j]);
    i = j;
  }
  const drop = new Set();
  // Leading: blocks before the first heading.
  for (const [a, b] of blocks) {
    if (/^#{1,6}\s/.test(lines[a])) break;
    const text = lines.slice(a, b).join('\n');
    if (isIndexPointer(text) && text.length < 600) { for (let k = a; k < b; k++) drop.add(k); stats.preamble++; }
  }
  // Trailing: last block, plus a heading-only block and a rule right before it.
  const last = blocks[blocks.length - 1];
  if (last) {
    const text = lines.slice(last[0], last[1]).join('\n');
    if (isIndexPointer(text) && text.length < 400 && !/^\s*(`{3,}|~{3,})/.test(text)) {
      for (let k = last[0]; k < last[1]; k++) drop.add(k);
      stats.postamble++;
      let bi = blocks.length - 2;
      if (bi >= 0 && blocks[bi][1] - blocks[bi][0] === 1 && /^#{1,6}\s/.test(lines[blocks[bi][0]])) {
        drop.add(blocks[bi][0]);
        bi--;
      }
      if (bi >= 0 && blocks[bi][1] - blocks[bi][0] === 1 && /^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[blocks[bi][0]])) drop.add(blocks[bi][0]);
    }
  }
  return drop.size ? lines.filter((_, k) => !drop.has(k)) : lines;
}

/** Does the text (outside fences) use MDX syntax? */
export function detectMdx(lines) {
  let esm = 0, jsx = 0, comments = 0;
  for (let i = 0; i < lines.length; i++) {
    const open = fenceOpen(lines[i]);
    if (open) {
      let j = i + 1;
      while (j < lines.length && !isFenceClose(lines[j], open)) j++;
      i = j;
      continue;
    }
    const l = lines[i];
    if (/^(import\s+[\w{*][^\n]*\bfrom\s+['"]|import\s+['"]|export\s+(const|let|default|function)\b)/.test(l)) esm++;
    if (/^\s*<\/?[A-Z][\w.]*(?:\s[^<>]*)?\/?>\s*$/.test(l) || /^\s*<[A-Z][\w.]*(\s|$)/.test(l)) jsx++;
    if (/\{\/\*.*\*\/\}/.test(l)) comments++;
  }
  return { isMdx: esm > 0 || jsx >= 2 || comments > 0, esm, jsx, comments };
}

/**
 * Light cleanup of owner-published markdown. Code fence *content* is never
 * edited (fences inside components lose only the component's indentation;
 * their info string is reduced to the language, a title moving to a bold label).
 *
 * @param {string} md
 * @param {{url?: string, headingIds?: Array, stats?: object}} [opts]
 *   headingIds, if given, receives `{level, text, id}` for headings that carried
 *   an explicit id (`{#id}`, `{/*id*\/}`, `[[id]]`).
 * @returns {string}
 */
/**
 * Code inside a fence is literal, so an HTML entity there shows as `&quot;`. A block
 * whose quotes and angle brackets appear ONLY as entities was HTML-escaped twice by
 * the site (developers.facebook.com's `.md`: `curl -F &#039;adset_id=&quot;…&quot;&#039;`)
 * and is decoded. A block with any literal `"`, `'`, `<` or `>` is left as it is: its
 * entities may be the point (code about escaping).
 */
const CODE_ENTITY_RE = /&(quot|#0*34|#x0*22|apos|#0*39|#x0*27|lt|#0*60|gt|#0*62);/i;
const CODE_ENTITIES = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&', '#123': '{', '#125': '}', '#124': '|', '#96': '`', nbsp: '\u00a0' };
export function unescapeCodeEntities(lines, stats = null) {
  const text = lines.join('\n');
  if (!CODE_ENTITY_RE.test(text) || /["'<>]/.test(text)) return lines;
  if (stats) stats.codeUnescaped = (stats.codeUnescaped || 0) + 1;
  return lines.map(l => l.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k in CODE_ENTITIES) return CODE_ENTITIES[k];
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return m;
  }));
}

export function cleanOwnerMarkdown(md, opts = {}) {
  return cleanWithStats(md, opts).markdown;
}

export function cleanWithStats(md, { url, headingIds } = {}) {
  const stats = {
    esm: 0, components: 0, callouts: 0, dropped: 0, inline: 0, comments: 0, resolved: 0, unresolved: 0,
    preamble: 0, postamble: 0, permalinks: 0, links: 0, headingIds: 0, isMdx: false,
  };
  const text = String(md ?? '').replace(/\r\n?/g, '\n');
  const { block, body } = splitFrontMatter(text);
  let lines = body.split('\n');
  const mdx = detectMdx(lines);
  stats.isMdx = mdx.isMdx;
  let consts = {};
  if (mdx.isMdx) ({ lines, consts } = stripEsm(lines, stats));

  const ctx = { stats, consts, url, isMdx: mdx.isMdx, headingIds };
  const tree = parseTree(toItems(lines), mdx.isMdx);
  const items = renderChildren(tree.children, { ...ctx, inGroup: false });

  const out = [];
  for (const it of items) {
    if (it.t === 'fence') {
      out.push(`${it.indent}${it.marker}${it.info}`, ...it.body, it.close ?? `${it.indent}${it.marker}`);
      continue;
    }
    if (it.raw) { out.push(it.s); continue; }
    let s = it.s;
    const qm = it.quoted ? /^(>+ ?)/.exec(s) : null;
    const prefix = qm ? qm[1] : '';
    let rest = s.slice(prefix.length);
    // Stray closing tags / lone JSX lines left over from unbalanced markup.
    if (mdx.isMdx && /^\s*<\/[A-Z][\w.]*\s*>\s*$/.test(rest)) { stats.dropped++; continue; }
    // Layout wrappers on a line of their own (`<div style=…>`, `</div>`): the
    // content between them stays, the box goes.
    if (/^\s*<\/?(div|span|section|main|article|header|footer|nav|aside|center)\b(?:[^<>{}]|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})*>\s*$/i.test(rest)) { stats.dropped++; continue; }
    const h = cleanHeading(rest, ctx);
    rest = h !== null ? h : cleanInline(rest, ctx);
    out.push(prefix + rest);
  }

  let result = stripIndexNotes(out, stats);
  // Collapse runs of blank lines (outside fences) left by removed blocks; decode code
  // blocks the site HTML-escaped twice (every fence, nested in lists or not).
  const collapsed = [];
  let fence = null;
  let codeAt = -1;
  for (const l of result) {
    if (fence) {
      if (isFenceClose(l, fence)) {
        const body = collapsed.splice(codeAt);
        collapsed.push(...unescapeCodeEntities(body, stats), l);
        fence = null;
      } else collapsed.push(l);
      continue;
    }
    const o = fenceOpen(l);
    if (o) { fence = o; collapsed.push(l); codeAt = collapsed.length; continue; }
    if (isBlank(l) && collapsed.length && isBlank(collapsed[collapsed.length - 1])) continue;
    collapsed.push(isBlank(l) ? '' : l.replace(/[ \t]+$/, (m) => (/ {2}$/.test(m) ? m : '')));
  }
  while (collapsed.length && isBlank(collapsed[0])) collapsed.shift();
  while (collapsed.length && isBlank(collapsed[collapsed.length - 1])) collapsed.pop();
  // The site renders the front-matter title as the page's H1; the source has none.
  const title = block && /^title:[ \t]*(.+)$/m.exec(block)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (title && !/^[>|]/.test(title) && !hasH1(collapsed)) {
    collapsed.unshift(`# ${title}`, '');
    stats.titleAdded = 1;
  }
  return { markdown: block + collapsed.join('\n') + '\n', stats };
}

function hasH1(lines) {
  let fence = null;
  for (const l of lines) {
    if (fence) { if (isFenceClose(l, fence)) fence = null; continue; }
    const o = fenceOpen(l);
    if (o) { fence = o; continue; }
    if (/^#[ \t]+\S/.test(l)) return true;
  }
  return false;
}

// ─── assessment ──────────────────────────────────────────────────────────────

/** Markup-free, case-folded words — for comparing texts, not for output. */
export function plainWords(md) {
  let s = String(md || '').normalize('NFKC');
  s = s.replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1').replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1');
  s = s.replace(/<\/?[a-zA-Z][\w:-]*(?:\s[^<>]*)?\/?>/g, ' ');
  s = s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, ' ');
  s = s.replace(/[\u200b-‍﻿]/g, '');
  s = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  return s.split(' ').filter(Boolean);
}

function shingles(words, n = 3) {
  const set = new Set();
  for (let i = 0; i + n <= words.length; i++) set.add(words.slice(i, i + n).join(' '));
  if (words.length && words.length < n) set.add(words.join(' '));
  return set;
}

/** Share of `a`'s word trigrams that also occur in `b` (null when `a` has none). */
export function coverage(aWords, bSet) {
  const a = shingles(aWords);
  if (!a.size) return null;
  let hit = 0;
  for (const t of a) if (bSet.has(t)) hit++;
  return hit / a.size;
}

/**
 * Fingerprints of an HTML page converted to markdown by something other than
 * the author (a CDN edge feature, a generic converter): the site template and
 * HTML-only artefacts survive. Each is a count; `score` is how many kinds occur.
 */
export function conversionFingerprints(md) {
  const { body } = splitFrontMatter(String(md || '').replace(/\r\n?/g, '\n'));
  const lines = body.split('\n');
  const prose = [];
  for (let i = 0; i < lines.length; i++) {
    const open = fenceOpen(lines[i]);
    if (open) { let j = i + 1; while (j < lines.length && !isFenceClose(lines[j], open)) j++; i = j; continue; }
    prose.push(lines[i]);
  }
  const text = prose.join('\n');
  const firstH1 = prose.findIndex(l => /^#\s/.test(l));
  const beforeH1 = firstH1 > 0 ? prose.slice(0, firstH1).filter(l => l.trim()) : [];
  const h1s = prose.filter(l => /^#\s/.test(l)).map(l => l.replace(/^#\s+/, '').replace(/[\s\\#¶]+$/, '').trim().toLowerCase());
  const signals = {
    // "[Skip to main content](#…)", "Back to top", keyboard hints — page chrome.
    skipLinks: (text.match(/^\s*\[?(skip to (main )?content|back to top|jump to content)\b/gim) || []).length,
    // Headings ending in a permalink glyph: `## Title ¶`, `## Title \#`, `[#](#id)`.
    headingPermalinks: prose.filter(l => /^#{1,6}\s.*(¶|\\#|\[(#|¶|\u200b)?\]\(#[^)]*\))\s*$/.test(l)).length,
    // HTML block structures a markdown author would not write (definition lists, layout).
    rawHtmlBlocks: (text.match(/^\s*<(dl|dt|dd|div|section|article|nav|aside|span|table)\b[^>]*>/gim) || []).length,
    // Link-list breadcrumbs / navigation before the title.
    navBeforeTitle: beforeH1.length >= 3 && beforeH1.filter(l => /^\s*([-*]\s+)?\[[^\]]+\]\([^)]+\)\s*$|^\s*[-*]\s+\S{1,30}\s*$/.test(l)).length >= 3 ? 1 : 0,
    // The same title twice (page header + article header).
    duplicateTitle: h1s.length >= 2 && new Set(h1s).size < h1s.length ? 1 : 0,
  };
  const score = Object.values(signals).filter(v => v > 0).length;
  return { score, signals };
}

/** Redirect / moved stubs: short text whose point is a link elsewhere. */
function redirectStub(body) {
  const compact = body.replace(/\s+/g, ' ').trim();
  if (compact.length > 600) return false;
  return /^(redirecting|you are being redirected|this page (has )?moved|moved (permanently|to)|page moved|continue to|click here if you are not redirected)/i.test(compact.replace(/^[#>*\s]+/, ''))
    || /\bhttp-equiv=["']?refresh/i.test(body);
}

/** v1's structural check: enough markdown indicators to be a markdown document. */
export function looksLikeMarkdown(text) {
  const t = String(text || '').trim();
  if (t.length < 50) return false;
  if (/^(<!doctype|<html|<head|<body|<\?xml)/i.test(t) || t.startsWith('%PDF-')) return false;
  if (/^[[{]/.test(t)) {
    try { JSON.parse(t); return false; } catch { /* not JSON */ }
  }
  const indicators = [
    /^#{1,6}\s+\S/m, /^\s*(`{3,}|~{3,})/m, /^\s*[-*+]\s+\S/m, /^\s*\d+[.)]\s+\S/m,
    /\[[^\]\n]+\]\([^)\n]+\)/, /\*\*[^*\n]+\*\*/, /^>\s/m, /^\|.*\|\s*$/m, /^\s*([-*_])(\s*\1){2,}\s*$/m,
    /^---\n[\s\S]*?\n---/,
  ];
  const hits = indicators.filter(re => re.test(t)).length;
  // A heading is the strongest single indicator (prose pages may have nothing else).
  return hits >= 2 || (hits === 1 && (indicators[0].test(t) || t.length < 500));
}

/** Words of a title that identify the page (≥ 3 letters). */
const titleWords = (s) => plainWords(s).filter(w => w.length >= 3);

function identityScore(title, cleanedBody) {
  if (!title) return null;
  const words = titleWords(title);
  if (!words.length) return null;
  const hm = /^#{1,2}[ \t]+(.+)$/m.exec(cleanedBody);
  const head = new Set(plainWords(hm ? hm[1] : cleanedBody.slice(0, 400)));
  const all = new Set(plainWords(cleanedBody.slice(0, 20000)));
  const inHead = words.filter(w => head.has(w)).length / words.length;
  const inBody = words.filter(w => all.has(w)).length / words.length;
  return Math.max(inHead, 0.8 * inBody);
}

/**
 * Thresholds (see eval/results/OWNER_LOG.md for the measurements behind them).
 *   minRecall      share of the rendered page's word trigrams the markdown must contain
 *   minPrecision   share of the markdown's word trigrams that must be on the rendered page
 *   maxCdnScore    conversion fingerprints tolerated (0–5 kinds)
 *   maxProseCodeRatio  a "page" that is one giant fence (an OpenAPI/YAML dump) is data, not the doc
 */
export const OWNER_THRESHOLDS = {
  minRecall: 0.75,
  minPrecision: 0.60,
  minHtmlShare: 0.25,
  maxCdnScore: 1,
  minIdentity: 0.5,
  maxCodeShare: 0.85,
};

/**
 * Can this owner-served markdown stand in for the page?
 *
 * @param {string} md  the markdown as served
 * @param {object} o
 * @param {string} o.url             the page URL
 * @param {'accept'|'variant'} [o.how]  how it was obtained
 * @param {string} [o.contentType]
 * @param {object} [o.headers]       response headers (lower-case keys)
 * @param {string} [o.htmlText]      text/markdown of the rendered page's content, if available
 * @param {string} [o.title]         the rendered page's title / H1, if known
 * @param {object} [o.thresholds]
 * @returns {{use: boolean, reason: string, quality: object, markdown?: string}}
 *   `markdown` is the cleaned markdown when `use` is true.
 */
export function assessOwnerMarkdown(md, o = {}) {
  const th = { ...OWNER_THRESHOLDS, ...(o.thresholds || {}) };
  const text = String(md ?? '').replace(/\r\n?/g, '\n');
  const quality = { chars: text.length };
  const no = (reason) => ({ use: false, reason, quality });

  if (!text.trim()) return no('empty');
  const ct = String(o.contentType || '').toLowerCase();
  if (/html|json|xml|pdf|image\//.test(ct) && !/markdown/.test(ct)) return no(`content-type ${ct.split(';')[0]}`);
  if (!looksLikeMarkdown(text)) return no('not markdown');

  const { body } = splitFrontMatter(text);
  if (redirectStub(body)) return no('redirect stub');
  const bad = detectBadPage(text);
  if (bad) return no(`${bad.reason}: ${bad.detail}`);

  // Edge conversions: the text's own fingerprints decide. Response headers are
  // recorded as a hint only — the eval recording kept no headers, so a header
  // rule could not be measured, and many owner-written sites sit behind the
  // same CDNs.
  const fp = conversionFingerprints(text);
  quality.cdn = fp;
  const hdr = o.headers || {};
  quality.edgeHeader = !!(hdr['x-markdown-tokens'] || /markdown/i.test(hdr['x-content-source'] || '') || /cloudflare/i.test(hdr.server || '') && !/^---\n/.test(text));

  const { markdown: cleaned, stats } = cleanWithStats(text, { url: o.url });
  quality.clean = stats;
  const cleanedBody = splitFrontMatter(cleaned).body;

  // Unresolved placeholders: expressions left in code (`{PyConnect}`), doc-builder
  // directives (`[[autodoc]] Foo`).
  const directives = (cleanedBody.match(/^\s*\[\[[\w-]+\]\]\s+\S+/gm) || []).length;
  quality.unresolved = stats.unresolved + directives;

  // How much of the body is one kind of code (an OpenAPI/YAML dump rendered by the site).
  const lines = cleanedBody.split('\n');
  let codeChars = 0, maxFence = 0;
  for (let i = 0; i < lines.length; i++) {
    const open = fenceOpen(lines[i]);
    if (!open) continue;
    let j = i + 1, n = 0;
    while (j < lines.length && !isFenceClose(lines[j], open)) n += lines[j++].length + 1;
    codeChars += n;
    maxFence = Math.max(maxFence, n);
    i = j;
  }
  quality.codeShare = cleanedBody.length ? codeChars / cleanedBody.length : 0;
  quality.largestFenceShare = cleanedBody.length ? maxFence / cleanedBody.length : 0;

  quality.identity = identityScore(o.title, cleanedBody);

  let htmlFailed = false;
  if (o.htmlText) {
    const ownerWords = plainWords(cleanedBody);
    const htmlWords = plainWords(o.htmlText);
    quality.ownerWords = ownerWords.length;
    quality.htmlWords = htmlWords.length;
    quality.recall = coverage(htmlWords, shingles(ownerWords));
    quality.precision = coverage(ownerWords, shingles(htmlWords));
    // The HTML route itself produced next to nothing (a client-side error, a
    // 500 page, an empty shell): coverage against it means nothing.
    htmlFailed = htmlWords.length < th.minHtmlShare * ownerWords.length || !!detectBadPage(o.htmlText);
    quality.htmlFailed = htmlFailed;
  }

  if (fp.score > th.maxCdnScore) return no(`converted from HTML (${Object.entries(fp.signals).filter(([, v]) => v).map(([k]) => k).join(', ')})`);
  if (quality.identity !== null && quality.identity < th.minIdentity) return no(`title mismatch (${quality.identity.toFixed(2)})`);
  // A site's markdown twin that is one big code block is a dump of what its HTML page
  // renders (an OpenAPI spec); the HTML is the better copy. A URL that IS markdown has
  // no better copy: rendering it only shows the same text in a <pre>.
  if (o.how !== 'direct' && quality.largestFenceShare > th.maxCodeShare) return no(`one code block is ${(100 * quality.largestFenceShare).toFixed(0)}% of the page`);
  if (quality.unresolved > 0) return no(`${quality.unresolved} unresolved placeholder(s)`);
  // Completeness: the markdown must carry (nearly) everything the rendered page
  // shows. Low precision alone is fine — the markdown may hold more than the
  // HTML route recovered (hidden panels, code tabs); low recall is not.
  if (quality.recall != null && !htmlFailed && quality.recall < th.minRecall) {
    return no(quality.precision < th.minPrecision
      ? `not this page: recall ${quality.recall.toFixed(2)}, precision ${quality.precision.toFixed(2)}`
      : `incomplete: recall ${quality.recall.toFixed(2)} of the rendered page`);
  }
  // Code is the most valuable part of a page. When our own conversion of the
  // page has the same code block, it must match byte for byte apart from the
  // text itself: a CDN auto-conversion (docs.pytorch.org) collapsed Python's
  // 4-space indentation to 1 space while keeping every word.
  if (o.htmlText && !htmlFailed) {
    const mangled = codeWhitespaceMismatches(cleaned, o.htmlText);
    quality.codeMismatch = mangled;
    if (mangled > 0) return no(`${mangled} code block(s) differ from the page in whitespace/indentation`);
  }
  return { use: true, reason: htmlFailed ? 'ok (rendered-page text too small to compare)' : 'ok', quality, markdown: cleaned };
}

/** Fenced code bodies of a markdown text (fence indentation removed, CommonMark-style). */
function fenceBodies(md) {
  const lines = md.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const open = fenceOpen(lines[i]);
    if (!open) continue;
    let j = i + 1;
    while (j < lines.length && !isFenceClose(lines[j], open)) j++;
    const ind = open.indent.length;
    out.push(lines.slice(i + 1, j).map(l => l.slice(Math.min(ind, /^[ \t]*/.exec(l)[0].length))).join('\n').replace(/\s+$/, ''));
    i = j;
  }
  return out;
}

/**
 * How many owner code blocks match one of our blocks word for word but with
 * their indentation collapsed (less leading whitespace than ours). Blocks with no counterpart
 * are not counted — the owner file may legitimately hold more examples.
 */
export function codeWhitespaceMismatches(ownerMd, htmlMd) {
  const squash = (t) => t.replace(/\s+/g, '');
  const ours = new Map();
  for (const b of fenceBodies(htmlMd)) if (b.trim()) ours.set(squash(b), b);
  let n = 0;
  for (const b of fenceBodies(ownerMd)) {
    const twin = ours.get(squash(b));
    if (twin !== undefined && twin !== b && b.includes('\n')) {
      // Indentation is what matters (Python, YAML). Only a collapse counts: when
      // the owner has LESS than our conversion. The reverse happens when a
      // site's DOM strips indentation that its own markdown keeps (lancedb).
      const indent = (t) => t.split('\n').reduce((a, l) => a + (l.trim() ? /^[ \t]*/.exec(l)[0].replace(/\t/g, '    ').length : 0), 0);
      if (indent(b) < indent(twin)) n++;
    }
  }
  return n;
}
