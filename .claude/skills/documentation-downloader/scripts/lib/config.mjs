/**
 * Where the cache lives.
 *
 * Resolution: explicit --root, then DD_DOCS_ROOT, then the default
 * `external-docs/` under the current working directory (the project root).
 * The root is marked by `.docs-cache.json` so tools can tell a cache from an
 * unrelated folder, and a legacy v1 cache (`docs/llms.txt`) can be detected
 * for `docs migrate`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

export const DEFAULT_ROOT = 'external-docs';
export const MARKER_FILE = '.docs-cache.json';
export const SCHEMA_VERSION = 2;
export const LEGACY_ROOT = 'docs';

/**
 * @param {{root?: string, cwd?: string, env?: object}} opts
 * @returns {{abs: string, rel: string, exists: boolean, marker: object|null}}
 */
export function resolveRoot({ root, cwd = process.cwd(), env = process.env } = {}) {
  const chosen = root || env.DD_DOCS_ROOT || DEFAULT_ROOT;
  const abs = resolve(cwd, chosen);
  const rel = relative(cwd, abs).split('\\').join('/') || '.';
  const markerPath = join(abs, MARKER_FILE);
  let marker = null;
  if (existsSync(markerPath)) {
    try { marker = JSON.parse(readFileSync(markerPath, 'utf-8')); } catch { marker = {}; }
  }
  return { abs, rel, exists: existsSync(abs), marker };
}

/** A v1 cache in `docs/` that `docs migrate` could move. */
export function detectLegacyRoot(cwd = process.cwd()) {
  const abs = resolve(cwd, LEGACY_ROOT);
  return existsSync(join(abs, 'llms.txt')) ? abs : null;
}

/** Paths inside the root that hold derived, gitignored state. */
export function cacheDirs(rootAbs) {
  const cache = join(rootAbs, '.cache');
  return {
    cache,
    raw: join(cache, 'raw'),
    rawMap: join(cache, 'raw-map.jsonl'),
    assets: join(cache, 'assets'),
    locks: join(cache, 'locks'),
    sqlite: join(cache, 'index.sqlite'),
    jsonIndex: join(cache, 'index.json'),
    profiles: join(rootAbs, '_profiles'),
  };
}
