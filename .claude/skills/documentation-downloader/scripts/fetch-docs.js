#!/usr/bin/env node
/**
 * v1 entry point, kept for compatibility: translates v1 flags onto the v2
 * pipeline (`node scripts/docs.mjs fetch`, lib/fetch/). New callers should use
 * `docs fetch` directly.
 *
 *   v1 flag                      v2 behaviour
 *   ---------------------------  -------------------------------------------------
 *   <url> (alone)                markdown to stdout (not cached), as in v1
 *   -o, --output <path>          single URL: markdown written to <path> (not cached)
 *   -d, --output-dir <dir>       cache root (pages at <dir>/<domain>/<path>.md)
 *   --skip-existing              the default now (cached URLs are skipped)
 *   --force                      re-fetch even when cached
 *   --update-index               no-op (the search index is updated on every write)
 *   --discover <url>             same, now scoped to the URL's site and path prefix
 *   --max-discover <n>           same
 *   --refresh [days]             same (default 30)
 *   -c, --concurrency <n>        same (1-10)
 *   -u, --urls <file>            same
 *   --no-front-matter            only with -o / stdout (cached pages always carry it)
 *   -s, --selector <css>         ignored (content extraction is automatic), with a warning
 *
 * Without -o/-d, several URLs, --discover or --refresh go to the default cache
 * root (--root, $DD_DOCS_ROOT or external-docs/).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { explainBrowserLaunchFailure, checkFetchDeps } from './lib/deps.mjs';

/**
 * Translate v1 argv (pure; unit tested).
 * @returns {{mode: 'stdout'|'file'|'cache', urls: string[], urlFiles: string[], output: string|null,
 *   frontMatter: boolean, docsArgv: string[], warnings: string[], error?: string}}
 */
export function translateArgs(argv) {
  const r = { mode: 'cache', urls: [], urlFiles: [], output: null, frontMatter: true, docsArgv: [], warnings: [] };
  const takesValue = new Set(['--output', '-o', '--output-dir', '-d', '--concurrency', '-c', '--urls', '-u',
    '--selector', '-s', '--discover', '--max-discover', '--root', '--lib', '--version']);
  let outputDir = null;
  let root = null;
  let refresh = null;
  const discover = [];
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (takesValue.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) return { ...r, error: `${a} requires a value` };
      i++;
      if (a === '-o' || a === '--output') r.output = v;
      else if (a === '-d' || a === '--output-dir') outputDir = v;
      else if (a === '--root') root = v;
      else if (a === '-u' || a === '--urls') r.urlFiles.push(v);
      else if (a === '-s' || a === '--selector') r.warnings.push(`--selector is ignored in v2 (content extraction is automatic): ${v}`);
      else if (a === '--discover') discover.push(v);
      else if (a === '-c' || a === '--concurrency') passthrough.push('--concurrency', v);
      else passthrough.push(a, v); // --max-discover, --lib, --version
    } else if (a === '--refresh') {
      if (/^\d+$/.test(argv[i + 1] ?? '')) refresh = argv[++i]; else refresh = '30';
    } else if (a === '--no-front-matter') r.frontMatter = false;
    else if (a === '--skip-existing' || a === '--update-index') { /* default / automatic now */ }
    else if (['--force', '--json', '--raw-first', '-q', '--quiet', '-v', '--verbose'].includes(a)) passthrough.push(a);
    else if (a.startsWith('-')) return { ...r, error: `Unknown option: ${a}` };
    else r.urls.push(a);
  }
  const single = r.urls.length === 1 && r.urlFiles.length === 0 && discover.length === 0 && refresh === null;
  if (r.output) {
    if (!single) return { ...r, error: '--output/-o takes exactly one URL (use --output-dir for several)' };
    r.mode = 'file';
  } else if (single && !outputDir && !root) {
    r.mode = 'stdout';
  }
  if (r.mode === 'cache' && !r.frontMatter) r.warnings.push('--no-front-matter is ignored for cached pages (the cache is keyed by Source:)');
  const rootArg = root ?? outputDir;
  r.docsArgv = [
    ...r.urls,
    ...(rootArg ? ['--root', rootArg] : []),
    ...r.urlFiles.flatMap(f => ['--urls', f]),
    ...discover.flatMap(d => ['--discover', d]),
    ...(refresh !== null ? ['--refresh', refresh] : []),
    ...passthrough,
  ];
  return r;
}

/**
 * The document written for -o / stdout: the page with the same provenance
 * front matter a cached page gets (upstream front matter merged, never stacked).
 */
export async function documentFor(markdown, url, { finalUrl = url, via, frontMatter = true, now } = {}) {
  const { parseFrontMatter, mergeFrontMatter, renderDocument } = await import('./lib/store/frontmatter.mjs');
  const { canonicalUrl } = await import('./lib/paths.mjs');
  const upstream = parseFrontMatter(markdown);
  if (!frontMatter) return upstream.body.replace(/^\n+/, '');
  const data = mergeFrontMatter({
    url: canonicalUrl(url), final: canonicalUrl(finalUrl), upstream: upstream.data,
    supplied: via ? { Via: via } : {}, now,
  });
  let text = renderDocument(data, upstream.body);
  if (!text.endsWith('\n')) text += '\n';
  return text;
}

async function single(t) {
  const { createFetchContext, fetchPage } = await import('./lib/fetch/pipeline.mjs');
  const url = t.urls[0];
  const ctx = createFetchContext({ log: (m) => console.error(m) });
  try {
    console.error(`Fetching: ${url}`);
    const r = await fetchPage(url, ctx);
    if (!r.ok) {
      console.error(`Error: ${r.reason}`);
      return 1;
    }
    const text = await documentFor(r.markdown, url, { finalUrl: r.finalUrl, via: r.via, frontMatter: t.frontMatter });
    if (t.mode === 'file') {
      mkdirSync(dirname(resolve(t.output)), { recursive: true });
      writeFileSync(t.output, text);
      console.error(`Written to: ${t.output} (via ${r.via})`);
    } else {
      process.stdout.write(text);
    }
    return 0;
  } catch (err) {
    const advice = explainBrowserLaunchFailure(err);
    if (advice) console.error(advice);
    console.error(`Error: ${err.message}`);
    return 1;
  } finally {
    await ctx.close();
  }
}

async function main(argv) {
  const t = translateArgs(argv);
  if (t.error) {
    console.error(`Error: ${t.error}\n\nUsage: node fetch-docs.js <url...> [-o file | -d dir] [--discover url] [--refresh [days]] [-c n] [-u file]\n` +
      `(v1-compatible wrapper; see node scripts/docs.mjs fetch --help)`);
    return 1;
  }
  for (const w of t.warnings) console.error(`Warning: ${w}`);
  checkFetchDeps(); // a missing `npm install` gets the setup command, not a stack trace
  if (t.mode !== 'cache') return single(t);
  const { run } = await import('./commands/fetch.mjs');
  const code = await run(t.docsArgv);
  return code === 2 ? 1 : code;
}

const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { console.error('Error:', err.message); process.exitCode = 1; },
  );
}
