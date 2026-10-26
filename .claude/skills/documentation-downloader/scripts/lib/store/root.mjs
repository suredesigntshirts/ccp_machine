/**
 * Cache root initialisation (`docs init`).
 *
 * Two files make a directory a v2 cache:
 *   <root>/.docs-cache.json   marker with the schema version (committed)
 *   <root>/.cache/.gitignore  containing `*`
 *
 * The second is how derived state (index, raw bytes, locks) stays out of git
 * without editing the user's own .gitignore: git honours a .gitignore inside the
 * ignored directory itself, and `*` also matches that .gitignore, so the whole
 * `.cache/` directory is invisible to `git status`.
 *
 * Safe to call from many processes at once: every write is atomic and
 * create-if-absent, and concurrent creators write identical content.
 */

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { MARKER_FILE, SCHEMA_VERSION, cacheDirs } from '../config.mjs';
import { writeFileAtomic } from './atomic.mjs';

async function readJson(path) {
  try { return JSON.parse(await fsp.readFile(path, 'utf-8')); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${path} exists but is not valid JSON (${err.message}); fix or remove it`);
  }
}

async function createIfAbsent(path, content) {
  try {
    await writeFileAtomic(path, content, { exclusive: true });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Make `rootAbs` a cache root (idempotent).
 * @returns {Promise<{root: string, created: boolean, marker: object}>}
 * @throws if the marker declares a newer schema than this tool understands.
 */
export async function ensureRoot(rootAbs) {
  const dirs = cacheDirs(rootAbs);
  await fsp.mkdir(dirs.cache, { recursive: true });

  const markerPath = join(rootAbs, MARKER_FILE);
  const created = await createIfAbsent(markerPath, `${JSON.stringify({
    schema: SCHEMA_VERSION,
    tool: 'documentation-downloader',
    created: new Date().toISOString().slice(0, 10),
  }, null, 2)}\n`);
  const marker = await readJson(markerPath);
  if (marker && Number(marker.schema) > SCHEMA_VERSION) {
    throw new Error(`${markerPath} has schema ${marker.schema}; this tool understands up to ${SCHEMA_VERSION}. Update the skill.`);
  }

  await createIfAbsent(join(dirs.cache, '.gitignore'),
    '# Derived state (search index, raw fetches, locks): rebuildable, never committed.\n*\n');
  return { root: rootAbs, created, marker };
}
