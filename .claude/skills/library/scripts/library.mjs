#!/usr/bin/env node
// library.mjs: catalog, map and upkeep for the project Library (/mnt/project-files).
// Zero dependencies, Node 18+. Every command is safe to run from any session; the ones
// that rewrite shared files (scan --write, build, mv --apply) want the librarian's lease.
//
// Why it looks like this (the theory, in short; the long form is the librarian skill's
// references/theory.md):
// - The mount costs ~100 ms per cold file open and ~85 opens/s in total, but a stat after
//   a directory listing is free. So the catalog is built from listings (cheap) and only
//   new or changed markdown files are opened. Readers open one catalog shard, not 50k files.
// - The coordinator sees only the first 150 entries of the Library, sorted by path. So the
//   names that sort first are a generated map (00-START-HERE.md, 01-map/), and the
//   librarian's own machinery sorts last (~librarian/).
// - Many sessions write at once and see each other's writes ~40 s late. So derived files are
//   regenerable caches, writes go to a dot temp name and are renamed, and moves are logged
//   in files named by their writer.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const MOUNT = '/mnt/project-files';
const ROOT = path.resolve(process.env.LIBRARY_ROOT || MOUNT);
const SYS = '~librarian';
const START = '00-START-HERE.md';
const MAP = '01-map';
const WRITER = (process.env.LIBRARY_WRITER || os.hostname() || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 40);
const MD_READ_LIMIT = 1 << 20;
const KIT_CLI = `${MOUNT}/${SYS}/kit/skills/library/scripts/library.mjs`;

const DEFAULT_POLICY = {
  version: 1,
  window: 150,
  reserve: 12,
  fanout_max: 400,
  settle_minutes: 10,
  lease_minutes: 90,
  dynamic_topics: 80,
  areas: {},
  map: [],
};

// ---------- small utilities ----------

const now = () => new Date();
const iso = (d = now()) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abs = (rel) => path.join(ROOT, rel);
const posix = (p) => p.split(path.sep).join('/');

function die(msg, code = 2) {
  process.stderr.write(`library: ${msg}\n`);
  process.exit(code);
}

async function pool(items, jobs, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

// Atomic write: dot temp name in the same folder, then rename over. Readers skip dot files.
async function writeAtomic(rel, text) {
  const file = abs(rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${WRITER}-${process.pid}`);
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, file);
}

async function readText(rel, limit = MD_READ_LIMIT) {
  const fh = await fsp.open(abs(rel), 'r');
  try {
    const buf = Buffer.alloc(limit);
    const { bytesRead } = await fh.read(buf, 0, limit, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

async function exists(rel) {
  try {
    await fsp.stat(abs(rel));
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) opt[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opt[k] = argv[++i];
      else opt[k] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

// Accepts a Library path in any of the forms agents write: root-relative, /mnt/project-files/...,
// or an absolute path under LIBRARY_ROOT. Returns root-relative posix, '' for the root.
function toRel(p) {
  let s = String(p).trim();
  for (const base of [ROOT, MOUNT]) {
    if (s === base) return '';
    if (s.startsWith(base + '/')) {
      s = s.slice(base.length + 1);
      break;
    }
  }
  s = s.replace(/^\.\//, '').replace(/^\/+/, '');
  return posix(path.posix.normalize(s)).replace(/^\.$/, '').replace(/\/$/, '');
}

// ---------- ordering: how the Library list is sorted for the coordinator ----------
// Probed 2026-10-26 (theory.md, "The window"): the list holds every entry, folders included,
// each as its full path; folders show a trailing '/' but sort as the bare path, by plain
// code-unit order. So `a/` < `a-x.md` < `a.md` < `a/b.md`, '!' '#' '.' digits < uppercase < '_'
// < lowercase < '~'. Dot files are listed. The children of uploads/ were not listed.
function windowKey(e) {
  return e.p;
}
function compareFlat(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------- policy ----------

async function loadPolicy() {
  try {
    const p = JSON.parse(await readText(`${SYS}/policy.json`));
    return { ...DEFAULT_POLICY, ...p };
  } catch (e) {
    if (e.code === 'ENOENT') return { ...DEFAULT_POLICY };
    die(`${SYS}/policy.json unreadable: ${e.message}`);
  }
}

function areaOf(rel) {
  return rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '_root';
}

// ---------- markdown parsing ----------

function parseFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return null;
  const fm = {};
  for (const line of text.slice(4, end).split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (/^\[.*\]$/.test(v)) {
      v = v
        .slice(1, -1)
        .split(',')
        .map((x) => x.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else v = v.replace(/^["']|["']$/g, '');
    fm[m[1]] = v;
  }
  return fm;
}

function firstHeading(text) {
  const m = /^#\s+(.+)$/m.exec(text);
  return m ? m[1].trim() : '';
}

const MD_LINK = /\[[^\]\n]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g;
const MOUNT_MENTION = /\/mnt\/project-files\/[^\s)'"`<>\]]+/g;

// Links to other Library paths, as {raw, target} with target root-relative.
function extractLinks(text, fromRel) {
  const out = [];
  const dir = path.posix.dirname(fromRel);
  for (const m of text.matchAll(MD_LINK)) {
    const raw = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#')) continue;
    let target = raw.split('#')[0];
    try {
      target = decodeURIComponent(target);
    } catch {}
    if (!target) continue;
    const rel = target.startsWith('/') ? toRel(target) : toRel(path.posix.join(dir === '.' ? '' : dir, target));
    if (rel.startsWith('..')) continue;
    out.push({ raw, target: rel });
  }
  for (const m of text.matchAll(MOUNT_MENTION)) {
    const raw = m[0].replace(/[.,;:]+$/, '');
    out.push({ raw, target: toRel(raw) });
  }
  return out;
}

function extractUrls(text) {
  const set = new Set();
  for (const m of text.matchAll(/https?:\/\/[^\s)<>\]"'`]+/g)) {
    set.add(m[0].replace(/[.,;:]+$/, ''));
    if (set.size >= 300) break;
  }
  return [...set];
}

function sniff(buf) {
  const s = buf.subarray(0, 8).toString('latin1');
  if (s.startsWith('%PDF')) return 'pdf';
  if (s.startsWith('\x89PNG')) return 'png';
  if (s.startsWith('\xff\xd8')) return 'jpeg';
  if (s.startsWith('GIF8')) return 'gif';
  if (s.startsWith('PK')) return 'zip';
  const t = buf.toString('utf8');
  if (/^\s*[{[]/.test(t)) return 'json';
  if (/�|\x00/.test(t)) return 'binary';
  return 'text';
}

// ---------- catalog ----------
// One JSONL shard per top-level area at ~librarian/catalog/<area>.jsonl. An entry is
// {p, d?, size, mtime, title?, summary?, kind?, topic?, status?, tags?, links?, urls?, fm?, sniff?}.
// The catalog is a cache: `scan --write` rebuilds it from the tree at any time.

async function loadCatalog() {
  const dir = abs(`${SYS}/catalog`);
  let names = [];
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.jsonl') && !n.startsWith('.'));
  } catch {
    return new Map();
  }
  const map = new Map();
  await pool(names, 16, async (n) => {
    const text = await fsp.readFile(path.join(dir, n), 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        map.set(e.p, e);
      } catch {}
    }
  });
  return map;
}

async function saveCatalog(entries) {
  const shards = new Map();
  for (const e of [...entries.values()].sort((a, b) => compareFlat(a.p, b.p))) {
    const a = areaOf(e.p);
    if (!shards.has(a)) shards.set(a, []);
    shards.get(a).push(JSON.stringify(e));
  }
  const want = new Set();
  for (const [a, lines] of shards) {
    const name = `${a.replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`;
    want.add(name);
    await writeAtomic(`${SYS}/catalog/${name}`, lines.join('\n') + '\n');
  }
  for (const n of await fsp.readdir(abs(`${SYS}/catalog`))) {
    if (n.endsWith('.jsonl') && !n.startsWith('.') && !want.has(n)) await fsp.rm(abs(`${SYS}/catalog/${n}`), { force: true });
  }
}

// Walk the tree with listings only. Returns [{p, d, size, mtime}], dot entries skipped.
async function walk(startRel = '', { jobs = 16 } = {}) {
  const out = [];
  let queue = [startRel];
  while (queue.length) {
    const next = [];
    await pool(queue, jobs, async (rel) => {
      let ents;
      try {
        ents = await fsp.readdir(abs(rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of ents) {
        if (ent.name.startsWith('.')) continue;
        const p = rel ? `${rel}/${ent.name}` : ent.name;
        let st;
        try {
          st = await fsp.stat(abs(p));
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          out.push({ p, d: 1, mtime: Math.round(st.mtimeMs) });
          next.push(p);
        } else out.push({ p, size: st.size, mtime: Math.round(st.mtimeMs) });
      }
    });
    queue = next;
  }
  return out;
}

function needsContent(e, policy) {
  if (e.d) return false;
  const area = policy.areas[areaOf(e.p)];
  if (area && area.catalog === 'names') return false;
  if (e.p.startsWith(`${SYS}/`)) return false;
  return true;
}

async function describe(e, policy) {
  const out = { ...e };
  if (!needsContent(e, policy)) return out;
  const isMd = e.p.endsWith('.md');
  const noExt = !path.posix.basename(e.p).includes('.');
  if (!isMd && !noExt) return out;
  try {
    if (noExt) {
      const fh = await fsp.open(abs(e.p), 'r');
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(buf, 0, 4096, 0);
      await fh.close();
      out.sniff = sniff(buf.subarray(0, bytesRead));
      if (out.sniff === 'text') {
        const t = buf.subarray(0, bytesRead).toString('utf8');
        out.title = (firstHeading(t) || t.split('\n').find((l) => l.trim()) || '').slice(0, 120);
      }
      return out;
    }
    const text = await readText(e.p);
    const fm = parseFrontmatter(text);
    if (fm) {
      out.fm = 1;
      for (const k of ['title', 'summary', 'kind', 'topic', 'status', 'tags', 'superseded_by']) if (fm[k] !== undefined && fm[k] !== '') out[k] = fm[k];
    }
    if (!out.title) out.title = firstHeading(text).slice(0, 160) || undefined;
    const links = [...new Set(extractLinks(text, e.p).map((l) => l.target))];
    if (links.length) out.links = links;
    const urls = extractUrls(text);
    if (urls.length) out.urls = urls.length;
  } catch (err) {
    out.err = err.code || String(err.message).slice(0, 60);
  }
  return out;
}

async function scan({ write = false, jobs = 16, quiet = false } = {}) {
  const t0 = Date.now();
  const policy = await loadPolicy();
  const old = await loadCatalog();
  const tree = await walk('', { jobs });
  const tWalk = Date.now();
  const todo = [];
  const next = new Map();
  for (const e of tree) {
    const prev = old.get(e.p);
    if (prev && prev.size === e.size && prev.mtime === e.mtime && !!prev.d === !!e.d) next.set(e.p, prev);
    else todo.push(e);
  }
  const described = await pool(todo, jobs, (e) => describe(e, policy));
  for (const e of described) next.set(e.p, e);
  const removed = [...old.keys()].filter((p) => !next.has(p));
  if (write) {
    await saveCatalog(next);
    // Signals older than 30 days have done their job (reflection.md, "Housekeeping").
    const cutoff = iso(new Date(Date.now() - 30 * 864e5)).slice(0, 10);
    for (const e of tree) if (e.p.startsWith(`${SYS}/signals/`) && path.posix.basename(e.p).slice(0, 10) < cutoff) await fsp.rm(abs(e.p), { force: true });
  }
  const stats = {
    entries: next.size,
    files: [...next.values()].filter((e) => !e.d).length,
    dirs: [...next.values()].filter((e) => e.d).length,
    changed: todo.filter((e) => !e.p.startsWith(SYS)).length,
    opened: described.filter((e) => needsContent(e, policy) && (e.p.endsWith('.md') || !path.posix.basename(e.p).includes('.'))).length,
    removed: removed.length,
    walk_ms: tWalk - t0,
    total_ms: Date.now() - t0,
    written: write,
  };
  if (!quiet) console.log(JSON.stringify(stats));
  return { catalog: next, stats, policy };
}

async function catalogOrScan() {
  const c = await loadCatalog();
  if (c.size) return c;
  return (await scan({ quiet: true })).catalog;
}

// ---------- signals ----------
// What readers looked for and did not find, written by every session to its own file so the
// librarian can see where the layout fails its users (reflection.md, "Evidence").

async function signal(kind, data) {
  try {
    const d = iso();
    const dir = abs(`${SYS}/signals`);
    if (!fs.existsSync(abs(SYS))) return;
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(path.join(dir, `${d.slice(0, 10)}--${WRITER}.jsonl`), JSON.stringify({ at: d, kind, ...data }) + '\n');
  } catch {}
}

async function readSignals(days = 7) {
  const since = Date.now() - days * 864e5;
  const out = [];
  let names = [];
  try {
    names = (await fsp.readdir(abs(`${SYS}/signals`))).filter((n) => n.endsWith('.jsonl') && !n.startsWith('.'));
  } catch {
    return out;
  }
  for (const n of names) {
    if (Date.parse(n.slice(0, 10)) < since - 864e5) continue;
    for (const line of (await fsp.readFile(abs(`${SYS}/signals/${n}`), 'utf8')).split('\n')) {
      try {
        if (line) out.push(JSON.parse(line));
      } catch {}
    }
  }
  return out.filter((x) => Date.parse(x.at) >= since);
}

// ---------- warm ----------
// Opens files in parallel so later reads in this container are warm (<1 ms) for ~45 min.

async function warm(targets, { jobs = 16 } = {}) {
  const t0 = Date.now();
  let files = [];
  for (const t of targets) {
    const rel = toRel(t);
    let st;
    try {
      st = await fsp.stat(abs(rel));
    } catch {
      continue;
    }
    if (st.isDirectory()) files.push(...(await walk(rel, { jobs })).filter((e) => !e.d).map((e) => e.p));
    else files.push(rel);
  }
  files = [...new Set(files)];
  let bytes = 0;
  await pool(files, jobs, async (rel) => {
    try {
      const fh = await fsp.open(abs(rel), 'r');
      const st = await fh.stat();
      const buf = Buffer.alloc(Math.min(st.size, 64 << 20));
      await fh.read(buf, 0, buf.length, 0);
      await fh.close();
      bytes += buf.length;
    } catch {}
  });
  return { files: files.length, bytes, ms: Date.now() - t0 };
}

async function hotSet() {
  try {
    return (await readText(`${SYS}/hot.txt`)).split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  } catch {
    return [START, `${SYS}/policy.json`, `${SYS}/catalog`];
  }
}

// ---------- moves ----------

async function loadMoves() {
  const dir = abs(`${SYS}/moves`);
  let names = [];
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.jsonl') && !n.startsWith('.')).sort();
  } catch {
    return [];
  }
  const moves = [];
  for (const n of names) {
    for (const line of (await fsp.readFile(path.join(dir, n), 'utf8')).split('\n')) {
      if (!line) continue;
      try {
        moves.push(JSON.parse(line));
      } catch {}
    }
  }
  return moves.sort((a, b) => compareFlat(a.at, b.at));
}

function resolvePath(rel, moves) {
  let cur = rel;
  const seen = new Set();
  for (let hops = 0; hops < 50; hops++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    let hit = null;
    for (const m of moves) {
      if (cur === m.from) hit = m.to;
      else if (cur.startsWith(m.from + '/')) hit = m.to + cur.slice(m.from.length);
      if (hit) break;
    }
    if (!hit) break;
    cur = hit;
  }
  return cur;
}

// ---------- window ----------

function windowList(catalog, { n = 150, policy = DEFAULT_POLICY } = {}) {
  const unlisted = Object.entries(policy.areas || {}).filter(([, a]) => a.listed === false).map(([k]) => k + '/');
  const ents = [...catalog.values()].filter((e) => !unlisted.some((u) => e.p.startsWith(u)));
  ents.sort((a, b) => compareFlat(windowKey(a), windowKey(b)));
  const all = ents.map((e) => (e.d ? e.p + '/' : e.p));
  return { all, visible: all.slice(0, n) };
}

// ---------- audit ----------

function isForeign(rel, policy) {
  const a = policy.areas[areaOf(rel)];
  return !!a && a.owner && a.owner !== 'librarian' && a.owner !== 'any';
}

async function audit(catalog, policy) {
  const files = [...catalog.values()].filter((e) => !e.d);
  const dirs = new Set([...catalog.values()].filter((e) => e.d).map((e) => e.p));
  const present = (p) => catalog.has(p) || dirs.has(p) || p === '';
  const moves = await loadMoves();
  const findings = [];
  const add = (sev, code, p, msg) => findings.push({ sev, code, p, msg });

  // strays at the root
  for (const e of catalog.values()) {
    if (e.p.includes('/')) continue;
    if (e.p === START || e.p === MAP || e.p === SYS) continue;
    if (!policy.areas[e.p]) add('warn', 'stray-root', e.p, 'not a registered area; file it or register the area in policy.json');
  }
  // dangling links
  for (const e of files) {
    for (const t of e.links || []) {
      if (present(t)) continue;
      const r = resolvePath(t, moves);
      if (r !== t && present(r)) add(isForeign(e.p, policy) ? 'info' : 'warn', 'moved-link', e.p, `${t} moved to ${r}`);
      else add(isForeign(e.p, policy) ? 'info' : 'error', 'dangling-link', e.p, t);
    }
  }
  // markdown without frontmatter in librarian-owned areas
  for (const e of files) {
    if (!e.p.endsWith('.md') || isForeign(e.p, policy) || e.p.startsWith(SYS + '/') || !e.p.includes('/')) continue;
    if (!e.fm) add('warn', 'no-frontmatter', e.p, 'add title, summary, kind');
    else if (!e.summary) add('info', 'no-summary', e.p, 'frontmatter has no summary');
  }
  // fan-out
  const counts = new Map();
  for (const e of catalog.values()) {
    const parent = e.p.includes('/') ? e.p.slice(0, e.p.lastIndexOf('/')) : '';
    counts.set(parent, (counts.get(parent) || 0) + 1);
  }
  for (const [d, c] of counts) if (c > policy.fanout_max && !isForeign(d || '_root', policy)) add('warn', 'fanout', d || '/', `${c} entries (max ${policy.fanout_max}); shard it`);
  // research topics
  for (const d of dirs) {
    const parts = d.split('/');
    if (parts[0] !== 'research' || parts.length !== 2) continue;
    if (!catalog.has(`${d}/README.md`)) add('warn', 'topic-no-readme', d, 'research topic without README.md');
    if (!catalog.has(`${d}/sources.md`)) add('warn', 'topic-no-sources', d, 'research topic without sources.md');
  }
  // drop zone backlog
  const dropped = files.filter((e) => e.p.startsWith('drop/') && e.p !== 'drop/README.md');
  for (const e of dropped) add('info', 'drop-waiting', e.p, 'waiting to be filed');
  // window
  const { visible, all } = windowList(catalog, { n: policy.window, policy });
  const startIdx = visible.indexOf(START);
  if (startIdx !== 0) add('error', 'window-start', START, startIdx < 0 ? 'missing from the window' : `at position ${startIdx + 1}, not first`);
  const mapVisible = visible.filter((k) => k.startsWith(MAP + '/')).length;
  const mapTotal = all.filter((k) => k.startsWith(MAP + '/')).length;
  if (mapVisible < mapTotal) add('error', 'window-map-cut', MAP, `${mapTotal - mapVisible} signposts fall past the ${policy.window} cut`);
  if (mapTotal + 2 > policy.window - policy.reserve) add('warn', 'window-tight', MAP, `${mapTotal} signposts leave less than the ${policy.reserve}-slot reserve`);
  const sysVisible = visible.filter((k) => k.startsWith(SYS)).length;
  if (sysVisible && all.length > visible.length) add('warn', 'window-sys', SYS, `${sysVisible} machinery entries are visible; they waste slots`);
  // catalog age
  const catAge = Math.max(0, ...files.filter((e) => e.p.startsWith(`${SYS}/catalog/`)).map((e) => e.mtime));

  const byArea = {};
  for (const e of files) {
    const a = areaOf(e.p);
    byArea[a] = byArea[a] || { files: 0, bytes: 0 };
    byArea[a].files++;
    byArea[a].bytes += e.size || 0;
  }
  const metrics = {
    at: iso(),
    files: files.length,
    dirs: dirs.size,
    areas: byArea,
    window: { size: policy.window, signposts: mapTotal, visible_signposts: mapVisible, first: visible[0], last_visible: visible[visible.length - 1], total_entries: all.length },
    findings: findings.reduce((m, f) => ((m[f.code] = (m[f.code] || 0) + 1), m), {}),
    errors: findings.filter((f) => f.sev === 'error').length,
    warnings: findings.filter((f) => f.sev === 'warn').length,
    catalog_built: catAge ? iso(new Date(catAge)) : null,
  };
  return { findings, metrics };
}

// ---------- build: START-HERE, map, indexes, hot set ----------

function slugForName(s) {
  return String(s)
    .replace(/\.md$/, '')
    .replace(/\//g, '--')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{3,}/g, '--')
    .replace(/^-|-$/g, '')
    .slice(0, 110);
}

function signpostName(rank, label) {
  return `${String(rank).padStart(2, '0')}-${slugForName(label)}.md`;
}

function topicsOf(catalog) {
  const topics = [];
  for (const e of catalog.values()) {
    if (!e.d) continue;
    const parts = e.p.split('/');
    if (parts[0] !== 'research' || parts.length !== 2) continue;
    const readme = catalog.get(`${e.p}/README.md`) || {};
    let latest = 0;
    let nfiles = 0;
    for (const f of catalog.values()) {
      if (!f.d && f.p.startsWith(e.p + '/')) {
        nfiles++;
        latest = Math.max(latest, f.mtime || 0);
      }
    }
    const sources = catalog.get(`${e.p}/sources.md`);
    topics.push({ slug: parts[1], p: e.p, title: readme.title || parts[1], summary: readme.summary || '', status: readme.status || '', latest, nfiles, sources: sources ? sources.urls || 0 : 0 });
  }
  return topics;
}

function fmBlock(obj) {
  const q = (v) => (/^[\w .,/()+-]*$/.test(v) && !/^\s|\s$/.test(v) ? v : JSON.stringify(v));
  return '---\n' + Object.entries(obj).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : q(String(v))}`).join('\n') + '\n---\n';
}

async function build(catalog, policy, { dry = false } = {}) {
  const writes = new Map();
  const topics = topicsOf(catalog);
  const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');

  // 01-map: pinned signposts from policy, then the most recently active research topics.
  const posts = [];
  for (const m of policy.map) posts.push({ name: signpostName(m.rank, m.label || m.target), target: m.target, summary: m.summary || '' });
  const budget = Math.max(0, policy.window - policy.reserve - 2 - posts.length - 1);
  const shown = topics
    .slice()
    .sort((a, b) => b.latest - a.latest)
    .slice(0, Math.min(budget, policy.dynamic_topics));
  for (const t of shown) {
    const label = `research--${t.slug}${t.status ? `--${t.status}` : ''}`;
    posts.push({ name: signpostName(50, label), target: `${t.p}/README.md`, summary: `${t.title}. ${t.summary}`.trim(), updated: day(t.latest) });
  }
  const hidden = topics.length - shown.length;
  // Uploads are named by id and their children are not in the session file list, so each
  // recent upload gets a signpost that says what it is.
  const uploads = [...catalog.values()]
    .filter((e) => !e.d && e.p.startsWith('uploads/'))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, Math.max(0, Math.min(policy.dynamic_uploads ?? 20, budget - shown.length)));
  for (const u of uploads) {
    const id = path.posix.basename(u.p);
    const what = u.title ? slugForName(u.title).slice(0, 40) : u.sniff || 'file';
    posts.push({ name: signpostName(60, `upload--${what}--${id.slice(0, 8)}`), target: u.p, summary: `Upload ${id} (${u.sniff || 'unknown type'}, ${u.size} B)${u.title ? `: ${u.title}` : ''}`, updated: day(u.mtime) });
  }
  if (hidden > 0) posts.push({ name: signpostName(89, `research--${hidden}-older-topics--listed-in--research--INDEX`), target: 'research/INDEX.md', summary: `${hidden} older research topics are not signposted; research/INDEX.md lists every topic.` });
  const known = (t) => catalog.has(toRel(t)) || writes.has(toRel(t)) || toRel(t) === START || toRel(t) === 'research/INDEX.md';
  for (const s of posts) {
    const open = known(s.target) || Object.entries(policy.areas).some(([a, o]) => toRel(s.target) === `${a}/README.md` && (!o.owner || o.owner === 'librarian' || o.owner === 'any')) ? `Open [${s.target}](../${s.target}).` : `\`${s.target}\` does not exist yet; it is where this kind of content goes.`;
    writes.set(
      `${MAP}/${s.name}`,
      fmBlock({ title: `Signpost: ${s.target}`, summary: s.summary || `Points to ${s.target}`, kind: 'signpost', target: s.target, built: iso() }) +
        `\n# ${s.target}\n\n${s.summary}\n\n${open}${s.updated ? ` Last change ${s.updated}.` : ''}\n\nThis file is generated by the librarian (\`library.mjs build\`); edits are overwritten.\n`,
    );
  }

  // A README for each librarian-owned area that lacks one, from its policy entry.
  for (const [name, a] of Object.entries(policy.areas)) {
    if ((a.owner && a.owner !== 'librarian' && a.owner !== 'any') || catalog.has(`${name}/README.md`)) continue;
    writes.set(
      `${name}/README.md`,
      fmBlock({ title: `${name}/: ${a.purpose || ''}`.trim(), summary: a.purpose || name, kind: 'index' }) +
        `\n# ${name}/\n\n${a.purpose || ''}\n\n${a.layout ? `Layout: \`${a.layout}\`\n\n` : ''}${a.rules ? `${a.rules}\n\n` : ''}Written by the librarian from \`${SYS}/policy.json\`; it is not regenerated once it exists, so edit it freely.\n`,
    );
  }

  // research/INDEX.md: every topic, newest first.
  {
    const rows = topics
      .slice()
      .sort((a, b) => b.latest - a.latest)
      .map((t) => `| [${t.slug}](${t.slug}/README.md) | ${String(t.title).replace(/\|/g, '/')} | ${t.status || '-'} | ${day(t.latest)} | ${t.nfiles} | ${t.sources} | ${String(t.summary).replace(/\|/g, '/')} |`);
    writes.set(
      'research/INDEX.md',
      fmBlock({ title: 'Research topics', summary: `All ${topics.length} research topics, newest first`, kind: 'index', built: iso() }) +
        `\n# Research topics\n\nGenerated by the librarian from each topic's README.md frontmatter. To add a topic, run \`library.mjs new-topic <slug>\` (library skill).\n\n| Topic | Title | Status | Updated | Files | Source URLs | Summary |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`,
    );
  }

  // 00-START-HERE.md
  const areaRows = Object.entries(policy.areas)
    .map(([name, a]) => {
      const n = [...catalog.values()].filter((e) => !e.d && (e.p === name || e.p.startsWith(name + '/'))).length;
      return `| \`${name}/\` | ${a.purpose || ''} | ${a.layout ? `\`${a.layout}\`` : '-'} | ${a.owner || 'librarian'} | ${n} |`;
    })
    .join('\n');
  const total = [...catalog.values()].filter((e) => !e.d).length;
  writes.set(
    START,
    fmBlock({ title: 'Library map: start here', summary: 'What is in the Library, where each kind of content goes, and how to find anything', kind: 'index', built: iso() }) +
      `
# Library map: start here

This Library is organized and kept tidy by the **librarian**. Its kit (agent, skills, tool) is installed at \`${SYS}/kit/\` and its source is the repository's \`.claude/\` folder. It holds ${total} files. Built ${iso()}.

**Coordinator and threads:** a session's prompt lists only the first names of the Library (a thread's list held 199 entries; plan on ${policy.window}), sorted by full path. Those first names are this file and the signposts in \`${MAP}/\`: each signpost's name is the path it points to, with \`--\` standing for \`/\`. You have no file tools, so to read anything ask a thread or a worker to open it. To have the Library reorganized, cleaned up or searched, start a thread that loads the **librarian** skill.

**Threads and agents:** read \`${MOUNT}/${SYS}/kit/skills/library/SKILL.md\` before you read or write here (repository skills do not load in Project threads by themselves). In short:

1. Find before you fetch: \`node "${KIT_CLI}" find <words>\` searches the catalog (one file) instead of opening thousands.
2. Warm before you read many files: \`library.mjs warm <folder>\` opens them 16 at a time (cold opens cost ~100 ms each, warm ones <1 ms for ~45 min).
3. Write only new files, named by you, in the area below that fits; give every markdown file frontmatter (\`title\`, \`summary\`, \`kind\`). Unsure where? Write it to \`drop/\` and the librarian files it.
4. A path that no longer exists may have moved: \`library.mjs resolve <path>\`.

## Areas

| Folder | What goes there | Layout | Owner | Files |
|---|---|---|---|---|
${areaRows}

Owner \`librarian\` areas are reorganized by the librarian; other owners' folders are catalogued but never moved or edited.

## Indexes

- [research/INDEX.md](research/INDEX.md): every research topic.
- \`${SYS}/catalog/*.jsonl\`: one line per file (path, title, summary, kind, links), the source of \`find\` and \`refs\`.
- \`${SYS}/moves/\`: every move the librarian made, so old paths still resolve.
- \`${SYS}/journal/\`: the librarian's runs and reflections.
`,
  );

  // hot set: what a reader warms first
  const hot = [START, 'research/INDEX.md', `${SYS}/policy.json`, `${SYS}/catalog`, `${SYS}/moves`];
  writes.set(`${SYS}/hot.txt`, `# Files and folders worth warming first (library.mjs warm --hot). Generated by build.\n${hot.join('\n')}\n`);

  // Remove signposts no longer wanted.
  const removes = [...catalog.values()].filter((e) => !e.d && e.p.startsWith(MAP + '/') && !writes.has(e.p)).map((e) => e.p);
  if (!dry) {
    for (const [rel, text] of writes) {
      let same = false;
      try {
        const cur = await readText(rel);
        same = cur.replace(/^built: .*$/gm, '').replace(/Built \S+\./, '') === text.replace(/^built: .*$/gm, '').replace(/Built \S+\./, '');
      } catch {}
      if (!same) await writeAtomic(rel, text);
    }
    for (const rel of removes) await fsp.rm(abs(rel), { force: true });
  }
  return { writes: [...writes.keys()], removes, signposts: posts.length, topics: topics.length, hidden };
}

// ---------- mv ----------

function relLink(fromFile, target, originalRaw) {
  if (originalRaw.startsWith('/mnt/project-files/')) return `${MOUNT}/${target}`;
  if (originalRaw.startsWith('/')) return `${ROOT}/${target}`;
  const dir = path.posix.dirname(fromFile);
  let r = path.posix.relative(dir === '.' ? '' : dir, target);
  if (!r) r = path.posix.basename(target);
  return r;
}

async function mv(fromArg, toArg, { apply = false, force = false } = {}) {
  const policy = await loadPolicy();
  const from = toRel(fromArg);
  const to = toRel(toArg);
  if (!from || !to) die('mv needs <from> and <to>');
  if (from === to) die('from and to are the same');
  if (to.startsWith(from + '/')) die('cannot move a folder into itself');
  for (const p of [from, to]) if (isForeign(p, policy) && !force) die(`${p} is in a folder owned by ${policy.areas[areaOf(p)].owner}; the librarian does not move it (use --force only on the owner's request)`);
  if (!(await exists(from))) die(`${from} does not exist`);
  if (await exists(to)) die(`${to} already exists`);
  if (apply && !force) await requireLease();

  const catalog = (await scan({ quiet: true })).catalog;
  const fromIsDir = !!catalog.get(from)?.d;
  const mapPath = (p) => (p === from ? to : fromIsDir && p.startsWith(from + '/') ? to + p.slice(from.length) : null);
  const moved = [...catalog.values()].filter((e) => mapPath(e.p) !== null);
  const settleMs = policy.settle_minutes * 60e3;
  const fresh = moved.filter((e) => !e.d && Date.now() - e.mtime < settleMs);
  if (fresh.length && !force) die(`${fresh.length} file(s) changed in the last ${policy.settle_minutes} min (e.g. ${fresh[0].p}); a writer may be active. Retry later or --force.`);

  // Files whose links need rewriting: those linking into the moved set, plus moved md files
  // with relative links (their own location changes).
  const edits = [];
  const deferred = [];
  for (const e of catalog.values()) {
    if (e.d || !e.p.endsWith('.md')) continue;
    const selfMoved = mapPath(e.p) !== null;
    const touches = (e.links || []).some((t) => mapPath(t) !== null);
    if (!touches && !selfMoved) continue;
    if (isForeign(e.p, policy)) {
      if (touches) deferred.push({ p: e.p, why: `owned by ${policy.areas[areaOf(e.p)].owner}; resolve via moves log` });
      continue;
    }
    if (!selfMoved && Date.now() - e.mtime < settleMs) {
      deferred.push({ p: e.p, why: 'changed recently; next run rewrites it' });
      continue;
    }
    edits.push(e.p);
  }

  const plan = { from, to, folder: fromIsDir, moved: moved.length, rewrite: [], deferred };
  const rewrites = new Map();
  for (const p of edits) {
    const text = await readText(p);
    const newSelf = mapPath(p) ?? p;
    let changed = text;
    let count = 0;
    const repl = (raw, target) => {
      const newTarget = mapPath(target) ?? target;
      if (newTarget === target && newSelf === p) return null;
      const out = relLink(newSelf, newTarget, raw);
      return out === raw ? null : out;
    };
    changed = changed.replace(MD_LINK, (whole, raw) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#')) return whole;
      const [pathPart, anchor] = raw.split(/#(.*)/s);
      const l = extractLinks(`[x](${pathPart})`, p)[0];
      if (!l) return whole;
      const out = repl(pathPart, l.target);
      if (!out) return whole;
      count++;
      return whole.replace(raw, out + (anchor !== undefined ? '#' + anchor : ''));
    });
    changed = changed.replace(MOUNT_MENTION, (whole) => {
      const raw = whole.replace(/[.,;:]+$/, '');
      const tail = whole.slice(raw.length);
      const target = toRel(raw);
      const nt = mapPath(target);
      if (nt === null) return whole;
      count++;
      return `${MOUNT}/${nt}${tail}`;
    });
    if (count) {
      rewrites.set(p, changed);
      plan.rewrite.push({ p, newPath: newSelf, links: count });
    }
  }

  if (!apply) return { ...plan, applied: false };

  // 1. move on disk  2. rewrite links (at their new paths)  3. log the move  4. rescan
  await fsp.mkdir(path.dirname(abs(to)), { recursive: true });
  await fsp.rename(abs(from), abs(to));
  for (const [p, text] of rewrites) await writeAtomic(mapPath(p) ?? p, text);
  const month = iso().slice(0, 7);
  const line = JSON.stringify({ at: iso(), from, to, folder: fromIsDir, files: moved.filter((e) => !e.d).length, by: WRITER, rewrote: plan.rewrite.length, deferred: deferred.length }) + '\n';
  await fsp.mkdir(abs(`${SYS}/moves`), { recursive: true });
  await fsp.appendFile(abs(`${SYS}/moves/${month}--${WRITER}.jsonl`), line);
  await scan({ write: true, quiet: true });
  return { ...plan, applied: true };
}

// ---------- lease ----------
// One librarian at a time. Writes are seen by other sessions ~40 s late, so acquire writes
// the lease, waits 45 s, and checks it still holds its own name.

const LEASE = `${SYS}/lease.json`;
async function readLease() {
  try {
    return JSON.parse(await readText(LEASE));
  } catch {
    return null;
  }
}
async function requireLease() {
  const l = await readLease();
  if (!l || l.writer !== WRITER || Date.parse(l.until) < Date.now()) die(`this session (${WRITER}) does not hold the librarian lease; run \`library.mjs lease acquire\` first (holder: ${l ? `${l.writer} until ${l.until}` : 'none'})`);
}
async function lease(action, { minutes, wait = 45 } = {}) {
  const policy = await loadPolicy();
  const cur = await readLease();
  const live = cur && Date.parse(cur.until) > Date.now();
  if (action === 'status') return { holder: cur, live, me: WRITER };
  if (action === 'release') {
    if (cur && cur.writer === WRITER) await writeAtomic(LEASE, JSON.stringify({ ...cur, until: iso(), released: true }) + '\n');
    return { released: true };
  }
  if (action === 'acquire') {
    if (live && cur.writer !== WRITER) return { acquired: false, holder: cur };
    const mine = { writer: WRITER, since: iso(), until: iso(new Date(Date.now() + (Number(minutes) || policy.lease_minutes) * 60e3)) };
    await writeAtomic(LEASE, JSON.stringify(mine) + '\n');
    if (Number(wait) > 0) await sleep(Number(wait) * 1000);
    const back = await readLease();
    return back && back.writer === WRITER ? { acquired: true, lease: back } : { acquired: false, holder: back };
  }
  die('lease acquire|release|status');
}

// ---------- lint (for any writer, on the files it wrote) ----------

async function lint(paths) {
  const policy = await loadPolicy();
  const catalog = await catalogOrScan();
  const moves = await loadMoves();
  const problems = [];
  for (const p0 of paths) {
    const p = toRel(p0);
    if (!(await exists(p))) {
      problems.push([p, 'missing']);
      continue;
    }
    const area = areaOf(p);
    if (!policy.areas[area] && p !== START) problems.push([p, `not under a registered area (${Object.keys(policy.areas).join(', ')})`]);
    if (/[A-Z ]/.test(path.posix.basename(p)) && !isForeign(p, policy) && area !== '_root') problems.push([p, 'name has uppercase or spaces; use lowercase-kebab']);
    if (!p.endsWith('.md')) continue;
    const text = await readText(p);
    const fm = parseFrontmatter(text);
    if (!fm) problems.push([p, 'no frontmatter (title, summary, kind)']);
    else for (const k of ['title', 'summary', 'kind']) if (!fm[k]) problems.push([p, `frontmatter lacks ${k}`]);
    for (const l of extractLinks(text, p)) {
      if (catalog.has(l.target) || (await exists(l.target))) continue;
      const r = resolvePath(l.target, moves);
      problems.push([p, r !== l.target ? `link ${l.raw} moved to ${r}` : `link ${l.raw} does not resolve`]);
    }
  }
  return problems;
}

// ---------- new-topic ----------

async function newTopic(slug, { title, question, by } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug || '')) die('new-topic <slug>: lowercase letters, digits and -');
  const base = `research/${slug}`;
  if (await exists(base)) return { exists: true, path: base };
  const d = iso().slice(0, 10);
  const who = by || WRITER;
  await writeAtomic(`${base}/brief.md`, fmBlock({ title: `Brief: ${title || slug}`, summary: question || 'The research question and its scope', kind: 'brief', topic: slug, created: d, author: who }) + `\n# Brief: ${title || slug}\n\n## Question\n\n${question || '(the question, in the asker\'s words)'}\n\n## Scope and out of scope\n\n## Asked by\n\n${who}, ${d}\n`);
  await writeAtomic(`${base}/README.md`, fmBlock({ title: title || slug, summary: 'Draft: findings not yet synthesized', kind: 'report', topic: slug, status: 'draft', created: d, author: who }) + `\n# ${title || slug}\n\n## Answer\n\n(Synthesis goes here. Cite every claim with a source id, like [S3], defined in [sources.md](sources.md).)\n\n## Findings\n\n## Open questions\n\n## Method\n\nNotes from each researcher are in [notes/](notes/).\n`);
  await writeAtomic(`${base}/sources.md`, fmBlock({ title: `Sources: ${title || slug}`, summary: 'Every source used, with ids cited from README.md', kind: 'sources', topic: slug, created: d }) + `\n# Sources\n\n| Id | Title | Author / publisher | Date | URL | Accessed | Reliability | Supports |\n|---|---|---|---|---|---|---|---|\n`);
  await fsp.mkdir(abs(`${base}/notes`), { recursive: true });
  return { created: base };
}

// ---------- journal ----------

async function journal(metrics, body) {
  const d = iso();
  const name = `${SYS}/journal/${d.slice(0, 10)}/${d.replace(/[-:]/g, '').slice(0, 15)}Z--${WRITER}.md`;
  await writeAtomic(name, fmBlock({ title: `Librarian run ${d}`, summary: `files ${metrics.files}, errors ${metrics.errors}, warnings ${metrics.warnings}`, kind: 'journal', at: d, writer: WRITER }) + `\n${body || ''}\n\n## Metrics\n\n\`\`\`json\n${JSON.stringify(metrics, null, 2)}\n\`\`\`\n`);
  return name;
}

async function recentJournals(n = 5) {
  const all = (await walk(`${SYS}/journal`)).filter((e) => !e.d && e.p.endsWith('.md')).map((e) => e.p).sort().slice(-n);
  const out = [];
  for (const p of all) {
    const t = await readText(p);
    const m = /```json\n([\s\S]*?)\n```/.exec(t);
    let metrics = null;
    try {
      metrics = m ? JSON.parse(m[1]) : null;
    } catch {}
    out.push({ p, metrics });
  }
  return out;
}

// ---------- init and install ----------

const HERE = path.dirname(new URL(import.meta.url).pathname);

async function init({ seed } = {}) {
  const done = [];
  if (!(await exists(`${SYS}/policy.json`))) {
    const file = seed || path.join(HERE, '..', '..', 'librarian', 'policy.seed.json');
    const text = await fsp.readFile(file, 'utf8');
    JSON.parse(text);
    await writeAtomic(`${SYS}/policy.json`, text);
    done.push(`${SYS}/policy.json`);
  }
  for (const d of ['catalog', 'moves', 'journal', 'requests', 'requests/done', 'signals']) await fsp.mkdir(abs(`${SYS}/${d}`), { recursive: true });
  return { created: done };
}

// Copies the reviewed kit (this skill, the librarian skill, the agent) from a repo checkout into
// ~librarian/kit/, so sessions without the repo (the coordinator's workers) can run it from the mount.
async function install({ repo } = {}) {
  const base = repo ? path.resolve(repo) : path.resolve(HERE, '..', '..', '..', '..');
  const pick = [];
  for (const sub of ['.claude/skills/library', '.claude/skills/librarian']) {
    const stack = [sub];
    while (stack.length) {
      const d = stack.pop();
      for (const ent of await fsp.readdir(path.join(base, d), { withFileTypes: true })) {
        if (ent.name === 'node_modules' || ent.name === 'test' || ent.name.startsWith('.')) continue;
        const rel = `${d}/${ent.name}`;
        if (ent.isDirectory()) stack.push(rel);
        else pick.push(rel);
      }
    }
  }
  pick.push('.claude/agents/librarian.md');
  for (const rel of pick) await writeAtomic(`${SYS}/kit/${rel.replace(/^\.claude\//, '')}`, await fsp.readFile(path.join(base, rel)));
  let commit = 'unknown';
  try {
    const head = (await fsp.readFile(path.join(base, '.git', 'HEAD'), 'utf8')).trim();
    commit = head.startsWith('ref: ') ? (await fsp.readFile(path.join(base, '.git', head.slice(5)), 'utf8')).trim() : head;
  } catch {}
  await writeAtomic(`${SYS}/kit/VERSION`, `${commit}\ninstalled ${iso()} by ${WRITER}\n`);
  return { installed: pick.length, commit, at: `${SYS}/kit/` };
}

// ---------- CLI ----------

const HELP = `library.mjs <command>   (root: ${ROOT}, writer: ${WRITER})

For every agent:
  find <words...> [--area a] [--kind k] [--limit 20]   search the catalog (titles, summaries, tags, paths)
  warm [--hot] [path...]                                open files 16 at a time so later reads are warm
  resolve <path>                                        follow the moves log to a path's current place
  refs <path>                                           files that link to a path (or into a folder)
  lint <path...>                                        check files you wrote: area, name, frontmatter, links
  new-topic <slug> [--title t] [--question q]           scaffold research/<slug>/
  window [--n 150] [--all] [--live]                     the coordinator's view: the first N entries

For the librarian (hold the lease for the writing ones):
  lease acquire|release|status [--minutes m] [--wait s]
  scan [--write]                                        refresh the catalog from listings (+ changed md)
  audit [--json] [--journal "<reflection text>"]        health findings and metrics
  build [--dry]                                         regenerate ${START}, ${MAP}/, research/INDEX.md, hot set
  mv <from> <to> [--apply] [--force]                    move, rewrite links, log the move (dry run by default)
  trend [--n 5]                                         metrics of the last N journal entries
  signals [--days 7]                                    what readers searched for and missed, lint failures
  init [--seed policy.json]                             first run: policy.json and ${SYS}/ folders
  install [--repo dir]                                  copy the reviewed kit into ${SYS}/kit/
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  const jobs = Number(opt.jobs) || 16;
  switch (cmd) {
    case 'find': {
      const cat = await catalogOrScan();
      const terms = pos.map((t) => t.toLowerCase());
      if (!terms.length) die('find <words...>');
      const scored = [];
      for (const e of cat.values()) {
        if (opt.area && areaOf(e.p) !== opt.area) continue;
        if (opt.kind && e.kind !== opt.kind) continue;
        const fields = [
          [String(e.title || '').toLowerCase(), 3],
          [[].concat(e.tags || []).join(' ').toLowerCase(), 2],
          [String(e.summary || '').toLowerCase(), 2],
          [e.p.toLowerCase(), 1],
        ];
        let s = 0;
        let all = true;
        for (const t of terms) {
          let hit = 0;
          for (const [f, w] of fields) if (f.includes(t)) hit += w;
          if (!hit) all = false;
          s += hit;
        }
        if (s && all) scored.push([s, e]);
      }
      scored.sort((a, b) => b[0] - a[0] || compareFlat(a[1].p, b[1].p));
      for (const [, e] of scored.slice(0, Number(opt.limit) || 20)) console.log(`${e.d ? e.p + '/' : e.p}${e.title ? `  | ${e.title}` : ''}${e.summary ? `  | ${e.summary}` : ''}`);
      if (!scored.length) {
        console.log('(no match; try fewer or shorter words)');
        await signal('find-miss', { q: pos.join(' '), area: opt.area, kind: opt.kind });
      }
      break;
    }
    case 'warm': {
      const targets = opt.hot ? [...(await hotSet()), ...pos] : pos;
      if (!targets.length) die('warm [--hot] [path...]');
      console.log(JSON.stringify(await warm(targets, { jobs })));
      break;
    }
    case 'resolve': {
      const rel = toRel(pos[0] || die('resolve <path>'));
      const r = resolvePath(rel, await loadMoves());
      const there = r !== rel || (await exists(rel));
      console.log(r === rel ? `${rel}${there ? '' : '  (does not exist, no move recorded; try find)'}` : `${rel} -> ${r}`);
      if (!there) await signal('resolve-miss', { p: rel });
      break;
    }
    case 'refs': {
      const rel = toRel(pos[0] || die('refs <path>'));
      const cat = await catalogOrScan();
      for (const e of cat.values()) if ((e.links || []).some((t) => t === rel || t.startsWith(rel + '/'))) console.log(e.p);
      break;
    }
    case 'lint': {
      if (!pos.length) die('lint <path...>');
      const probs = await lint(pos);
      for (const [p, m] of probs) console.log(`${p}: ${m}`);
      if (probs.length) await signal('lint', { problems: probs.slice(0, 20).map(([p, m]) => `${p}: ${m}`) });
      if (!probs.length) console.log('ok');
      process.exitCode = probs.length ? 1 : 0;
      break;
    }
    case 'new-topic':
      console.log(JSON.stringify(await newTopic(pos[0], { title: opt.title, question: opt.question, by: opt.by })));
      break;
    case 'window': {
      const cat = opt.live ? (await scan({ quiet: true })).catalog : await catalogOrScan();
      const policy = await loadPolicy();
      const n = Number(opt.n) || policy.window;
      const { all, visible } = windowList(cat, { n, policy });
      const list = opt.all ? all : visible;
      list.forEach((k, i) => console.log(`${String(i + 1).padStart(4)}  ${k}`));
      console.log(`-- ${visible.length} of ${all.length} entries visible; signposts ${visible.filter((k) => k.startsWith(MAP + '/')).length}; the cut falls after: ${visible[visible.length - 1] || '-'}`);
      break;
    }
    case 'scan':
      if (opt.write) await requireLeaseUnlessFresh();
      await scan({ write: !!opt.write, jobs });
      break;
    case 'audit': {
      const cat = await catalogOrScan();
      const policy = await loadPolicy();
      const { findings, metrics } = await audit(cat, policy);
      if (opt.json) console.log(JSON.stringify({ metrics, findings }, null, 2));
      else {
        for (const f of findings.sort((a, b) => ['error', 'warn', 'info'].indexOf(a.sev) - ['error', 'warn', 'info'].indexOf(b.sev))) console.log(`${f.sev.padEnd(5)} ${f.code.padEnd(16)} ${f.p}  ${f.msg}`);
        console.log(JSON.stringify(metrics));
      }
      if (opt.journal) console.log(`journal: ${await journal(metrics, typeof opt.journal === 'string' ? opt.journal : '')}`);
      break;
    }
    case 'build': {
      if (!opt.dry) await requireLeaseUnlessFresh();
      const cat = (await scan({ quiet: true, write: !opt.dry })).catalog;
      const policy = await loadPolicy();
      const r = await build(cat, policy, { dry: !!opt.dry });
      if (!opt.dry) await scan({ write: true, quiet: true });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'mv':
      console.log(JSON.stringify(await mv(pos[0], pos[1], { apply: !!opt.apply, force: !!opt.force }), null, 2));
      break;
    case 'lease':
      console.log(JSON.stringify(await lease(pos[0], { minutes: opt.minutes, wait: opt.wait ?? 45 })));
      break;
    case 'signals': {
      const sig = await readSignals(Number(opt.days) || 7);
      const by = {};
      for (const x of sig) (by[x.kind] = by[x.kind] || []).push(x);
      for (const [k, xs] of Object.entries(by)) {
        console.log(`${k}: ${xs.length}`);
        for (const x of xs.slice(-15)) console.log(`  ${x.at} ${x.q || x.p || (x.problems || []).join('; ') || ''}`);
      }
      if (!sig.length) console.log('(no signals)');
      break;
    }
    case 'init':
      console.log(JSON.stringify(await init({ seed: opt.seed })));
      break;
    case 'install':
      await requireLeaseUnlessFresh();
      console.log(JSON.stringify(await install({ repo: opt.repo })));
      break;
    case 'trend':
      for (const j of await recentJournals(Number(opt.n) || 5)) {
        const m = j.metrics || {};
        console.log(`${j.p}  files=${m.files} errors=${m.errors} warnings=${m.warnings} signposts=${m.window?.signposts} findings=${JSON.stringify(m.findings || {})}`);
      }
      break;
    default:
      process.stdout.write(HELP);
      process.exitCode = cmd && cmd !== 'help' ? 2 : 0;
  }
}

// The very first build has no lease file yet; after that the lease is required.
async function requireLeaseUnlessFresh() {
  if (!(await readLease()) && !(await exists(`${SYS}/policy.json`))) return;
  await requireLease();
}

main().catch((e) => die(e.stack || String(e), 1));
