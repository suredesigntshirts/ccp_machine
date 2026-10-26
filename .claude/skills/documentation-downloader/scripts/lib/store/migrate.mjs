/**
 * `docs migrate`: move a v1 cache (`docs/` + `docs/llms.txt`) into the v2 layout.
 *
 * Rules (DESIGN.md → Migration):
 *   - Only pages the skill created — front matter with `Source:` — are moved.
 *     `Source:` is never changed: it is the URL that was requested.
 *   - The file path follows v2's rule "path from the FINAL url (after
 *     redirects)". v1 already named files that way, so a URL-shaped old path
 *     (`<host>/<path>.md`) is kept — only normalised to v2's spelling (percent-
 *     decoding) — even when Source names another URL: Source redirected there.
 *     Only two old layouts are re-pathed: root pages stored beside their domain
 *     folder (`fly.io.md` → `fly.io/index.md`), and non-URL-shaped trees from
 *     older tools (`google/support/…` → path re-derived from Source).
 *     `Final:` is not added: the old path doesn't say the final URL's scheme,
 *     query, extension or trailing slash, so it can't be derived reliably.
 *   - Everything else (no Source, not markdown, sub-`llms.txt`, CLAUDE.md) is
 *     listed and left where it is.
 *   - Two old files → one new path: the newest `Updated:` wins; the others stay
 *     in place and are reported.
 *   - Good descriptions from the old llms.txt are carried into the page's front
 *     matter as `description:` when the page has none. The v1 index is otherwise
 *     dropped: v2 regenerates its indexes from the pages.
 *   - v1 (before its fix) stacked the provenance block on top of the upstream
 *     page's own front matter; those two blocks are merged on the way through.
 *   - Likely-bad pages (bot-check interstitials, error pages, stubs) are moved
 *     like any other page and reported for re-fetching — never deleted.
 *
 * Crash safety: each page goes copy (atomic) → verify hash → journal → remove
 * original. At every instant a page exists as the original, as original + a
 * byte-identical copy, or as the copy only; re-running recognises the middle
 * state (destination already holds exactly the bytes it would write) and just
 * finishes the removal. So an interrupted run is completed by running again, and
 * a completed run re-run is a no-op.
 */

import { promises as fsp } from 'node:fs';
import { join, relative, sep, dirname, basename, resolve } from 'node:path';
import { descriptionProblem } from '../descriptions.mjs';
import { urlToRelPath } from '../paths.mjs';
import { cacheDirs } from '../config.mjs';
import { sha256, sha256File, writeFileAtomic } from './atomic.mjs';
import { parseUnstacked, renderDocument } from './frontmatter.mjs';
import { withGlobalLock, withUrlLock, LOCK_DEFAULTS } from './locks.mjs';
import { detectBadPage } from './quality.mjs';
import { ensureRoot } from './root.mjs';

const toPosix = (p) => p.split(sep).join('/');

/** Where the migration keeps its journal and the retired v1 index. */
export function legacyDir(to) {
  return join(cacheDirs(to).cache, 'legacy');
}

async function exists(p) {
  try { await fsp.lstat(p); return true; } catch { return false; }
}

/** `dev:ino` of what `p` names (following symlinks), or null when it doesn't exist. */
async function fileId(p) {
  try { const s = await fsp.stat(p); return `${s.dev}:${s.ino}`; } catch { return null; }
}

/**
 * realpath() of `p`, or — when `p` doesn't exist yet — of its deepest existing
 * ancestor with the missing tail appended. Resolves symlinks anywhere on the path.
 */
async function realpathLoose(p) {
  const tail = [];
  let cur = p;
  for (;;) {
    try {
      const real = await fsp.realpath(cur);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const up = dirname(cur);
      if (up === cur) return p;
      tail.push(basename(cur));
      cur = up;
    }
  }
}

/** Is `outer` the directory `inner` itself or one of its ancestors — by identity (dev+ino), not by spelling? */
async function isSameOrInside(inner, outer) {
  if (inner === outer || inner.startsWith(outer + sep)) return true;
  const id = await fileId(outer);
  if (!id) return false;
  for (let cur = inner; ; cur = dirname(cur)) {
    if ((await fileId(cur)) === id) return true;
    if (dirname(cur) === cur) return false;
  }
}

/**
 * Canonical `from`/`to`, refusing layouts where moving a page could remove its
 * only copy. Spellings are not identities: `--to` may reach `--from` through a
 * symlink (`ln -s docs external-docs`) or a case variant on a case-insensitive
 * filesystem, so both are compared as real paths and by dev+ino.
 * `to` inside `from` is allowed (the walk skips it); `from` inside `to` is not.
 */
export async function resolveMigrationDirs(from, to) {
  from = await realpathLoose(resolve(from));
  to = await realpathLoose(resolve(to));
  if (!(await exists(from))) throw new Error(`${from} does not exist`);
  const fromId = await fileId(from);
  if (from === to || (fromId && fromId === (await fileId(to)))) {
    throw new Error('--from and --to are the same directory');
  }
  if (await isSameOrInside(from, to)) throw new Error(`--from (${from}) is inside --to (${to})`);
  return { from, to };
}

/** Every file under `dir` (relative posix paths), skipping dot-entries and the directory `skipAbs`. */
async function walkFiles(dir, skipAbs) {
  const files = [];
  const symlinks = [];
  const skipId = skipAbs ? await fileId(skipAbs) : null;
  async function walk(d) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (skipAbs && (p === skipAbs || p.startsWith(skipAbs + sep))) continue;
      if (e.name.startsWith('.')) continue; // .DS_Store, editor droppings, a nested .git
      if (e.isSymbolicLink()) symlinks.push(toPosix(relative(dir, p)));
      else if (e.isDirectory()) {
        if (skipId && (await fileId(p)) === skipId) continue; // `to`, spelled differently
        await walk(p);
      }
      else if (e.isFile()) files.push(toPosix(relative(dir, p)));
    }
  }
  await walk(dir);
  files.sort();
  return { files, symlinks };
}

// ─── the v1 index ─────────────────────────────────────────────────────────────

/**
 * Parse a v1 llms.txt. Entries look like `- <path>: <description>`, where <path>
 * is `docs/…` relative to the project — or, in indexes that travelled between
 * machines, an absolute path from somebody else's home directory.
 */
export function parseLegacyIndex(text) {
  const entries = [];
  let notes = 0;
  for (const [i, line] of text.split('\n').entries()) {
    const m = /^\s*[-*]\s+(\S+?\.[A-Za-z0-9]+):(?:\s+(.*))?$/.exec(line);
    if (m) {
      entries.push({ line: i + 1, path: m[1], description: (m[2] ?? '').trim() });
    } else if (line.trim() && !/^#{1,6}\s/.test(line)) {
      notes++; // hand-written prose between entries; only a copy of the file keeps it
    }
  }
  return { entries, notes };
}

/**
 * Map an index path onto a file of the old cache: the longest suffix of its
 * segments that names a known file. `docs/a/b.md` → `a/b.md`;
 * `/home/someone/proj/docs/a/b.md` → `a/b.md`.
 */
function resolveIndexPath(p, known) {
  const segs = p.replace(/\\/g, '/').split('/').filter(s => s && s !== '.');
  for (let i = 0; i < segs.length; i++) {
    const cand = segs.slice(i).join('/');
    if (known.has(cand)) return cand;
  }
  return null;
}

// ─── planning ────────────────────────────────────────────────────────────────

// A top-level directory named like a host (`docs.example.com`, `fly.io`).
const HOST_LIKE = /^(?=[^/]*[a-z])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?$/i;

/**
 * v2 spelling of a URL-shaped v1 path (`host/a%20b.md` → `host/a b.md`). Only the
 * path is computed from the reconstructed URL; the URL itself is never stored.
 */
function normalisedPath(rel) {
  try {
    const out = urlToRelPath(`https://${rel.replace(/\.md$/i, '')}`);
    return out || rel;
  } catch {
    return rel; // e.g. a malformed %-escape: keep the old spelling
  }
}

/**
 * Where a v1 page goes, and why it moves (`kind` null = same relative path).
 *   url-path     `<host>/<path>.md` — v1 derived it from the final URL; kept.
 *                `redirected` says Source maps elsewhere (the request redirected).
 *   normalised   URL-shaped, respelled to v2's rule (percent-decoding, sanitising)
 *   root-page    `<host>.md` beside the domain folders → `<host>/index.md`
 *                (the file name is the final URL's host)
 *   non-url-path any other layout (`google/support/…`) → re-derived from Source
 * @returns {{to: string, kind: null|'normalised'|'root-page'|'non-url-path', redirected: boolean}}
 */
export function destinationFor(from, source) {
  const fromSource = urlToRelPath(source);
  const segs = from.split('/');
  if (segs.length === 1) {
    const host = from.replace(/\.md$/i, '');
    if (HOST_LIKE.test(host)) {
      const to = normalisedPath(`${host}/`);
      return { to, kind: 'root-page', redirected: to !== fromSource };
    }
    return { to: fromSource, kind: 'non-url-path', redirected: false };
  }
  if (HOST_LIKE.test(segs[0])) {
    const to = normalisedPath(from);
    return { to, kind: to === from ? null : 'normalised', redirected: to !== fromSource };
  }
  return { to: fromSource, kind: 'non-url-path', redirected: false };
}

async function readJournal(to) {
  const moved = new Map(); // old rel path → journal record
  let text = '';
  try { text = await fsp.readFile(join(legacyDir(to), 'migrated.jsonl'), 'utf-8'); } catch { return moved; }
  for (const line of text.split('\n')) {
    try { const r = JSON.parse(line); if (r?.from) moved.set(r.from, r); } catch { /* torn line */ }
  }
  return moved;
}

function compareCandidates(a, b) {
  // Newest Updated wins; then the file already at its URL-shaped path; then the
  // larger capture; then path order, so the result is deterministic.
  const ua = String(a.updated ?? ''), ub = String(b.updated ?? '');
  if (ua !== ub) return ua > ub ? -1 : 1;
  const sa = a.from === a.to, sb = b.from === b.to;
  if (sa !== sb) return sa ? -1 : 1;
  if (a.size !== b.size) return b.size - a.size;
  return a.from < b.from ? -1 : 1;
}

/**
 * Work out what a migration would do. Read-only.
 * @param {{from: string, to: string}} opts  absolute directories
 * @returns {Promise<object>} the plan (see `formatPlan` for how it reads)
 */
export async function planMigration({ from, to }) {
  ({ from, to } = await resolveMigrationDirs(from, to));

  const { files, symlinks } = await walkFiles(from, to);
  const journal = await readJournal(to);
  const skipped = symlinks.map(path => ({ path, reason: 'symlink' }));
  const candidates = [];

  const indexPath = join(from, 'llms.txt');
  const hasIndex = files.includes('llms.txt');

  for (const rel of files) {
    if (rel === 'llms.txt') continue; // the legacy index itself, handled below
    const name = basename(rel);
    if (name.toLowerCase() === 'claude.md') { skipped.push({ path: rel, reason: 'agent-instructions' }); continue; }
    if (name === 'llms.txt') { skipped.push({ path: rel, reason: 'sub-index' }); continue; }
    if (!rel.toLowerCase().endsWith('.md')) { skipped.push({ path: rel, reason: 'not-markdown' }); continue; }

    const buf = await fsp.readFile(join(from, rel));
    const text = buf.toString('utf-8');
    const parsed = parseUnstacked(text);
    if (!/^\uFEFF?---[ \t]*\r?\n/.test(text)) { skipped.push({ path: rel, reason: 'no-front-matter' }); continue; }
    const source = parsed.data.Source;
    if (!source) { skipped.push({ path: rel, reason: 'no-source' }); continue; }
    let dest;
    try {
      const u = new URL(String(source));
      if (!/^https?:$/.test(u.protocol)) throw new Error('not http(s)');
      dest = destinationFor(rel, u.href);
    } catch {
      skipped.push({ path: rel, reason: 'invalid-source', detail: String(source) });
      continue;
    }
    candidates.push({
      from: rel, to: dest.to, relocated: dest.kind, redirected: dest.redirected, source: String(source),
      updated: parsed.data.Updated ?? parsed.data.Generated ?? null,
      size: buf.length, buf, text, parsed,
    });
  }

  // Collisions: several old files claim one new path.
  const byDest = new Map();
  for (const c of candidates) {
    if (!byDest.has(c.to)) byDest.set(c.to, []);
    byDest.get(c.to).push(c);
  }
  const winners = [];
  const collisions = [];
  for (const [dest, group] of byDest) {
    group.sort(compareCandidates);
    winners.push(group[0]);
    if (group.length > 1) {
      collisions.push({
        to: dest,
        winner: { from: group[0].from, updated: group[0].updated },
        losers: group.slice(1).map(c => ({ from: c.from, updated: c.updated, source: c.source })),
      });
      for (const c of group.slice(1)) {
        skipped.push({ path: c.from, reason: 'collision-older', detail: `${dest} taken by ${group[0].from}` });
      }
    }
  }

  // Descriptions from the old index, keyed by the old file they describe.
  const known = new Set([...files, ...journal.keys()]);
  let legacyIndex = null;
  const indexDescriptions = new Map();
  if (hasIndex) {
    const { entries, notes } = parseLegacyIndex(await fsp.readFile(indexPath, 'utf-8'));
    for (const e of entries) {
      e.resolved = resolveIndexPath(e.path, known);
      if (e.resolved && e.description && !indexDescriptions.has(e.resolved)) {
        indexDescriptions.set(e.resolved, e.description);
      }
    }
    legacyIndex = { path: 'llms.txt', entries, notes };
  }

  const journalByDest = new Map([...journal.values()].map(r => [r.to, r]));
  const moves = [];
  const badPages = [];
  const rejectedDescriptions = [];
  for (const c of winners) {
    const bad = detectBadPage(c.text);
    if (bad) badPages.push({ from: c.from, to: c.to, source: c.source, ...bad });

    let carried = null;
    const hasDesc = typeof c.parsed.data.description === 'string' && c.parsed.data.description.trim() !== '';
    const desc = indexDescriptions.get(c.from);
    if (!hasDesc && desc) {
      const problem = bad ? `page flagged ${bad.reason}` : descriptionProblem(desc, c.to, { handWritten: true });
      if (problem) rejectedDescriptions.push({ from: c.from, description: desc, reason: problem });
      else carried = desc;
    }

    // Rewrite only when there's something to change; otherwise move bytes verbatim.
    let out = c.buf;
    if (carried || c.parsed.unstacked) {
      const data = { ...c.parsed.data };
      if (carried) data.description = carried;
      out = Buffer.from(renderDocument(data, c.parsed.body), 'utf-8');
    }
    const hash = sha256(out);

    let state = 'pending';
    const destAbs = join(to, c.to);
    if (await exists(destAbs)) {
      // The destination path reaches the original itself (a symlinked directory
      // inside `to`): "copying" would verify against itself and then delete the only copy.
      const srcId = await fileId(join(from, c.from));
      if (srcId && srcId === (await fileId(destAbs))) {
        skipped.push({ path: c.from, reason: 'same-file', detail: c.to });
        continue;
      }
      let destHash = null;
      try { destHash = await sha256File(destAbs); } catch { /* unreadable: treat as different */ }
      if (destHash === hash) state = 'copied'; // an interrupted run got this far
      else {
        // A collision decided by an earlier run looks the same on re-run; report it the same way.
        const earlier = journalByDest.get(c.to);
        skipped.push(earlier && earlier.from !== c.from
          ? { path: c.from, reason: 'collision-older', detail: `${c.to} taken by ${earlier.from}` }
          : { path: c.from, reason: 'destination-exists', detail: c.to });
        continue;
      }
    }
    moves.push({
      from: c.from, to: c.to, source: c.source, updated: c.updated, sha256: hash, state,
      carriedDescription: carried, mergedStackedFrontMatter: c.parsed.unstacked,
      repairedYaml: !c.parsed.valid && out !== c.buf,
      relocated: c.relocated, redirected: c.redirected, out,
    });
  }

  // Will the old index be retired? Only if every entry points at a page that is
  // (or will be) migrated — otherwise it's still the only record of something.
  if (legacyIndex) {
    const migrating = new Set([...moves.map(m => m.from), ...journal.keys()]);
    const blockers = legacyIndex.entries.filter(e => !e.resolved || !migrating.has(e.resolved));
    legacyIndex.unmigratedEntries = blockers.map(e => ({
      line: e.line, path: e.path,
      why: !e.resolved ? 'file not found' : (skipped.find(s => s.path === e.resolved)?.reason ?? 'not migrated'),
    }));
    legacyIndex.willRetire = blockers.length === 0;
  }
  const retiredIndexExists = await exists(join(legacyDir(to), 'llms.txt'));

  skipped.sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    from, to,
    moves, skipped, collisions, badPages, rejectedDescriptions,
    legacyIndex, retiredIndexExists,
    previouslyMigrated: journal.size,
    counts: summarizeCounts({ moves, skipped, collisions, badPages, rejectedDescriptions }),
  };
}

function summarizeCounts({ moves, skipped, collisions, badPages, rejectedDescriptions }) {
  const skippedByReason = {};
  for (const s of skipped) skippedByReason[s.reason] = (skippedByReason[s.reason] ?? 0) + 1;
  return {
    moves: moves.length,
    alreadyCopied: moves.filter(m => m.state === 'copied').length,
    relocated: moves.filter(m => m.relocated).length,
    redirectedKeptPath: moves.filter(m => m.redirected).length,
    relocatedByKind: moves.reduce((acc, m) => {
      if (m.relocated) acc[m.relocated] = (acc[m.relocated] ?? 0) + 1;
      return acc;
    }, {}),
    carriedDescriptions: moves.filter(m => m.carriedDescription).length,
    rejectedDescriptions: rejectedDescriptions.length,
    mergedStackedFrontMatter: moves.filter(m => m.mergedStackedFrontMatter).length,
    repairedYaml: moves.filter(m => m.repairedYaml).length,
    skipped: skipped.length,
    skippedByReason,
    collisions: collisions.length,
    badPages: badPages.length,
  };
}

// ─── applying ────────────────────────────────────────────────────────────────

/** Remove now-empty directories from `dir` up to (not including) `stop`. */
async function pruneEmptyDirs(dir, stop) {
  while (dir !== stop && dir.startsWith(stop + sep)) {
    try { await fsp.rmdir(dir); } catch { return; } // not empty (or gone): stop climbing
    dir = dirname(dir);
  }
}

/**
 * Carry out a migration. Idempotent and resumable.
 * @param {{from: string, to: string, hooks?: {afterCopy?: (move) => any, rethrow?: boolean}}} opts
 *   Test hooks: `afterCopy` runs after a page is copied and verified but before
 *   its original is removed — the window a crash test needs to hit; `rethrow`
 *   aborts the run on the first error (like a crash) instead of collecting it.
 * @returns {Promise<object>} the plan, plus `applied: {moved, retiredIndex, errors}`
 */
export async function applyMigration({ from, to, hooks = {} }) {
  // Checked before ensureRoot, which would otherwise write the marker into `from`.
  ({ from, to } = await resolveMigrationDirs(from, to));
  await ensureRoot(to);
  // The one outermost lock: no other code path takes global/migrate, so holding
  // it while taking url locks below cannot form a cycle.
  // Wait up to two stale periods: re-running right after a crashed migration
  // must outlast the dead run's lock going stale rather than fail.
  return withGlobalLock(to, 'migrate', async () => {
    const plan = await planMigration({ from, to }); // re-plan under the lock
    const journalPath = join(legacyDir(to), 'migrated.jsonl');
    await fsp.mkdir(legacyDir(to), { recursive: true });
    const errors = [];
    let moved = 0;

    for (const m of plan.moves) {
      try {
        await withUrlLock(to, m.source, async () => {
          const destAbs = join(to, m.to);
          if (await exists(destAbs)) {
            if ((await sha256File(destAbs)) !== m.sha256) {
              throw new Error(`${m.to} appeared during migration with different content; original kept`);
            }
          } else {
            await writeFileAtomic(destAbs, m.out);
            if ((await sha256File(destAbs)) !== m.sha256) {
              throw new Error(`verification failed for ${m.to}; original kept`);
            }
          }
          await hooks.afterCopy?.(m);
          // Last line of defence before the only destructive step: never unlink
          // a source that IS the destination (same inode reached by another path).
          const srcAbs = join(from, m.from);
          const srcId = await fileId(srcAbs);
          if (srcId && srcId === (await fileId(destAbs))) {
            throw new Error(`${m.from} and ${m.to} are the same file; original kept`);
          }
          await fsp.appendFile(journalPath, JSON.stringify({
            from: m.from, to: m.to, source: m.source, sha256: m.sha256, at: new Date().toISOString(),
          }) + '\n');
          await fsp.unlink(srcAbs).catch(err => { if (err.code !== 'ENOENT') throw err; });
          await pruneEmptyDirs(dirname(join(from, m.from)), from);
        });
        moved++;
      } catch (err) {
        if (hooks.rethrow) throw err;
        errors.push({ from: m.from, to: m.to, error: err.message });
      }
    }

    // Retire the v1 index only after every page it lists has been moved.
    let retiredIndex = false;
    if (plan.legacyIndex?.willRetire && errors.length === 0) {
      const src = join(from, 'llms.txt');
      const dst = join(legacyDir(to), 'llms.txt');
      const buf = await fsp.readFile(src);
      await writeFileAtomic(dst, buf);
      if ((await sha256File(dst)) !== sha256(buf)) throw new Error(`verification failed for ${dst}`);
      if ((await fileId(src)) === (await fileId(dst))) throw new Error(`${src} and ${dst} are the same file; kept`);
      await fsp.unlink(src);
      retiredIndex = true;
    }
    return { ...plan, applied: { moved, retiredIndex, errors } };
  }, { waitMs: 2 * LOCK_DEFAULTS.staleMs });
}

// ─── reporting ───────────────────────────────────────────────────────────────

const REASON_TEXT = {
  'no-front-matter': 'no front matter (not written by this skill)',
  'no-source': 'front matter without Source:',
  'invalid-source': 'Source: is not an http(s) URL',
  'not-markdown': 'not a .md file',
  'sub-index': 'sub-index llms.txt',
  'agent-instructions': 'agent instructions, not a cached page',
  'collision-older': 'older copy of a page another file also holds',
  'destination-exists': 'destination already holds a different version',
  'same-file': 'destination path leads back to this same file (symlink)',
  symlink: 'symbolic link',
};

/** Plan (or apply result) → JSON-safe object (drops file contents). */
export function planToJson(plan) {
  return { ...plan, moves: plan.moves.map(({ out, ...m }) => m) };
}

/** Human-readable summary. Lists everything the user must look at; moves only as counts. */
export function formatPlan(plan, { apply = false } = {}) {
  const c = plan.counts;
  const rel = (p) => {
    const r = toPosix(relative(process.cwd(), p)) || '.';
    return r.startsWith('../') ? p : r; // outside the project: the absolute path reads better
  };
  const L = [];
  const done = plan.applied;
  L.push(done
    ? `Migrated ${rel(plan.from)}/ → ${rel(plan.to)}/`
    : `Migration plan: ${rel(plan.from)}/ → ${rel(plan.to)}/${apply ? '' : '  (dry run — nothing changed; add --apply to migrate)'}`);
  L.push('');
  L.push(`  pages to move            ${c.moves}${c.alreadyCopied ? `  (${c.alreadyCopied} already copied by an interrupted run)` : ''}`);
  if (done) L.push(`  pages moved              ${done.moved}`);
  if (plan.previouslyMigrated) L.push(`  moved by earlier runs    ${plan.previouslyMigrated}`);
  const kinds = Object.entries(c.relocatedByKind).map(([k, n]) => `${n} ${k}`).join(', ');
  L.push(`  re-pathed                ${c.relocated}${kinds ? `  (${kinds})` : ''}`);
  L.push(`  path ≠ Source's path     ${c.redirectedKeptPath}  (Source redirected; path follows the final URL, Source unchanged)`);
  L.push(`  descriptions carried     ${c.carriedDescriptions}  (${c.rejectedDescriptions} rejected by quality checks)`);
  L.push(`  stacked front matter merged  ${c.mergedStackedFrontMatter}`);
  if (c.repairedYaml) L.push(`  invalid YAML repaired    ${c.repairedYaml}`);
  L.push(`  collisions               ${c.collisions}`);
  L.push(`  likely-bad pages         ${c.badPages}  (moved, flagged for re-fetch)`);
  L.push(`  left in place            ${c.skipped}`);
  for (const [reason, n] of Object.entries(c.skippedByReason).sort((a, b) => b[1] - a[1])) {
    L.push(`      ${String(n).padStart(4)}  ${REASON_TEXT[reason] ?? reason}`);
  }

  if (plan.collisions.length) {
    L.push('', 'Collisions (newest Updated wins; the others are left in place):');
    for (const col of plan.collisions) {
      L.push(`  ${col.to}`);
      L.push(`      ← ${col.winner.from}  (Updated ${col.winner.updated ?? '?'})  kept`);
      for (const l of col.losers) L.push(`        ${l.from}  (Updated ${l.updated ?? '?'})  left in place`);
    }
  }
  if (plan.badPages.length) {
    L.push('', 'Likely-bad pages (bot checks, error pages, stubs) — re-fetch these:');
    for (const b of plan.badPages) L.push(`  ${b.to}  ← ${b.source}  [${b.reason}: ${b.detail}]`);
  }
  const repathed = plan.moves.filter(m => m.relocated);
  if (repathed.length) {
    L.push('', 'Re-pathed (old layout was not the v2 URL-shaped path):');
    for (const m of repathed.slice(0, 15)) L.push(`  ${m.from} → ${m.to}  (${m.relocated})`);
    if (repathed.length > 15) L.push(`  … ${repathed.length - 15} more (see --json)`);
  }
  if (plan.skipped.length) {
    L.push('', `Left in place in ${rel(plan.from)}/ (review; move or delete by hand):`);
    for (const s of plan.skipped) L.push(`  ${s.path}  (${REASON_TEXT[s.reason] ?? s.reason}${s.detail ? `: ${s.detail}` : ''})`);
  }

  L.push('');
  if (plan.legacyIndex) {
    const li = plan.legacyIndex;
    const blockers = li.unmigratedEntries.length;
    L.push(`Legacy index ${rel(plan.from)}/llms.txt: ${li.entries.length} entries${li.notes ? `, ${li.notes} lines of hand-written notes` : ''}.`);
    if (done?.retiredIndex) {
      L.push(`  Retired to ${rel(legacyDir(plan.to))}/llms.txt (every entry's page was migrated).`);
    } else if (li.willRetire) {
      L.push(`  Every entry's page will be migrated → it ${done ? 'could not be retired (see errors)' : `will be moved to ${rel(legacyDir(plan.to))}/llms.txt`}.`);
    } else {
      L.push(`  Left in place: ${blockers} entr${blockers === 1 ? 'y points' : 'ies point'} at files that are not migrated:`);
      for (const e of li.unmigratedEntries.slice(0, 20)) L.push(`    line ${e.line}: ${e.path}  (${e.why})`);
      if (blockers > 20) L.push(`    … ${blockers - 20} more (see --json)`);
    }
    if (li.notes) L.push('  Its hand-written notes are not carried anywhere; keep a copy if they matter.');
  } else if (plan.retiredIndexExists) {
    L.push(`Legacy index already retired to ${rel(legacyDir(plan.to))}/llms.txt.`);
  } else {
    L.push('No legacy llms.txt found.');
  }

  if (done?.errors.length) {
    L.push('', `Errors (${done.errors.length}) — originals kept; re-run to retry:`);
    for (const e of done.errors) L.push(`  ${e.from} → ${e.to}: ${e.error}`);
  }
  return L.join('\n');
}
