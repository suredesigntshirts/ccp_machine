/**
 * Atomic file writes.
 *
 * Every file the store writes goes through here so that no reader — another
 * subagent's `docs search`, ripgrep, a human in an editor — can ever observe a
 * half-written file. The recipe is the classic one: write a temp file in the
 * SAME directory (rename is only atomic within one filesystem), fsync it, rename
 * it over the target, then fsync the directory so the rename itself survives a
 * crash.
 *
 * Temp files are dot-prefixed so ripgrep/Glob never index them even in the
 * instant they exist, and carry a recognisable marker so a crashed writer's
 * leftovers can be swept (`sweepTempFiles`).
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp, constants as FS } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { TEMP_FILE_MARK as TEMP_MARK } from '../paths.mjs';

/** Substring every temp file name carries; used by tests and the sweeper. */
export { TEMP_MARK };

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export async function sha256File(path) {
  return sha256(await fsp.readFile(path));
}

/**
 * fsync a directory so a rename/create inside it is durable. Not every platform
 * lets you open a directory for fsync (Windows: EPERM/EISDIR), and durability of
 * the directory entry is a nicety there, not a correctness requirement — the
 * rename is still atomic — so failures are ignored.
 */
async function fsyncDir(dir) {
  let fh;
  try {
    fh = await fsp.open(dir, 'r');
    await fh.sync();
  } catch { /* best effort */ } finally {
    await fh?.close().catch(() => {});
  }
}

function tempPathFor(target) {
  const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`;
  return join(dirname(target), `.${basename(target)}${TEMP_MARK}${suffix}`);
}

/**
 * Write `data` to `path` atomically. Parent directories are created.
 *
 * @param {string} path
 * @param {string|Uint8Array} data
 * @param {{mode?: number, exclusive?: boolean}} [opts]
 *   `exclusive`: fail with EEXIST instead of replacing an existing file — used
 *   for write-once data (raw blobs, the root marker). Implemented with link(),
 *   which, unlike rename(), refuses to overwrite.
 */
export async function writeFileAtomic(path, data, opts = {}) {
  const dir = dirname(path);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = tempPathFor(path);
  let fh;
  try {
    fh = await fsp.open(tmp, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY, opts.mode ?? 0o644);
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = null;
    if (opts.exclusive) {
      await fsp.link(tmp, path); // EEXIST if someone else got there first
      await fsp.unlink(tmp);
    } else {
      await fsp.rename(tmp, path);
    }
    await fsyncDir(dir);
  } catch (err) {
    await fh?.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
  return path;
}

/**
 * Remove temp files left behind by writers that crashed between open and rename.
 * Only files older than `olderThanMs` are touched, so a write in flight in
 * another process is never pulled out from under it.
 *
 * @returns {Promise<string[]>} removed paths
 */
export async function sweepTempFiles(dir, { olderThanMs = 10 * 60_000, recursive = true } = {}) {
  const removed = [];
  const cutoff = Date.now() - olderThanMs;
  async function walk(d) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (recursive && !e.name.endsWith('.lock')) await walk(p);
      } else if (e.name.includes(TEMP_MARK)) {
        try {
          const st = await fsp.stat(p);
          if (st.mtimeMs < cutoff) { await fsp.unlink(p); removed.push(p); }
        } catch { /* raced with its owner or another sweeper */ }
      }
    }
  }
  await walk(dir);
  return removed;
}
