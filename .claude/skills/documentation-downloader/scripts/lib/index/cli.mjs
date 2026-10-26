/**
 * Small helpers shared by the index-related commands (search, outline, lookup,
 * catalog, reindex): argument parsing and cache-root resolution.
 */

import { resolveRoot } from '../config.mjs';

/**
 * Parse `argv` against a spec: {name: 'string'|'number'|'boolean'}. Positionals
 * are collected in `_`. Unknown flags are an error (typos should not be ignored).
 */
export function parseArgs(argv, spec) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--') || a === '--') { out._.push(a); continue; }
    let [name, value] = a.slice(2).split(/=(.*)/s);
    const type = spec[name];
    if (!type) throw new UsageError(`Unknown option --${name}`);
    if (type === 'boolean') { out[name] = value === undefined ? true : value !== 'false'; continue; }
    if (value === undefined) {
      if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
      value = argv[++i];
    }
    if (type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number`);
      out[name] = n;
    } else {
      out[name] = value;
    }
  }
  return out;
}

export class UsageError extends Error {}

/** Resolve the cache root from --root / DD_DOCS_ROOT / default; error if missing. */
export function rootFromArgs(args) {
  const root = resolveRoot({ root: args.root });
  if (!root.exists) throw new UsageError(`No documentation cache at ${root.rel} (use --root or DD_DOCS_ROOT)`);
  return root;
}

/**
 * Prefix that turns a root-relative path into one Read-able from the cwd: relative
 * when the root is inside the cwd (the usual `external-docs/`), absolute otherwise.
 */
export function displayPrefix(root) {
  if (root.rel === '.') return '';
  return root.rel.startsWith('..') ? `${root.abs}/` : `${root.rel}/`;
}

/** Run a command body, mapping usage errors to exit code 2 with a message. */
export async function runCommand(argv, spec, usage, body) {
  let args;
  try {
    args = parseArgs(argv, { ...spec, help: 'boolean', root: 'string' });
  } catch (e) {
    if (e instanceof UsageError) { console.error(`${e.message}\n\n${usage}`); return 2; }
    throw e;
  }
  if (args.help || argv.includes('-h')) { console.log(usage); return 0; }
  try {
    return await body(args);
  } catch (e) {
    if (e instanceof UsageError) { console.error(e.message); return 2; }
    throw e;
  }
}
