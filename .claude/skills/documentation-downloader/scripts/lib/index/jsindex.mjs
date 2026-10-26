/**
 * Pure-JS index backend, for Node < 22.13 (no `node:sqlite`).
 *
 * Same interface and the same ranking as the SQLite backend: terms are
 * pre-tokenized identically, and `search()` reproduces FTS5's bm25() (weighted
 * term frequency per phrase, whole-row length normalisation, k1 = 1.2, b = 0.75,
 * IDF floored at 1e-6), so the two backends return the same order.
 *
 * Layout: postings are stored *per file* ({term: [unit, packedCounts, …]}). A
 * query then costs a few hash lookups per file — no global postings to build on
 * load — and an incremental update replaces one file's entry without touching
 * the rest. (Measured on the 23 MB fixture: building global postings on load cost
 * ~500 ms per search; per-file lookups cost ~10 ms after the JSON parse.)
 *
 * Persistence: one JSON file, written to a temp file and renamed (atomic), by one
 * writer at a time (the caller holds the index lock). Readers never lock: they see
 * the old or the new file, never a partial one.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

const K1 = 1.2;
const B = 0.75;
const SCHEMA = 2;
// Per-field count packing: p, h, s ≤ 99; b ≤ 9999 (BM25 saturates long before).
const cap = (n, m) => (n > m ? m : n);
const pack = (p, h, s, b) => cap(b, 9999) + 10000 * (cap(s, 99) + 100 * (cap(h, 99) + 100 * cap(p, 99)));
const unpack = x => [Math.floor(x / 1e8), Math.floor(x / 1e6) % 100, Math.floor(x / 1e4) % 100, x % 1e4];
const weighted = (x, w) => w[0] * Math.floor(x / 1e8) + w[1] * (Math.floor(x / 1e6) % 100)
  + w[2] * (Math.floor(x / 1e4) % 100) + w[3] * (x % 1e4);

/** One file's persisted entry: unit list + per-file postings + symbols. */
function encodeFile(f) {
  const units = [];
  const post = Object.create(null);
  const sym = Object.create(null);
  let len = 0;
  f.units.forEach((u, i) => {
    const counts = new Map();
    let n = 0;
    for (let k = 0; k < 4; k++) {
      if (!u.fields[k]) continue;
      for (const t of u.fields[k].split(' ')) {
        if (!t) continue;
        n++;
        let c = counts.get(t);
        if (!c) { c = [0, 0, 0, 0]; counts.set(t, c); }
        c[k]++;
      }
    }
    for (const [t, c] of counts) (post[t] ||= []).push(i, pack(c[0], c[1], c[2], c[3]));
    for (const [name, def] of u.symbols) (sym[name] ||= []).push(i, def);
    len += n;
    units.push([u.start, u.end, u.spanEnd, u.level, u.heading, u.window, n]);
  });
  return { units, post, sym, len };
}

export class JsonIndex {
  static async open(file) {
    const idx = new JsonIndex(file);
    idx.load();
    return idx;
  }

  constructor(file) {
    this.file = file;
    this.name = 'json';
    this.data = { schema: SCHEMA, files: {} };
    this.mem = null;
  }

  /**
   * (Re)read the index file — unless it is the very file we already hold (same
   * inode, size, mtime): parsing costs ~300 ms on a 23 MB cache, and a refresh
   * calls load() up to three times (open, re-plan under the lock, update).
   */
  load() {
    let st = null;
    try { st = statSync(this.file); } catch { /* not written yet */ }
    const sig = st ? `${st.ino}:${st.size}:${st.mtimeMs}` : null;
    if (sig && sig === this.sig) return;
    this.mem = null;
    this.sig = null;
    this.data = { schema: SCHEMA, files: {} };
    if (!st) return;
    try {
      const d = JSON.parse(readFileSync(this.file, 'utf-8'));
      if (d?.schema === SCHEMA && d.files) { this.data = d; this.sig = sig; }
    } catch { /* unreadable: start empty (the caller refreshes) */ }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
      const st = statSync(this.file);
      this.sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* nothing to clean */ }
      throw e;
    }
  }

  fileStates() {
    const m = new Map();
    for (const [p, f] of Object.entries(this.data.files)) m.set(p, { mtime: f.mtime, size: f.size, hash: f.hash });
    return m;
  }

  fileMeta(path) {
    const f = this.data.files[path];
    return f ? { path, domain: f.domain, lines: f.lines, title: f.title, description: f.description, source: f.source } : null;
  }

  files() {
    return Object.keys(this.data.files).sort().map(p => this.fileMeta(p));
  }

  pathsForSource(url) {
    return Object.keys(this.data.files).filter(p => this.data.files[p].source === url);
  }

  /** Apply changes and persist. The caller must hold the index write lock. */
  getMeta(key) {
    return this.data.meta?.[key] ?? null;
  }

  update({ upserts = [], deletes = [], touches = [], reset = false, meta = null } = {}) {
    // Re-read first: another process may have written since we loaded.
    if (reset) this.data = { schema: SCHEMA, files: {}, meta: this.data.meta || {} };
    else this.load();
    if (meta) this.data.meta = { ...(this.data.meta || {}), ...meta };
    const files = this.data.files;
    for (const p of deletes) delete files[p];
    for (const t of touches) if (files[t.path]) Object.assign(files[t.path], { mtime: t.mtime, size: t.size });
    for (const f of upserts) {
      const m = f.meta;
      files[m.path] = {
        domain: m.domain, mtime: f.mtime, size: f.size, hash: f.hash, lines: m.lines,
        title: m.title, description: m.description, source: m.source,
        ...encodeFile(f),
      };
    }
    this.save();
    this.mem = null;
  }

  /** Global numbering of units (ids are per-process, used to join BM25 and symbol hits). */
  #memory() {
    if (this.mem) return this.mem;
    const paths = Object.keys(this.data.files);
    const base = new Map();
    let n = 0, total = 0;
    for (const p of paths) {
      base.set(p, n);
      n += this.data.files[p].units.length;
      total += this.data.files[p].len;
    }
    this.mem = { paths, base, nUnits: n, avgdl: n ? total / n : 1 };
    return this.mem;
  }

  #unit(path, i, id) {
    const [start, end, spanEnd, level, heading, window] = this.data.files[path].units[i];
    return { id, path, start, end, spanEnd, level, heading, window };
  }

  search({ terms, weights, limit = 200, domain, pathPrefix, prefixTerms = [] }) {
    const mem = this.#memory();
    const allow = p => (!domain || p === `${domain}.md` || p.startsWith(`${domain}/`))
      && (!pathPrefix || p.startsWith(pathPrefix));
    // Phrases: each term, and each prefix term (all its expansions as one phrase, like FTS5).
    const phrases = [];
    for (const t of terms) phrases.push(post => post[t]);
    for (const pre of prefixTerms) {
      phrases.push(post => {
        const merged = new Map();
        for (const k in post) {
          if (!k.startsWith(pre)) continue;
          const p = post[k];
          for (let j = 0; j < p.length; j += 2) {
            const c = unpack(p[j + 1]);
            const prev = merged.get(p[j]);
            if (prev) for (let k = 0; k < 4; k++) prev[k] += c[k];
            else merged.set(p[j], c);
          }
        }
        if (!merged.size) return undefined;
        const out = [];
        for (const [i, c] of merged) out.push(i, pack(c[0], c[1], c[2], c[3]));
        return out;
      });
    }
    // Pass 1: document frequency of each phrase over the whole index (IDF is global).
    const perFile = [];
    const nHit = new Array(phrases.length).fill(0);
    for (const p of mem.paths) {
      const post = this.data.files[p].post;
      const lists = phrases.map(get => get(post));
      if (lists.every(l => !l)) continue;
      lists.forEach((l, i) => { if (l) nHit[i] += l.length / 2; });
      perFile.push([p, lists]);
    }
    const N = mem.nUnits;
    const idf = nHit.map(h => {
      const v = Math.log((N - h + 0.5) / (h + 0.5));
      return v <= 0 ? 1e-6 : v;
    });
    // Pass 2: score units in files that pass the filters.
    const out = [];
    for (const [p, lists] of perFile) {
      if (!allow(p)) continue;
      const f = this.data.files[p];
      const scores = new Map();
      lists.forEach((l, i) => {
        if (!l) return;
        for (let j = 0; j < l.length; j += 2) {
          const u = l[j];
          const freq = weighted(l[j + 1], weights);
          const D = f.units[u][6];
          const s = idf[i] * (freq * (K1 + 1)) / (freq + K1 * (1 - B + B * D / mem.avgdl));
          scores.set(u, (scores.get(u) || 0) + s);
        }
      });
      const base = mem.base.get(p);
      for (const [u, score] of scores) out.push({ ...this.#unit(p, u, base + u), score });
    }
    // Ties broken by insertion order, as SQLite's rowid order does.
    out.sort((a, b) => b.score - a.score || a.id - b.id);
    return out.slice(0, limit);
  }

  symbols(name, { prefix = false } = {}) {
    const mem = this.#memory();
    const out = [];
    for (const p of mem.paths) {
      const sym = this.data.files[p].sym;
      const base = mem.base.get(p);
      const names = prefix ? Object.keys(sym).filter(n => n.startsWith(name) && n !== name) : (sym[name] ? [name] : []);
      for (const n of names) {
        const s = sym[n];
        for (let j = 0; j < s.length && out.length < 200; j += 2) {
          out.push({ ...this.#unit(p, s[j], base + s[j]), def: s[j + 1], name: n });
        }
      }
      if (out.length >= 200) break;
    }
    return out;
  }

  /** Number of units containing each term (for IDF weights in the reranker). */
  docFreq(terms) {
    const m = new Map(terms.map(t => [t, 0]));
    for (const f of Object.values(this.data.files)) {
      for (const t of terms) {
        const l = f.post[t];
        if (l) m.set(t, m.get(t) + l.length / 2);
      }
    }
    return m;
  }

  unitCount() {
    return this.#memory().nUnits;
  }

  stats() {
    let units = 0, symbols = 0;
    for (const f of Object.values(this.data.files)) {
      units += f.units.length;
      for (const k in f.sym) symbols += f.sym[k].length / 2;
    }
    let bytes = 0;
    try { bytes = statSync(this.file).size; } catch { /* not written yet */ }
    return { backend: this.name, file: this.file, files: Object.keys(this.data.files).length, units, symbols, bytes };
  }

  close() {}
}
