/**
 * Ad and tracker blocking for renders, from maintained filter lists (EasyList /
 * EasyPrivacy via @ghostery/adblocker's prebuilt ads-and-tracking engine).
 *
 * Analytics, tag managers and ad scripts never carry documentation, but they keep
 * the network busy after DOMContentLoaded, and the render waits for the network to
 * settle. Blocking by list — not by "another domain", which removed real content
 * on sites that load it from a CDN (eval/results/SPEED_LOG.md, H7) — keeps the
 * content and drops the waiting.
 *
 * The built engine is cached machine-wide (limits.machineDir()) and rebuilt after
 * MAX_AGE_DAYS. If the lists cannot be fetched and there is no cache, nothing is
 * blocked: this is an optimisation, never a requirement.
 */

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { machineDir } from '../store/limits.mjs';
import { writeFileAtomic } from '../store/atomic.mjs';
import { chromeHeaders } from './http.mjs';

export const MAX_AGE_DAYS = 7;
const FILE = 'adblock-engine.bin';

let enginePromise = null;

/** Forget the loaded engine (tests). */
export function resetBlocker() { enginePromise = null; }

async function build(dir) {
  const { FiltersEngine } = await import('@ghostery/adblocker');
  const file = join(dir, FILE);
  try {
    const st = await fsp.stat(file);
    if (Date.now() - st.mtimeMs < MAX_AGE_DAYS * 86_400_000) {
      return FiltersEngine.deserialize(new Uint8Array(await fsp.readFile(file)));
    }
  } catch { /* no cache */ }
  try {
    // Same request headers as every other download (lib/fetch/http.mjs).
    const get = (url, init = {}) => fetch(url, { ...init, headers: { ...chromeHeaders(), ...(init.headers || {}) } });
    const engine = await FiltersEngine.fromPrebuiltAdsAndTracking(get);
    await fsp.mkdir(dir, { recursive: true });
    await writeFileAtomic(file, Buffer.from(engine.serialize()));
    return engine;
  } catch {
    // Offline or the list host is unreachable: an old cache is better than none.
    try { return FiltersEngine.deserialize(new Uint8Array(await fsp.readFile(file))); } catch { return null; }
  }
}

/**
 * The shared blocker for this process: `(url, pageUrl, type) => boolean`, or null
 * when no lists are available (or DD_BLOCK_TRACKERS=0).
 */
export function loadBlocker({ dir = machineDir(), env = process.env } = {}) {
  if (env.DD_BLOCK_TRACKERS === '0') return Promise.resolve(null);
  enginePromise ??= (async () => {
    const [engine, { Request }] = await Promise.all([build(dir), import('@ghostery/adblocker')]);
    if (!engine) return null;
    return (url, pageUrl, type) => {
      try {
        return engine.match(Request.fromRawDetails({ url, sourceUrl: pageUrl, type })).match;
      } catch { return false; }
    };
  })().catch(() => null);
  return enginePromise;
}
