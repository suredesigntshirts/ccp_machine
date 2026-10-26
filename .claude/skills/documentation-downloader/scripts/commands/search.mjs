/**
 * `docs search "<query>"` — ranked sections of cached pages as line ranges.
 *
 * Output (grouped by file, bounded by --limit and --budget):
 *   <path> — <page title>
 *     <start>-<end> (<n> lines) <heading path> — <snippet>
 * Read exactly those lines (Read with offset=start, limit=n). The index is
 * refreshed (mtime check) before every search, so results are never stale.
 */

import { runCommand, rootFromArgs, displayPrefix, UsageError } from '../lib/index/cli.mjs';
import { searchIndex, formatText, formatJson, SEARCH_DEFAULTS } from '../lib/index/index.mjs';

export const summary = 'Search cached docs; prints ranked path:start-end line ranges';

const USAGE = `Usage: docs search "<query>" [options]

Finds the sections that answer a query and prints them as line ranges,
grouped by file (files in rank order of their best section):
  <path> — <page title>
    <start>-<end> (<n> lines) <heading path> — <snippet>
Read just those lines: Read(<path>, offset=<start>, limit=<n>).

Options:
  --domain <d>        only pages under <root>/<d>/ (e.g. code.claude.com)
  --path-prefix <p>   only pages whose root-relative path starts with <p>
  --limit <n>         max results (default ${SEARCH_DEFAULTS.limit})
  --budget <tokens>   cap text output at ~<tokens> (default ${SEARCH_DEFAULTS.budget})
  --json              structured output
  --backend <b>       sqlite | json (default: sqlite when available)
  --no-refresh        skip the freshness check (the index may be stale)
  --root <dir>        cache root (default: $DD_DOCS_ROOT or external-docs/)

Query tips: exact API names work (onConflictDoUpdate, google.genai.types.X);
so do a few content words or a plain question.`;

export async function run(argv) {
  return runCommand(argv, {
    domain: 'string', 'path-prefix': 'string', limit: 'number', budget: 'number',
    json: 'boolean', backend: 'string', 'no-refresh': 'boolean',
  }, USAGE, async (args) => {
    const query = args._.join(' ').trim();
    if (!query) throw new UsageError(USAGE);
    const root = rootFromArgs(args);
    const res = await searchIndex(root.abs, query, {
      domain: args.domain,
      pathPrefix: args['path-prefix'],
      limit: args.limit ?? SEARCH_DEFAULTS.limit,
      backend: args.backend,
      refresh: !args['no-refresh'],
    });
    if (res.stale) console.error(`note: ${res.stale}`);
    const prefix = displayPrefix(root);
    if (args.json) console.log(JSON.stringify(formatJson(res, { prefix })));
    else console.log(formatText(res, { prefix, budget: args.budget ?? SEARCH_DEFAULTS.budget }));
    return 0;
  });
}
