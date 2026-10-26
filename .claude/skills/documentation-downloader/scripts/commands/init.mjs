/**
 * `docs init` — make the cache root (marker file + self-ignoring .cache/).
 * Every writing command does this implicitly; this is for doing it up front.
 */

import { parseArgs } from 'node:util';
import { resolveRoot, detectLegacyRoot } from '../lib/config.mjs';
import { ensureRoot } from '../lib/store/root.mjs';

export const summary = 'create the cache root (external-docs/) and its gitignored .cache/';

export async function run(argv) {
  let args;
  try {
    ({ values: args } = parseArgs({
      args: argv,
      options: { root: { type: 'string' }, help: { type: 'boolean', short: 'h', default: false } },
      strict: true,
    }));
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (args.help) {
    console.log('Usage: node scripts/docs.mjs init [--root <dir>]');
    return 0;
  }
  const { abs, rel } = resolveRoot({ root: args.root });
  try {
    const { created } = await ensureRoot(abs);
    console.log(created ? `Initialised ${rel}/` : `${rel}/ is already a docs cache`);
  } catch (err) {
    console.error(`init: ${err.message}`);
    return 1;
  }
  if (detectLegacyRoot()) {
    console.log('A v1 cache (docs/llms.txt) exists here: preview moving it with `node scripts/docs.mjs migrate`.');
  }
  return 0;
}
