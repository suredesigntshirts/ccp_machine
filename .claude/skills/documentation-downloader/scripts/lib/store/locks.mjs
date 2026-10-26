/**
 * Cross-process locks for one cache root.
 *
 * Three kinds, all under `<root>/.cache/locks/` (gitignored, rebuildable):
 *
 *   url/<hash>       one page. Held for the whole fetch → write of that URL, so a
 *                    second requester waits and then finds the page cached instead
 *                    of fetching it again.
 *   page/<hash>      one page FILE (path, not URL): its write and the split that
 *                    follows. Several URLs can land on one file — two requested
 *                    URLs redirecting to one final URL, or `/a` and `/a/` — and
 *                    their url locks don't exclude each other.
 *   domain/<host>    that domain's generated files (`_outline.md`) and its site
 *                    profile (`_profiles/<host>.json`).
 *   global/<name>    short critical sections over the whole root (catalog.md
 *                    regeneration, migration).
 *
 * Acquisition order, when nesting is needed: url → page → domain → global, never
 * the reverse. Two url locks nest only as requested URL → final URL after a redirect
 * (writePage locks the final URL while the fetch holds the requested one); a
 * cycle would need a redirect loop. Processes nesting in opposite orders
 * deadlock until one of them times out. (global/migrate is the documented
 * exception: it is outermost, and nothing else takes it.)
 *
 * Built on proper-lockfile (an mkdir-based lock whose mtime the holder refreshes
 * while alive, so a crashed holder's lock goes stale and is reclaimed). Waiting
 * is bounded, and running out of time FAILS with LockTimeoutError — v1's lock
 * "proceeded without it" after 10 s, which is exactly how llms.txt lost entries.
 *
 * Locks are re-entrant within one async call chain (AsyncLocalStorage), so
 * `writePage` can take the URL lock itself and still be called from inside a
 * fetch that already holds it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fsp } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { cacheDirs } from '../config.mjs';
import { canonicalUrl, hostKey } from '../paths.mjs';
import { sha256 } from './atomic.mjs';

/** Defaults, overridable per call and by env (DD_LOCK_WAIT_MS applies to every kind). */
export const LOCK_DEFAULTS = {
  // A URL lock is held across a whole fetch, which can include waiting for a
  // browser slot and host politeness delays; waiters need patience.
  url: { waitMs: 5 * 60_000 },
  // Held for one write + split (no network), but behind a url lock's whole fetch.
  page: { waitMs: 5 * 60_000 },
  domain: { waitMs: 60_000 },
  global: { waitMs: 30_000 },
  // A live holder refreshes its lock every staleMs/2. Only a holder whose event
  // loop is blocked for longer than this (or that died) loses the lock.
  staleMs: 30_000,
};

export class LockTimeoutError extends Error {
  constructor({ kind, key, lockPath, waitedMs, ageMs }) {
    const age = ageMs == null ? '' : ` (held for ${Math.round(ageMs / 1000)}s by another process)`;
    super(
      `Timed out after ${Math.round(waitedMs / 1000)}s waiting for the ${kind} lock on ${key}${age}. ` +
      `Another docs process is still working on it; retry later. If no docs process is running, ` +
      `the lock is released automatically once it goes stale, or remove ${lockPath}.`);
    this.name = 'LockTimeoutError';
    this.code = 'ELOCKTIMEOUT';
    Object.assign(this, { kind, key, lockPath, waitedMs });
  }
}

// Map<lockFile, {released: boolean}> for the current async chain. The token's
// `released` flag matters: async work spawned inside a lock inherits this
// context and may outlive the lock; once released it must lock for itself.
const held = new AsyncLocalStorage();

function envInt(name) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : undefined;
}

function safeName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 120) || '_';
}

/** Path (without the `.lock` suffix proper-lockfile adds) for a lock. */
export function lockFileFor(root, kind, key) {
  const base = join(cacheDirs(root).locks, kind);
  if (kind === 'url') {
    // Hash: URLs are long and full of characters filesystems dislike.
    return join(base, sha256(canonicalUrl(key)).slice(0, 40));
  }
  if (kind === 'page') return join(base, sha256(pageKey(root, key)).slice(0, 40));
  return join(base, safeName(key));
}

/**
 * Acquire `file` (a path; the lock itself is the directory `${file}.lock`),
 * waiting at most `waitMs`. Returns proper-lockfile's async release function.
 */
export async function acquireLockFile(file, { waitMs, staleMs, kind = 'lock', key = file } = {}) {
  waitMs ??= envInt('DD_LOCK_WAIT_MS') ?? LOCK_DEFAULTS.global.waitMs;
  staleMs ??= envInt('DD_LOCK_STALE_MS') ?? LOCK_DEFAULTS.staleMs;
  const start = Date.now();
  const deadline = start + waitMs;
  let delay = 15;
  let missingDir = 0;
  await fsp.mkdir(dirname(file), { recursive: true });

  for (;;) {
    try {
      return await lockfile.lock(file, {
        realpath: false,     // the locked "file" need not exist; we lock a name
        stale: staleMs,
        retries: 0,          // we run our own bounded, jittered wait loop below
        onCompromised: (err) => {
          // Default is to throw from a timer, which would crash the process mid-write.
          // The write itself is still atomic; say loudly that exclusivity was lost.
          console.error(`[LOCK] lost ${kind} lock on ${key}: ${err.message}`);
        },
      });
    } catch (err) {
      if (err.code === 'ENOENT' && missingDir++ < 5) {
        await fsp.mkdir(dirname(file), { recursive: true }); // locks dir removed under us
        continue;
      }
      if (err.code !== 'ELOCKED') throw err;
    }
    const now = Date.now();
    if (now >= deadline) {
      let ageMs = null;
      try {
        const born = (await fsp.stat(`${file}.lock`)).birthtimeMs;
        if (born > 0) ageMs = now - born; // 0 where the fs has no birth time
      } catch { /* just released */ }
      throw new LockTimeoutError({ kind, key, lockPath: `${file}.lock`, waitedMs: now - start, ageMs });
    }
    // Jitter keeps a crowd of waiters from retrying in lockstep.
    await sleep(Math.min(delay * (0.5 + Math.random()), deadline - now));
    delay = Math.min(delay * 1.6, 500);
  }
}

/** Run `fn` holding the lock at `file`. Re-entrant within one async call chain. */
export async function withLockFile(file, fn, opts = {}) {
  const current = held.getStore();
  if (current?.get(file)?.released === false) return fn();
  const release = await acquireLockFile(file, opts);
  const token = { released: false };
  try {
    return await held.run(new Map([...(current ?? []), [file, token]]), fn);
  } finally {
    token.released = true;
    await release().catch(err => {
      if (err.code !== 'ERELEASED') console.error(`[LOCK] release failed for ${file}: ${err.message}`);
    });
  }
}

function kindOpts(kind, opts) {
  return {
    waitMs: opts.waitMs ?? envInt('DD_LOCK_WAIT_MS') ?? LOCK_DEFAULTS[kind].waitMs,
    staleMs: opts.staleMs,
  };
}

/** Exclusive access to one URL's page (fetch → write). */
export function withUrlLock(root, url, fn, opts = {}) {
  const key = canonicalUrl(url);
  return withLockFile(lockFileFor(root, 'url', key), fn, { ...kindOpts('url', opts), kind: 'URL', key });
}

/**
 * The page-file key: its path relative to the root, `/`-separated, lower-cased
 * (so case variants that are one file on a case-insensitive filesystem share a lock).
 */
function pageKey(root, path) {
  const rel = isAbsolute(path) ? relative(root, path) : path;
  return rel.split(sep).join('/').toLowerCase();
}

/**
 * Exclusive access to one page file (absolute or root-relative path): hold it
 * across a page write AND the split that follows, so two writers landing on one
 * file cannot interleave write, write, split, split. Take it after any url
 * locks (url → page), never before.
 */
export function withPageLock(root, path, fn, opts = {}) {
  return withLockFile(lockFileFor(root, 'page', path), fn, { ...kindOpts('page', opts), kind: 'page', key: pageKey(root, path) });
}

/** The domain a lock is keyed on: `hostKey` of a URL, or a bare host normalised the same way. */
export function domainKey(host) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? hostKey(host) : String(host).toLowerCase().replace(/^www\./, '');
}

/** Exclusive access to a domain's generated files and site profile. `host` may be a URL. */
export function withDomainLock(root, host, fn, opts = {}) {
  const key = domainKey(host);
  return withLockFile(lockFileFor(root, 'domain', key), fn, { ...kindOpts('domain', opts), kind: 'domain', key });
}

/** A short root-wide critical section, e.g. `withGlobalLock(root, 'catalog', …)`. */
export function withGlobalLock(root, name, fn, opts = {}) {
  return withLockFile(lockFileFor(root, 'global', name), fn, { ...kindOpts('global', opts), kind: 'global', key: name });
}

/** True if the current async chain holds the given lock (for assertions in writers). */
export function holdsLock(root, kind, key) {
  const k = kind === 'url' ? canonicalUrl(key) : kind === 'domain' ? domainKey(key) : key; // page: lockFileFor normalises
  return held.getStore()?.get(lockFileFor(root, kind, k))?.released === false;
}
