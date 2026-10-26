/**
 * `docs fetch` — fetch documentation pages into the cache.
 *
 * Default is skip-if-cached (by URL: the page at the URL's path, or a page whose
 * `Source:` is the URL after a redirect). Concurrent `docs fetch` processes on one
 * root fetch each URL once (per-URL lock). See lib/fetch/batch.mjs.
 *
 * Index: every path a run writes or removes (a page, or a split page's index
 * and parts) is collected via `hooks.onWritten` and re-indexed in one batch at
 * the end (search also refreshes stale entries itself, so an interrupted run
 * self-heals on the next query).
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isAbsolute, relative } from 'node:path';
import { resolveRoot } from '../lib/config.mjs';
import { checkFetchDeps } from '../lib/deps.mjs';
import { canonicalUrl } from '../lib/paths.mjs';
import { ensureRoot } from '../lib/store/root.mjs';
import { findStalePages } from '../lib/store/pages.mjs';
import { createFetchContext } from '../lib/fetch/pipeline.mjs';
import { discoverUrls, DISCOVERY } from '../lib/fetch/discover.mjs';
import { fetchUrls, rawCacheSiblings } from '../lib/fetch/batch.mjs';
import { updateIndexForFiles } from '../lib/index/index.mjs';
import { cacheDirs } from '../lib/config.mjs';

export const summary = 'fetch pages into the cache (skips cached URLs; --discover, --refresh)';

/** Extra per-page hook (tests, embedding callers). The search index is updated regardless. */
export const hooks = {
  /** @param {string[]} paths  absolute paths just written or removed  @param {{root: string, url: string, finalUrl: string}} info */
  onWritten: async (paths, info) => {}, // eslint-disable-line no-unused-vars
};

const HELP = `Usage: node scripts/docs.mjs fetch <url...> [options]

  --root <dir>           cache root (default: $DD_DOCS_ROOT or external-docs)
  -u, --urls <file>      read URLs from a file (one per line, # comments)
  --discover <url>       also fetch the pages found under <url> (llms.txt, sitemaps;
                         same site and path prefix only)
  --max-discover <n>     cap on discovered pages (default ${DISCOVERY.MAX_URLS})
  --refresh [days]       re-fetch cached pages older than <days> (default 30)
  --force                fetch even when cached
  -c, --concurrency <n>  pages in flight (1-10, default 3)
  --lib <name>           record Library: <name> in front matter
  --version <v>          record DocsVersion: <v> in front matter
  --browser <when>       auto (default): skip the browser when the page's server HTML
                         looks complete and this site's server HTML has been checked
                         against a browser render (first pages of each site are
                         rendered and compared; see DESIGN.md); always: render every
                         page; never: never launch a browser (server HTML only)
  --llm-profiles <model> when content extraction is not confident, ask a model
                         (haiku | sonnet | id, via \`claude -p\`) for a site profile,
                         saved to <root>/_profiles/ and reused for the host
  --no-index             don't update the search index (it catches up on the next search)
  --json                 print {results: {url: {status, path | error}}, summary} on stdout
  -q, --quiet            no per-page progress lines
  -v, --verbose          also report owner-markdown probe misses

Exit status: 0 when every URL is fetched or already cached, 1 if any failed, 2 on usage errors.`;

function browserFlag(v) {
  if (v === undefined) return 'auto';
  if (!['auto', 'always', 'never'].includes(v)) throw new Error('--browser must be auto, always or never');
  return v;
}

/** `--refresh` takes an optional number: normalise to `--refresh=<days>` for parseArgs. */
export function normaliseArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--refresh') {
      if (/^\d+$/.test(argv[i + 1] ?? '')) { out.push(`--refresh=${argv[i + 1]}`); i++; } else out.push('--refresh=30');
    } else out.push(argv[i]);
  }
  return out;
}

export function parseFetchArgs(argv) {
  const { values, positionals } = parseArgs({
    args: normaliseArgv(argv),
    allowPositionals: true,
    strict: true,
    options: {
      root: { type: 'string' },
      urls: { type: 'string', short: 'u', multiple: true },
      discover: { type: 'string', multiple: true },
      'max-discover': { type: 'string' },
      refresh: { type: 'string' },
      force: { type: 'boolean', default: false },
      concurrency: { type: 'string', short: 'c' },
      lib: { type: 'string' },
      version: { type: 'string' },
      browser: { type: 'string' },
      'raw-first': { type: 'boolean', default: false }, // legacy: --browser auto
      'llm-profiles': { type: 'string' },
      'no-index': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const urls = [...positionals];
  for (const file of values.urls ?? []) {
    urls.push(...readFileSync(file, 'utf-8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')));
  }
  for (const u of urls) {
    let parsed;
    try { parsed = new URL(u); } catch { throw new Error(`Invalid URL: ${u}`); }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error(`Only http(s) URLs are supported: ${u}`);
  }
  const int = (name, v, lo, hi) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`--${name} must be an integer ${lo}-${hi}`);
    return n;
  };
  return {
    urls,
    root: values.root,
    discover: values.discover ?? [],
    maxDiscover: int('max-discover', values['max-discover'], 1, 100_000) ?? DISCOVERY.MAX_URLS,
    refresh: values.refresh === undefined ? null : int('refresh', values.refresh, 0, 100_000),
    force: values.force,
    concurrency: int('concurrency', values.concurrency, 1, 10) ?? 3,
    lib: values.lib,
    version: values.version,
    browser: browserFlag(values.browser),
    llmProfiles: values['llm-profiles'],
    noIndex: values['no-index'],
    json: values.json,
    quiet: values.quiet,
    verbose: values.verbose,
    help: values.help,
  };
}

/**
 * The whole command, reusable by the v1 wrapper.
 * @returns {Promise<{results: object[], exitCode: number, browserLaunched: boolean, ms: number}>}
 */
export async function runFetch(opts, { onWritten = hooks.onWritten, log = console.error, ctx: givenCtx } = {}) {
  const t0 = Date.now();
  const { abs: root } = resolveRoot({ root: opts.root });
  await ensureRoot(root);
  // Site profiles live with the cache; conversion may run in a worker, so pass via env.
  process.env.DD_PROFILES_DIR ??= cacheDirs(root).profiles;
  if (opts.llmProfiles) process.env.DD_PROFILE_LLM = opts.llmProfiles;
  const quietLog = opts.quiet ? () => {} : log;
  const sourcePolicy = { auto: 'auto', always: 'render', never: 'never' }[opts.browser ?? 'auto'];
  const ctx = givenCtx ?? createFetchContext({ root, sourcePolicy, siblings: rawCacheSiblings(root), log: quietLog });
  ctx.verbose = !!opts.verbose;

  const onSignal = async (sig) => {
    log(`\n${sig}: closing the browser`);
    await ctx.close().catch(() => {});
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const urls = [...opts.urls];
    const forceUrls = new Set();

    for (const start of opts.discover) {
      const found = await discoverUrls(start, { http: ctx.http, max: opts.maxDiscover, log: quietLog });
      log(`Discovered ${found.total} page(s) in ${found.scope.host}${found.scope.prefix}` +
        (found.sources.length ? ` (from ${found.sources.map(s => s.replace(/^https?:\/\/[^/]+/, '')).join(', ')})` : ' (no llms.txt, sitemap or links found)'));
      if (found.capped) {
        log(`  CAPPED at ${opts.maxDiscover}: ${found.total - found.urls.length} discovered page(s) NOT fetched. Raise with --max-discover <n>.`);
      }
      urls.push(...found.urls);
    }

    if (opts.refresh !== null) {
      const stale = await findStalePages(root, opts.refresh);
      log(stale.length ? `Refreshing ${stale.length} page(s) older than ${opts.refresh} days` : `No pages older than ${opts.refresh} days`);
      for (const s of stale) { urls.push(s.source); forceUrls.add(canonicalUrl(s.source)); }
    }

    // One entry per canonical URL.
    const seen = new Set();
    const unique = urls.filter(u => { const k = canonicalUrl(u); return seen.has(k) ? false : seen.add(k); });
    if (unique.length === 0) return { results: [], exitCode: 0, browserLaunched: false, ms: Date.now() - t0 };

    const touched = new Set();
    const results = await fetchUrls(unique, {
      root, ctx, force: opts.force, forceUrls, concurrency: opts.concurrency,
      lib: opts.lib, version: opts.version, log: quietLog,
      onWritten: async (paths, info) => { paths.forEach(p => touched.add(p)); await onWritten(paths, info); },
    });
    if (touched.size && !opts.noIndex) {
      try { await updateIndexForFiles(root, [...touched]); }
      catch (err) { log(`[WARN] search index not updated (${err.message}); it refreshes itself on the next search`); }
    }
    const browserLaunched = !!ctx.browserLaunched;
    return { results, exitCode: results.some(r => r.status === 'failed') ? 1 : 0, browserLaunched, ms: Date.now() - t0 };
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (!givenCtx) await ctx.close().catch(() => {});
  }
}

export function summarise(results, { browserLaunched, ms } = {}) {
  const fetched = results.filter(r => r.status === 'fetched');
  const cached = results.filter(r => r.status === 'cached');
  const failed = results.filter(r => r.status === 'failed');
  return {
    total: results.length,
    fetched: fetched.length,
    viaMarkdown: fetched.filter(r => r.via === 'markdown').length,
    viaHtml: fetched.filter(r => r.via === 'html').length,
    viaText: fetched.filter(r => r.via === 'text').length,
    rendered: results.filter(r => r.browser).length,
    cached: cached.length,
    failed: failed.length,
    browserLaunched: !!browserLaunched,
    seconds: ms == null ? null : Math.round(ms / 100) / 10,
  };
}

/** A path relative to the cwd when it is inside it, else absolute. */
function displayPath(p) {
  const r = relative(process.cwd(), p);
  return r.startsWith('..') || isAbsolute(r) ? p : r;
}

export async function run(argv, { onWritten } = {}) {
  let opts;
  try {
    opts = parseFetchArgs(argv);
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) { console.log(HELP); return 0; }
  checkFetchDeps(); // a missing `npm install` gets the setup command, not a stack trace
  if (opts.urls.length === 0 && opts.discover.length === 0 && opts.refresh === null) {
    console.error(HELP);
    return 2;
  }

  const out = await runFetch(opts, { onWritten: onWritten ?? hooks.onWritten });
  const s = summarise(out.results, out);
  const failed = out.results.filter(r => r.status === 'failed');
  if (opts.json) {
    const results = {};
    for (const r of out.results) {
      results[r.url] = r.status === 'failed'
        ? { status: r.status, error: r.reason, ms: r.ms }
        : {
          status: r.status, path: displayPath(r.path),
          ...(r.via ? { via: r.via, rendered: !!r.browser } : {}),
          ...(r.finalUrl && r.finalUrl !== r.url ? { finalUrl: r.finalUrl } : {}),
          ms: r.ms,
        };
    }
    console.log(JSON.stringify({ results, summary: s }, null, 2));
  }
  console.error(`\n${s.fetched} fetched (${s.viaMarkdown} owner markdown, ${s.viaHtml} HTML${s.viaText ? `, ${s.viaText} text files` : ''}; ${s.rendered} rendered), ` +
    `${s.cached} already cached, ${s.failed} failed — ${s.seconds}s, browser ${s.browserLaunched ? 'launched' : 'not launched'}`);
  for (const f of failed) console.error(`  FAILED ${f.url}: ${f.reason}`);
  return out.exitCode;
}
