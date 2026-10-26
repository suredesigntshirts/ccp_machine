/**
 * The search index: public API.
 *
 *   openIndex(root)                    → backend (SQLite FTS5, or the JSON fallback)
 *   refreshIndex(root, {full, paths})  → bring the index + generated files up to date
 *   updateIndexForFiles(root, paths)   → the same, for just-written pages (call after a fetch)
 *   searchIndex(root, query, opts)     → ranked, grouped line ranges with snippets
 *
 * The markdown files are the source of truth; everything here is derived and can
 * be rebuilt with `docs reindex --full`. Freshness is checked by (mtime, size) —
 * one stat per page — and a changed stat is confirmed by content hash before any
 * re-analysis, so `touch` costs nothing and a 500-page cache refreshes in ms.
 */

import { readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { cacheDirs } from '../config.mjs';
import { loadSqlite, SqliteIndex } from './sqlite.mjs';
import { JsonIndex } from './jsindex.mjs';
import { scanPages, analyzePage, hashText, isPagePath, domainOf, ANALYZER_VERSION } from './files.mjs';
import { writeGenerated } from './generated.mjs';
import { withLock } from './lock.mjs';
import { queryTerms, tokenize, fold, STOPWORDS } from './tokenize.mjs';
import { splitLines } from './markdown.mjs';
import { rerank, idfOf, LineMasks, RERANK_DEFAULTS } from './rank.mjs';

/** BM25 field weights: path, heading path, symbols, body. */
export const DEFAULT_WEIGHTS = [2, 4, 3, 1];

export const SEARCH_DEFAULTS = {
  limit: 6,          // results shown (first hits at rank 7–8: 1 of 195 eval queries)
  budget: 1200,      // output token budget (chars / 4) for the text format
  candidates: 150,   // BM25 candidates considered by the reranker
  mergeLines: 150,   // merge an overlapping lower-ranked range while the union stays this short
                     // (0 = just skip it: 19% fewer tokens to read, but one query fewer at
                     // rank 1 on each split — eval log #15)
  perFile: 4,        // max results from one page (diversity; 3 dropped answers, eval log)
  maxChars: 6000,    // hard cap on text output
};

/**
 * Open the index for a cache root. Backend: `sqlite` when node:sqlite works,
 * else `json`. Override with opts.backend or DD_INDEX_BACKEND=sqlite|json.
 */
export async function openIndex(rootAbs, { backend } = {}) {
  const want = backend || process.env.DD_INDEX_BACKEND || 'auto';
  const dirs = cacheDirs(rootAbs);
  if (want !== 'json') {
    if (await loadSqlite()) return SqliteIndex.open(dirs.sqlite);
    if (want === 'sqlite') throw new Error('node:sqlite is unavailable (needs Node ≥ 22.13); use --backend json');
  }
  return JsonIndex.open(dirs.jsonIndex);
}

/**
 * `.cache/` holds only derived, rebuildable state (DESIGN.md: gitignored). A `*`
 * .gitignore inside it keeps it out of the consuming project's commits without
 * touching the project's own .gitignore.
 */
function ignoreCacheDir(rootAbs) {
  const file = join(cacheDirs(rootAbs).cache, '.gitignore');
  if (existsSync(file)) return;
  try { writeFileSync(file, '# Derived and rebuildable (`docs reindex --full`); never commit.\n*\n'); } catch { /* read-only: harmless */ }
}

function lockDir(rootAbs) {
  return join(cacheDirs(rootAbs).locks, 'index.lock');
}

/** Normalize caller-supplied page paths (absolute, cwd- or root-relative) to root-relative. */
function toRel(rootAbs, p) {
  const abs = isAbsolute(p) ? p : (existsSync(resolve(p)) && !existsSync(join(rootAbs, p)) ? resolve(p) : join(rootAbs, p));
  return relative(rootAbs, abs).split(sep).join('/');
}

function statPaths(rootAbs, rels) {
  const out = new Map();
  for (const rel of rels) {
    if (!isPagePath(rel)) continue;
    try {
      const st = statSync(join(rootAbs, rel));
      if (st.isFile()) out.set(rel, { mtime: Math.floor(st.mtimeMs), size: st.size });
    } catch { /* deleted */ }
  }
  return out;
}

function diffPages(rootAbs, known, rels, full) {
  const disk = rels ? statPaths(rootAbs, rels) : scanPages(rootAbs);
  const added = [], changed = [], removed = [];
  let unchanged = 0;
  for (const [rel, st] of disk) {
    const k = known.get(rel);
    if (!k) added.push([rel, st]);
    else if (full || k.mtime !== st.mtime || k.size !== st.size) changed.push([rel, st]);
    else unchanged++;
  }
  const gone = rels ? rels.filter(r => known.has(r) && !disk.has(r)) : [...known.keys()].filter(r => !disk.has(r));
  removed.push(...gone);
  return { added, changed, removed, unchanged };
}

/**
 * Bring the index (and, by default, catalog.md + affected _outline.md files) up to date.
 * @param {string} rootAbs
 * @param {{full?: boolean, paths?: string[]|null, generate?: boolean|'all', backend?: string, index?: object}} opts
 *   full: re-analyze every page from scratch; paths: only look at these pages;
 *   generate: true = rewrite generated files for changed domains, 'all' = rewrite all.
 */
export async function refreshIndex(rootAbs, { full = false, paths = null, generate = true, backend, index } = {}) {
  const t0 = performance.now();
  const idx = index || await openIndex(rootAbs, { backend });
  const rels = paths ? [...new Set(paths.map(p => toRel(rootAbs, p)))] : null;
  const summary = { backend: idx.name, added: 0, updated: 0, removed: 0, touched: 0, unchanged: 0, generated: [], ms: 0 };
  try {
    // An index written by a different analyzer is rebuilt in full.
    if (idx.getMeta('analyzer') !== String(ANALYZER_VERSION)) full = true;
    let d = diffPages(rootAbs, idx.fileStates(), rels, full);
    summary.unchanged = d.unchanged;
    const dirty = d.added.length || d.changed.length || d.removed.length;
    if (!dirty && !full && generate !== 'all') {
      summary.ms = performance.now() - t0;
      return summary;
    }
    await withLock(lockDir(rootAbs), async () => {
      ignoreCacheDir(rootAbs);
      // Re-plan inside the lock: another process may have done (some of) the work.
      if (idx.load) idx.load();
      if (idx.getMeta('analyzer') !== String(ANALYZER_VERSION)) full = true;
      // A full rebuild always rescans the whole root, even when called for a few paths.
      const scanAll = !rels || full;
      d = diffPages(rootAbs, idx.fileStates(), scanAll ? null : rels, full);
      const known = idx.fileStates();
      const upserts = [], touches = [];
      const domains = new Set();
      for (const [rel, st] of [...d.added, ...d.changed]) {
        let text;
        try { text = readFileSync(join(rootAbs, rel), 'utf-8'); } catch { continue; }
        const hash = hashText(text);
        const k = known.get(rel);
        if (k && k.hash === hash && !full) { touches.push({ path: rel, ...st }); summary.touched++; continue; }
        upserts.push({ ...analyzePage(rel, text), mtime: st.mtime, size: st.size, hash });
        domains.add(domainOf(rel));
        if (k) summary.updated++; else summary.added++;
      }
      for (const r of d.removed) domains.add(domainOf(r));
      summary.removed = d.removed.length;
      if (upserts.length || d.removed.length || touches.length || full) {
        const rebuild = full && scanAll;
        idx.update({ upserts, deletes: d.removed, touches, reset: rebuild, meta: rebuild ? { analyzer: String(ANALYZER_VERSION) } : null });
      }
      if (generate) {
        const all = generate === 'all' || full;
        if (all || domains.size) summary.generated = writeGenerated(rootAbs, idx.files(), all ? null : domains);
      }
    });
  } finally {
    if (!index) idx.close();
  }
  summary.ms = performance.now() - t0;
  return summary;
}

/**
 * Index just-written or just-deleted pages (for `docs fetch` to call after writing).
 * Cheap: stats and re-analyzes only the given files, then rewrites their domains'
 * outlines and the catalog.
 * @param {string} rootAbs cache root
 * @param {string[]} paths page paths: absolute, or relative to the root (a path relative
 *   to the cwd works while the file exists; pass absolute paths for deleted pages)
 */
export function updateIndexForFiles(rootAbs, paths, opts = {}) {
  return refreshIndex(rootAbs, { ...opts, paths });
}

// ─────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} rootAbs
 * @param {string} query
 * @param {{limit?, candidates?, perFile?, domain?, pathPrefix?, weights?, refresh?, backend?, index?}} opts
 * @returns {Promise<{query:string, backend:string, results: object[], refreshed: object|null}>}
 */
export async function searchIndex(rootAbs, query, opts = {}) {
  const o = { ...SEARCH_DEFAULTS, ...opts };
  const idx = opts.index || await openIndex(rootAbs, { backend: opts.backend });
  try {
    let refreshed = null, stale = null;
    if (o.refresh !== false) {
      try {
        refreshed = await refreshIndex(rootAbs, { index: idx });
      } catch (e) {
        // A read-only cache (a mounted or vendored copy) can still be searched with
        // the index it has; say so rather than fail.
        if (!['EACCES', 'EPERM', 'EROFS'].includes(e?.code)) throw e;
        stale = `index not refreshed (${e.code}: cache is read-only); results may be stale`;
      }
    }
    const { terms: allTerms, identifiers } = queryTerms(query);
    const terms = allTerms.slice(0, 30); // reranker bitmasks are 31-bit
    const weights = o.weights || DEFAULT_WEIGHTS;
    const rr = { ...RERANK_DEFAULTS, ...(o.rerank || {}) };
    const filters = { domain: o.domain, pathPrefix: o.pathPrefix };
    const cands = idx.search({ terms, weights, limit: o.candidates, ...filters });

    // Exact-symbol lookups: a query naming an API identifier should land on the
    // section that defines it (symbol in its heading), then on code that uses it.
    const byId = new Map(cands.map(c => [c.id, c]));
    for (const ident of identifiers) {
      const name = fold(ident);
      const tails = [name];
      // `types.GenerateContentConfig` should also find `google.genai.types.GenerateContentConfig`
      // headings; try the last segment on its own too.
      if (name.includes('.')) tails.push(name.split('.').pop());
      for (const n of tails) {
        let hits = idx.symbols(n);
        let factor = n === name ? 1 : 0.7;
        // No exact name: a prefix may still identify it (`useEdges` → `useEdgesState`).
        if (!hits.length && n === name && n.length >= 5) {
          hits = idx.symbols(n, { prefix: true });
          factor = 0.5;
        }
        // Full boost when a heading *is* the name (a definition); a fraction when the
        // name is one word of a heading, shrinking with how many headings use it —
        // `GraphQL` is a word of every "GraphQL query" heading on shopify.dev.
        const partial = hits.filter(h => h.def === 1).length;
        const rarity = 1 / Math.max(1, Math.log2(partial));
        for (const h of hits) {
          if (!passes(h, filters)) continue;
          const base = h.def === 2 ? rr.symDef : h.def === 1 ? rr.symDef * rr.symPartial * rarity : rr.symCode;
          const boost = base * factor;
          const c = byId.get(h.id) || { ...h, score: 0 };
          c.sym = Math.max(c.sym || 0, boost);
          byId.set(h.id, c);
        }
      }
    }

    // Rerank: IDF-weighted coverage, proximity and own-heading match (rank.mjs).
    const df = idx.docFreq(terms);
    const N = idx.unitCount();
    const present = terms.filter(t => df.get(t) > 0);
    // A symbol boost is for queries *about* that symbol; in "setup script versus
    // SessionStart hook" it is one concept of several, so scale its boost by the
    // identifier's share of the query's IDF weight (^symShare).
    if (rr.symShare && identifiers.length) {
      const idfT = t => idfOf(df.get(t) || 0, N);
      const total = present.reduce((a, t) => a + idfT(t), 0) || 1;
      const idTerms = new Set(identifiers.flatMap(i => tokenize(i)));
      const share = present.filter(t => idTerms.has(t)).reduce((a, t) => a + idfT(t), 0) / total;
      const f = Math.pow(Math.max(0.05, share), rr.symShare);
      for (const c of byId.values()) if (c.sym) c.sym *= f;
    }
    const files = new Map();
    const readLines = path => {
      let lines = files.get(path);
      if (!lines) {
        try { lines = splitLines(readFileSync(join(rootAbs, path), 'utf-8')); } catch { lines = []; }
        files.set(path, lines);
      }
      return lines;
    };
    const masks = new LineMasks(present, readLines);
    const titles = new Map();
    const titleOf = path => {
      if (!titles.has(path)) titles.set(path, idx.fileMeta(path)?.title || null);
      return titles.get(path);
    };
    const ranked = rerank([...byId.values()], {
      terms: present, idf: present.map(t => idfOf(df.get(t), N)), masks, titleOf, opts: rr,
    });

    const results = groupResults(ranked, o);
    const qset = new Set(present);
    for (const r of results) {
      finishResult(r, readLines(r.path), qset, identifiers, masks);
      r.title = titleOf(r.path);
    }
    const out = { query, backend: idx.name, results, refreshed };
    if (stale) out.stale = stale;
    if (o.debug) {
      out.terms = present;
      out.candidates = ranked.slice(0, o.debug === true ? 15 : o.debug).map(c => ({
        at: `${c.path}:${c.start}-${c.end}`, heading: c.heading,
        bm25: +c.score.toFixed(3), cov: +c.cov.toFixed(2), local: +c.local.toFixed(2), head: +c.head.toFixed(2),
        sym: c.sym || 0, rank: +c.rank.toFixed(3),
      }));
    }
    return out;
  } finally {
    if (!opts.index) idx.close();
  }
}

function passes(u, { domain, pathPrefix }) {
  if (domain && !(u.path === `${domain}.md` || u.path.startsWith(`${domain}/`))) return false;
  if (pathPrefix && !u.path.startsWith(pathPrefix)) return false;
  return true;
}

/**
 * Pick the top results: skip ranges overlapping (or touching) one already chosen
 * in the same file — overlapping windows and parent/child sections would
 * otherwise repeat the same lines — and cap results per file for diversity.
 */
export function groupResults(ranked, { limit, perFile, mergeLines = SEARCH_DEFAULTS.mergeLines }) {
  const chosen = [];
  const perPath = new Map();
  for (const c of ranked) {
    if (chosen.length >= limit) break;
    const list = perPath.get(c.path) || [];
    if (list.length >= perFile) continue;
    const range = displayRange(c);
    const hit = list.find(r => range.start <= r.end + 1 && range.end >= r.start - 1);
    if (hit) {
      // Overlaps a better-ranked range: drop it (default), or merge it in when the
      // union stays within mergeLines.
      const s = Math.min(hit.start, range.start), e = Math.max(hit.end, range.end);
      if (e - s + 1 <= mergeLines) { hit.start = s; hit.end = e; }
      continue;
    }
    const r = { path: c.path, start: range.start, end: range.end, heading: c.heading, level: c.level, score: c.rank, id: c.id, bestLine: c.bestLine };
    list.push(r);
    perPath.set(c.path, list);
    chosen.push(r);
  }
  return chosen;
}

/**
 * A heading whose own content is (nearly) empty — `## Configuration` directly
 * followed by `### Hook locations` — is useless as a 2-line answer; show the
 * start of its subsections instead.
 */
function displayRange(c) {
  let end = c.end;
  if (!c.window && end - c.start < 3 && c.spanEnd > end) end = Math.min(c.spanEnd, c.start + 40);
  return { start: c.start, end };
}

/** Plain text for a snippet: markup removed, whitespace collapsed. */
function plain(line) {
  return line
    .replace(/<wbr\s*\/?>/gi, '')
    .replace(/\{\/\*.*?\*\/\}/g, '')                        // MDX comments
    .replace(/!\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', '#39': "'" })[e])
    .replace(/^\s*(?:[-*+]\s+|\d+\.\s+|>+\s*|\|\s*)/, '')
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/[*_]{2,}/g, '')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s),.:;]|$)/g, '$1$2') // *emphasis*
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>=])/g, '$1')                     // markdown escapes
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fill in line count, size and the snippet (the reranker's best line when it has one). */
function finishResult(r, lines, qset, identifiers, masks) {
  r.end = Math.min(r.end, lines.length || r.end);
  r.lines = r.end - r.start + 1;
  let chars = 0;
  for (let l = r.start; l <= r.end; l++) chars += (lines[l - 1] || '').length + 1;
  r.tokens = Math.ceil(chars / 4);
  const idents = identifiers.map(fold);
  const usable = l => {
    const raw = lines[l - 1] || '';
    if (!raw.trim() || /^\s*(```|~~~|\|?\s*:?-{3,}|\[\s*\u200b?\s*$|\]\(#)/.test(raw)) return false;
    return !/^\s{0,3}#{1,6}(\s|$)/.test(raw); // the heading is shown already
  };
  let best = null, bestScore = -1;
  const consider = l => {
    if (!usable(l)) return;
    const text = plain(lines[l - 1].length > 4000 ? lines[l - 1].slice(0, 4000) : lines[l - 1]);
    if (!text) return;
    let s = 0;
    const m = masks.line(r.path, l);
    for (let x = m; x; x >>>= 1) s += x & 1;
    const low = text.toLowerCase();
    for (const id of idents) if (low.includes(id)) s += 2;
    if (s > bestScore) { best = text; bestScore = s; }
  };
  if (r.bestLine && r.bestLine >= r.start && r.bestLine <= r.end) consider(r.bestLine);
  if (bestScore <= 0) for (let l = r.start; l <= Math.min(r.end, r.start + 300); l++) consider(l);
  r.snippet = clipAround(best || '', qset, SNIPPET_CHARS);
}

const SNIPPET_CHARS = 110;

function clipAround(text, qset, max) {
  if (text.length <= max) return text;
  const low = text.toLowerCase();
  let pos = -1;
  for (const t of qset) {
    if (STOPWORDS.has(t) || t.length < 3) continue;
    const i = low.indexOf(t);
    if (i !== -1 && (pos === -1 || i < pos)) pos = i;
  }
  let start = pos > 50 ? pos - 40 : 0;
  // Start on a word boundary.
  if (start > 0) { const sp = text.indexOf(' ', start); if (sp !== -1 && sp - start < 15) start = sp + 1; }
  const out = text.slice(start, start + max);
  return (start > 0 ? '…' : '') + out.trimEnd() + (start + max < text.length ? '…' : '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Output formats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Heading path for display, relative to the page (the page title is printed on
 * the file line): a leading heading equal to the title is dropped, long paths are
 * elided in the middle.
 */
export function displayHeading(heading, title) {
  let parts = heading ? heading.split(' › ') : [];
  if (parts.length && title && (parts[0] === title || title.startsWith(parts[0]))) parts = parts.slice(1);
  if (!parts.length) return '';
  let h = parts.length > 3 ? [parts[0], '…', ...parts.slice(-2)].join(' › ') : parts.join(' › ');
  if (h.length > 100) h = '…' + h.slice(-99);
  return h;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/**
 * Compact text output: results grouped by file (files in order of their best
 * result), one line per range:
 *
 *   code.claude.com/docs/en/hooks.md — Hooks reference
 *     1550-1589 (40 lines) Hook events › PreToolUse › PreToolUse decision control — `PreToolUse` hooks can…
 *
 * Read a range with Read(file, offset=start, limit=lines). The path is printed once
 * per file (paths are the longest part of a line); ranges within a file are in
 * rank order. Stops at the token budget and a hard character cap.
 * @param {{results: object[], query: string}} res
 * @param {{prefix?: string, budget?: number, maxChars?: number}} opts prefix: turns a
 *   root-relative path into one Read-able from the cwd
 */
export function formatText(res, { prefix = '', budget = SEARCH_DEFAULTS.budget, maxChars = SEARCH_DEFAULTS.maxChars } = {}) {
  if (!res.results.length) return `No sections match "${res.query}". Try fewer or different words, or check \`docs catalog\`.`;
  const cap = Math.min(maxChars, budget * 4);
  const groups = new Map();
  for (const r of res.results) {
    if (!groups.has(r.path)) groups.set(r.path, []);
    groups.get(r.path).push(r);
  }
  const out = [];
  let used = 0, shown = 0;
  outer:
  for (const [path, rs] of groups) {
    const title = rs[0].title;
    const header = `${prefix}${path}${title ? ` — ${clip(title, 70)}` : ''}`;
    let headerDone = false;
    for (const r of rs) {
      const size = r.tokens > Math.max(2000, r.lines * 60) ? `${r.lines} lines, ~${Math.round(r.tokens / 1000)}k tok` : `${r.lines} lines`;
      const heading = displayHeading(r.heading, title);
      const snip = r.snippet && r.snippet.toLowerCase() !== heading.toLowerCase() ? ` — ${r.snippet}` : '';
      const line = `  ${r.start}-${r.end} (${size})${heading ? ' ' + heading : ''}${snip}`;
      const cost = line.length + 1 + (headerDone ? 0 : header.length + 1);
      if (shown && used + cost > cap) break outer;
      if (!headerDone) { out.push(header); headerDone = true; }
      out.push(line);
      used += cost;
      shown++;
    }
  }
  if (shown < res.results.length) out.push(`(${res.results.length - shown} more; raise --budget)`);
  return out.join('\n');
}

/** Structured output for --json. */
export function formatJson(res, { prefix = '' } = {}) {
  return {
    query: res.query,
    backend: res.backend,
    results: res.results.map(r => ({
      path: r.path, file: prefix + r.path, start: r.start, end: r.end, lines: r.lines, tokens: r.tokens,
      heading: r.heading ? r.heading.split(' › ') : [], snippet: r.snippet, score: Number(r.score.toFixed(4)),
    })),
  };
}
