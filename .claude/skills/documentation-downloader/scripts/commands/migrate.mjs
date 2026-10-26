/**
 * `docs migrate` — move a v1 `docs/` cache into the v2 layout (dry run by default).
 * The rules live in lib/store/migrate.mjs.
 */

import { parseArgs } from 'node:util';
import { relative, resolve, sep } from 'node:path';
import { LEGACY_ROOT, resolveRoot } from '../lib/config.mjs';
import { planMigration, applyMigration, formatPlan, planToJson } from '../lib/store/migrate.mjs';
import { splitLargePages } from '../lib/store/split.mjs';
import { refreshIndex } from '../lib/index/index.mjs';

export const summary = 'move a v1 docs/ cache into the v2 layout (dry run unless --apply)';

const HELP = `Usage: node scripts/docs.mjs migrate [--from docs] [--to external-docs] [--apply] [--json]

Moves pages written by v1 of this skill (front matter with Source:) into the v2
cache, at paths re-derived from each page's Source URL. Files without Source:,
non-markdown files and CLAUDE.md are listed and left where they are.

  --from <dir>   v1 cache directory (default: ${LEGACY_ROOT})
  --to <dir>     v2 cache root (default: --root, $DD_DOCS_ROOT, or external-docs)
  --root <dir>   same as --to
  --apply        perform the migration (otherwise: print the plan only)
  --json         print the full plan / result as JSON

Safe to interrupt and re-run: each page is copied, verified, then removed.`;

export async function run(argv) {
  let args;
  try {
    ({ values: args } = parseArgs({
      args: argv,
      options: {
        from: { type: 'string' },
        to: { type: 'string' },
        root: { type: 'string' },
        apply: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    return 2;
  }
  if (args.help) { console.log(HELP); return 0; }

  const from = resolve(args.from ?? LEGACY_ROOT);
  const to = resolveRoot({ root: args.to ?? args.root }).abs;

  let result;
  try {
    result = args.apply ? await applyMigration({ from, to }) : await planMigration({ from, to });
  } catch (err) {
    console.error(`migrate: ${err.message}`);
    return 1;
  }
  // After a real move: split every page in the root that is too large for one
  // Read — including pages an earlier, interrupted run moved, and regardless of
  // per-page errors in this run — then build the search index and the
  // generated catalog/outlines for the new root.
  let post = null;
  if (args.apply && result.applied) {
    post = { split: [], indexed: false };
    const { split, errors } = await splitLargePages(result.to ?? to);
    post.split = split.map(s => ({ page: relative(result.to ?? to, s.path).split(sep).join('/'), parts: s.parts }));
    for (const e of errors) console.error(`[WARN] could not split ${e.path}: ${e.error}`);
    try { await refreshIndex(result.to ?? to, { full: true }); post.indexed = true; }
    catch (err) { console.error(`[WARN] search index not built (${err.message}); run: docs reindex`); }
  }
  if (args.json) console.log(JSON.stringify({ ...planToJson(result), ...(post ? { post } : {}) }, null, 2));
  else {
    console.log(formatPlan(result, { apply: args.apply }));
    if (post) {
      console.log(`Split ${post.split.length} large page(s) into parts${post.split.length ? `: ${post.split.slice(0, 5).map(s => `${s.page} (${s.parts})`).join(', ')}${post.split.length > 5 ? ', …' : ''}` : ''}.`);
      console.log(post.indexed ? 'Search index, catalog.md and per-domain _outline.md built.' : 'Search index NOT built — run: node scripts/docs.mjs reindex');
    }
  }
  return result.applied?.errors.length ? 1 : 0;
}
