/**
 * `docs catalog` — what is cached: one line per domain (from `<root>/catalog.md`),
 * or with --domain, that domain's pages (`<root>/<domain>/_outline.md`).
 * The generated files are refreshed first if any page changed.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, rootFromArgs } from '../lib/index/cli.mjs';
import { refreshIndex, openIndex } from '../lib/index/index.mjs';
import { renderOutline, renderCatalog, groupByDomain } from '../lib/index/generated.mjs';

export const summary = 'List cached domains (or one domain\'s pages) with page counts';

const USAGE = `Usage: docs catalog [--domain <d>] [--root <dir>]

Without --domain: one line per cached domain with page count and path groups.
With --domain: one line per page of that domain (path — title (lines)).`;

export async function run(argv) {
  return runCommand(argv, { domain: 'string' }, USAGE, async (args) => {
    const root = rootFromArgs(args);
    const catalogFile = join(root.abs, 'catalog.md');
    await refreshIndex(root.abs, { generate: existsSync(catalogFile) ? true : 'all' });
    if (!args.domain) {
      process.stdout.write(readFileSync(catalogFile, 'utf-8'));
      return 0;
    }
    // Render from the index (works for root-level v1 pages that have no domain dir).
    const idx = await openIndex(root.abs);
    try {
      const files = groupByDomain(idx.files()).get(args.domain);
      if (!files) {
        console.error(`No pages for domain ${args.domain}.\n`);
        process.stderr.write(renderCatalog(groupByDomain(idx.files())));
        return 1;
      }
      process.stdout.write(renderOutline(args.domain, files));
      return 0;
    } finally {
      idx.close();
    }
  });
}
