/**
 * Markdown → section tree, with 1-based inclusive line ranges relative to the
 * whole file (front matter included), so `path:start-end` can be handed straight
 * to a Read(offset, limit) call.
 *
 * What counts as a heading:
 *   - ATX headings (`## Title`), not inside fenced code (``` or ~~~).
 *   - HTML headings (`<h2>…</h2>`) at the start of a line. Some generators render
 *     API reference entries as HTML tables with a heading per entry (Google Ads'
 *     fields pages: 500+ `<h2>metrics.x</h2>` rows and no markdown heading at all);
 *     treating them as headings makes each entry addressable.
 *
 * Search units:
 *   - one per heading, covering that heading's *own* content (up to the next
 *     heading of any level) — the tightest range that still starts at a heading;
 *   - a preamble unit for content before the first heading;
 *   - a unit longer than `chunkLines` is replaced by overlapping line windows, so
 *     a 500-row table or a 2,000-line section still yields ~60-line answers.
 *     Windows also close early on a character budget: some lines are 60 kB.
 */

export const CHUNK_DEFAULTS = {
  chunkLines: 120,   // units longer than this are windowed
  windowLines: 60,   // target window length
  overlapLines: 15,  // overlap between consecutive windows
  windowChars: 16000, // ~4k tokens: close a window early on very long lines
  tinyLines: 0,      // a heading with at most this many content lines before its first
                     // subsection is merged into that subsection's unit (2 also folded
                     // page intros into the first section; 0 scored the same on dev and
                     // better on test)
};

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HTML_H = /^\s*(?:<[^>]{0,200}>\s*){0,8}<h([1-6])\b[^>]*>(.*?)<\/h\1\s*>/i;
// A heading as a list item's first content (`* #### orders/paid: Sample Payload`):
// GitHub renders it as a heading, and generated API references use it per entry.
const LIST_H = /^ {0,3}[-*+][ \t]+(#{1,6})[ \t]+(.+?)[ \t]*$/;
// A definition line ending in a permalink: `*class* pkg.mod.Name(args)[[source]](…)[¶](#pkg.mod.Name "…")`.
// Sphinx/autodoc renders API entries (classes, functions, attributes, "Parameters:"
// rubrics) as <dt> with such an anchor rather than as headings; making them
// headings makes every API entry an addressable section.
const DEF_LINE = /\[¶\]\(#([\w.:-]+)(?:\s+"[^"]*")?\)\s*$/;

/**
 * Parse a YAML-ish front matter block: `key: value` scalars and folded/literal
 * block scalars (`description: >-`). Nested structures are kept as raw text.
 * @returns {{data: Record<string,string>, endLine: number}|null} endLine = the closing `---` line (1-based)
 */
export function parseFrontMatter(lines) {
  if (lines[0]?.trim() !== '---') return null;
  let end = -1;
  const max = Math.min(lines.length, 400);
  for (let i = 1; i < max; i++) {
    const t = lines[i].trim();
    if (t === '---' || t === '...') { end = i; break; }
  }
  if (end === -1) return null;
  const data = {};
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let value = m[2].trim();
    if (/^[>|][-+]?$/.test(value)) {
      const folded = [];
      while (i + 1 < end && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        folded.push(lines[++i].trim());
      }
      value = folded.join(' ').replace(/\s+/g, ' ').trim();
    } else {
      value = value.replace(/^(["'])(.*)\1$/, '$2');
    }
    if (!(key in data)) data[key] = value;
  }
  return { data, endLine: end + 1 };
}

/** Strip inline markup from heading text for display; keeps identifiers intact. */
export function cleanHeading(text) {
  return text
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/<wbr\s*\/?>/gi, '')
    .replace(/\[\[[\w.-]+\]\]/g, '')                                    // doc-builder anchors: Name[[pkg.Name]]
    .replace(/\{\/\*.*?\*\/\}/g, '')                                     // MDX anchor comments: {/*usage*/}
    .replace(/\[\s*[¶#§*↩︎]*\s*\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '')       // permalink anchors
    // `[Anchor to Rate limits](#rate-limits)Rate limits`: a permalink carrying a copy of the title.
    .replace(/^\[([^\]]*)\]\([^)]*\)(.+)$/, (m, a, b) => (a.trim().endsWith(b.trim()) ? b : m))
    .replace(/!\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d{1,6});/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s*\{#[\w.:-]+\}\s*$/, '')                               // kramdown/Pandoc ids: Title {#title}
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, '$1')
    .replace(/[¶#]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find headings (outside fenced code) and fenced-code line spans.
 * @param {string[]} lines
 * @param {number} from 0-based first line to scan (after front matter)
 */
export function scanStructure(lines, from = 0) {
  const headings = [];   // {line (1-based), level, raw, text}
  const fences = [];     // [start, end] 1-based inclusive, the fence lines included
  let fence = null;      // {ch, len, start}
  let defBase = 0;       // level of the last real heading (definition lines nest below it)
  const defStack = [];   // anchors of enclosing definition lines
  const push = h => {
    headings.push(h);
    defBase = h.level;
    defStack.length = 0;
  };
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const m = line.match(FENCE);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && !m[2].trim()) {
        fences.push([fence.start, i + 1]);
        fence = null;
      }
      continue;
    }
    const f = line.match(FENCE);
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = { ch: f[1][0], len: f[1].length, start: i + 1 };
      continue;
    }
    const c0 = line.charCodeAt(0);
    // '#' or ' ' — cheap pre-check before regex on multi-kB lines
    if (c0 === 35 || c0 === 32) {
      const m = line.length < 2000 && line.match(ATX);
      if (m) {
        let raw = (m[2] || '').replace(/[ \t]+#+$/, '');
        let text = cleanHeading(raw);
        if (!text) ({ raw, text } = recoverEmptyHeading(lines, i));
        if (text) push({ line: i + 1, level: m[1].length, raw, text, kind: 'atx' });
        continue;
      }
    }
    if (c0 === 42 || c0 === 45 || c0 === 43 || c0 === 32) { // '*' '-' '+' ' '
      const m = line.length < 2000 && line.match(LIST_H);
      if (m) {
        const raw = m[2].replace(/[ \t]+#+$/, '');
        const text = cleanHeading(raw);
        if (text) { push({ line: i + 1, level: m[1].length, raw, text, kind: 'list' }); continue; }
      }
    }
    if (c0 === 60 || c0 === 32 || c0 === 9) { // '<'
      const head = line.length > 600 ? line.slice(0, 600) : line;
      const m = head.match(HTML_H);
      if (m) {
        const text = cleanHeading(m[2]);
        if (text) { push({ line: i + 1, level: Number(m[1]), raw: m[2], text, kind: 'html' }); continue; }
      }
    }
    if (line.includes('¶](#') && !/^\s*(?:[|>]|[-*+]\s)/.test(line)) {
      const m = line.length < 3000 && line.match(DEF_LINE);
      if (m) {
        const anchor = m[1];
        while (defStack.length && !anchor.startsWith(defStack[defStack.length - 1] + '.')) defStack.pop();
        const level = Math.min(6, defBase + 1 + defStack.length);
        const raw = line.slice(0, m.index);
        const text = definitionTitle(raw);
        if (text) {
          headings.push({ line: i + 1, level, raw, text, kind: 'def' });
          defStack.push(anchor);
        }
      }
    }
  }
  if (fence) fences.push([fence.start, lines.length]);
  return { headings, fences };
}

/** `*class* a.b.C(*x=None*, …)[[source]](…)` → `class a.b.C()` (signature elided, name kept). */
function definitionTitle(raw) {
  let t = raw.replace(/\[\\?\[source\\?\]\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1');
  const paren = t.indexOf('(');
  const hadArgs = paren > 0 && !/^\s*\*?[\w\s]*:\s*$/.test(t);
  if (paren > 0) t = t.slice(0, paren);
  t = cleanHeading(t.replace(/\\_/g, '_').replace(/\*/g, ' '));
  if (!t || t.length > 150) return '';
  return hadArgs && paren > 0 ? `${t}()` : t;
}

/**
 * An empty ATX heading followed by a split permalink and the title as a plain line:
 *
 *   ##
 *
 *   [​
 *
 *   ](#choose-an-approach)
 *
 *   Choose an approach
 *
 * is what an HTML→markdown converter makes of `<h2><a href="#x">​</a>Title</h2>`
 * (seen ~460 times in a real v1 cache, e.g. every Mintlify page). Take the first
 * short text line after the link as the heading; fall back to the anchor slug.
 */
function recoverEmptyHeading(lines, i) {
  let slug = null;
  for (let k = i + 1; k < Math.min(lines.length, i + 10); k++) {
    const t = lines[k].trim();
    if (!t || t === '[' || /^\[[\s\u200b]*$/.test(t)) continue;
    const link = t.match(/^\]\(#([^)\s]+)\)$/) || t.match(/^\[[\s\u200b]*\]\(#([^)\s]+)\)$/);
    if (link) { slug = link[1]; continue; }
    if (/^(#|```|~~~|\||<|[-*+] |\d+\. )/.test(t) || t.length > 120) break;
    return { raw: t, text: cleanHeading(t) };
  }
  if (slug) return { raw: slug, text: slug.replace(/[-_]+/g, ' ') };
  return { raw: '', text: '' };
}

/** Split text into lines the way editors number them (a trailing newline adds no line). */
export function splitLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Parse a markdown document into metadata, a heading outline and search units.
 * @param {string} text
 * @param {Partial<typeof CHUNK_DEFAULTS>} opts
 */
export function parseDocument(text, opts = {}) {
  const o = { ...CHUNK_DEFAULTS, ...opts };
  const lines = splitLines(text);
  const fm = parseFrontMatter(lines);
  const bodyStart = fm ? fm.endLine : 0; // 0-based index of first body line
  const { headings, fences } = scanStructure(lines, bodyStart);

  // Section tree: each heading's own range and its full span (incl. subsections).
  const sections = [];
  const stack = [];
  for (let h = 0; h < headings.length; h++) {
    const hd = headings[h];
    while (stack.length && stack[stack.length - 1].level >= hd.level) stack.pop();
    const path = [...stack.map(s => s.text), hd.text];
    const ownEnd = h + 1 < headings.length ? headings[h + 1].line - 1 : lines.length;
    let spanEnd = lines.length;
    for (let k = h + 1; k < headings.length; k++) {
      if (headings[k].level <= hd.level) { spanEnd = headings[k].line - 1; break; }
    }
    const sec = {
      level: hd.level, text: hd.text, raw: hd.raw, path,
      start: hd.line, end: trimEnd(lines, hd.line, ownEnd), spanEnd: trimEnd(lines, hd.line, spanEnd),
    };
    sections.push(sec);
    stack.push(sec);
  }

  const title = pickTitle(fm?.data, headings);
  const description = fm?.data?.description ? cleanHeading(fm.data.description) : null;

  // Search units.
  const units = [];
  const firstHeading = headings.length ? headings[0].line : lines.length + 1;
  const preStart = firstNonBlank(lines, bodyStart + 1, firstHeading - 1);
  if (preStart) {
    const preEnd = trimEnd(lines, preStart, firstHeading - 1);
    pushUnit(units, lines, { start: preStart, end: preEnd, spanEnd: preEnd, level: 0, path: [], heads: [] }, o);
  }
  // A heading with (almost) no content of its own before its first subsection —
  // `## Configuration` then `### Hook locations` — would be a 1–3 line unit that
  // wins BM25 on length normalisation alone while answering nothing. Its lines are
  // folded into the first subsection's unit instead (the heading path already
  // names the parent).
  let pending = null;
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const next = sections[i + 1];
    const heads = [...(pending?.heads || []), { line: sec.start, raw: sec.raw }];
    const start = pending ? pending.start : sec.start;
    if (next && next.level > sec.level && countContent(lines, sec.start + 1, sec.end) <= o.tinyLines) {
      pending = { start, heads };
      continue;
    }
    pushUnit(units, lines, { ...sec, start, heads }, o);
    pending = null;
  }

  return {
    lineCount: lines.length,
    frontMatter: fm?.data || {},
    frontMatterEnd: fm ? fm.endLine : 0,
    title,
    description,
    sections,
    fences,
    units,
    lines,
  };
}

/**
 * Page title: front matter `title`, else the first H1, else the first markdown
 * heading. HTML/list/definition headings are entries (`metrics.ctr`), not titles;
 * with nothing better the caller falls back to the file name.
 */
function pickTitle(fm, headings) {
  if (fm?.title) return cleanHeading(fm.title);
  const h1 = headings.find(h => h.level === 1 && h.kind === 'atx');
  if (h1) return h1.text;
  return headings.find(h => h.kind === 'atx')?.text || null;
}

function countContent(lines, from, to) {
  let n = 0;
  for (let l = from; l <= to; l++) if (lines[l - 1] && lines[l - 1].trim()) n++;
  return n;
}

function firstNonBlank(lines, from, to) {
  for (let l = from; l <= to; l++) if (lines[l - 1] && lines[l - 1].trim()) return l;
  return 0;
}

/** Drop trailing blank lines from a 1-based inclusive range (never before `start`). */
function trimEnd(lines, start, end) {
  while (end > start && !(lines[end - 1] && lines[end - 1].trim())) end--;
  return end;
}

function pushUnit(units, lines, sec, o) {
  const len = sec.end - sec.start + 1;
  let chars = 0;
  for (let l = sec.start; l <= sec.end; l++) chars += lines[l - 1].length + 1;
  if (len <= o.chunkLines && chars <= o.windowChars * 2) {
    units.push({ ...sec, window: false });
    return;
  }
  // Window the unit. Windows prefer to end at a blank line so code blocks and
  // paragraphs are not cut mid-way when that can be avoided cheaply.
  let s = sec.start;
  while (s <= sec.end) {
    let e = s;
    let c = 0;
    while (e <= sec.end && e - s < o.windowLines && (c === 0 || c + lines[e - 1].length < o.windowChars)) {
      c += lines[e - 1].length + 1;
      e++;
    }
    e--; // last included line
    if (e < sec.end && e - s + 1 >= o.windowLines) {
      for (let k = e; k > e - 12 && k > s + o.overlapLines; k--) {
        if (!lines[k - 1].trim()) { e = k - 1; break; }
      }
    }
    e = trimEnd(lines, s, e);
    units.push({
      ...sec, start: s, end: e, spanEnd: e, window: true,
      heads: sec.heads.filter(h => h.line >= s && h.line <= e),
      tableHeader: tableHeaderFor(lines, sec.start, s),
    });
    if (e >= sec.end) break;
    const next = e + 1 - o.overlapLines;
    s = firstNonBlank(lines, Math.max(next, s + 1), sec.end) || sec.end + 1;
  }
}

/** For a window starting mid-table, the table's header row (indexed as context). */
function tableHeaderFor(lines, secStart, winStart) {
  if (winStart === secStart || !lines[winStart - 1].startsWith('|')) return null;
  for (let l = winStart - 1; l >= secStart && lines[l - 1].startsWith('|'); l--) {
    if (/^\|\s*:?-{3,}/.test(lines[l - 1]) && l - 1 >= secStart) return lines[l - 2];
  }
  return null;
}

/**
 * The page's outline: headings with own/section ranges.
 * @returns {{level:number, text:string, start:number, end:number, spanEnd:number}[]}
 */
export function outlineOf(doc) {
  return doc.sections.map(s => ({ level: s.level, text: s.text, start: s.start, end: s.end, spanEnd: s.spanEnd }));
}
