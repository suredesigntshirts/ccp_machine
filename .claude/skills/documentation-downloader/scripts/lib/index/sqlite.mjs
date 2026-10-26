/**
 * SQLite FTS5 index backend (`node:sqlite`, Node ≥ 22.13 unflagged).
 *
 * Text arrives pre-tokenized (tokenize.mjs) as space-separated terms, so FTS5 only
 * splits on spaces; stemming and identifier splitting happen in JS so this backend
 * and the pure-JS one rank identically.
 *
 * Concurrency: WAL (readers never block the writer or each other) plus a busy
 * timeout (writers queue instead of failing), and every update is one
 * `BEGIN IMMEDIATE` transaction, so a reader sees a file's units either all old
 * or all new — never half.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let sqliteModule; // undefined = not tried, null = unavailable

/**
 * Load node:sqlite without printing its ExperimentalWarning. The filter is
 * installed only around this one import, so other experimental warnings still show.
 */
export async function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  const orig = process.emitWarning;
  process.emitWarning = function (warning, ...args) {
    const msg = typeof warning === 'string' ? warning : warning?.message;
    const type = typeof args[0] === 'string' ? args[0] : (args[0]?.type || warning?.name);
    if (type === 'ExperimentalWarning' && /sqlite/i.test(msg || '')) return;
    return orig.call(this, warning, ...args);
  };
  try {
    const mod = await import('node:sqlite');
    // FTS5 must be compiled in (it is in Node's bundled SQLite; check anyway).
    const probe = new mod.DatabaseSync(':memory:');
    probe.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
    probe.close();
    sqliteModule = mod;
  } catch {
    sqliteModule = null;
  } finally {
    process.emitWarning = orig;
  }
  return sqliteModule;
}

export const FIELD_NAMES = ['p', 'h', 's', 'b'];

function ftsQuote(term) {
  return `"${term.replace(/"/g, '""')}"`;
}

export class SqliteIndex {
  static async open(file) {
    const mod = await loadSqlite();
    if (!mod) throw new Error('node:sqlite is not available');
    mkdirSync(dirname(file), { recursive: true });
    const db = new mod.DatabaseSync(file);
    const idx = new SqliteIndex(db, file);
    idx.init();
    return idx;
  }

  constructor(db, file) {
    this.db = db;
    this.file = file;
    this.name = 'sqlite';
  }

  init() {
    const db = this.db;
    db.exec('PRAGMA busy_timeout = 30000');
    // journal_mode=WAL is persistent; setting it needs a brief write lock, so do it
    // only when the database is not already in WAL mode.
    const mode = db.prepare('PRAGMA journal_mode').get();
    if (String(Object.values(mode)[0]).toLowerCase() !== 'wal') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files'").get();
    if (!has) {
      this.tx(() => {
        // Re-check inside the write lock: another process may have created it.
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files'").get()) return;
        db.exec(`
          CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
          CREATE TABLE files(
            path TEXT PRIMARY KEY, domain TEXT NOT NULL, mtime INTEGER, size INTEGER, hash TEXT,
            lines INTEGER, title TEXT, description TEXT, source TEXT);
          CREATE INDEX files_by_source ON files(source);
          CREATE TABLE units(
            id INTEGER PRIMARY KEY, path TEXT NOT NULL, start INTEGER, "end" INTEGER, span_end INTEGER,
            level INTEGER, heading TEXT, win INTEGER);
          CREATE INDEX units_by_path ON units(path);
          CREATE TABLE symbols(name TEXT NOT NULL, unit INTEGER NOT NULL, def INTEGER NOT NULL);
          CREATE INDEX symbols_by_name ON symbols(name);
          CREATE INDEX symbols_by_unit ON symbols(unit);
        `);
        try {
          db.exec(`CREATE VIRTUAL TABLE fts USING fts5(p, h, s, b, content='', contentless_delete=1,
            tokenize="unicode61 remove_diacritics 0 tokenchars '._$'")`);
        } catch {
          // SQLite < 3.43 has no contentless_delete: store content (bigger, same results).
          db.exec(`CREATE VIRTUAL TABLE fts USING fts5(p, h, s, b,
            tokenize="unicode61 remove_diacritics 0 tokenchars '._$'")`);
        }
        db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema', '1');
      });
    }
    this.stmts = {
      fileStates: db.prepare('SELECT path, mtime, size, hash FROM files'),
      files: db.prepare('SELECT path, domain, lines, title, description, source FROM files ORDER BY path'),
      fileBySource: db.prepare('SELECT path FROM files WHERE source = ?'),
      fileMeta: db.prepare('SELECT path, domain, lines, title, description, source FROM files WHERE path = ?'),
      unitIds: db.prepare('SELECT id FROM units WHERE path = ?'),
      delFts: db.prepare('DELETE FROM fts WHERE rowid = ?'),
      delSymbols: db.prepare('DELETE FROM symbols WHERE unit IN (SELECT id FROM units WHERE path = ?)'),
      delUnits: db.prepare('DELETE FROM units WHERE path = ?'),
      delFile: db.prepare('DELETE FROM files WHERE path = ?'),
      touch: db.prepare('UPDATE files SET mtime = ?, size = ? WHERE path = ?'),
      insFile: db.prepare(`INSERT OR REPLACE INTO files(path, domain, mtime, size, hash, lines, title, description, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      insUnit: db.prepare('INSERT INTO units(path, start, "end", span_end, level, heading, win) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      insFts: db.prepare('INSERT INTO fts(rowid, p, h, s, b) VALUES (?, ?, ?, ?, ?)'),
      insSym: db.prepare('INSERT INTO symbols(name, unit, def) VALUES (?, ?, ?)'),
      symExact: db.prepare(`SELECT s.unit AS id, s.def, u.path, u.start, u."end", u.span_end, u.level, u.heading, u.win
        FROM symbols s JOIN units u ON u.id = s.unit WHERE s.name = ? LIMIT 200`),
      symPrefix: db.prepare(`SELECT s.unit AS id, s.def, s.name, u.path, u.start, u."end", u.span_end, u.level, u.heading, u.win
        FROM symbols s JOIN units u ON u.id = s.unit WHERE s.name > ? AND s.name < ? LIMIT 200`),
    };
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }

  /** @returns {Map<string, {mtime:number, size:number, hash:string}>} */
  fileStates() {
    const m = new Map();
    for (const r of this.stmts.fileStates.all()) m.set(r.path, { mtime: r.mtime, size: r.size, hash: r.hash });
    return m;
  }

  files() {
    return this.stmts.files.all().map(r => ({ ...r }));
  }

  fileMeta(path) {
    const r = this.stmts.fileMeta.get(path);
    return r ? { ...r } : null;
  }

  pathsForSource(url) {
    return this.stmts.fileBySource.all(url).map(r => r.path);
  }

  #deletePath(path) {
    const s = this.stmts;
    for (const { id } of s.unitIds.all(path)) s.delFts.run(id);
    s.delSymbols.run(path);
    s.delUnits.run(path);
    s.delFile.run(path);
  }

  /**
   * Apply a batch of changes atomically.
   * @param {{upserts?: object[], deletes?: string[], touches?: object[], reset?: boolean}} changes
   *   upserts: {meta, mtime, size, hash, units} (from files.analyzePage + stat)
   */
  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  }

  update({ upserts = [], deletes = [], touches = [], reset = false, meta = null } = {}) {
    const s = this.stmts;
    this.tx(() => {
      if (meta) {
        const put = this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)');
        for (const [k, v] of Object.entries(meta)) put.run(k, v);
      }
      if (reset) {
        this.db.exec("DELETE FROM symbols; DELETE FROM units; DELETE FROM files; DELETE FROM fts;");
      }
      for (const p of deletes) this.#deletePath(p);
      for (const t of touches) s.touch.run(t.mtime, t.size, t.path);
      for (const f of upserts) {
        const m = f.meta;
        this.#deletePath(m.path);
        s.insFile.run(m.path, m.domain, f.mtime, f.size, f.hash, m.lines, m.title, m.description, m.source);
        for (const u of f.units) {
          const { lastInsertRowid: id } = s.insUnit.run(m.path, u.start, u.end, u.spanEnd, u.level, u.heading, u.window);
          s.insFts.run(id, ...u.fields);
          for (const [name, def] of u.symbols) s.insSym.run(name, id, def);
        }
      }
    });
  }

  /**
   * BM25 candidates. Scores are positive, higher is better.
   * @param {{terms:string[], weights:number[], limit:number, domain?:string, pathPrefix?:string, prefixTerms?:string[]}} q
   */
  search({ terms, weights, limit = 200, domain, pathPrefix, prefixTerms = [] }) {
    if (!terms.length && !prefixTerms.length) return [];
    const match = [...terms.map(ftsQuote), ...prefixTerms.map(t => `${ftsQuote(t)}*`)].join(' OR ');
    const where = [];
    const params = [match];
    // substr() rather than LIKE: `_` is a LIKE wildcard and common in doc paths.
    if (domain) {
      where.push('(u.path = ? OR substr(u.path, 1, ?) = ?)');
      params.push(`${domain}.md`, domain.length + 1, `${domain}/`);
    }
    if (pathPrefix) { where.push('substr(u.path, 1, ?) = ?'); params.push(pathPrefix.length, pathPrefix); }
    const sql = `SELECT u.id, u.path, u.start, u."end" AS "end", u.span_end, u.level, u.heading, u.win,
        bm25(fts, ${weights.map(Number).join(', ')}) AS score
      FROM fts JOIN units u ON u.id = fts.rowid
      WHERE fts MATCH ? ${where.length ? 'AND ' + where.join(' AND ') : ''}
      ORDER BY score LIMIT ${Number(limit)}`;
    return this.db.prepare(sql).all(...params).map(r => ({
      id: r.id, path: r.path, start: r.start, end: r.end, spanEnd: r.span_end,
      level: r.level, heading: r.heading, window: r.win, score: -r.score,
    }));
  }

  /** Units whose symbols equal (or, with prefix, start with) a folded name. */
  symbols(name, { prefix = false } = {}) {
    const rows = prefix ? this.stmts.symPrefix.all(name, name + '￿') : this.stmts.symExact.all(name);
    return rows.map(r => ({
      id: r.id, def: r.def, name: r.name || name, path: r.path, start: r.start, end: r.end, spanEnd: r.span_end,
      level: r.level, heading: r.heading, window: r.win,
    }));
  }

  /** Number of units containing each term (for IDF weights in the reranker). */
  docFreq(terms) {
    if (!this.vocab) {
      // A temp-schema vocab table: per connection, so creating it takes no write lock.
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.fts_vocab USING fts5vocab(main, 'fts', 'row')");
      this.vocab = this.db.prepare('SELECT doc FROM temp.fts_vocab WHERE term = ?');
    }
    const m = new Map();
    for (const t of terms) m.set(t, this.vocab.get(t)?.doc || 0);
    return m;
  }

  unitCount() {
    return Object.values(this.db.prepare('SELECT count(*) FROM units').get())[0];
  }

  stats() {
    const one = sql => Object.values(this.db.prepare(sql).get())[0];
    return {
      backend: this.name,
      file: this.file,
      files: one('SELECT count(*) FROM files'),
      units: one('SELECT count(*) FROM units'),
      symbols: one('SELECT count(*) FROM symbols'),
      bytes: one('SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()'),
    };
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }
}
