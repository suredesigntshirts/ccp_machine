/**
 * The index writers' lock (lib/index/lock.mjs): a lock is broken only when its
 * owner is gone (or it is absurdly old), never merely because the owner's
 * heartbeat could not fire during a long synchronous critical section; and
 * release never removes a lock that is no longer ours.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { withLock } from '../lib/index/lock.mjs';

function fakeLock(dir, owner, ageMs) {
  mkdirSync(dir, { recursive: true });
  if (owner) writeFileSync(join(dir, 'owner.json'), JSON.stringify(owner));
  const t = new Date(Date.now() - ageMs);
  utimesSync(dir, t, t);
}

test('a lock older than `stale` whose owner is alive is NOT broken', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dd-ilock-'));
  try {
    const lockDir = join(tmp, 'index.lock');
    // Owner: this very (live) process, heartbeat 60 s old — a reindex blocking its event loop.
    fakeLock(lockDir, { pid: process.pid, host: hostname(), token: 'someone-else' }, 60_000);
    let ran = false;
    await assert.rejects(withLock(lockDir, () => { ran = true; }, { timeout: 600, stale: 20_000 }), /Timed out/);
    assert.equal(ran, false);
    assert.equal(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf-8')).token, 'someone-else', 'lock untouched');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('a lock whose owner process is gone is broken promptly; a very old one as a last resort', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dd-ilock-'));
  try {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf-8' });
    const lockDir = join(tmp, 'index.lock');
    fakeLock(lockDir, { pid: Number(dead.stdout), host: hostname(), token: 'dead' }, 2_000);
    const t0 = Date.now();
    assert.equal(await withLock(lockDir, () => 'ran', { timeout: 5_000 }), 'ran');
    assert.ok(Date.now() - t0 < 2_000);
    assert.equal(existsSync(lockDir), false, 'released');

    // Live owner, but older than maxAge: broken.
    fakeLock(lockDir, { pid: process.pid, host: hostname(), token: 'hung' }, 11 * 60_000);
    assert.equal(await withLock(lockDir, () => 'ran', { timeout: 2_000 }), 'ran');

    // No owner record and older than `stale`: broken.
    fakeLock(lockDir, null, 30_000);
    assert.equal(await withLock(lockDir, () => 'ran', { timeout: 2_000 }), 'ran');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('release leaves alone a lock that is no longer ours', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dd-ilock-'));
  try {
    const lockDir = join(tmp, 'index.lock');
    await withLock(lockDir, () => {
      // Our lock was broken and another process took it over while we ran.
      rmSync(lockDir, { recursive: true, force: true });
      fakeLock(lockDir, { pid: process.pid, host: hostname(), token: 'next-owner' }, 0);
    });
    assert.equal(existsSync(lockDir), true, "the next owner's lock survives our release");
    assert.equal(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf-8')).token, 'next-owner');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
