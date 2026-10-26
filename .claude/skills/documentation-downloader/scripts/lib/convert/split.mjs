/**
 * Large pages: split a page too big for one Read into addressable files along
 * its own heading structure.
 *
 *   index                every part: heading path, size, URL#anchor (+ its sections);
 *                        the store writes it at the page's own path (store/split.mjs)
 *   <slug>.md            one part: `Source: <url>#<anchor>` + a verbatim slice of the body
 *                        (the store writes these into `<page>.parts/`)
 *
 * Invariant: the parts' bodies, concatenated in order, are the original body
 * byte for byte — splitting only chooses where to cut, it never edits.
 *
 * Where to cut: at heading lines only, never inside a code fence or an HTML
 * block (<table>, <details>, <pre>…), and GFM tables have no headings inside.
 * The shallowest heading level present is used first; a section that is still
 * too big is split again at its own sub-headings, recursively. Small adjacent
 * sections are then packed together (up to `targetTokens`) so a page with
 * thousands of tiny entries does not become thousands of files — the index,
 * not the file list, is the table of contents. A section that cannot be cut
 * (one giant table or code block, no sub-headings) stays whole; the index
 * says so and gives line windows to read it in.
 */

import { splitFrontMatter, parseFrontMatter, serializeFrontMatter } from '../store/frontmatter.mjs';
import { fenceOpen, isFenceClose } from './mdscan.mjs';

/** Conservative token estimate (code and markup tokenize denser than prose). */
export function estimateTokens(text) {
  return Math.ceil(text.length / 3.5);
}

// Column 0 only: an indented heading belongs to a list item (cutting there would
// break the list), and converters write top-level headings unindented.
const ATX = /^(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HTML_BLOCK_OPEN = /^[ \t]*<(table|details|div|dl|section|pre|figure|aside|blockquote|ul|ol|article|nav|form|fieldset|script|style|textarea)\b/i;

/**
 * Per line: is it a heading we may cut before? Fences and HTML blocks are
 * opaque. An HTML block that never closes ends at its first blank line
 * (CommonMark's rule for such blocks).
 * @returns {Array<{line: number, level: number, text: string}>}
 */
const LIST_ITEM = /^([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const LIST_ITEM_HEADING = /^(?:[-*+]|\d{1,9}[.)])[ \t]+(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const INDENTED_ATX = /^[ \t]+(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

export function findHeadings(lines) {
  const headings = [];
  const n = lines.length;
  // Headings inside a top-level list item (`* #### topic`, or indented under
  // the item) are real section titles on sites that render reference entries as
  // list items; the cut goes before the item, which keeps the list valid.
  let item = -1;          // start line of the current top-level list item
  let itemHasHeading = false;
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    if (line && !/^[ \t]/.test(line)) {
      if (LIST_ITEM.test(line)) { item = i; itemHasHeading = false; } else item = -1;
    }
    const open = fenceOpen(line);
    if (open) {
      let j = i + 1;
      while (j < n && !isFenceClose(lines[j], open)) j++;
      i = j;
      continue;
    }
    const hb = HTML_BLOCK_OPEN.exec(line);
    if (hb) {
      const tag = hb[1].toLowerCase();
      const openRe = new RegExp(`<${tag}\\b`, 'gi');
      const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
      let depth = 0;
      let j = i;
      for (; j < n; j++) {
        const l = lines[j].replace(/`[^`\n]*`/g, '');
        depth += (l.match(openRe) || []).length - (l.match(closeRe) || []).length;
        if (depth <= 0) break;
      }
      if (j >= n) { // never closed: the block ends at the first blank line
        j = i;
        while (j + 1 < n && lines[j + 1].trim()) j++;
      }
      i = j;
      continue;
    }
    const m = ATX.exec(line);
    if (m) {
      if (m[2] && m[2].trim()) headings.push({ line: i, level: m[1].length, text: m[2].trim() });
      else {
        // An empty heading whose text a converter pushed onto the next lines
        // (v1 caches: '##', '[\u200b', '](#installation)', 'Installation'): still a
        // section boundary; take its title and id from those lines.
        let text = '';
        let id = null;
        for (let j = i + 1; j < Math.min(n, i + 9) && !text; j++) {
          const l = lines[j].trim();
          if (/^(#|```|~~~|[-*+] |\d+[.)] |\|)/.test(l)) break;
          const a = /\]\(#([^)\s]+)\)/.exec(l);
          if (a) id = a[1];
          const plain = l.replace(/\[[\s\u200b]*\]?\(?#?[^)]*\)?/g, '').replace(/^[\[\]\s\u200b]+|[\[\]\s\u200b]+$/g, '');
          if (plain && !/^\]\(/.test(l)) text = plain;
        }
        if (text) headings.push({ line: i, level: m[1].length, text: id ? `${text} {#${id}}` : text });
      }
      continue;
    }
    if (item >= 0 && !itemHasHeading) {
      const lm = (i === item ? LIST_ITEM_HEADING : INDENTED_ATX).exec(line);
      if (lm && lm[2].trim()) {
        headings.push({ line: item, level: lm[1].length, text: lm[2].trim(), inList: true });
        itemHasHeading = true;
      }
    }
  }
  return headings;
}

// ─── anchors ─────────────────────────────────────────────────────────────────

/** Heading markdown → the text a reader sees. */
export function headingPlainText(md) {
  let s = String(md || '');
  // Permalink residue a converter may have left: [¶](#x), [#](…#x "Anchor link"), bare ¶.
  s = s.replace(/\[(?:¶|#|\u200b|\s*)\]\([^)]*\)/g, '').replace(/[¶\u200b]/g, '');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/`+([^`]*)`+/g, '$1');
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)/g, '$1$2');
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|>~<])/g, '$1');
  s = s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[e]);
  return s.replace(/\s+/g, ' ').trim();
}

/** GitHub's heading slug (github-slugger): lower-case, punctuation dropped, spaces → '-'. */
export function githubSlug(text) {
  return headingPlainText(text).toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** An id the heading declares itself: `{#id}`, `<a id="id">`, `<span id="id">`. */
function explicitId(text) {
  const m = /\{#([\w:.-]+)\}\s*$/.exec(text)
    || /<(?:a|span)\b[^>]*\b(?:id|name)=["']([^"']+)["']/i.exec(text)
    // the site's own permalink inside the heading: [¶](https://…/page#id)
    || /\[(?:¶|#|\u200b|\s*)\]\([^)#\s]*#([^)\s"]+)/.exec(text);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/**
 * Anchors for every heading, in page order, as GitHub would generate them
 * (duplicates get -1, -2 …), unless the heading carries an explicit id or one
 * is supplied in `ids` ([{text, id}] in page order, e.g. from cleanOwnerMarkdown).
 */
export function assignAnchors(headings, ids = []) {
  const seen = new Map();
  const supplied = new Map();
  for (const { text, id } of ids) {
    const k = headingPlainText(text);
    if (!supplied.has(k)) supplied.set(k, []);
    supplied.get(k).push(id);
  }
  for (const h of headings) {
    const plain = headingPlainText(h.text.replace(/\s*\{#[\w:.-]+\}\s*$/, ''));
    const given = explicitId(h.text) || supplied.get(plain)?.shift();
    if (given) { h.anchor = given; seen.set(given, (seen.get(given) ?? -1) + 1); h.title = plain; continue; }
    const base = githubSlug(h.text.replace(/\s*\{#[\w:.-]+\}\s*$/, ''));
    let slug = base;
    if (seen.has(base)) {
      let k = seen.get(base) + 1;
      while (seen.has(`${base}-${k}`)) k++;
      seen.set(base, k);
      slug = `${base}-${k}`;
    }
    seen.set(slug, seen.get(slug) ?? 0);
    h.anchor = slug;
    h.title = plain;
  }
  return headings;
}

/** A filesystem-safe file stem from an anchor/title. */
export function fileSlug(text, max = 60) {
  let s = String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^[-_.]+|[-_.]+$/g, '');
  if (s.length > max) s = s.slice(0, max).replace(/-[^-]*$/, '') || s.slice(0, max);
  return s || 'section';
}

// ─── splitting ───────────────────────────────────────────────────────────────

/**
 * @param {string} markdown  a page (front matter optional)
 * @param {object} [opts]
 * @param {string} [opts.url]           the page URL (parts get `Source: <url>#<anchor>`)
 * @param {number} [opts.maxTokens=25000]  a part never exceeds this unless it cannot be cut
 * @param {number} [opts.targetTokens]  packing target for small sections (default maxTokens/2)
 * @param {Array<{text,id}>} [opts.ids] explicit heading ids
 * @param {(s: string) => number} [opts.tokens]  token estimator
 * @returns {null | {index: {markdown: string}, parts: Array<{slug, anchor, title, path, markdown, body, lines, tokens, oversized, sections}>}}
 *   null when the page fits, or cannot be cut at all.
 */
export function splitLargePage(markdown, opts = {}) {
  const maxTokens = opts.maxTokens ?? 25000;
  const targetTokens = opts.targetTokens ?? Math.floor(maxTokens / 2);
  const tokensOf = opts.tokens ?? estimateTokens;
  const url = opts.url || null;

  const text = String(markdown ?? '');
  const { block: fmBlock, body } = splitFrontMatter(text);
  if (tokensOf(body) <= maxTokens) return null;

  // Lines keep their '\n' so slices concatenate back to the body exactly.
  const lines = body.split('\n');
  const starts = new Array(lines.length + 1);
  starts[0] = 0;
  for (let i = 0; i < lines.length; i++) starts[i + 1] = starts[i] + lines[i].length + (i < lines.length - 1 ? 1 : 0);
  const slice = (a, b) => body.slice(starts[a], starts[b]);
  // Sizes come from prefix sums: the default estimator is linear in characters;
  // a custom one is summed per line (close enough for choosing cut points).
  let sizeOf;
  if (opts.tokens) {
    const pre = new Float64Array(lines.length + 1);
    for (let i = 0; i < lines.length; i++) pre[i + 1] = pre[i] + tokensOf(lines[i] + '\n');
    sizeOf = (a, b) => pre[b] - pre[a];
  } else {
    sizeOf = (a, b) => Math.ceil((starts[b] - starts[a]) / 3.5);
  }

  const headings = assignAnchors(findHeadings(lines), opts.ids);
  const byLine = new Map(headings.map(h => [h.line, h]));

  // Cut [a, b) into chunks that fit, preferring shallow headings.
  const chunks = [];
  const cut = (a, b) => {
    if (a >= b) return;
    if (sizeOf(a, b) <= maxTokens) { chunks.push({ a, b }); return; }
    const own = byLine.get(a);
    const inner = headings.filter(h => h.line > a && h.line < b && (!own || h.level > own.level));
    if (!inner.length) { chunks.push({ a, b, oversized: true }); return; }
    const level = Math.min(...inner.map(h => h.level));
    const points = inner.filter(h => h.level === level).map(h => h.line);
    let prev = a;
    for (const p of points) { cut(prev, p); prev = p; }
    cut(prev, b);
  };
  cut(0, lines.length);

  // Pack adjacent chunks up to the target, never letting a shallower heading
  // hide inside a part that a deeper heading starts.
  const levelAt = (line) => byLine.get(line)?.level ?? 0; // 0 = lead text before any heading
  const packed = [];
  for (const c of chunks) {
    const last = packed[packed.length - 1];
    if (last && !last.oversized && !c.oversized
      && sizeOf(last.a, c.b) <= targetTokens
      && levelAt(c.a) >= levelAt(last.a)) {
      last.b = c.b;
    } else {
      packed.push({ ...c });
    }
  }
  if (packed.length < 2) return null;

  // Heading path of each part: the enclosing headings at its start + its own.
  const pathAt = (line) => {
    const stack = [];
    for (const h of headings) {
      if (h.line > line) break;
      while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
      stack.push(h);
    }
    return stack;
  };

  const used = new Set(['_index', 'index']);
  const { data: pageData } = parseFrontMatter(text);
  const pageTitle = (typeof pageData.title === 'string' && pageData.title) || headings.find(h => h.level === 1)?.title || headings[0]?.title || 'Page';

  const parts = packed.map((p, i) => {
    const partBody = slice(p.a, p.b);
    const own = byLine.get(p.a) || headings.find(h => h.line >= p.a && h.line < p.b) || null;
    const inPart = headings.filter(h => h.line >= p.a && h.line < p.b);
    const anchor = own ? own.anchor : null;
    // A packed part spans sibling sections: "First … Last".
    const lastTop = own ? inPart.filter(h => h.level === own.level && h !== own).pop() : null;
    const title = own ? (lastTop && lastTop.title !== own.title ? `${own.title} … ${lastTop.title}` : own.title) : (i === 0 ? pageTitle : `Part ${i + 1}`);
    const path = (own ? pathAt(own.line) : pathAt(p.a)).map(h => h.title);
    if (own && path.length) path[path.length - 1] = title;
    let stem = i === 0 && (!own || own.level === 1) ? 'intro' : fileSlug(anchor || title);
    let slug = stem;
    for (let k = 2; used.has(slug); k++) slug = `${stem}-${k}`;
    used.add(slug);
    const source = url ? (anchor && !(i === 0 && own?.level === 1) ? `${url}#${anchor}` : url) : (anchor ? `#${anchor}` : null);
    const fm = { ...(source ? { Source: source } : {}), title, Part: `${i + 1} of ${packed.length}` };
    const lineCount = partBody.split('\n').length - (partBody.endsWith('\n') ? 1 : 0);
    return {
      slug,
      anchor,
      source,
      title,
      path,
      body: partBody,
      markdown: serializeFrontMatter(fm) + partBody,
      startLine: p.a + 1,
      lines: lineCount,
      tokens: tokensOf(partBody),
      oversized: !!p.oversized,
      sections: inPart.map(h => ({ level: h.level, title: h.title, anchor: h.anchor, line: h.line - p.a + 1 })),
    };
  });

  const linkPrefix = opts.linkPrefix ?? '';
  return { index: { markdown: renderIndex({ pageData, pageTitle, url, parts, maxTokens, fmBlock, tokensOf, linkPrefix }) }, parts };
}

function fmtTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

/** Line windows of about `maxTokens` each, for reading an uncuttable part in pieces. */
function lineWindows(body, maxTokens, tokensOf) {
  const lines = body.split('\n');
  const out = [];
  let start = 0, size = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = tokensOf(lines[i] + '\n');
    if (size + t > maxTokens && i > start) { out.push([start + 1, i]); start = i; size = 0; }
    size += t;
  }
  if (start < lines.length) out.push([start + 1, lines.length]);
  return out;
}

function renderIndex({ pageData, pageTitle, url, parts, maxTokens, tokensOf, linkPrefix = '' }) {
  const total = parts.reduce((a, p) => a + p.tokens, 0);
  const fm = { ...pageData, ...(url && !pageData.Source ? { Source: url } : {}), Parts: parts.length };
  const head = [
    serializeFrontMatter(fm).trimEnd(),
    '',
    `# ${pageTitle} (index)`,
    '',
    `This page (~${fmtTokens(total)} tokens) is split into ${parts.length} parts along its own headings.`,
    'Each entry: part file — heading path — lines, ~tokens — source anchor. Nested entries are the part\'s',
    'sections with their line number inside the part file.',
    '',
  ];
  // The index must itself fit in one read: drop nested levels, deepest first, until it does.
  const levels = [...new Set(parts.flatMap(p => p.sections.map(s => s.level)))].sort((a, b) => a - b);
  let maxLevel = levels.length ? levels[levels.length - 1] : 0;
  const render = (depthLimit) => {
    const out = [];
    for (const p of parts) {
      const src = p.source || '';
      const pathText = p.path.length ? p.path.join(' › ') : p.title;
      out.push(`- [${p.slug}.md](${linkPrefix}${p.slug}.md) — ${pathText} — ${p.lines} lines, ~${fmtTokens(p.tokens)} tokens${src ? ` — ${src}` : ''}`);
      if (p.oversized) {
        const w = lineWindows(p.body, maxTokens, tokensOf).map(([a, b]) => `${a}–${b}`);
        const shown = w.length > 12 ? [...w.slice(0, 10), '…', w[w.length - 1]] : w;
        out.push(`  - too large to split (no headings to cut at: one table, code block or list) — read it in ${w.length} line windows: ${shown.join(', ')}`);
      }
      const open = []; // levels of the enclosing listed sections, for nesting
      for (const s of p.sections) {
        if (s.line === 1 && s === p.sections[0]) continue;
        if (s.level > depthLimit) continue;
        while (open.length && open[open.length - 1] >= s.level) open.pop();
        const indent = '  '.repeat(open.length + 1);
        open.push(s.level);
        out.push(`${indent}- ${s.title} — line ${s.line}${s.anchor ? ` — #${s.anchor}` : ''}`);
      }
    }
    return out;
  };
  let body = render(maxLevel);
  while (tokensOf(body.join('\n')) > maxTokens * 0.8 && maxLevel > 0) {
    maxLevel = levels.filter(l => l < maxLevel).pop() ?? 0;
    body = render(maxLevel);
  }
  if (maxLevel < (levels[levels.length - 1] ?? 0)) {
    head.push(`(Sections deeper than level ${maxLevel || 'part'} are omitted here to keep the index readable in one go; each part lists them.)`, '');
  }
  return head.join('\n') + '\n' + body.join('\n') + '\n';
}
