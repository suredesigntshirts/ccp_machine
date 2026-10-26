/**
 * `docs lookup <url...>` — is each URL cached, and in which file?
 *
 *   cached  https://code.claude.com/docs/en/hooks → external-docs/code.claude.com/docs/en/hooks.md (3179 lines)
 *   missing https://example.com/x → would be external-docs/example.com/x.md
 *
 * Exit code: 0 when every URL is cached, 1 when any is missing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, rootFromArgs, displayPrefix, UsageError } from '../lib/index/cli.mjs';
import { lookupUrl } from '../lib/index/lookup.mjs';
import { openIndex } from '../lib/index/index.mjs';

export const summary = 'Is a URL cached? Which file? (checks v1 path rules and Source: too)';

const USAGE = `Usage: docs lookup <url...> [--json] [--root <dir>]

Reports whether each URL is cached and the file that holds it.
Exit code 0 when all are cached, 1 when any is missing.`;

function lineCount(file) {
  try {
    const t = readFileSync(file, 'utf-8');
    return t.split('\n').length - (t.endsWith('\n') ? 1 : 0);
  } catch { return null; }
}

export async function run(argv) {
  return runCommand(argv, { json: 'boolean' }, USAGE, async (args) => {
    if (!args._.length) throw new UsageError(USAGE);
    const root = rootFromArgs(args);
    const prefix = displayPrefix(root);
    let idx = null;
    try { idx = await openIndex(root.abs); } catch { /* path rules only */ }
    try {
      const results = args._.map(url => {
        const r = lookupUrl(root.abs, url, idx);
        if (r.cached) r.lines = lineCount(join(root.abs, r.path));
        return r;
      });
      if (args.json) {
        console.log(JSON.stringify(results.map(r => ({ ...r, file: r.path ? prefix + r.path : null }))));
      } else {
        for (const r of results) {
          if (r.error) console.log(`invalid ${r.url}`);
          else if (r.cached) console.log(`cached  ${r.url} → ${prefix}${r.path} (${r.lines} lines)${r.via === 'path' ? '' : ` [via ${r.via}]`}`);
          else console.log(`missing ${r.url} → would be ${prefix}${r.expected}`);
        }
      }
      return results.every(r => r.cached) ? 0 : 1;
    } finally {
      idx?.close();
    }
  });
}
