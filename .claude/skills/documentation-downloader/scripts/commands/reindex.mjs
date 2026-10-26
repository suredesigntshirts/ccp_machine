/**
 * `docs reindex` — bring the search index and the generated files (catalog.md,
 * <domain>/_outline.md) up to date with the pages on disk. Incremental by default
 * (only pages whose mtime/size and content changed are re-analyzed); --full
 * rebuilds from scratch.
 */

import { runCommand, rootFromArgs } from '../lib/index/cli.mjs';
import { refreshIndex, openIndex } from '../lib/index/index.mjs';

export const summary = 'Rebuild/refresh the search index, catalog.md and _outline.md files';

const USAGE = `Usage: docs reindex [--full] [--backend sqlite|json] [--json] [--root <dir>]

  --full      re-analyze every page (default: only changed pages)
  --backend   index backend (default: sqlite when node:sqlite is available, else json)
  --json      print the summary as JSON`;

export async function run(argv) {
  return runCommand(argv, { full: 'boolean', backend: 'string', json: 'boolean' }, USAGE, async (args) => {
    const root = rootFromArgs(args);
    const s = await refreshIndex(root.abs, { full: !!args.full, generate: 'all', backend: args.backend });
    const idx = await openIndex(root.abs, { backend: args.backend });
    const stats = idx.stats();
    idx.close();
    if (args.json) {
      console.log(JSON.stringify({ ...s, stats }));
    } else {
      console.log(`Indexed ${stats.files} pages (${stats.units} sections) with ${s.backend} in ${(s.ms / 1000).toFixed(1)}s: ` +
        `${s.added} added, ${s.updated} updated, ${s.removed} removed, ${s.touched} unchanged content, ${s.unchanged} unchanged. ` +
        `Index ${(stats.bytes / 1e6).toFixed(1)} MB; ${s.generated.length} generated files rewritten.`);
    }
    return 0;
  });
}
