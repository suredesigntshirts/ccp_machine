/**
 * A page's `description:` — one or two sentences saying what the page is for, so an
 * agent can choose it from `_outline.md`, search results or grep without opening it.
 *
 * Never written by us: always taken from something the site published, best first
 * (DESIGN.md "Descriptions"):
 *
 *   llms.txt      the site's own llms.txt entry for the page — written for LLMs
 *   front-matter  the page's markdown front matter (`description:`), by its author
 *   meta          <meta name="description">, og:description, twitter:description,
 *                 JSON-LD — only when it is about THIS page (not the site's default)
 *   lead          the page's opening: the summary line under its title, else its
 *                 first paragraph, cut at a sentence end
 *
 * The first candidate that passes the checks wins. `DescriptionFrom:` records which,
 * so a refresh never replaces a description with one from a worse source
 * (store/frontmatter.mjs mergeFrontMatter).
 */

import { descriptionProblem } from '../descriptions.mjs';

export { DESCRIPTION_SOURCES } from '../store/frontmatter.mjs';

/** A lead is cut at a sentence end within this many characters. */
export const MAX_LEAD_CHARS = 250;
/** Anything published longer than this is cut at a sentence end (a whole intro pasted into meta). */
export const MAX_DESCRIPTION_CHARS = 300;
const MIN_CHARS = 20;
const MIN_WORDS = 3;

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k in ENT) return ENT[k];
    try {
      if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
    } catch { /* out of range */ }
    return m;
  });
}

/** Plain one-line text: entities decoded, HTML tags and markdown link/emphasis syntax dropped. */
export function cleanDescription(s) {
  if (s == null) return '';
  // Literal `\n` from a JSON-escaped field, and entities encoded twice (`&amp;#x27;`).
  let t = String(s).replace(/\\[nrt]/g, ' ');
  for (let k = 0; k < 2 && /&(?:#x?[0-9a-f]+|[a-z]+);/i.test(t); k++) t = decodeEntities(t);
  t = t.replace(/<\/?[a-z][^<>]*>/gi, ' ')
    // Heading permalinks (`[¶](#id "Link to this heading")`) carry no words.
    .replace(/\[\s*[¶#§*↩︎]*\s*\]\([^)]*\)/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(["'“‘]).*(["'”’])$/.test(t) && t.length > 2) t = t.slice(1, -1).trim();
  return t;
}

/** Cut at the last sentence end within `max` characters (else at a word boundary, marked `…`). */
export function cutAtSentence(t, max) {
  if (t.length <= max) return t;
  const cut = cutRaw(t, max);
  // Never leave a bracket open: end before it (at a sentence end when there is one).
  const open = unclosedAt(cut);
  if (open === -1) return cut;
  const before = cut.slice(0, open).replace(/[\s,;:–—-]+$/, '');
  const lastEnd = Math.max(...[...before.matchAll(/[.!?](?=\s|$)/g)].map(m => m.index + 1), -1);
  if (lastEnd >= 40) return before.slice(0, lastEnd);
  return before.length >= 40 ? `${before}…` : cut;
}
function unclosedAt(t) {
  const stack = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '(' || t[i] === '[') stack.push(i);
    else if ((t[i] === ')' || t[i] === ']') && stack.length) stack.pop();
  }
  return stack.length ? stack[0] : -1;
}
function cutRaw(t, max) {
  const head = t.slice(0, max + 1);
  let end = -1;
  for (const m of head.matchAll(/[.!?](?=\s|$)/g)) if (m.index >= 40) end = m.index + 1;
  if (end > 0) return t.slice(0, end);
  return head.replace(/\s+\S*$/, '').replace(/[,;:\s]+$/, '') + '…';
}

/** Description candidates in a page's HTML <head>, best first. */
export function htmlDescriptions(html) {
  if (!html) return [];
  const headEnd = html.search(/<\/head\s*>|<body[\s>]/i);
  const head = html.slice(0, headEnd > 0 ? headEnd : 300_000);
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map(m => m[0]);
  const attr = (tag, name) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
    return m ? (m[1] ?? m[2] ?? m[3]) : null;
  };
  const metaContent = (key) => {
    for (const t of metas) {
      const k = (attr(t, 'name') ?? attr(t, 'property') ?? '').toLowerCase();
      if (k === key) { const c = attr(t, 'content'); if (c && c.trim()) return c; }
    }
    return null;
  };
  const out = [];
  for (const key of ['description', 'og:description', 'twitter:description']) {
    const c = metaContent(key);
    if (c) out.push(c);
  }
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1]);
      const items = [j, ...(Array.isArray(j?.['@graph']) ? j['@graph'] : [])].flat();
      const d = items.map(x => x && typeof x.description === 'string' ? x.description : null).find(Boolean);
      if (d) { out.push(d); break; }
    } catch { /* not JSON */ }
  }
  return [...new Set(out.map(cleanDescription).filter(Boolean))];
}

/** The `description:` in a markdown document's own front matter. */
export function frontMatterDescription(markdown) {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown || '');
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const i = lines.findIndex(l => /^description:/.test(l));
  if (i === -1) return null;
  let v = lines[i].replace(/^description:\s*/, '');
  if (/^[|>][-+]?\s*$/.test(v)) {
    const block = [];
    for (let j = i + 1; j < lines.length && (/^\s+\S/.test(lines[j]) || !lines[j].trim()); j++) block.push(lines[j].trim());
    v = block.join(' ');
  }
  return cleanDescription(v) || null;
}

const NOTICE_RE = /^(?:(?:note|notes|warning|caution|important|tip|deprecated|deprecation notice|attention|heads up|info|beta|preview|announcement|new)\b\s*[:!—–-]|requires\b)/i;
const SIGNATURE_RE = /->|\b\w+=[\w'"\[({-]|^[\w.]+\(.*\)\s*:?$/;
const LEGAL_RE = /\b(?:privacy (?:policy|notice|statement)|terms (?:of (?:service|use)|and conditions)|cookies?\b.*\b(?:consent|accept|use)|you (?:agree|consent)|will be (?:collected|stored|processed|shared)|all rights reserved)\b/i;
const OPENER_RE = /^(?:let's|let us|the following|here's|here is|in this (?:section|example|step)|for example|e\.g\.|see also|first,|next,|then,|now,|finally,)/i;
const PARAM_RE = /^[\w.*]+\s+:\s/;
const DANGLING_RE = /\b(?:to|that|for|of|with|by|as|the|a|an|and|or|in|on|from|following|these|this|are|is|include|includes|including|like|such as|below|here)$/i;
const BLOCK_START = /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|\||```|~~~|<|!\[|\[!\[|---\s*$|\*\*\*\s*$|=+\s*$|[ \t]{4})/;

/**
 * The page's opening: the summary line right under its title (`> …`, as Mintlify and
 * many docs themes render it), else its first prose paragraph — cut at a sentence end.
 */
export function leadDescription(markdown) {
  return leadCandidates(markdown, 1)[0] ?? null;
}

/** Up to `max` opening candidates, in page order (a later one is tried when an earlier fails the checks). */
export function leadCandidates(markdown, max = 3) {
  const out = [];
  const push = (t) => { out.push(t); return out.length >= max; };
  let body = (markdown || '').replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, '');
  const lines = body.split('\n');
  let i = 0;
  // Start after the title when the page opens with one.
  const firstNonBlank = lines.findIndex(l => l.trim());
  if (firstNonBlank !== -1 && /^#\s/.test(lines[firstNonBlank])) i = firstNonBlank + 1;
  let fence = null;
  let firstProse = true; // a short paragraph counts only as the page's first prose
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (fence) { if (l.trim().startsWith(fence)) fence = null; continue; }
    const f = /^\s*(```+|~~~+)/.exec(l);
    if (f) { fence = f[1]; continue; }
    if (!l.trim()) continue;
    if (/^#{1,6}\s/.test(l)) {
      // A heading before any prose: the page opens with its sections (a reference
      // page); its first paragraph still describes it, so keep looking.
      continue;
    }
    if (/^>\s*/.test(l)) {
      // A summary blockquote, not a GitHub alert / callout.
      if (/^>\s*\[!/.test(l)) { while (i + 1 < lines.length && /^>/.test(lines[i + 1])) i++; continue; }
      const quote = [];
      for (; i < lines.length && /^>/.test(lines[i]); i++) quote.push(lines[i].replace(/^>\s?/, ''));
      const t = cleanDescription(quote.join(' '));
      if (/^#{1,6}\s/.test(quote[0] || '') || t.length < 40) continue; // a heading inside a note box
      if (push(cutAtSentence(t, MAX_LEAD_CHARS))) break;
      continue;
    }
    if (BLOCK_START.test(l)) continue;
    // A notice ("**Warning:** For v20.0+ …") is not what the page is about.
    if (NOTICE_RE.test(cleanDescription(l)) || /^\*\*[^*].*\*\*\s*$/.test(l.trim())) {
      // A notice, or a paragraph that is all bold (a banner): skip it.
      while (i + 1 < lines.length && lines[i + 1].trim()) i++;
      firstProse = false;
      continue;
    }
    const para = [];
    for (; i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i]) && !/^>/.test(lines[i]); i++) para.push(lines[i].trim());
    const t = cleanDescription(para.join(' '));
    if (PARAM_RE.test(t)) break; // `count : int or float`: the parameters began; no summary after this
    if (SIGNATURE_RE.test(t)) continue; // `is_causal=False, scale=None) -> Tensor:` — a signature
    if (OPENER_RE.test(t)) { firstProse = false; continue; } // "Let's start by…", "The following…": a step, not a summary
    if (LEGAL_RE.test(t)) { firstProse = false; continue; } // consent / privacy / terms boilerplate
    const short = t.length < (firstProse ? 20 : 40);
    firstProse = false;
    if (short || !/[.!?:]/.test(t) && t.split(' ').length < 8) continue; // a label, a byline
    const lead = cutAtSentence(t, MAX_LEAD_CHARS);
    if (/:$/.test(lead)) {
      // It introduces a list or code. A whole sentence ("… when it is served:") still
      // describes the page; a stub ("Use the API to:") does not.
      if (DANGLING_RE.test(lead.slice(0, -1)) || lead.length < 40) continue;
      if (push(lead.replace(/:$/, '.'))) break;
      continue;
    }
    if (push(lead)) break;
  }
  return out;
}

const STOP = new Set('about above after again also another because been before being between both could does doing down during each from further have having here into itself just more most other over same should some such than that their them then there these they this those through under until very were what when where which while with would your yours page pages documentation docs guide learn using use used make makes made available information'.split(' '));
const contentWords = (s) => (s.toLowerCase().match(/\p{L}[\p{L}\p{N}_'-]{3,}/gu) || []).filter(w => !STOP.has(w));

/**
 * Is a meta description about this page? A site that sets one default description on
 * every page ("Next Generation Frontend Tooling", "We're on a journey to advance and
 * democratize AI…") states its tagline, not the page: most of its words are absent from
 * the page's own text. A page's description summarises the page, so most are present.
 */
export function aboutThisPage(description, pageText) {
  const words = [...new Set(contentWords(description))];
  if (words.length < 2) return true; // too few words to judge; other checks apply
  const text = (pageText || '').toLowerCase();
  // A crude stem (assets ~ asset, imported ~ importing): the word minus its last 3 letters, at least 4.
  const found = words.filter(w => text.includes(w.slice(0, Math.max(4, w.length - 3)))).length;
  return found / words.length >= 0.5;
}

const FILLER = new Set('learn about overview introduction reference read more details detail information guide guides documentation docs version latest page explains describes covers'.split(' '));
const norm = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Why a candidate is not a usable description (null when it is). */
export function candidateProblem(text, { title, path = 'page.md', cut = false } = {}) {
  if (!text) return 'empty';
  // A lead we cut ourselves ends in `…` on purpose; that is not a broken entry.
  if (cut) text = text.replace(/…$/, '');
  if (text.length < MIN_CHARS || text.split(/\s+/).length < MIN_WORDS) return 'too short';
  const n = norm(text), nt = norm(title);
  if (nt && (n === nt || (nt.includes(n) && n.length < 60))) return 'only the title';
  // Nothing but the title's words ("Learn about Webhooks" on the Webhooks page).
  const own = contentWords(text).filter(w => !FILLER.has(w));
  if (nt && own.length && own.length <= 4 && own.every(w => nt.includes(w.slice(0, Math.max(4, w.length - 3))))) return 'only the title';
  // Template text a site forgot to fill in (`moonrise-replace9ffc0e…`).
  if (/\b(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{24,}\b/i.test(text) && !/https?:|\.\w+\(/.test(text)) return 'template placeholder';
  // Written on purpose by the site: long is fine (descriptionProblem's length rule is
  // for text extracted from a page), anything else that marks a broken entry is not.
  return descriptionProblem(text, path, { handWritten: true });
}

/**
 * Choose the page's description.
 * @param {{llms?: string|null, markdown?: string, html?: string|null, title?: string|null, path?: string,
 *          isSiteDefault?: (text: string) => boolean|Promise<boolean>}} o
 * @returns {Promise<{description: string|null, from: string|null, rejected: {from: string, text: string, why: string}[]}>}
 */
export async function chooseDescription(o) {
  const rejected = [];
  const pageText = (o.markdown || '').replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, '');
  const cands = [];
  if (o.llms) cands.push({ from: 'llms.txt', text: cleanDescription(o.llms) });
  const fm = frontMatterDescription(o.markdown);
  if (fm) cands.push({ from: 'front-matter', text: fm });
  for (const t of htmlDescriptions(o.html)) cands.push({ from: 'meta', text: t });
  for (const lead of leadCandidates(o.markdown)) cands.push({ from: 'lead', text: lead });
  // A description the site wrote that only restates the title is weak, but rated above
  // an opening sentence that is a fragment of the page: it is kept as the fallback
  // before the lead. A lead that restates the title still beats having none.
  let restated = null;
  for (const c of cands) {
    let why = candidateProblem(c.text, { title: o.title, path: o.path, cut: c.from === 'lead' });
    if (why === 'only the title' && c.from === 'lead') why = null;
    if (!why && c.from === 'meta') {
      if (!aboutThisPage(c.text, pageText)) why = 'not about this page (site default?)';
      else if (o.isSiteDefault && await o.isSiteDefault(c.text)) why = 'the site\'s default (seen on other pages)';
    }
    if (why === 'only the title' && !restated && norm(c.text) !== norm(o.title)) restated = c;
    if (c.from === 'lead' && restated) return { description: cutAtSentence(restated.text, MAX_DESCRIPTION_CHARS), from: restated.from, rejected };
    if (why) { rejected.push({ from: c.from, text: c.text, why }); continue; }
    return { description: cutAtSentence(c.text, MAX_DESCRIPTION_CHARS), from: c.from, rejected };
  }
  if (restated) return { description: cutAtSentence(restated.text, MAX_DESCRIPTION_CHARS), from: restated.from, rejected };
  return { description: null, from: null, rejected };
}
