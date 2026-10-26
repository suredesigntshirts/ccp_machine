/**
 * Second-stage ranking over the BM25 candidates.
 *
 * BM25 with an OR query rewards a section that repeats one rare query word as
 * much as one that contains all of them, and length normalisation over-rewards
 * tiny sections. On the eval set the misses were dominated by exactly that, plus
 * table rows: a row matching every query word on one line, lost in a 60-line
 * window that BM25 scores as a whole. So, for the top candidates, we read their
 * lines and compute IDF-weighted features (each 0..1):
 *
 *   cov    share of the query's (IDF-weighted) terms present within the best
 *          window of `covLines` lines, together with the unit's heading path and
 *          page path/title. A window, not the whole unit: whole-unit coverage
 *          rewarded long sections for mentioning everything somewhere;
 *   local  best share within `localLines` lines plus the own heading (proximity);
 *   head   share present in the unit's own heading.
 *
 *   score = wBm25 · bm25/max(bm25) + wCov · cov + wLocal · local + wHead · head + symbol boost
 *
 * Only `cov` earned a weight on the dev split (local and head lowered MRR at every
 * weight tried); `local` still picks the snippet line. Weights and the experiments
 * behind them: eval/search/RESULTS.md.
 */

import { tokenize } from './tokenize.mjs';
import { bodyText, pathText } from './files.mjs';

export const RERANK_DEFAULTS = {
  top: 60,        // BM25 candidates reranked (the rest keep BM25 order below them)
  wBm25: 1,
  wCov: 0.5,
  wLocal: 0,      // proximity: tested 0.3–1, hurt dev MRR; still picks the snippet line
  wHead: 0,       // own-heading share: tested 0.2–0.3, hurt dev MRR
  localLines: 3,  // proximity window, in non-blank lines
  covLines: 5,    // coverage window in non-blank lines (0 = the whole unit)
  symShare: 1,    // exponent: scale symbol boosts by the identifier's share of the query
  symDef: 0.6,    // query names an identifier that this unit's heading defines
  symPartial: 0.35, // … that is one word of this unit's heading (× rarity)
  symCode: 0.1,   // … that this unit's code mentions
  maxLines: 400,  // lines read per candidate
};

/** IDF like FTS5's bm25(): floored so a term in most units still counts a little. */
export function idfOf(df, N) {
  const v = Math.log((N - df + 0.5) / (df + 0.5));
  return v <= 0 ? 1e-6 : v;
}

/**
 * Per-file cache of each line's query-term bitmask (bit i = terms[i] present).
 * Windows of one section overlap, so candidates from the same page share work.
 */
export class LineMasks {
  constructor(terms, readLines) {
    this.bit = new Map(terms.map((t, i) => [t, 1 << i]));
    this.readLines = readLines;
    this.files = new Map();
  }

  maskOf(text) {
    let m = 0;
    for (const t of tokenize(text)) m |= this.bit.get(t) || 0;
    return m;
  }

  /** @returns {{lines: string[], masks: Int32Array, done: Uint8Array}} */
  file(path) {
    let f = this.files.get(path);
    if (!f) {
      const lines = this.readLines(path);
      f = { lines, masks: new Int32Array(lines.length + 1), done: new Uint8Array(lines.length + 1) };
      this.files.set(path, f);
    }
    return f;
  }

  line(path, l) {
    const f = this.file(path);
    if (l < 1 || l > f.lines.length) return 0;
    if (!f.done[l]) {
      const raw = f.lines[l - 1];
      f.masks[l] = raw.trim() ? this.maskOf(bodyText(raw)) : 0;
      f.done[l] = 1;
    }
    return f.masks[l];
  }
}

/**
 * Rerank candidates in place order; returns a new sorted array with `rank`,
 * feature values and `bestLine` set.
 * @param {object[]} cands units with {id, path, start, end, heading, score (bm25), sym (boost)}
 * @param {{terms: string[], idf: number[], masks: LineMasks, titleOf: (path) => string|null, opts?: object}} ctx
 */
export function rerank(cands, { terms, idf, masks, titleOf, opts = {} }) {
  const o = { ...RERANK_DEFAULTS, ...opts };
  const total = idf.reduce((a, b) => a + b, 0) || 1;
  const weight = m => {
    let s = 0;
    for (let i = 0; m; i++, m >>>= 1) if (m & 1) s += idf[i];
    return s / total;
  };
  const maxBm25 = Math.max(1e-9, ...cands.map(c => c.score));
  const byBm25 = [...cands].sort((a, b) => b.score - a.score || a.id - b.id);
  const pathMask = new Map();
  const out = [];
  byBm25.forEach((c, i) => {
    let cov = 0, local = 0, head = 0, bestLine = null;
    if (i < o.top || c.sym) {
      if (!pathMask.has(c.path)) pathMask.set(c.path, masks.maskOf(`${pathText(c.path)} ${titleOf(c.path) || ''}`));
      const parts = c.heading ? c.heading.split(' › ') : [];
      const ownHead = parts.length ? masks.maskOf(parts[parts.length - 1]) : 0;
      let unit = pathMask.get(c.path) | masks.maskOf(c.heading || '') | ownHead;
      // Proximity: a window of `localLines` non-blank lines, plus the own heading.
      const win = [];
      let winMask = 0, bestW = -1;
      // Coverage within a window of `covLines` lines (plus heading path and page),
      // so a long section does not win just by being long enough to mention everything.
      const cwin = [];
      let bestCov = 0;
      const ctx = unit;
      const end = Math.min(c.end, c.start + o.maxLines);
      for (let l = c.start; l <= end; l++) {
        const m = masks.line(c.path, l);
        if (!masks.file(c.path).lines[l - 1]?.trim()) continue;
        unit |= m;
        if (o.covLines) {
          cwin.push(m);
          if (cwin.length > o.covLines) cwin.shift();
          let cm = ctx;
          for (const x of cwin) cm |= x;
          const cw = weight(cm);
          if (cw > bestCov) bestCov = cw;
        }
        win.push([l, m]);
        if (win.length > o.localLines) win.shift();
        winMask = 0;
        for (const [, wm] of win) winMask |= wm;
        const w = weight(winMask | ownHead);
        if (w > bestW) {
          bestW = w;
          // Best line inside the window: the one carrying the most weight itself.
          let bl = win[win.length - 1];
          for (const x of win) if (weight(x[1]) > weight(bl[1])) bl = x;
          bestLine = bl[0];
        }
      }
      cov = o.covLines ? Math.max(bestCov, weight(ctx)) : weight(unit);
      local = Math.max(0, bestW);
      head = weight(ownHead);
    }
    const rank = o.wBm25 * c.score / maxBm25 + o.wCov * cov + o.wLocal * local + o.wHead * head + (c.sym || 0);
    out.push({ ...c, rank, cov, local, head, bestLine });
  });
  out.sort((a, b) => b.rank - a.rank || a.id - b.id);
  return out;
}
