/**
 * Machine-wide limits shared by every docs process for this user, whichever
 * cache root each one writes to.
 *
 *   browser slots   at most N headless browsers alive at once (each is hundreds
 *                   of MB; eight subagents each launching one can exhaust a VM)
 *   host slots      at most N requests in flight per host, and a rate: on average
 *                   one request start per interval to one host, in bursts of up
 *                   to B (a token bucket). Parallel agents hammering one site is
 *                   how bot-checks get triggered.
 *
 * State lives in `os.tmpdir()/documentation-downloader-<uid>/` (override with
 * DD_MACHINE_DIR), deliberately outside any cache root so two projects on one
 * machine still share the budget. Slots are proper-lockfile locks — a crashed
 * holder's slot goes stale and is reclaimed — and waiting is bounded: running out
 * of time throws SlotTimeoutError rather than quietly exceeding the limit.
 *
 * Tunables (env):
 *   DD_MAX_BROWSERS          default 3
 *   DD_HOST_CONCURRENCY      default 3   (v1's per-process default, now machine-wide)
 *   DD_HOST_INTERVAL_MS      default 200 (average gap between request starts to one host)
 *   DD_HOST_BURST            default 6   (requests that may start together; 1 = strict gap)
 *   DD_BROWSER_SLOT_WAIT_MS  default 600000
 *   DD_HOST_SLOT_WAIT_MS     default 600000
 */

import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { hostKey } from '../paths.mjs';
import { acquireLockFile, LOCK_DEFAULTS } from './locks.mjs';

export class SlotTimeoutError extends Error {
  constructor(what, max, waitedMs, dir) {
    super(`Timed out after ${Math.round(waitedMs / 1000)}s waiting for a ${what} slot ` +
      `(all ${max} in use by other docs processes on this machine; state in ${dir}). ` +
      `Retry later, or raise the limit with the environment variable named in lib/store/limits.mjs.`);
    this.name = 'SlotTimeoutError';
    this.code = 'ESLOTTIMEOUT';
  }
}

function envInt(name, fallback, env = process.env) {
  const v = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Current limits (read at call time so tests and callers can change env). */
export function limitsConfig(env = process.env) {
  return {
    maxBrowsers: Math.max(1, envInt('DD_MAX_BROWSERS', 3, env)),
    hostConcurrency: Math.max(1, envInt('DD_HOST_CONCURRENCY', 3, env)),
    hostIntervalMs: envInt('DD_HOST_INTERVAL_MS', 200, env),
    // A page's own requests (plain GET + markdown probes) go out together; the
    // average stays one request per hostIntervalMs.
    hostBurst: Math.max(1, envInt('DD_HOST_BURST', 6, env)),
    browserWaitMs: envInt('DD_BROWSER_SLOT_WAIT_MS', 600_000, env),
    hostWaitMs: envInt('DD_HOST_SLOT_WAIT_MS', 600_000, env),
  };
}

export function machineDir(env = process.env) {
  if (env.DD_MACHINE_DIR) return env.DD_MACHINE_DIR;
  let who;
  try { who = process.getuid?.() ?? userInfo().username; } catch { who = 'user'; }
  return join(tmpdir(), `documentation-downloader-${who}`);
}

// Slots are acquired per page render or request: short and frequent. Two things
// keep that cheap: a waiter in the same process is woken the moment a slot is
// released (no polling delay), and polling for slots freed by OTHER processes
// backs off only to 250 ms.
const released = new EventEmitter();
released.setMaxListeners(0);
const readyDirs = new Set();
const MAX_POLL_MS = 250;

/** Sleep up to `ms`, returning early if a slot in `dir` is released in this process. */
function waitForRelease(dir, ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); released.off(dir, done); resolve(); };
    const timer = setTimeout(done, ms);
    released.on(dir, done);
  });
}

async function ensureDir(dir) {
  if (readyDirs.has(dir)) return;
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  readyDirs.add(dir);
}

/**
 * Take one of `max` slots in `dir`. Tries slots in a random order so waiters
 * don't all contend for slot-0.
 * @returns {Promise<{slot: number, release: () => Promise<void>}>}
 */
export async function acquireSlot(dir, max, { waitMs, staleMs = LOCK_DEFAULTS.staleMs, what = 'slot' } = {}) {
  await ensureDir(dir);
  const start = Date.now();
  let delay = 10;
  for (;;) {
    const offset = Math.floor(Math.random() * max);
    for (let k = 0; k < max; k++) {
      const slot = (offset + k) % max;
      try {
        const release = await lockfile.lock(join(dir, `slot-${slot}`), {
          realpath: false, stale: staleMs, retries: 0,
          onCompromised: (err) => console.error(`[LIMITS] lost ${what} slot ${slot}: ${err.message}`),
        });
        let done = false;
        return {
          slot,
          release: async () => {
            if (done) return;
            done = true;
            await release().catch(() => {});
            released.emit(dir); // wake this process's waiters now
          },
        };
      } catch (err) {
        if (err.code === 'ENOENT') { readyDirs.delete(dir); await ensureDir(dir); continue; } // dir cleaned away
        if (err.code !== 'ELOCKED') throw err;
      }
    }
    const waited = Date.now() - start;
    if (waited >= waitMs) throw new SlotTimeoutError(what, max, waited, dir);
    await waitForRelease(dir, Math.min(delay * (0.5 + Math.random()), waitMs - waited));
    delay = Math.min(delay * 1.5, MAX_POLL_MS);
  }
}

/**
 * Take a browser slot; call `release()` when done. Meant to be held per page
 * render (short, frequent acquisitions are cheap), so a browser kept open
 * between pages doesn't count against the limit while idle.
 * @returns {Promise<{slot: number, release: () => Promise<void>}>}
 */
export function acquireBrowserSlot(opts = {}) {
  const cfg = limitsConfig();
  return acquireSlot(join(opts.dir ?? machineDir(), 'browsers'), opts.max ?? cfg.maxBrowsers,
    { waitMs: opts.waitMs ?? cfg.browserWaitMs, what: 'browser' });
}

/** Run `fn` holding a browser slot. */
export async function withBrowserSlot(fn, opts = {}) {
  const { release, slot } = await acquireBrowserSlot(opts);
  try { return await fn({ slot }); } finally { await release(); }
}

function hostDirName(host) {
  const h = /^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? hostKey(host) : String(host).toLowerCase().replace(/^www\./, '');
  return h.replace(/[^a-z0-9.-]+/g, '_') || '_';
}

/**
 * Reserve a start time for a request to this host and return how long to wait
 * for it: a token bucket (GCRA — one timestamp, the "theoretical arrival time")
 * allowing on average one request per `intervalMs`, in bursts of up to `burst`.
 * burst 1 is a plain minimum gap between starts. Reservations are handed out
 * under a short lock, so N waiters get N distinct start times instead of all
 * waking together.
 */
export function gcraReserve(tat, now, intervalMs, burst) {
  const base = Math.max(tat, now);
  const allowAt = base - (Math.max(1, burst) - 1) * intervalMs;
  return { wait: Math.max(0, allowAt - now), tat: base + intervalMs };
}

async function reserveHostStart(dir, intervalMs, burst) {
  if (intervalMs <= 0) return 0;
  const release = await acquireLockFile(join(dir, 'rate'), { waitMs: 30_000, kind: 'host rate', key: dir });
  try {
    const file = join(dir, 'next-start');
    let tat = 0;
    try { tat = Number((await fsp.readFile(file, 'utf-8')).trim()) || 0; } catch { /* first use */ }
    const r = gcraReserve(tat, Date.now(), intervalMs, burst);
    // Plain write is fine here: it's advisory timing state guarded by the lock,
    // and a torn value just parses as 0 (no delay once).
    await fsp.writeFile(file, String(r.tat));
    return r.wait;
  } finally {
    await release().catch(() => {});
  }
}

/**
 * Run `fn` as one polite request to `host` (a hostname or any URL on it): waits
 * for one of the host's concurrent slots, then for its turn in the rate schedule.
 */
export async function withHostSlot(host, fn, opts = {}) {
  const cfg = limitsConfig();
  const dir = join(opts.dir ?? machineDir(), 'hosts', hostDirName(host));
  const { release, slot } = await acquireSlot(dir, opts.max ?? cfg.hostConcurrency,
    { waitMs: opts.waitMs ?? cfg.hostWaitMs, what: `host (${hostDirName(host)})` });
  try {
    const wait = await reserveHostStart(dir, opts.intervalMs ?? cfg.hostIntervalMs, opts.burst ?? cfg.hostBurst);
    if (wait > 0) await sleep(wait);
    return await fn({ slot });
  } finally {
    await release();
  }
}
