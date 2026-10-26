/**
 * A cross-process lock for index writers: `mkdir` is atomic on every filesystem we
 * care about, so the process that creates the directory owns the lock.
 *
 * The lock records its owner (`owner.json`: pid, host, a random token). The
 * heartbeat (the directory's mtime, refreshed while held) cannot fire while a
 * synchronous critical section — a long reindex — runs, so age alone never
 * breaks a lock whose owner is alive. A waiter breaks a lock only when:
 *   - its owner is on this host and gone (`process.kill(pid, 0)` → ESRCH);
 *   - its owner is unknown (no/unreadable owner.json: died between mkdir and
 *     writing it, or an old-format lock) and it is older than `stale`;
 *   - it is older than `maxAge` (10 min) whatever the owner — the last resort
 *     for a hung process, a reused pid, or an owner on another host.
 * Release removes the lock only while it still carries our token, so an owner
 * whose lock was broken never removes the next owner's lock.
 * We never "proceed without the lock": a waiter that times out throws.
 */

import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function readOwner(lockDir) {
  try {
    const o = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf-8'));
    return o && typeof o === 'object' ? o : null;
  } catch { return null; }
}

/** 'alive' | 'dead' | 'unknown' (no owner record, or on another host). */
function ownerState(owner) {
  if (!owner || !Number.isInteger(owner.pid)) return 'unknown';
  if (owner.host !== hostname()) return 'unknown';
  try {
    process.kill(owner.pid, 0);
    return 'alive';
  } catch (e) {
    // EPERM: the process exists but is not ours.
    return e?.code === 'EPERM' ? 'alive' : 'dead';
  }
}

/**
 * Run `fn` while holding the lock at `lockDir`.
 * @param {string} lockDir
 * @param {() => Promise<T>|T} fn
 * @param {{timeout?: number, stale?: number, maxAge?: number}} opts
 *   stale: age after which a lock with no readable owner may be broken;
 *   maxAge: age after which any lock may be broken (last resort)
 * @returns {Promise<T>}
 * @template T
 */
export async function withLock(lockDir, fn, { timeout = 120000, stale = 20000, maxAge = 10 * 60_000 } = {}) {
  mkdirSync(dirname(lockDir), { recursive: true });
  const token = randomBytes(12).toString('hex');
  const deadline = Date.now() + timeout;
  let wait = 20;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let st;
      try { st = statSync(lockDir); } catch { continue; } // released meanwhile
      const age = Date.now() - st.mtimeMs;
      const owner = readOwner(lockDir);
      const state = ownerState(owner);
      const foreign = !!owner?.host && owner.host !== hostname(); // can't probe its pid
      const breakable = state === 'dead'
        || (state === 'unknown' && !foreign && age > stale)
        || age > maxAge;
      if (breakable) {
        // Break it only if it is still the same lock: another waiter may have broken
        // it and re-acquired in the meantime (new inode, fresh mtime, new token).
        try {
          const again = statSync(lockDir);
          if (again.ino === st.ino && again.mtimeMs === st.mtimeMs && readOwner(lockDir)?.token === owner?.token) {
            // Rename first, so a racing waiter can never remove the next owner's fresh lock.
            const doomed = `${lockDir}.broken-${token}`;
            renameSync(lockDir, doomed);
            rmSync(doomed, { recursive: true, force: true });
          }
        } catch { /* raced */ }
        continue;
      }
      if (Date.now() > deadline) {
        const who = owner ? `pid ${owner.pid} on ${owner.host}` : 'an unknown owner';
        throw new Error(`Timed out waiting for lock ${lockDir} (held by ${who} for ${Math.round(age / 1000)}s)`);
      }
      await sleep(wait + Math.random() * wait);
      wait = Math.min(wait * 2, 250);
    }
  }
  let recorded = false;
  try {
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), token, at: new Date().toISOString() }));
    recorded = true;
  } catch { /* best effort: an ownerless lock is only broken once older than `stale` */ }
  const beat = setInterval(() => {
    try { const now = new Date(); utimesSync(lockDir, now, now); } catch { /* lock dir gone */ }
  }, Math.max(1000, stale / 4));
  beat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    if (recorded) release(lockDir, token);
    else try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

/** Remove the lock only if it is still ours (it may have been broken and re-acquired). */
function release(lockDir, token) {
  if (readOwner(lockDir)?.token !== token) {
    console.error(`[LOCK] ${lockDir} is no longer ours (broken while held); leaving it to its current owner`);
    return;
  }
  const doomed = `${lockDir}.released-${token}`;
  try { renameSync(lockDir, doomed); } catch { return; } // already gone
  // Between the check and the rename another process could have taken over;
  // if what we moved aside isn't ours, put it back.
  if (readOwner(doomed)?.token !== token) {
    try { renameSync(doomed, lockDir); } catch { /* a new lock exists; theirs wins */ }
    return;
  }
  try { rmSync(doomed, { recursive: true, force: true }); } catch { /* best effort */ }
}
