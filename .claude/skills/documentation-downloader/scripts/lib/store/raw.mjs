/**
 * Raw cache: the fetched bytes, kept so the whole cache can be re-converted
 * offline when the HTML→markdown converter improves.
 *
 *   .cache/raw/<sha256>     content-addressed, write-once (identical bytes share a file)
 *   .cache/raw-map.jsonl    one JSON line per fetch: url → sha256, status, type, time
 *
 * Concurrency: blobs need no lock (same name ⇒ same bytes; creation is atomic and
 * exclusive). raw-map lines are appended with O_APPEND in ONE write() each, which
 * on local filesystems places every line whole at the end of the file without
 * interleaving. The reader still defends against the two failure modes that
 * remain (a process killed mid-write, or a network filesystem that doesn't honour
 * O_APPEND atomically): unparseable lines are skipped, and a torn line that got
 * glued to the next record is split back apart, so a crash costs at most the
 * record being written — never a later one.
 */

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { cacheDirs } from '../config.mjs';
import { canonicalUrl } from '../paths.mjs';
import { sha256, writeFileAtomic } from './atomic.mjs';
import { ensureRootOnce } from './pages.mjs';

// Every record starts with this, which is what lets the reader find a record
// boundary inside a torn line.
const RECORD_START = '{"url":';

export function rawPath(root, hash) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`not a sha256: ${hash}`);
  return join(cacheDirs(root).raw, hash);
}

/** Store bytes (write-once). @returns {Promise<string>} their sha256 */
export async function putRaw(root, bytes) {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : Buffer.from(bytes);
  const hash = sha256(buf);
  const path = rawPath(root, hash);
  try {
    await fsp.access(path);
    return hash; // already stored: content-addressed, so it's the same bytes
  } catch { /* store it */ }
  try {
    await writeFileAtomic(path, buf, { exclusive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err; // a concurrent writer stored the same bytes
  }
  return hash;
}

export async function readRaw(root, hash) {
  return fsp.readFile(rawPath(root, hash));
}

/**
 * Append one fetch record to raw-map.jsonl.
 * @param {{url: string, finalUrl?: string, sha256: string, status?: number,
 *          contentType?: string, fetchedAt?: string, kind?: string}} rec
 *   `kind`: what the bytes are — 'html' | 'markdown' | 'text' | 'json' | …
 */
export async function recordRaw(root, rec) {
  if (!rec?.url || !rec?.sha256) throw new Error('recordRaw needs url and sha256');
  const line = JSON.stringify({
    url: rec.url,                     // first key: RECORD_START depends on it
    finalUrl: rec.finalUrl ?? rec.url,
    sha256: rec.sha256,
    status: rec.status ?? null,
    contentType: rec.contentType ?? null,
    fetchedAt: rec.fetchedAt ?? new Date().toISOString(),
    kind: rec.kind ?? null,
  }) + '\n';
  const { rawMap, cache } = cacheDirs(root);
  await fsp.mkdir(cache, { recursive: true });
  const fh = await fsp.open(rawMap, 'a'); // O_APPEND: every write lands at the current end
  try {
    // One write() call for the whole line. FileHandle.write may in theory write
    // fewer bytes; it doesn't for regular files, but loop rather than assume.
    const buf = Buffer.from(line, 'utf-8');
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await fh.write(buf, off, buf.length - off);
      off += bytesWritten;
    }
  } finally {
    await fh.close();
  }
}

/** putRaw + recordRaw. @returns {Promise<string>} sha256 */
export async function storeRaw(root, bytes, meta) {
  await ensureRootOnce(root);
  const hash = await putRaw(root, bytes);
  await recordRaw(root, { ...meta, sha256: hash });
  return hash;
}

/** Parse raw-map text, tolerating torn and garbage lines. */
export function parseRawMap(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // A torn record followed by a whole one on the same line: parse each piece.
    const pieces = line.split(RECORD_START).filter(Boolean).map(p => RECORD_START + p);
    for (const piece of pieces) {
      try {
        const rec = JSON.parse(piece);
        if (rec && typeof rec.url === 'string' && typeof rec.sha256 === 'string') out.push(rec);
      } catch { /* torn: skip */ }
    }
  }
  return out;
}

/** All raw-map records, in append order. */
export async function readRawMap(root) {
  try {
    return parseRawMap(await fsp.readFile(cacheDirs(root).rawMap, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Most recent raw record for a URL (matched on `url` or `finalUrl`, canonicalised),
 * with the path of its bytes. Null if never recorded or the blob is gone.
 * @returns {Promise<null|(object & {path: string})>}
 */
export async function latestRaw(root, url) {
  const key = canonical(url);
  const recs = await readRawMap(root);
  let best = null;
  for (const rec of recs) {
    if (canonical(rec.url) !== key && canonical(rec.finalUrl) !== key) continue;
    // Later in the file wins ties; fetchedAt decides otherwise (clocks agree on one machine).
    if (!best || String(rec.fetchedAt) >= String(best.fetchedAt)) best = rec;
  }
  if (!best) return null;
  const path = rawPath(root, best.sha256);
  try { await fsp.access(path); } catch { return null; }
  return { ...best, path };
}

function canonical(u) {
  try { return canonicalUrl(String(u)); } catch { return String(u); }
}
