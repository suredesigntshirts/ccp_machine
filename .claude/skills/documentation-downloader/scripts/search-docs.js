#!/usr/bin/env node
/**
 * v1 compatibility entry point for searching the cache. The v2 commands are
 * `docs search` / `docs catalog` / `docs lookup` (scripts/docs.mjs); this maps
 * the old flags onto them so existing instructions keep working.
 *
 *   node search-docs.js --list                 every cached page with its title
 *   node search-docs.js "query"                ranked sections (docs search)
 *   node search-docs.js --content "query"      same — the index covers content
 *   node search-docs.js --stale 30             pages older than N days
 *   --docs-dir <dir>                           cache root (default: external-docs,
 *                                              or a v1 docs/ cache if that is all there is)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveRoot, detectLegacyRoot } from './lib/config.mjs';
import { listPages, findStalePages } from './lib/store/pages.mjs';
import { parseFrontMatter } from './lib/store/frontmatter.mjs';

const args = process.argv.slice(2);
const valueOf = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };

function pickRoot() {
  const explicit = valueOf('--docs-dir') || valueOf('--root');
  if (explicit) return resolve(explicit);
  const v2 = resolveRoot();
  if (v2.exists) return v2.abs;
  const legacy = detectLegacyRoot() || (existsSync(resolve('docs')) ? resolve('docs') : null);
  if (legacy) {
    console.error(`Note: using the v1 cache in ${legacy}. Move it with: node scripts/docs.mjs migrate --apply`);
    return legacy;
  }
  return v2.abs;
}

function help() {
  console.log(`Usage: node search-docs.js [--list | --content <q> | --stale <days> | <query>] [--docs-dir <dir>]

v1 compatibility wrapper. Prefer: node scripts/docs.mjs search "<query>" | catalog | lookup <url> | outline <file>`);
}

async function main() {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) { help(); return args.length ? 0 : 1; }
  const root = pickRoot();

  if (args.includes('--list') || args.includes('-l')) {
    let n = 0;
    for await (const { path, relPath } of listPages(root)) {
      const text = readFileSync(path, 'utf-8');
      const { data, body } = parseFrontMatter(text);
      const title = data.title || /^#[ \t]+(.+)$/m.exec(body)?.[1] || '';
      console.log(`  ${relPath} — ${String(title).trim()}`);
      n++;
    }
    if (!n) console.log('No cached docs found.');
    return 0;
  }

  const stale = valueOf('--stale');
  if (stale !== null) {
    const days = Number.isFinite(Number(stale)) ? Number(stale) : 30;
    const pages = await findStalePages(root, days);
    if (!pages.length) { console.log(`No docs older than ${days} days.`); return 0; }
    for (const p of pages.sort((a, b) => b.ageDays - a.ageDays)) console.log(`  ${p.relPath} — ${p.ageDays}d old [${p.source}]`);
    return 0;
  }

  const query = valueOf('--content') ?? args.find((a, i) => !a.startsWith('-') && !['--docs-dir', '--root', '--content', '--stale'].includes(args[i - 1]));
  if (!query) { help(); return 1; }
  const { run } = await import('./commands/search.mjs');
  return run([query, '--root', root]);
}

main().then(code => { process.exitCode = code ?? 0; }, err => { console.error(err.message); process.exitCode = 1; });
