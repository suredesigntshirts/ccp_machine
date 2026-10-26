/**
 * Tokenization shared by indexing and querying, and by both index backends.
 *
 * Documentation is half prose, half code, and agents search for both. So:
 *   - prose words are lowercased and Porter-stemmed ("selecting" → "select");
 *   - identifiers are indexed whole AND split into parts:
 *       onConflictDoUpdate  → onconflictdoupdate, conflict, updat
 *       use_edges_state     → use_edges_state, use, edg, state
 *       google.genai.types.GenerateContentConfig
 *                           → google.genai.types.generatecontentconfig, google, genai,
 *                             type, generatecontentconfig, gener, content, config
 *     so an exact API name ranks the defining section first, while "drizzle select"
 *     or "content config" still reach it.
 *
 * Stop words are dropped at index and query time: in an OR query they match
 * every section, cost time, and add nothing BM25 can use.
 */

import { stem } from './stem.mjs';

export const STOPWORDS = new Set((
  'a an and are as at be been but by can could did do does doing for from had has have ' +
  'how i if in into is it its just me my of on or our so than that the their them then ' +
  'there these they this those to too us was we were what when where which while who whom ' +
  'why will with would you your yours about also any all both each few more most other some ' +
  'such no nor not only own same very s t should shall may might must am i\'m it\'s using use ' +
  'want need way e g eg ie etc many much one every else'
).split(/\s+/));

// A raw token: letters/digits/underscore runs, optionally joined by single dots
// (dotted names like `google.genai.types.X`, `v1.2.3`). `$` is allowed inside
// identifiers because JS/PHP APIs use it (`$ref`, `jQuery.$`).
// Letters are explicit script ranges (Latin-1/Extended minus × ÷, Greek, Cyrillic,
// Hebrew, Arabic, Devanagari, Thai, kana minus ・, CJK, Hangul) rather than
// \p{L}: twice as fast on the corpus, and every char here is a letter to FTS5's
// unicode61 too, so both backends split text identically.
const W = 'A-Za-z0-9_$\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u024f\u0370-\u03ff\u0400-\u04ff\u05d0-\u05ea'
  + '\u0620-\u064a\u0904-\u0939\u0e01-\u0e30\u3041-\u30fa\u30fc-\u30ff\u3400-\u9fff\uac00-\ud7af';
const RAW = new RegExp(`[${W}]+(?:\\.[${W}]+)*`, 'g');

// camelCase / PascalCase / ACRONYMWord boundaries.
const CAMEL = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;

/** Lowercase and strip diacritics (matches FTS5 unicode61 remove_diacritics). */
export function fold(s) {
  // Fast path: the corpus is overwhelmingly ASCII.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(s)) return s.toLowerCase();
  return s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** Does this segment carry identifier structure (underscore, inner capital, digit+letter)? */
function isCompound(seg) {
  return seg.includes('_') || seg.includes('$') || /[a-z][A-Z]|[A-Z]{2,}[a-z]/.test(seg);
}

function pushWord(out, w) {
  if (w.length < 2 && !/\d/.test(w)) return;
  if (STOPWORDS.has(w)) return;
  out.push(stem(w));
}

function pushSegment(out, seg) {
  if (isCompound(seg)) {
    // The whole identifier goes through the stemmer too: prose writes `PageSpeed`
    // (a compound here) where a query writes `pagespeed` (a plain word, stemmed).
    // stem() leaves anything with `_`/digits untouched, so snake_case stays exact.
    const whole = stem(fold(seg).replace(/^[_$]+|[_$]+$/g, ''));
    if (whole.length > 1) out.push(whole);
    for (const piece of seg.split(/[_$]+/)) {
      const parts = piece.match(CAMEL);
      if (!parts) continue;
      for (const p of parts) pushWord(out, fold(p));
    }
  } else {
    pushWord(out, fold(seg));
  }
}

/**
 * Terms for a piece of text, in order, with repeats (term frequency matters).
 * @param {string} text
 * @returns {string[]}
 */
// Zero-width spaces/joiners, soft hyphens and BOMs: some sites put U+200B inside
// identifiers as line-break hints (`bulk\u200bOperation\u200bRun\u200bQuery`).
const INVISIBLE_TEST = /[\u00ad\u200b-\u200d\u2060\ufeff]/;
export const INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;

export function tokenize(text) {
  const out = [];
  if (!text) return out;
  if (INVISIBLE_TEST.test(text)) text = text.replace(INVISIBLE, '');
  const raws = text.match(RAW);
  if (!raws) return out;
  for (let r = 0; r < raws.length; r++) {
    const raw = raws[r];
    if (raw.length > 120) continue; // base64 blobs, hashes, minified junk
    // Word frequencies are Zipfian: memoizing raw token → terms removes ~80% of
    // the per-token work (measured: full build of the 23 MB fixture 3.0 s → ~1 s).
    let terms = memo.get(raw);
    if (!terms) {
      terms = termsOf(raw);
      if (memo.size > 300000) memo.clear();
      memo.set(raw, terms);
    }
    for (let i = 0; i < terms.length; i++) out.push(terms[i]);
  }
  return out;
}

const memo = new Map();

function termsOf(raw) {
  const out = [];
  if (raw.includes('.')) {
    const segs = raw.split('.');
    // Plain version numbers are not worth a dotted term.
    if (/[a-z_]/i.test(raw)) out.push(fold(raw));
    for (const s of segs) pushSegment(out, s);
  } else {
    pushSegment(out, raw);
  }
  return out;
}

/**
 * Query terms: tokenize, then de-duplicate while remembering which terms came from
 * a whole identifier (those deserve an exact-symbol lookup).
 * @returns {{terms: string[], identifiers: string[]}}
 */
export function queryTerms(query) {
  const terms = [];
  const seen = new Set();
  for (const t of tokenize(query)) {
    if (!seen.has(t)) { seen.add(t); terms.push(t); }
  }
  const identifiers = [];
  for (const raw of query.match(RAW) || []) {
    if (raw.includes('.') || isCompound(raw)) identifiers.push(raw);
  }
  return { terms, identifiers };
}

// Identifiers worth putting in the symbol field/index: things that look like API
// names rather than prose. Plain lowercase words qualify only when they are
// called (`select(`), in which case they are function names.
const IDENT = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(\()?/g;

/** Extract API-looking identifiers from code or heading text. */
export function extractSymbols(text, out = new Set(), limit = 400) {
  if (!text) return out;
  if (INVISIBLE_TEST.test(text)) text = text.replace(INVISIBLE, '');
  for (const m of text.matchAll(IDENT)) {
    if (out.size >= limit) break;
    let name = m[0];
    const called = !!m[1];
    if (called) name = name.slice(0, -1);
    if (name.length < 3 || name.length > 100) continue;
    if (name.includes('.') || isCompound(name) || called) out.add(name);
  }
  return out;
}

/** Identifiers from a heading: anything in backticks, plus identifier-shaped words. */
export function headingSymbols(heading) {
  const out = new Set();
  for (const m of heading.matchAll(/`([^`]+)`/g)) {
    const t = m[1].trim().replace(/\(.*$/, '');
    if (/^[\w$.:#-]+$/.test(t) && t.length >= 2) out.add(t);
  }
  extractSymbols(heading.replace(/`/g, ''), out);
  return out;
}
