#!/usr/bin/env node
/**
 * Documentation Fetcher
 *
 * Fetches documentation pages from any website using Playwright (for JavaScript-rendered content),
 * converts to GitHub-flavored markdown, and outputs with front matter.
 *
 * Optimizations:
 * - Single page.evaluate() for title + content extraction (fewer browser round-trips)
 * - Resource blocking (images, media, fonts, stylesheets)
 * - Smart wait for content selector instead of fixed delay
 *
 * Usage:
 *   node fetch-docs.js <url> [--output <path>] [--selector <css-selector>] [--no-front-matter]
 *
 * Examples:
 *   node fetch-docs.js https://help.getzep.com/graphiti/getting-started/quick-start
 *   node fetch-docs.js https://developer.capsulecrm.com/v2/operations/Party --output docs/capsule/Party.md
 *   node fetch-docs.js https://example.com/docs --selector "article.docs-content"
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, unlinkSync, openSync, closeSync, statSync, renameSync } from 'fs';
import { dirname, parse, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { generateDescription } from './lib/descriptions.mjs';
import { loadFetchDeps, explainBrowserLaunchFailure } from './lib/deps.mjs';

// playwright/turndown are loaded dynamically so that a missing install reports
// the setup command instead of an ERR_MODULE_NOT_FOUND stack trace — a static
// import resolves before any code here could catch it. See lib/deps.mjs.
const { chromium, TurndownService, gfm } = await loadFetchDeps();

// ============================================================================
// Cloud egress (Claude Code web sessions)
// ============================================================================
// In a Claude Code cloud session every request leaves through an Anthropic egress
// proxy, and a DEFAULT Chromium launch cannot reach anything through it: every
// navigation fails with ERR_CONNECTION_RESET (ERR_CONNECTION_CLOSED on older VMs)
// while plain `curl` to the same URL through the same proxy returns 200. That
// asymmetry is the signature — if you see it, this is the cause.
//
// TWO settings are required. Neither works on its own (measured 2026-07-29 across
// the full matrix; see the harempants.com monorepo, plans/cloud-rebuild, spike S12):
//
//   1. channel: 'chrome'         The bundled/managed Chromium CANNOT navigate here
//                                at all — even with the TLS pin below. Only the
//                                system Google Chrome works. This is the half most
//                                people miss, because the pin alone looks like the
//                                whole fix in older write-ups.
//   2. --ssl-version-max=tls1.2  The proxy silently drops Chrome's large TLS 1.3
//                                ClientHello, so the handshake gets zero bytes
//                                back. Pinning the browser->proxy leg to TLS 1.2
//                                sends a smaller hello the proxy accepts.
//
// Supporting flags: --no-sandbox because cloud sessions run as root and Chrome
// refuses to start otherwise; --disable-dev-shm-usage because /dev/shm is tiny in
// containers; ignoreHTTPSErrors as a backstop for the proxy's MITM certificate.
// The explicit `proxy` option is OPTIONAL (the proxy is transparent) but harmless,
// so it is passed when HTTPS_PROXY is set, for older non-transparent VMs.
//
// Requires system Chrome on the box: `npx playwright install --with-deps chrome`.
// All of this is gated on CLAUDE_CODE_REMOTE so local runs are untouched.
const IS_CLOUD = process.env.CLAUDE_CODE_REMOTE === 'true';

/** Launch options needed to reach the network from a cloud session; {} locally. */
function cloudLaunchOptions() {
  if (!IS_CLOUD) return {};
  return {
    channel: 'chrome',
    args: ['--no-sandbox', '--ssl-version-max=tls1.2'],
    ...(process.env.HTTPS_PROXY
      ? { proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } }
      : {}),
  };
}

/**
 * Single place every browser launch goes through, so a new call site cannot
 * silently reintroduce the cloud-egress bug by calling chromium.launch directly.
 */
async function launchBrowser(extra = {}) {
  const { args: cloudArgs = [], ...cloudOpts } = cloudLaunchOptions();
  try {
    return await chromium.launch({
      headless: true,
      ...cloudOpts,
      ...extra,
      args: ['--disable-dev-shm-usage', ...cloudArgs],
    });
  } catch (err) {
    // `npm install` installs the library but never the browser binary, so this
    // is the most common second-stage failure. Say so in the skill's own terms.
    const advice = explainBrowserLaunchFailure(err);
    if (advice) console.error(advice);
    throw err;
  }
}

// ============================================================================
// Configuration Constants
// ============================================================================

const DEBUG = process.env.DEBUG === 'true';

/** Timeout values in milliseconds */
const TIMEOUTS = {
  GLOBAL: 120000,      // 2 minutes - floor for the whole operation (scaled up per URL, see globalBudgetMs)
  FETCH: 10000,        // 10 seconds - individual HTTP fetch requests
  FETCH_FAST: 3000,    // 3 seconds - fast fail for markdown variants (a miss just falls back to the browser)
  BROWSER: 30000,      // 30 seconds - browser operations
  PAGE_LOAD: 60000,    // 60 seconds - page navigation
  CONTENT_WAIT: 3000,  // 3 seconds - wait for content selector
  PER_URL: 30000,      // 30 seconds - added to the global budget for each serial batch slot
};

/**
 * The global watchdog must scale with the work, or a large --discover batch is
 * killed mid-run: files already written survive, but the llms.txt index update
 * (which happens after the batch) is lost and the command exits 1.
 */
function globalBudgetMs(urlCount = 1, concurrency = 1) {
  const waves = Math.ceil(Math.max(1, urlCount) / Math.max(1, concurrency));
  return TIMEOUTS.GLOBAL + waves * TIMEOUTS.PER_URL;
}

/** Scoring and validation thresholds */
const CONFIG = {
  SCORE_THRESHOLD: 10,       // Min score for markdown link candidate
  MIN_CONTENT_LENGTH: 200,   // Min chars for valid content container
  MAX_CANDIDATES: 3,         // Top N markdown source links to try
  MIN_MARKDOWN_LENGTH: 50,   // Min chars for valid markdown
};

// ============================================================================
// Pre-compiled Regex Patterns (avoid recompilation on each call)
// ============================================================================

const PATTERNS = {
  // URL conversion patterns
  GITHUB_BLOB: /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/,
  GITHUB_TREE: /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/(.+)$/,
  GITHUB_EDIT: /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/edit\/(.+)$/,
  GITLAB_BLOB: /^(https?:\/\/gitlab\.com\/.+)\/-\/blob\/(.+)$/,
  GITLAB_EDIT: /^(https?:\/\/gitlab\.com\/.+)\/-\/edit\/(.+)$/,

  // Language detection patterns
  LANG_PYTHON: /^from\s+\w+\s+import|^import\s+\w+|^def\s+\w+\(|^class\s+\w+[:(]|print\(/,
  LANG_JAVASCRIPT: /^import\s*{|^import\s+\w+\s+from|^const\s+\w+\s*=|^let\s+\w+\s*=|^var\s+\w+\s*=|async\s+function|=>\s*{|\.then\(/,
  LANG_GO: /^package\s+\w+|^func\s+\w+|:=\s*|fmt\.|^import\s*\(/,
  LANG_RUST: /^fn\s+\w+|^let\s+mut\s+|^use\s+\w+::|^impl\s+/,
  LANG_RUBY: /^require\s+['"]|^def\s+\w+|^class\s+\w+\s*<|\.each\s+do/,
  LANG_BASH: /^curl\s|^#.*\n.*\w|^\$\s*\w|^npm\s|^pip\s|^brew\s|^export\s/,
  LANG_YAML: /^\w+:\s*\n|^\s+-\s+\w+:/,
  LANG_SQL: /^SELECT\s|^INSERT\s|^UPDATE\s|^CREATE\s|^DROP\s/i,
  LANG_GRAPHQL: /^query\s+\w+|^mutation\s+\w+|^type\s+\w+\s*{|^fragment\s+/,
  LANG_HTML: /^<!DOCTYPE|^<html|^<div|^<span|^<p\b/,

  // Markdown validation patterns
  MD_HEADER: /^#{1,6}\s+\S/m,
  MD_CODE_FENCE: /^```/m,
  MD_UNORDERED_STAR: /^\*\s+\S/m,
  MD_UNORDERED_DASH: /^-\s+\S/m,
  MD_ORDERED: /^\d+\.\s+\S/m,
  MD_LINK: /\[.+\]\(.+\)/,
  MD_BOLD: /\*\*\S.*\S\*\*/,
  MD_BLOCKQUOTE: /^>\s+\S/m,
  MD_TABLE: /^\|.+\|/m,
  MD_HR: /^---$/m,

  // MDX patterns
  MDX_IMPORT: /^import\s+.*from\s+['"][@\w]/m,
  MDX_EXPORT: /^export\s+(default|const|let)/m,
  MDX_JSX: /<[A-Z][a-zA-Z]*[\s/>]/,
  MDX_COMMENT: /\{\/\*.*\*\/\}/,

  // HTML detection
  HTML_DOCTYPE: /^<!DOCTYPE|^<html|^<\?xml/i,

  // Simple markdown check
  SIMPLE_MD_CHECK: /^#\s|^```|^\*\s|^-\s|^\d+\.\s/m,

  // Double slashes in path
  DOUBLE_SLASH: /([^:])\/\/+/g,
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Detect soft-404 pages — sites that return HTTP 200 but render a "not found" page.
 * Strips front matter before checking. Returns true if the content looks like a 404 page.
 */
function isSoft404(markdown) {
  // Strip YAML front matter if present
  let content = markdown;
  if (content.startsWith('---\n')) {
    const endIdx = content.indexOf('\n---\n', 4);
    if (endIdx !== -1) {
      content = content.slice(endIdx + 5);
    }
  }
  content = content.trim();

  // Too little content after front matter is suspicious
  if (content.length < CONFIG.MIN_CONTENT_LENGTH) {
    // Check for 404-like phrases in short content
    const lower = content.toLowerCase();
    const notFoundPhrases = [
      'page not found',
      'not found',
      '404',
      'could not find',
      'does not exist',
      'no longer exists',
      'page doesn\'t exist',
      'page does not exist',
      'nothing here',
      'broken link',
    ];
    for (const phrase of notFoundPhrases) {
      if (lower.includes(phrase)) {
        return true;
      }
    }
  }

  // Check if the first heading is a 404 indicator (even in longer content)
  const firstHeadingMatch = content.match(/^#\s+(.+)/m);
  if (firstHeadingMatch) {
    const heading = firstHeadingMatch[1].toLowerCase().trim();
    if (heading === 'page not found' || heading === '404' || heading === 'not found' || heading === '404 not found') {
      return true;
    }
  }

  return false;
}

/** Debug logging - only outputs when DEBUG=true */
function logDebug(msg, err) {
  if (DEBUG) console.error(`[DEBUG] ${msg}`, err?.message || '');
}

/**
 * Fetch with timeout using AbortController
 * @param {string} url - URL to fetch
 * @param {object} options - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUTS.FETCH) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

/**
 * Validate URL before processing
 * @param {string} urlString - URL string to validate
 * @returns {URL} Parsed URL object
 * @throws {Error} If URL is invalid or has unsupported protocol
 */
function validateUrl(urlString) {
  const url = new URL(urlString);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Invalid protocol: ${url.protocol}. Only http and https are supported.`);
  }
  return url;
}

// ============================================================================
// Browser Instance (for graceful shutdown)
// ============================================================================

let browser = null;

// ============================================================================
// Global watchdog
// ============================================================================

let watchdogId = null;

/**
 * (Re)arm the watchdog. Armed from main() once the amount of work is known — a
 * fixed 2-minute limit killed any --discover run of more than a handful of pages
 * partway through, discarding the llms.txt update that runs after the batch.
 */
function armWatchdog(ms) {
  if (watchdogId) clearTimeout(watchdogId);
  watchdogId = setTimeout(() => {
    console.error(`Error: Global timeout - operation exceeded ${Math.round(ms / 1000)}s`);
    if (browser) browser.close().catch(() => {});
    process.exit(1);
  }, ms);
  // unref() so the timer doesn't keep the process alive after main() completes
  watchdogId.unref();
}

function disarmWatchdog() {
  if (watchdogId) clearTimeout(watchdogId);
  watchdogId = null;
}

// Graceful shutdown handlers
process.on('SIGINT', async () => {
  console.error('\nInterrupted, cleaning up...');
  if (browser) await browser.close().catch(() => {});
  process.exit(130);
});

process.on('SIGTERM', async () => {
  console.error('\nTerminated, cleaning up...');
  if (browser) await browser.close().catch(() => {});
  process.exit(143);
});

// ============================================================================
// URL Conversion Functions
// ============================================================================

/**
 * Convert GitHub/GitLab blob/edit/tree URLs to raw URLs
 */
function convertToRawUrl(url) {
  // Clean up double slashes in path (e.g., docs//edit -> docs/edit)
  url = url.replace(PATTERNS.DOUBLE_SLASH, '$1/');

  // GitHub blob -> raw.githubusercontent.com
  const githubBlobMatch = url.match(PATTERNS.GITHUB_BLOB);
  if (githubBlobMatch) {
    const [, owner, repo, path] = githubBlobMatch;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${path}`;
  }

  // GitHub tree -> raw.githubusercontent.com (tree URLs point to files too)
  const githubTreeMatch = url.match(PATTERNS.GITHUB_TREE);
  if (githubTreeMatch) {
    const [, owner, repo, path] = githubTreeMatch;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${path}`;
  }

  // GitHub edit -> raw.githubusercontent.com (same conversion, different source)
  const githubEditMatch = url.match(PATTERNS.GITHUB_EDIT);
  if (githubEditMatch) {
    const [, owner, repo, path] = githubEditMatch;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${path}`;
  }

  // GitLab blob -> raw
  const gitlabBlobMatch = url.match(PATTERNS.GITLAB_BLOB);
  if (gitlabBlobMatch) {
    const [, base, path] = gitlabBlobMatch;
    return `${base}/-/raw/${path}`;
  }

  // GitLab edit -> raw
  const gitlabEditMatch = url.match(PATTERNS.GITLAB_EDIT);
  if (gitlabEditMatch) {
    const [, base, path] = gitlabEditMatch;
    return `${base}/-/raw/${path}`;
  }

  return url;
}

/**
 * Check if content looks like valid markdown or MDX (not HTML)
 */
function looksLikeMarkdown(text) {
  if (!text || text.length < CONFIG.MIN_MARKDOWN_LENGTH) return false;

  // Reject if it's clearly HTML
  const trimmed = text.trim();
  if (PATTERNS.HTML_DOCTYPE.test(trimmed)) {
    return false;
  }

  // Reject if it's a PDF
  if (trimmed.startsWith('%PDF-')) {
    return false;
  }

  // MDX-specific patterns - if these are found, it's likely MDX
  const mdxPatterns = [
    PATTERNS.MDX_IMPORT,
    PATTERNS.MDX_EXPORT,
    PATTERNS.MDX_JSX,
    PATTERNS.MDX_COMMENT,
  ];

  const isMdx = mdxPatterns.some(pattern => pattern.test(text));

  // Count markdown indicators using pre-compiled patterns
  const mdPatterns = [
    PATTERNS.MD_HEADER,
    PATTERNS.MD_CODE_FENCE,
    PATTERNS.MD_UNORDERED_STAR,
    PATTERNS.MD_UNORDERED_DASH,
    PATTERNS.MD_ORDERED,
    PATTERNS.MD_LINK,
    PATTERNS.MD_BOLD,
    PATTERNS.MD_BLOCKQUOTE,
    PATTERNS.MD_TABLE,
    PATTERNS.MD_HR,
  ];

  const matchCount = mdPatterns.filter(pattern => pattern.test(text)).length;

  // MDX files may have fewer traditional markdown indicators but are still valid
  if (isMdx) {
    return matchCount >= 1;
  }

  return matchCount >= (text.length < 500 ? 2 : 3);
}

/**
 * Extract significant words from text (lowercase, 3+ chars, no stop words)
 */
const STOP_WORDS = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has', 'her', 'was', 'one', 'our', 'out', 'this', 'that', 'with', 'from', 'your', 'have', 'will', 'been', 'they', 'each', 'which', 'their', 'about', 'would', 'there', 'these', 'other', 'into', 'more', 'some', 'than', 'them', 'very', 'when', 'what', 'does', 'how']);

function extractWords(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Structural URL segments that describe where a page lives, not what it says.
 * `/en/guides/markdown-content/` is about markdown-content; "en" and "guides"
 * will never appear in the prose, so scoring them drags the ratio below the
 * threshold and rejects the page's own genuine source file.
 */
const STRUCTURAL_PATH_WORDS = new Set([
  'docs', 'doc', 'documentation', 'guide', 'guides', 'reference', 'references',
  'api', 'apis', 'manual', 'handbook', 'tutorial', 'tutorials', 'learn',
  'index', 'main', 'latest', 'stable', 'current', 'page', 'pages', 'site',
  'content', 'blog', 'articles', 'article', 'html', 'www',
]);

/** Two-letter locales are already dropped by the 3-char filter; catch the rest. */
function isStructuralWord(w) {
  return STRUCTURAL_PATH_WORDS.has(w) || /^v?\d+(\.\d+)*$/.test(w) || /^[a-z]{2}([-_][a-z]{2})?$/.test(w);
}

/**
 * Check if fetched markdown content is topically relevant to the original URL.
 * Compares significant words from the URL path against the markdown's
 * first heading and opening content. Rejects if there's no overlap.
 */
function isRelevantContent(markdown, originalUrl) {
  const urlPath = new URL(originalUrl).pathname;
  const urlWords = new Set(extractWords(urlPath).filter(w => !isStructuralWord(w)));
  if (urlWords.size === 0) return true; // No words to compare

  // Check first heading + first 500 chars of content
  const headingMatch = markdown.match(/^#\s+(.+)$/m);
  const sampleText = (headingMatch ? headingMatch[1] + ' ' : '') + markdown.slice(0, 500);
  const contentWords = new Set(extractWords(sampleText));

  // Count how many URL path words appear in the content
  let matches = 0;
  for (const word of urlWords) {
    if (contentWords.has(word)) matches++;
  }

  const ratio = matches / urlWords.size;
  logDebug(`Relevance check: ${matches}/${urlWords.size} URL words found in content (ratio=${ratio.toFixed(2)})`);

  // Require meaningful overlap:
  // - With 1 URL word, need exact match (1/1)
  // - With 2+ URL words, need at least half to match
  const needed = Math.max(1, Math.ceil(urlWords.size / 2));
  if (matches < needed) {
    console.error(`Markdown source rejected: only ${matches}/${urlWords.size} URL words in content (need ${needed})`);
    return false;
  }

  return true;
}

/**
 * Read the rendered page's title/H1 (same selectors the content extractor uses).
 * Used as an identity fingerprint for the page we KNOW we navigated to.
 */
async function getRenderedTitle(page) {
  try {
    return await page.evaluate((titleSelectors) => {
      for (const selector of titleSelectors) {
        try {
          const el = document.querySelector(selector);
          if (el && el.textContent.trim()) return el.textContent.trim();
        } catch (e) {}
      }
      return null;
    }, ['h1', 'article h1', '.page-title', '.doc-title', '.title', '[data-title]', 'title']);
  } catch {
    return null;
  }
}

/**
 * Identity gate: the rendered page's title should appear in candidate markdown.
 * A real markdown source of THIS page carries its title; an unrelated page
 * (a theme/attribution link, a prev/next nav target) does not. Non-hardcoded:
 * derived entirely from the page we already rendered.
 */
function titleMatchesContent(pageTitle, markdown) {
  if (!pageTitle) return true; // nothing to compare against — don't block
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const t = norm(pageTitle);
  if (!t) return true;
  const body = norm(markdown);
  if (body.includes(t)) return true; // whole title present verbatim
  // Fallback: most of the title's significant words present (handles minor
  // phrasing differences between an <h1> and its source heading).
  const words = [...new Set(t.split(' ').filter(w => w.length >= 4))];
  if (words.length === 0) return true;
  const hits = words.filter(w => body.includes(w)).length;
  return hits / words.length >= 0.6;
}

/**
 * Provenance gate: a page's markdown source lives on the same host, OR is a
 * recognized VCS "raw" transform of a source link on the page. Derived from the
 * two URLs — no per-site allowlist. Stops "source" links wandering to a theme's
 * own site (e.g. docs.scipy.org -> sphinx-doc.org).
 */
function sameSource(candidateUrl, originalUrl) {
  try {
    const a = new URL(convertToRawUrl(candidateUrl));
    const b = new URL(originalUrl);
    const strip = h => h.replace(/^www\./, '');
    if (strip(a.hostname) === strip(b.hostname)) return true;
    // convertToRawUrl only yields raw.githubusercontent.com for explicit
    // blob/tree/edit .md links, which are intentional source links.
    if (a.hostname === 'raw.githubusercontent.com') return true;
    // GitLab-style raw path on any host (a hostname can never contain a slash,
    // so the old hostname check here was dead code).
    if (/\/-\/raw\//.test(a.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Fetch markdown from a URL and validate it
 */
async function fetchAndValidateMarkdown(url, originalUrl, pageTitle = null) {
  const rawUrl = convertToRawUrl(url);
  logDebug(`Trying markdown URL: ${rawUrl}`);

  try {
    const response = await fetchWithTimeout(rawUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/plain, text/markdown, */*'
      },
      redirect: 'follow'
    });

    if (!response.ok) {
      logDebug(`Markdown fetch failed: HTTP ${response.status}`);
      return null;
    }

    const text = await response.text();

    if (!looksLikeMarkdown(text)) {
      logDebug(`Content does not look like markdown`);
      return null;
    }

    // Identity gate: the rendered page's title must appear in the candidate.
    let titleVerified = false;
    if (pageTitle) {
      if (!titleMatchesContent(pageTitle, text)) {
        console.error(`Markdown source rejected: page title "${pageTitle.slice(0, 60)}" not present in candidate content`);
        return null;
      }
      titleVerified = true;
    }

    // Check content is topically relevant to the original page. The title gate is
    // the stronger signal — it compares the page we actually rendered against the
    // candidate — so when it has already passed, the cruder URL-word heuristic is
    // skipped rather than allowed to veto a verified source.
    if (!titleVerified && originalUrl && !isRelevantContent(text, originalUrl)) {
      return null;
    }

    logDebug(`Markdown fetch success: ${text.length} chars`);
    return { markdown: text, sourceUrl: rawUrl };
  } catch (error) {
    logDebug(`Markdown fetch error`, error);
    return null;
  }
}

/**
 * Find markdown source links on a page using Playwright
 * Scoring based on SKILL.md Step 2.5 specification
 */
async function findMarkdownSourceLinks(page, originalUrl) {
  console.error('Scanning page for markdown source links...');

  const links = await page.evaluate(() => {
    const candidates = [];
    const seenUrls = new Set();

    function scoreLink(href, text, element) {
      let score = 0;
      const hrefLower = href.toLowerCase();
      const textLower = text.toLowerCase();

      // URL Patterns (highest priority per SKILL.md)
      if (hrefLower.includes('raw.githubusercontent.com')) score += 100;
      if (hrefLower.includes('/-/raw/')) score += 100;
      // GitHub blob/tree URLs with .md/.mdx extension
      if ((hrefLower.includes('/blob/') || hrefLower.includes('/tree/')) &&
          (hrefLower.endsWith('.md') || hrefLower.endsWith('.mdx'))) score += 80;
      if (hrefLower.endsWith('.md') || hrefLower.endsWith('.mdx')) score += 50;

      // Text Patterns (medium priority per SKILL.md)
      if (textLower.includes('see this page as markdown')) score += 60;
      if (textLower.includes('markdown')) score += 40;
      if (textLower.includes('view source') || textLower.includes('page source')) score += 30;
      if (textLower.includes('edit on github') || textLower.includes('edit on gitlab')) score += 20;

      // Location Context Modifiers per SKILL.md
      const inMeta = element.closest('.about-this-page, .page-meta, .page-source, .edit-page, footer');
      if (inMeta) score += 15;

      const inNav = element.closest('nav, .nav, .navigation, .sidebar, .menu');
      if (inNav) score -= 30;

      return score;
    }

    // Scan all links
    const allLinks = document.querySelectorAll('a[href]');
    for (const el of allLinks) {
      const href = el.getAttribute('href');
      if (!href || seenUrls.has(href)) continue;

      const text = el.textContent.trim();
      const score = scoreLink(href, text, el);

      if (score > 10) {
        seenUrls.add(href);
        candidates.push({ href, text: text.slice(0, 60), score });
      }
    }

    return candidates;
  });

  // Sort by score descending
  links.sort((a, b) => b.score - a.score);

  // Resolve relative URLs
  const resolvedLinks = links.map(link => {
    try {
      const resolved = new URL(link.href, originalUrl).href;
      return { ...link, href: resolved };
    } catch {
      return link;
    }
  });

  if (resolvedLinks.length > 0) {
    console.error(`Found ${resolvedLinks.length} candidate link(s):`);
    resolvedLinks.slice(0, 5).forEach((link, i) => {
      console.error(`  ${i + 1}. [score=${link.score}] "${link.text}" -> ${link.href}`);
    });
  } else {
    console.error('No markdown source links found');
  }

  return resolvedLinks;
}

/**
 * Try to fetch markdown from source links found on the page (Step 2.5)
 * Uses Promise.any for parallel validation of top candidates
 */
async function tryMarkdownSourceLinks(page, originalUrl) {
  const links = await findMarkdownSourceLinks(page, originalUrl);
  if (links.length === 0) return null;

  // Provenance gate: drop links that don't share the page's host / aren't a
  // known raw mirror BEFORE fetching anything.
  const sameOrigin = links.filter(link => sameSource(link.href, originalUrl));
  if (sameOrigin.length === 0) {
    console.error('No same-origin markdown source links (all candidates were off-site)');
    return null;
  }

  // Fingerprint the page we actually rendered — used for the identity gate.
  const pageTitle = await getRenderedTitle(page);

  const candidates = sameOrigin.slice(0, CONFIG.MAX_CANDIDATES);

  // Fetch+validate ALL candidates, then pick deterministically by candidate
  // score (candidates are pre-sorted desc). No Promise.any — selection must
  // be decided by relevance, not by whichever network response wins the race.
  const results = await Promise.allSettled(
    candidates.map(link => fetchAndValidateMarkdown(link.href, originalUrl, pageTitle))
  );
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) return result.value;
  }
  return null;
}

/**
 * Try to fetch markdown directly from URL.md variant
 * Many documentation sites serve raw markdown at .md URLs
 */
async function tryFetchMarkdownVariants(url) {
  const urlObj = new URL(url);
  const parsed = parse(urlObj.pathname);

  let mdUrl;

  // If already markdown (.md/.mdx), try fetching as-is
  if (['.md', '.mdx'].includes(parsed.ext.toLowerCase())) {
    mdUrl = url;
    console.error(`URL already markdown: ${mdUrl}`);
  } else {
    // Strip any extension and try .md variant
    const pathname = parsed.ext
      ? join(parsed.dir, parsed.name)
      : urlObj.pathname;
    mdUrl = `${urlObj.origin}${pathname}.md`;
    console.error(`Trying markdown variant: ${mdUrl}`);
  }

  try {
    // Speculative probe on a guessed URL: it must fast-fail. A hanging server
    // here used to stall the whole run against the global watchdog, even though
    // a miss costs nothing (the browser path still fetches the page).
    const response = await fetchWithTimeout(mdUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/plain, text/markdown, */*'
      }
    }, TIMEOUTS.FETCH_FAST);

    if (!response.ok) {
      console.error(`Markdown variant returned ${response.status}`);
      return null;
    }

    // A server that redirects a guessed .md path to something that is no longer
    // a .md path is serving a catch-all (SPA shell, docs home), not our page.
    try {
      const landed = new URL(response.url);
      if (!/\.mdx?$/i.test(landed.pathname)) {
        console.error(`Markdown variant redirected to a non-markdown path (${landed.pathname}), skipping`);
        return null;
      }
    } catch { /* non-parseable final URL — fall through to content checks */ }

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();

    // Check if we got HTML instead of markdown
    if (contentType.includes('text/html') || text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
      console.error('Markdown variant returned HTML, skipping');
      return null;
    }

    // Use the same validator as the source-link path. The previous inline check
    // only rejected non-markdown when it was ALSO under 100 chars, so a JSON
    // error body or a plain-text notice was cached as if it were documentation.
    if (!looksLikeMarkdown(text)) {
      console.error('Response does not look like markdown');
      return null;
    }

    console.error(`Successfully fetched markdown (${text.length} chars)`);
    return { markdown: text, finalUrl: response.url };
  } catch (error) {
    console.error(`Failed to fetch markdown variant: ${error.message}`);
    return null;
  }
}

// Generic content selectors that work across many documentation sites
// Ordered by likelihood - most common matches first for faster detection
const DEFAULT_CONTENT_SELECTORS = [
  // Most common patterns (check these first)
  'main article',
  'article',
  'main',
  '[role="main"]',

  // GitHub / markdown platforms
  'article.markdown-body',
  '.markdown-body',

  // Documentation platform specific
  'article.documentation',
  'article.docs-content',
  '.docs-content',
  '.documentation-content',
  '.doc-content',
  '.content-body',

  // Mintlify / GitBook / ReadMe style
  '[data-testid="content"]',
  '.prose',                       // Tailwind prose
  '.article-content',
  '.page-content',

  // Less common patterns
  'article[role="main"]',
  '.main-content',
  '#main-content',
  '.content',
  '#content',

  // Fallbacks
  '.container article',
  '.wrapper article'
];

// Elements to remove from content (generic patterns)
const REMOVE_SELECTORS = [
  // Navigation
  'nav',
  '[role="navigation"]',
  '.nav',
  '.navigation',
  '.sidebar',
  '.side-nav',
  '.sidenav',
  '.toc',
  '.table-of-contents',
  '.breadcrumb',
  '.breadcrumbs',

  // Headers/Footers (site-level, not content)
  'header:not(article header)',
  'footer',
  '[role="banner"]',
  '[role="contentinfo"]',
  '.site-header',
  '.site-footer',
  '.page-header:not(.doc-header)',
  '.page-footer',

  // Interactive elements
  '.feedback',
  '.feedback-buttons',
  '.rating',
  '.share-buttons',
  '.social-share',
  '.comments',
  '.comment-section',

  // Promotional/UI
  '.cookie-banner',
  '.cookie-consent',
  '.announcement',
  '.banner',
  '.popup',
  '.modal',
  '.newsletter',
  '.signup',
  '.cta',
  '.advertisement',
  '.ad',

  // Code UI elements
  '[data-copy-button]',
  '.copy-button',
  '.code-copy',
  'button[aria-label*="Copy"]',
  'button[aria-label*="copy"]',

  // Scripts and styles
  'script',
  'style',
  'noscript',
  'iframe:not([src*="youtube"]):not([src*="vimeo"])',

  // Search
  '.search',
  '.search-box',
  '[role="search"]',

  // Misc
  '.hidden',
  '[hidden]',
  '.sr-only',
  '.visually-hidden'
];

// Selector for smart wait - combined common content selectors
const CONTENT_WAIT_SELECTOR = 'article, main, [role="main"], .content, .docs-content, .markdown-body, .prose';

/**
 * Parse command line arguments and validate URLs
 */
function parseArgs(args) {
  const result = {
    urls: [],
    output: null,
    outputDir: null,
    concurrency: 3,
    selector: null,
    frontMatter: true,
    skipExisting: false,
    updateIndex: false,
    discover: null,
    refresh: null,
    maxDiscover: DISCOVERY.MAX_URLS,
  };

  // Flags that take a value must actually have one; `--output` as the final
  // argument previously produced `undefined` and failed much later, somewhere else.
  const takesValue = new Set(['--output', '-o', '--output-dir', '-d', '--concurrency', '-c',
    '--urls', '-u', '--selector', '-s', '--discover', '--max-discover']);
  for (let i = 0; i < args.length; i++) {
    if (takesValue.has(args[i]) && (i + 1 >= args.length || args[i + 1].startsWith('-'))) {
      console.error(`Error: ${args[i]} requires a value`);
      process.exit(1);
    }
  }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' || args[i] === '-o') {
      result.output = args[++i];
    } else if (args[i] === '--output-dir' || args[i] === '-d') {
      result.outputDir = args[++i];
    } else if (args[i] === '--max-discover') {
      const val = parseInt(args[++i], 10);
      if (!Number.isFinite(val) || val < 1) {
        console.error('--max-discover must be a positive integer');
        process.exit(1);
      }
      result.maxDiscover = val;
    } else if (args[i] === '--concurrency' || args[i] === '-c') {
      const val = parseInt(args[++i], 10);
      if (val >= 1 && val <= 10) {
        result.concurrency = val;
      } else {
        console.error('Concurrency must be between 1 and 10');
        process.exit(1);
      }
    } else if (args[i] === '--urls' || args[i] === '-u') {
      const urlsFile = args[++i];
      if (!existsSync(urlsFile)) {
        console.error(`URLs file not found: ${urlsFile}`);
        process.exit(1);
      }
      const content = readFileSync(urlsFile, 'utf-8');
      const fileUrls = content.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
      result.urls.push(...fileUrls);
    } else if (args[i] === '--selector' || args[i] === '-s') {
      result.selector = args[++i];
    } else if (args[i] === '--no-front-matter') {
      result.frontMatter = false;
    } else if (args[i] === '--skip-existing') {
      result.skipExisting = true;
    } else if (args[i] === '--update-index') {
      result.updateIndex = true;
    } else if (args[i] === '--discover') {
      result.discover = args[++i];
    } else if (args[i] === '--refresh') {
      const next = args[i + 1];
      if (next && !next.startsWith('-') && /^\d+$/.test(next)) {
        result.refresh = parseInt(args[++i], 10);
      } else {
        result.refresh = 30;
      }
    } else if (!args[i].startsWith('-')) {
      result.urls.push(args[i]);
    }
  }

  // Validate all URLs
  for (const url of result.urls) {
    try {
      validateUrl(url);
    } catch (error) {
      console.error(`Invalid URL "${url}": ${error.message}`);
      process.exit(1);
    }
  }

  // Backward compatibility: single URL accessible as .url
  if (result.urls.length === 1) {
    result.url = result.urls[0];
  }

  return result;
}

/**
 * Convert URL to output file path
 * @param {string} url - URL to convert
 * @param {string} outputDir - Base directory for output files
 * @returns {string} Output file path
 */
function urlToOutputPath(url, outputDir = 'docs') {
  const parsed = new URL(url);
  // Strip www. prefix per file-structure.md rules
  const hostname = parsed.hostname.replace(/^www\./, '');
  let path = `${hostname}${parsed.pathname}`;
  // Normalize outputDir (strip trailing slash)
  outputDir = outputDir.replace(/\/+$/, '');
  // Remove trailing slash
  path = path.replace(/\/$/, '');
  // Remove file extensions in order: first markdown (.md/.mdx), then web (.html/.php/etc)
  // This handles compound extensions like .html.md correctly
  path = path.replace(/\.mdx?$/i, '');       // Remove .md or .mdx
  path = path.replace(/\.(html?|php|aspx?)$/i, '');  // Remove .html, .htm, .php, .aspx, .asp
  // Ensure .md extension
  return `${outputDir}/${path}.md`;
}

/**
 * OPTIMIZED: Single evaluate call to extract both title and content
 * This replaces multiple browser round-trips with a single call.
 */
async function extractTitleAndContent(page, customSelector) {
  const selectors = customSelector
    ? [customSelector, ...DEFAULT_CONTENT_SELECTORS]
    : DEFAULT_CONTENT_SELECTORS;

  return await page.evaluate(({ selectors, removeSelectors, titleSelectors }) => {
    // Step 1: Extract title first (before removing elements)
    let title = null;
    for (const selector of titleSelectors) {
      try {
        const el = document.querySelector(selector);
        if (el && el.textContent.trim()) {
          title = el.textContent.trim();
          break;
        }
      } catch (e) {}
    }

    // Step 2: Remove unwanted elements
    for (const selector of removeSelectors) {
      try {
        document.querySelectorAll(selector).forEach(el => el.remove());
      } catch (e) {}
    }

    // Step 3: Find first matching selector with sufficient content
    let html = null;
    let matchedSelector = null;
    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          const content = el.innerHTML;
          if (content && content.trim().length > 200) {
            html = content;
            matchedSelector = selector;
            break;
          }
        }
      } catch (e) {}
    }

    // Step 4: Fallback to body if nothing matched
    if (!html) {
      html = document.body.innerHTML;
      matchedSelector = 'body (fallback)';
    }

    return { title, html, selector: matchedSelector };
  }, {
    selectors,
    removeSelectors: REMOVE_SELECTORS,
    titleSelectors: ['h1', 'article h1', '.page-title', '.doc-title', '.title', '[data-title]', 'title']
  });
}

/**
 * Configure Turndown for GitHub-flavored markdown
 */
function createTurndownService() {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined'
  });

  // Use GitHub-flavored markdown plugin
  turndown.use(gfm);

  // Use Turndown's native remove() for elements we don't want
  turndown.remove(['script', 'style', 'noscript']);

  // Remove empty links using Turndown's remove() with filter function
  turndown.remove((node) => {
    return node.nodeName === 'A' && !node.textContent.trim();
  });

  // Custom rule for code blocks with language
  turndown.addRule('codeBlockWithLanguage', {
    filter: (node) => {
      return node.nodeName === 'PRE' && node.querySelector('code');
    },
    replacement: (content, node) => {
      const code = node.querySelector('code');
      let language = '';

      // Try to detect language from class
      const classes = code.className || node.className || '';
      const langMatch = classes.match(/language-(\w+)|lang-(\w+)|(\w+)-code|highlight-(\w+)/);
      if (langMatch) {
        language = langMatch[1] || langMatch[2] || langMatch[3] || langMatch[4];
      }

      // Try data-language attribute
      if (!language) {
        language = code.getAttribute('data-language') ||
                   node.getAttribute('data-language') ||
                   code.getAttribute('data-lang') ||
                   node.getAttribute('data-lang') ||
                   code.closest('[data-language]')?.getAttribute('data-language') || '';
      }

      // Try to detect from content if still unknown
      const text = code.textContent || '';

      if (!language) {
        language = detectLanguageFromContent(text);
      }

      // Map common variations
      const langMap = {
        'js': 'javascript',
        'ts': 'typescript',
        'py': 'python',
        'sh': 'bash',
        'shell': 'bash',
        'zsh': 'bash',
        'golang': 'go',
        'yml': 'yaml',
        'rb': 'ruby',
        'cs': 'csharp',
        'objective-c': 'objc',
        'objectivec': 'objc'
      };
      language = langMap[language.toLowerCase()] || language.toLowerCase();

      return `\n\n\`\`\`${language}\n${text.trim()}\n\`\`\`\n\n`;
    }
  });

  // Helper function to detect language from code content
  function detectLanguageFromContent(text) {
    // Python patterns
    if (/^from\s+\w+\s+import|^import\s+\w+|^def\s+\w+\(|^class\s+\w+[:(]|print\(/.test(text)) {
      return 'python';
    }
    // JavaScript/TypeScript patterns
    if (/^import\s*{|^import\s+\w+\s+from|^const\s+\w+\s*=|^let\s+\w+\s*=|^var\s+\w+\s*=|async\s+function|=>\s*{|\.then\(/.test(text)) {
      return 'javascript';
    }
    // Go patterns
    if (/^package\s+\w+|^func\s+\w+|:=\s*|fmt\.|^import\s*\(/.test(text)) {
      return 'go';
    }
    // Rust patterns
    if (/^fn\s+\w+|^let\s+mut\s+|^use\s+\w+::|^impl\s+/.test(text)) {
      return 'rust';
    }
    // Ruby patterns
    if (/^require\s+['"]|^def\s+\w+|^class\s+\w+\s*<|\.each\s+do/.test(text)) {
      return 'ruby';
    }
    // Curl/bash patterns (including $pip, $npm, etc. without space)
    if (/^curl\s|^#.*\n.*\w|^\$\s*\w|^npm\s|^pip\s|^brew\s|^export\s/.test(text)) {
      return 'bash';
    }
    // JSON patterns
    if (/^\s*[{\[]/.test(text) && /[}\]]\s*$/.test(text)) {
      try {
        JSON.parse(text);
        return 'json';
      } catch {}
    }
    // YAML patterns
    if (/^\w+:\s*\n|^\s+-\s+\w+:/.test(text)) {
      return 'yaml';
    }
    // SQL patterns
    if (/^SELECT\s|^INSERT\s|^UPDATE\s|^CREATE\s|^DROP\s/i.test(text)) {
      return 'sql';
    }
    // GraphQL patterns
    if (/^query\s+\w+|^mutation\s+\w+|^type\s+\w+\s*{|^fragment\s+/.test(text)) {
      return 'graphql';
    }
    // HTML patterns
    if (/^<!DOCTYPE|^<html|^<div|^<span|^<p\b/.test(text)) {
      return 'html';
    }

    return '';
  }

  // Custom rule for inline code - needed because Turndown doesn't escape
  // backticks inside code elements (per docs: "text in code elements is never passed to escape")
  turndown.addRule('inlineCode', {
    filter: (node) => {
      return node.nodeName === 'CODE' &&
             node.parentNode.nodeName !== 'PRE';
    },
    replacement: (content) => {
      const cleaned = content.replace(/`/g, "'").trim();
      return cleaned ? `\`${cleaned}\`` : '';
    }
  });

  // Handle tables with rowspan/colspan
  turndown.addRule('complexTable', {
    filter: 'table',
    replacement: (content, node) => {
      const hasComplexStructure = node.querySelector('[rowspan], [colspan]');

      if (hasComplexStructure) {
        return cleanHtmlTable(node);
      }

      return convertSimpleTable(node);
    }
  });

  // Helper: Clean and keep HTML table
  function cleanHtmlTable(table) {
    let html = table.outerHTML;
    html = html
      .replace(/\s+(class|style|id|data-[^=]+)="[^"]*"/gi, '')
      .replace(/\s+(class|style|id|data-[^=]+)='[^']*'/gi, '')
      .replace(/>\s+</g, '><')
      .replace(/<tr/g, '\n<tr')
      .replace(/<\/table>/g, '\n</table>')
      .replace(/<thead/g, '\n<thead')
      .replace(/<tbody/g, '\n<tbody')
      .replace(/<\/thead>/g, '\n</thead>')
      .replace(/<\/tbody>/g, '\n</tbody>');

    return '\n\n' + html.trim() + '\n\n';
  }

  // Helper: Get cell text (preserving links as markdown)
  function getCellText(cell) {
    let html = cell.innerHTML || '';

    // Convert <a> tags to markdown links BEFORE stripping other tags
    // Match <a href="...">text</a> and convert to [text](href)
    html = html.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi,
      (match, href, text) => `[${text.trim()}](${href})`);

    // Handle <a> tags with nested elements (like <code>)
    html = html.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (match, href, innerHtml) => {
        // Strip inner tags to get text
        const text = innerHtml.replace(/<[^>]+>/g, '').trim();
        return `[${text}](${href})`;
      });

    // Convert <code> to backticks
    html = html.replace(/<code[^>]*>([^<]*)<\/code>/gi, '`$1`');

    html = html.replace(/<br\s*\/?>/gi, ' | ');
    html = html.replace(/<\/(p|div|li|tr)>/gi, ' | ');
    html = html.replace(/<(p|div|li|tr)[^>]*>/gi, '');
    html = html.replace(/<[^>]+>/g, '');
    html = html.replace(/&nbsp;/g, ' ')
               .replace(/&amp;/g, '&')
               .replace(/&lt;/g, '<')
               .replace(/&gt;/g, '>')
               .replace(/&quot;/g, '"');

    let text = html
      .split('|')
      .map(part => part.trim())
      .filter(part => part)
      .join(' | ');

    return text.trim();
  }

  // Helper: Convert simple table to markdown
  function convertSimpleTable(table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length === 0) return '';

    const firstRow = rows[0];
    const firstRowCells = Array.from(firstRow.querySelectorAll('th, td'));
    const colCount = firstRowCells.length;

    if (colCount === 0) return '';

    let result = '\n\n';
    let hasHeader = false;

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('th, td'));
      const isHeaderRow = row.querySelector('th') !== null;

      let rowStr = '|';
      for (let i = 0; i < colCount; i++) {
        const cell = cells[i];
        const text = cell ? getCellText(cell).replace(/\|/g, ',') : '';
        rowStr += ` ${text} |`;
      }
      result += rowStr + '\n';

      if (isHeaderRow && !hasHeader) {
        hasHeader = true;
        result += '|' + ' --- |'.repeat(colCount) + '\n';
      }
    }

    if (!hasHeader && rows.length > 0) {
      const lines = result.trim().split('\n');
      if (lines.length > 0) {
        const separator = '|' + ' --- |'.repeat(colCount);
        lines.splice(1, 0, separator);
        result = '\n\n' + lines.join('\n') + '\n';
      }
    }

    return result + '\n';
  }

  // Handle images
  turndown.addRule('images', {
    filter: 'img',
    replacement: (content, node) => {
      const alt = node.getAttribute('alt') || '';
      let src = node.getAttribute('src') || node.getAttribute('data-src') || '';

      // Skip tracking pixels and icons
      if (src.includes('tracking') || src.includes('pixel') ||
          (node.width && node.width < 20) || (node.height && node.height < 20)) {
        return '';
      }

      return src ? `![${alt}](${src})` : '';
    }
  });

  return turndown;
}

const PROVENANCE_KEYS = ['Source', 'Generated', 'Updated'];

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Attach provenance front matter to a document.
 *
 * When we fetched the upstream .md source verbatim it usually already opens with
 * its own YAML block. Prepending a second block leaves the file with two stacked
 * front matters, and every downstream parser reads only the first — so the
 * upstream `title:`/`description:` (the best material available for the llms.txt
 * index) becomes invisible. Merge into the existing block instead.
 *
 * @param {string} markdown - Document body
 * @param {string} url - Source URL
 * @param {{generated?: string}} opts - `generated` preserves the original fetch
 *   date across a --refresh, so Generated/Updated stay meaningfully different.
 */
function applyFrontMatter(markdown, url, opts = {}) {
  const now = todayIso();
  const provenance = [
    `Source: ${url}`,
    `Generated: ${opts.generated || now}`,
    `Updated: ${now}`,
  ].join('\n');

  const existing = markdown.match(/^---\n([\s\S]*?)\n---[ \t]*\n?/);
  if (existing) {
    const upstream = existing[1]
      .split('\n')
      .filter(line => !PROVENANCE_KEYS.some(k => line.startsWith(`${k}:`)))
      .join('\n')
      .trim();
    const block = upstream ? `${provenance}\n${upstream}` : provenance;
    return `---\n${block}\n---\n\n${markdown.slice(existing[0].length).replace(/^\n+/, '')}`;
  }

  return `---\n${provenance}\n---\n\n${markdown}`;
}

/**
 * Split markdown into fenced and unfenced runs, apply `fn` to the unfenced runs
 * only, and reassemble. Fenced blocks come back byte-identical.
 *
 * Every prose cleanup below is destructive inside a code block: the heading rule
 * injects a blank line before every `#` comment in a bash/python/yaml sample, the
 * blank-line collapse eats deliberate spacing, and the `---` rule rewrites SQL
 * comment rules. Code samples are the single most valuable part of a cached doc,
 * so they are left exactly as the converter produced them.
 */
function mapOutsideFences(markdown, fn) {
  const lines = markdown.split('\n');
  const parts = [];
  let current = [];
  let fenceChar = null; // non-null while inside a fence

  const flush = (fenced) => {
    if (current.length > 0) parts.push({ fenced, lines: current });
    current = [];
  };

  for (const line of lines) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceChar === null) {
      if (fence) {
        flush(false);          // close the prose run before the fence opens
        fenceChar = fence[1][0];
      }
      current.push(line);
    } else {
      current.push(line);
      // A fence closes only on the same marker character (``` cannot close ~~~).
      if (fence && fence[1][0] === fenceChar) {
        flush(true);
        fenceChar = null;
      }
    }
  }
  // An unterminated fence is still treated as code — safer than mangling it.
  flush(fenceChar !== null);

  return parts.map(p => (p.fenced ? p.lines.join('\n') : fn(p.lines.join('\n')))).join('\n');
}

/**
 * Clean up markdown output (prose only — fenced code is never touched)
 */
function cleanMarkdown(markdown) {
  const cleaned = mapOutsideFences(markdown, (prose) => prose
    // Remove common UI text artifacts
    .replace(/^(Send feedback|Give feedback|Was this helpful\?|Rate this page)\s*$/gim, '')
    .replace(/^\s*(content_copy|Copy|Copied!)\s*$/gm, '')
    // Remove "Edit this page" links
    .replace(/\[Edit this page.*?\]\([^)]+\)/gi, '')
    .replace(/\[Edit on GitHub.*?\]\([^)]+\)/gi, '')
    // Remove excessive blank lines
    .replace(/\n{4,}/g, '\n\n\n')
    // Fix heading spacing
    .replace(/\n(#{1,6})/g, '\n\n$1')
    // Remove trailing whitespace
    .replace(/[ \t]+$/gm, '')
    // Remove lines that are just whitespace
    .replace(/^\s+$/gm, '')
    // Clean up multiple dashes (often from removed content)
    .replace(/^-{3,}$/gm, '---')
  );

  // Ensure file ends with single newline
  return cleaned.trim() + '\n';
}

/**
 * Fetch a single URL and return markdown
 * @param {string} url - URL to fetch
 * @param {object} options - Options (selector, frontMatter)
 * @param {Browser|null} sharedBrowser - Optional shared browser instance for batch mode
 * @returns {Promise<{success: boolean, markdown?: string, finalUrl?: string, error?: string}>}
 */
async function fetchSingleUrl(url, options, sharedBrowser = null) {
  let markdown = null;
  let localBrowser = null;

  try {
    // Step 1: Try fetching markdown variant directly (faster, cleaner)
    const rawResult = await tryFetchMarkdownVariants(url);

    if (rawResult) {
      // Successfully got raw markdown
      markdown = rawResult.markdown;

      // Add front matter if requested
      if (options.frontMatter) {
        markdown = applyFrontMatter(markdown, url, { generated: options.generated });
      }

      // Reject soft-404 pages (HTTP 200 but "Page Not Found" content)
      if (isSoft404(markdown)) {
        return { success: false, error: 'Soft 404: page content indicates not found' };
      }

      return { success: true, markdown, finalUrl: rawResult.finalUrl };
    }

    // Step 2: Fall back to Playwright for JS-rendered pages
    const usedBrowser = sharedBrowser || await launchBrowser();
    if (!sharedBrowser) {
      localBrowser = usedBrowser;
    }

    const context = await usedBrowser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9'
      },
      // Backstop for the egress proxy's MITM certificate — see the cloud-egress
      // note at the top of this file. Not the load-bearing fix, but without it a
      // cert-validation failure would masquerade as a network failure.
      ...(IS_CLOUD ? { ignoreHTTPSErrors: true } : {})
    });

    try {
      const page = await context.newPage();

      // Block unnecessary resources for faster loading
      await page.route('**/*', route => {
        const resourceType = route.request().resourceType();
        if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
          route.abort();
        } else {
          route.continue();
        }
      });

      // Navigate and wait for content to load
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUTS.PAGE_LOAD
      });

      // Reject HTTP error responses (4xx, 5xx)
      if (response && response.status() >= 400) {
        return { success: false, error: `HTTP ${response.status()} ${response.statusText()}` };
      }

      // Smart wait for content (instead of fixed delay)
      try {
        await page.waitForSelector(CONTENT_WAIT_SELECTOR, { timeout: TIMEOUTS.CONTENT_WAIT });
        await page.waitForTimeout(100); // Tiny delay for final JS
      } catch {
        await page.waitForTimeout(300);
      }

      // Capture final URL after any redirects
      const finalUrl = page.url();
      if (finalUrl !== url) {
        console.error(`[REDIRECT] ${url} -> ${finalUrl}`);
      }

      // Step 2.5: Try to find and fetch markdown source links on the page
      const sourceMarkdown = await tryMarkdownSourceLinks(page, url);

      if (sourceMarkdown) {
        markdown = sourceMarkdown.markdown;

        if (options.frontMatter) {
          markdown = applyFrontMatter(markdown, url, { generated: options.generated });
        }
      } else {
        // Step 3: Fall back to HTML-to-markdown conversion
        const { title, html } = await extractTitleAndContent(page, options.selector);

        const turndown = createTurndownService();
        markdown = turndown.turndown(html);
        markdown = cleanMarkdown(markdown);

        if (title && !markdown.startsWith('# ')) {
          markdown = `# ${title}\n\n${markdown}`;
        }

        if (options.frontMatter) {
          markdown = applyFrontMatter(markdown, url, { generated: options.generated });
        }
      }

      // Reject soft-404 pages (HTTP 200 but "Page Not Found" content)
      if (isSoft404(markdown)) {
        return { success: false, error: 'Soft 404: page content indicates not found' };
      }

      return { success: true, markdown, finalUrl };

    } finally {
      await context.close().catch(() => {});
    }

  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    if (localBrowser) {
      await localBrowser.close().catch(() => {});
    }
  }
}

/**
 * Process multiple URLs in batch with parallel execution
 * @param {string[]} urls - URLs to process
 * @param {object} options - Options (outputDir, concurrency, selector, frontMatter)
 * @returns {Promise<{succeeded: number, failed: number, failures: Array<{url: string, error: string}>}>}
 */
/**
 * Run `worker` over `items` with at most `concurrency` in flight.
 * Shared by the batch fetch and the --refresh pass so both honour -c.
 */
async function runPool(items, worker, concurrency) {
  const queue = [...items];
  const active = new Set();
  const limit = Math.max(1, concurrency || 1);

  while (queue.length > 0 || active.size > 0) {
    while (queue.length > 0 && active.size < limit) {
      const item = queue.shift();
      const promise = Promise.resolve(worker(item)).finally(() => active.delete(promise));
      active.add(promise);
    }
    if (active.size > 0) await Promise.race(active);
  }
}

async function fetchBatch(urls, options) {
  const results = { succeeded: 0, failed: 0, skipped: 0, failures: [], fetched: [] };

  // Filter out existing files if --skip-existing
  let toFetch = urls;
  if (options.skipExisting) {
    toFetch = [];
    for (const url of urls) {
      const outputPath = urlToOutputPath(url, options.outputDir);
      if (existsSync(outputPath)) {
        console.error(`[SKIP] ${url} (cached: ${outputPath})`);
        results.skipped++;
      } else {
        toFetch.push(url);
      }
    }
  }

  if (toFetch.length === 0) {
    console.error('\nAll URLs already cached, nothing to fetch.');
    return results;
  }

  console.error(`\nBatch processing ${toFetch.length} URLs with concurrency ${options.concurrency}` +
    (results.skipped > 0 ? ` (${results.skipped} cached, skipped)` : '') + '\n');

  // Track active browser for graceful shutdown
  browser = await launchBrowser();

  async function processUrl(url) {
    const result = await fetchSingleUrl(url, options, browser);

    if (result.success) {
      // Use final URL (after redirects) to determine output path
      const effectiveUrl = result.finalUrl || url;
      const outputPath = urlToOutputPath(effectiveUrl, options.outputDir);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, result.markdown);
      console.error(`[OK] ${url} -> ${outputPath}`);
      results.succeeded++;
      results.fetched.push({ url: effectiveUrl, outputPath, markdown: result.markdown });
    } else {
      console.error(`[FAIL] ${url}: ${result.error}`);
      results.failed++;
      results.failures.push({ url, error: result.error });
    }
  }

  // Process with concurrency limit
  await runPool(toFetch, processUrl, options.concurrency);

  // Cleanup browser
  await browser.close().catch(() => {});
  browser = null;

  return results;
}

// ============================================================================
// Discovery: Find documentation URLs from remote llms.txt / sitemap.xml
// ============================================================================

const DISCOVERY = {
  MAX_URLS: 50,           // Default cap on fetched pages per discovery run
  DOC_FILTER_THRESHOLD: 100, // Above this many URLs, narrow to doc-like paths
  MAX_SITEMAP_DOCS: 12,   // Sitemap documents fetched per run (index + children)
  MAX_CHILD_SITEMAPS: 10, // Children taken from a single sitemap index
};

const DISCOVERY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/**
 * Parse a sitemap document.
 *
 * Distinguishing <sitemapindex> from <urlset> is the whole point: an index's
 * <loc> values are OTHER SITEMAPS, not pages. Treating them as pages (the
 * previous behaviour) queued .xml files up for markdown conversion.
 *
 * Pure function — unit tested without network access.
 * @returns {{isIndex: boolean, locs: string[]}}
 */
function parseSitemapXml(text) {
  const isIndex = /<sitemapindex[\s>]/i.test(text);
  const locs = [];
  const locPattern = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let match;
  while ((match = locPattern.exec(text)) !== null) {
    const url = match[1].trim()
      .replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
      .replace(/&amp;/g, '&');
    if (/^https?:\/\//i.test(url)) locs.push(url);
  }
  return { isIndex, locs };
}

/** Fetch a URL as text, returning a result object rather than throwing on HTTP errors. */
async function fetchText(url, timeoutMs = TIMEOUTS.FETCH) {
  const response = await fetchWithTimeout(url, {
    headers: { 'User-Agent': DISCOVERY_UA, 'Accept': 'text/plain, application/xml, text/xml, */*' }
  }, timeoutMs);
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, text: await response.text() };
}

/**
 * Sitemap locations to try, most authoritative first.
 *
 * robots.txt `Sitemap:` is the standard, site-declared answer; the conventional
 * paths are guesses. `/sitemap.xml` alone is not enough — Astro, Next.js and
 * WordPress commonly publish `/sitemap-index.xml` or `/sitemap_index.xml` and
 * return 404 for `/sitemap.xml`, which made discovery silently find nothing.
 */
async function sitemapCandidates(origin) {
  const candidates = [];
  try {
    const res = await fetchText(`${origin}/robots.txt`, TIMEOUTS.FETCH_FAST);
    if (res.ok) {
      for (const line of res.text.split('\n')) {
        const m = line.match(/^\s*sitemap:\s*(\S+)/i);
        if (m) candidates.push(m[1].trim());
      }
      if (candidates.length > 0) {
        console.error(`  robots.txt: ${candidates.length} Sitemap directive(s)`);
      }
    }
  } catch { /* robots.txt is optional */ }

  for (const path of ['/sitemap.xml', '/sitemap-index.xml', '/sitemap_index.xml', '/sitemap/sitemap.xml']) {
    const url = `${origin}${path}`;
    if (!candidates.includes(url)) candidates.push(url);
  }
  return candidates;
}

/**
 * Walk sitemap candidates, expanding sitemap indexes into their child sitemaps,
 * and collect page URLs.
 * @returns {Promise<string[]>}
 */
async function collectSitemapUrls(origin) {
  const pages = new Set();
  const queue = await sitemapCandidates(origin);
  const visited = new Set();
  let fetched = 0;

  while (queue.length > 0 && fetched < DISCOVERY.MAX_SITEMAP_DOCS) {
    const sitemapUrl = queue.shift();
    if (visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);

    console.error(`Checking ${sitemapUrl}...`);
    let res;
    try {
      res = await fetchText(sitemapUrl);
    } catch (error) {
      console.error(`  ${error.message}`);
      continue;
    }
    if (!res.ok) {
      console.error(`  HTTP ${res.status}`);
      continue;
    }
    fetched++;

    const { isIndex, locs } = parseSitemapXml(res.text);

    if (isIndex) {
      const children = locs.slice(0, DISCOVERY.MAX_CHILD_SITEMAPS);
      console.error(`  sitemap index with ${locs.length} child sitemap(s)` +
        (locs.length > children.length ? ` — expanding the first ${children.length}` : ' — expanding'));
      queue.unshift(...children);
      continue;
    }

    let added = 0;
    for (const url of locs) {
      try {
        // Never queue a sitemap/feed as if it were a documentation page.
        if (/\.(xml|gz)$/i.test(new URL(url).pathname)) continue;
      } catch { continue; }
      if (!pages.has(url)) { pages.add(url); added++; }
    }
    console.error(`  found ${added} page URL(s) (${pages.size} total)`);
  }

  if (queue.length > 0) {
    console.error(`  Stopped after ${fetched} sitemap document(s); ${queue.length} left unexplored`);
  }
  return [...pages];
}

const LOCALE_SEGMENT = /^[a-z]{2}(-[a-z]{2})?$/i;

function firstSegment(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean)[0] || '';
  } catch {
    return '';
  }
}

/**
 * Stable-sort URLs so English / unprefixed paths come first.
 *
 * A two-letter first segment is only treated as a locale when several distinct
 * ones appear across the set — otherwise a site with a legitimate `/go/` or
 * `/js/` section would have that whole section pushed to the back.
 */
function preferDefaultLocale(urls) {
  const candidates = new Set();
  for (const url of urls) {
    const seg = firstSegment(url).toLowerCase();
    if (LOCALE_SEGMENT.test(seg)) candidates.add(seg);
  }
  const nonEnglish = [...candidates].filter(s => !/^en(-|$)/.test(s));
  if (nonEnglish.length < 3) return urls; // not an i18n site — leave order alone

  const locales = new Set(nonEnglish);
  return [...urls].sort((a, b) =>
    (locales.has(firstSegment(a).toLowerCase()) ? 1 : 0) -
    (locales.has(firstSegment(b).toLowerCase()) ? 1 : 0));
}

/**
 * Discover documentation URLs from a site's llms.txt, llms-full.txt, or sitemaps
 * @param {string} baseUrl - Any URL on the site (origin is extracted)
 * @param {number} maxUrls - Cap on returned URLs
 * @returns {Promise<string[]>} Array of discovered documentation URLs
 */
async function discoverDocUrls(baseUrl, maxUrls = DISCOVERY.MAX_URLS) {
  const origin = new URL(baseUrl).origin;
  const discovered = new Set();

  // Try llms-full.txt first (more comprehensive), then llms.txt
  for (const filename of ['llms-full.txt', 'llms.txt']) {
    const url = `${origin}/${filename}`;
    console.error(`Checking ${url}...`);

    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/plain, text/markdown, */*'
        }
      }, TIMEOUTS.FETCH);

      if (!response.ok) {
        console.error(`  ${filename}: HTTP ${response.status}`);
        continue;
      }

      const text = await response.text();

      // Reject if we got HTML instead of text
      if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
        console.error(`  ${filename}: got HTML, not text`);
        continue;
      }

      console.error(`  ${filename}: found (${text.length} chars)`);

      // Extract URLs from markdown links: [text](url)
      const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g;
      let match;
      while ((match = linkPattern.exec(text)) !== null) {
        const href = match[2].trim();
        try {
          const resolved = new URL(href, origin).href;
          if (resolved.startsWith('http')) {
            discovered.add(resolved);
          }
        } catch { /* skip invalid URLs */ }
      }

      // Also extract bare URLs (one per line, common in simpler llms.txt files)
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
          const urlPart = trimmed.split(/\s/)[0].replace(/[,;]$/, '');
          try {
            new URL(urlPart);
            discovered.add(urlPart);
          } catch { /* skip invalid */ }
        }
      }

      if (discovered.size > 0) {
        console.error(`  Discovered ${discovered.size} URLs from ${filename}`);
        break; // Prefer llms-full.txt; don't also parse llms.txt if we found URLs
      }
    } catch (error) {
      console.error(`  ${filename}: ${error.message}`);
    }
  }

  // Fall back to sitemaps if no URLs came from llms.txt
  if (discovered.size === 0) {
    for (const url of await collectSitemapUrls(origin)) {
      discovered.add(url);
    }

    // If there are too many URLs, filter to doc-like paths
    if (discovered.size > DISCOVERY.DOC_FILTER_THRESHOLD) {
      const docPatterns = ['/docs/', '/doc/', '/api/', '/guide/', '/reference/', '/tutorial/',
        '/getting-started/', '/quickstart/', '/sdk/', '/learn/', '/manual/', '/handbook/'];
      const filtered = [...discovered].filter(url => {
        const path = new URL(url).pathname.toLowerCase();
        return docPatterns.some(p => path.includes(p));
      });

      if (filtered.length > 0 && filtered.length < discovered.size) {
        console.error(`  Filtered to ${filtered.length} doc-like URLs (from ${discovered.size} total)`);
        discovered.clear();
        filtered.forEach(url => discovered.add(url));
      }
    }
  }

  // Cap the run. Announce the truncation loudly: a silent cap reads to the
  // caller as "that was everything the site had".
  if (discovered.size > maxUrls) {
    // Sitemaps commonly list translations first, so a capped run on an i18n site
    // returns e.g. 50 Arabic pages and no English ones. Order English/unprefixed
    // URLs first before truncating.
    const kept = preferDefaultLocale([...discovered]).slice(0, maxUrls);
    console.error(`  Capped at ${maxUrls} URLs — ${discovered.size - maxUrls} discovered URLs NOT fetched.`);
    console.error(`  Raise the cap with --max-discover <n> to fetch more.`);
    discovered.clear();
    kept.forEach(url => discovered.add(url));
  }

  return [...discovered];
}

// ============================================================================
// Refresh: Find stale cached docs and return their source URLs
// ============================================================================

/**
 * Find cached docs older than maxDays.
 * @param {string} docsDir - Docs directory to scan
 * @param {number} maxDays - Maximum age in days
 * @returns {{source: string, path: string, ageDays: number}[]}
 */
function findStaleDocs(docsDir, maxDays) {
  const stale = [];
  const now = Date.now();

  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.md') && entry.name !== 'llms.txt') {
        try {
          const content = readFileSync(fullPath, 'utf-8');
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (!fmMatch) continue;

          let source = null, updated = null, generated = null;
          for (const line of fmMatch[1].split('\n')) {
            if (line.startsWith('Source:')) source = line.slice(7).trim();
            if (line.startsWith('Updated:')) updated = line.slice(8).trim();
            if (line.startsWith('Generated:')) generated = line.slice(10).trim();
          }
          if (!updated) updated = generated;

          if (!source || !updated) continue;

          const date = new Date(updated);
          if (isNaN(date.getTime())) continue;

          const ageDays = Math.floor((now - date.getTime()) / (1000 * 60 * 60 * 24));
          if (ageDays > maxDays) {
            // `generated` is carried through the re-fetch so the doc keeps its
            // original first-cached date; otherwise every refresh resets it and
            // Generated/Updated collapse into the same value.
            stale.push({ source, path: fullPath, ageDays, generated });
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }

  walk(docsDir);
  return stale;
}

// ============================================================================
// Index and Title Helpers
// ============================================================================

// extractTitle replaced by shared generateDescription from lib/descriptions.mjs

/** Synchronous sleep — the index critical section is sync, so it cannot await. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` holding an exclusive lock on the index.
 *
 * The index is shared mutable state: parallel agents fetching different libraries
 * into the same docs/ tree otherwise read-then-write on top of each other, which
 * loses entries and duplicates `## domain` headers. `wx` gives us an atomic
 * create-if-absent; a lock older than STALE_MS belonged to a process that died.
 */
function withIndexLock(indexPath, fn) {
  const lockPath = `${indexPath}.lock`;
  const STALE_MS = 30000;
  const deadline = Date.now() + 10000;
  let fd = null;

  while (fd === null) {
    try {
      fd = openSync(lockPath, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch { continue; } // lock disappeared — try to take it
      if (Date.now() > deadline) {
        console.error(`[INDEX] Lock ${lockPath} held for >10s; proceeding without it`);
        break;
      }
      sleepSync(50);
    }
  }

  try {
    return fn();
  } finally {
    if (fd !== null) {
      closeSync(fd);
      try { unlinkSync(lockPath); } catch { /* already gone */ }
    }
  }
}

/** Parse llms.txt into a preamble plus ordered `## <domain>` sections. */
function parseIndex(content) {
  const preamble = [];
  const sections = [];
  let current = null;
  for (const line of content.split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      // Fold a repeated header (left behind by an earlier racy append) into the
      // section that already exists rather than starting a second one.
      const existing = sections.find(s => s.name === heading[1]);
      current = existing || { name: heading[1], lines: [] };
      if (!existing) sections.push(current);
      continue;
    }
    (current ? current.lines : preamble).push(line);
  }
  return { preamble, sections };
}

/** Render the parsed index back to text with consistent spacing. */
function renderIndex({ preamble, sections }) {
  const chunks = [];
  const pre = preamble.join('\n').trim();
  if (pre) chunks.push(pre);
  for (const section of sections) {
    const body = section.lines.join('\n').trim();
    chunks.push(body ? `## ${section.name}\n\n${body}` : `## ${section.name}`);
  }
  return chunks.join('\n\n') + '\n';
}

/** Every `docs/...md` path already listed, matched exactly (not as a substring). */
function parseIndexPaths(content) {
  const paths = new Set();
  for (const line of content.split('\n')) {
    const match = line.match(/^-\s*(\S+\.md)\s*:/);
    if (match) paths.add(match[1]);
  }
  return paths;
}

/**
 * Add entries for newly fetched pages to <outputDir>/llms.txt.
 *
 * Rewrites the file in place under a lock (read → merge → atomic rename) so new
 * entries land inside their own domain section instead of being appended to
 * whatever section happens to be last.
 */
function updateLlmsIndex(fetched, outputDir) {
  const indexPath = join(outputDir, 'llms.txt');
  mkdirSync(dirname(indexPath), { recursive: true });

  withIndexLock(indexPath, () => {
    // Re-read inside the lock: another agent may have written since we started.
    const existing = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : '';
    const index = parseIndex(existing);
    const known = parseIndexPaths(existing);

    let added = 0;
    for (const { url, outputPath, markdown } of fetched) {
      if (known.has(outputPath)) continue;
      known.add(outputPath); // also dedupes repeats within this batch

      const desc = generateDescription(outputPath, markdown) || new URL(url).pathname;
      // Derive the section from the URL host, not by counting path segments —
      // that survives a nested --output-dir like `cache/docs`.
      let domain;
      try {
        domain = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        domain = 'other';
      }

      let section = index.sections.find(s => s.name === domain);
      if (!section) {
        section = { name: domain, lines: [] };
        index.sections.push(section);
      }
      section.lines.push(`- ${outputPath}: ${desc}`);
      added++;
    }

    if (added === 0) return;

    // Atomic replace: a crash mid-write must not truncate the index.
    const tmpPath = `${indexPath}.tmp.${process.pid}`;
    writeFileSync(tmpPath, renderIndex(index));
    renameSync(tmpPath, indexPath);
    console.error(`[INDEX] Updated ${indexPath} with ${added} new entries`);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Provisional budget; re-armed below once the real amount of work is known.
  armWatchdog(globalBudgetMs(args.urls.length || 1, args.concurrency));

  // Handle --discover: find URLs from remote llms.txt / sitemap.xml
  if (args.discover) {
    if (!args.outputDir) {
      args.outputDir = 'docs';
    }
    const discoveredUrls = await discoverDocUrls(args.discover, args.maxDiscover);
    if (discoveredUrls.length > 0) {
      console.error(`\nDiscovered ${discoveredUrls.length} documentation URLs`);
      args.urls.push(...discoveredUrls);
      armWatchdog(globalBudgetMs(args.urls.length, args.concurrency));
    } else {
      console.error('\nNo documentation URLs discovered');
    }
  }

  // Handle --refresh: find stale docs and re-fetch to original paths
  if (args.refresh !== null) {
    const docsDir = args.outputDir || 'docs';
    if (!args.outputDir) {
      args.outputDir = docsDir;
    }
    const stale = findStaleDocs(docsDir, args.refresh);
    if (stale.length > 0) {
      console.error(`\nRefreshing ${stale.length} stale docs (older than ${args.refresh} days)`);
      armWatchdog(globalBudgetMs(stale.length + args.urls.length, args.concurrency));

      browser = await launchBrowser();
      let refreshed = 0, failed = 0;
      const refreshedEntries = [];

      await runPool(stale, async (doc) => {
        console.error(`[REFRESH] ${doc.path} (${doc.ageDays}d old) from ${doc.source}`);
        const result = await fetchSingleUrl(doc.source, {
          selector: args.selector,
          frontMatter: args.frontMatter !== false,
          generated: doc.generated,
        }, browser);

        if (result.success) {
          mkdirSync(dirname(doc.path), { recursive: true });
          writeFileSync(doc.path, result.markdown);
          console.error(`[OK] ${doc.source} -> ${doc.path}`);
          refreshed++;
          refreshedEntries.push({ url: doc.source, outputPath: doc.path, markdown: result.markdown });
        } else {
          console.error(`[FAIL] ${doc.source}: ${result.error}`);
          failed++;
        }
      }, args.concurrency);

      await browser.close().catch(() => {});
      browser = null;

      console.error(`\nRefresh complete: ${refreshed} updated, ${failed} failed`);

      // Update index for refreshed entries
      if (args.updateIndex && refreshedEntries.length > 0) {
        updateLlmsIndex(refreshedEntries, docsDir);
      }
    } else {
      console.error(`\nNo stale docs found (threshold: ${args.refresh} days)`);
    }

    // If no other URLs were provided, exit after refresh
    if (args.urls.length === 0) {
      process.exit(0);
    }
  }

  // No URLs provided and no discover/refresh - show usage
  if (args.urls.length === 0) {
    if (args.discover || args.refresh !== null) {
      // discover/refresh ran but found nothing to fetch — that's OK
      process.exit(0);
    }
    console.error('Usage: node fetch-docs.js <url> [url2 ...] [options]');
    console.error('');
    console.error('Options:');
    console.error('  --output, -o <path>       Output file path (single URL only)');
    console.error('  --output-dir, -d <dir>    Base directory for auto-generated paths');
    console.error('  --concurrency, -c <n>     Parallel contexts 1-10 (default: 3)');
    console.error('  --urls, -u <file>         File with URLs (one per line)');
    console.error('  --selector, -s <sel>      Custom CSS selector for content');
    console.error('  --no-front-matter         Omit YAML front matter');
    console.error('  --skip-existing           Skip URLs whose output file already exists');
    console.error('  --update-index            Auto-append entries to docs/llms.txt');
    console.error('  --discover <url>          Discover docs from llms.txt / sitemaps');
    console.error(`  --max-discover <n>        Cap discovered URLs (default: ${DISCOVERY.MAX_URLS})`);
    console.error('  --refresh <days>          Re-fetch docs older than N days (default: 30)');
    console.error('');
    console.error('Examples:');
    console.error('  # Single URL to stdout');
    console.error('  node fetch-docs.js https://example.com/docs/intro');
    console.error('');
    console.error('  # Single URL to file');
    console.error('  node fetch-docs.js https://example.com/docs/intro -o docs/intro.md');
    console.error('');
    console.error('  # Single URL with auto-generated path');
    console.error('  node fetch-docs.js https://example.com/docs/intro -d docs/');
    console.error('');
    console.error('  # Multiple URLs (parallel)');
    console.error('  node fetch-docs.js https://a.com/page https://b.com/page -d docs/');
    console.error('');
    console.error('  # URLs from file');
    console.error('  node fetch-docs.js -u urls.txt -d docs/ -c 5');
    console.error('');
    console.error('  # Discover and fetch from a docs site');
    console.error('  node fetch-docs.js --discover https://docs.example.com -d docs/ --skip-existing --update-index');
    console.error('');
    console.error('  # Refresh docs older than 30 days');
    console.error('  node fetch-docs.js --refresh 30 -d docs/ --update-index');
    process.exit(1);
  }

  // Determine mode: single URL vs batch
  const isBatchMode = args.urls.length > 1 || (args.urls.length === 1 && args.outputDir && !args.output);

  if (isBatchMode) {
    // Batch mode requires --output-dir
    if (!args.outputDir) {
      console.error('Error: Multiple URLs require --output-dir (-d) flag');
      process.exit(1);
    }

    const results = await fetchBatch(args.urls, {
      outputDir: args.outputDir,
      concurrency: args.concurrency,
      selector: args.selector,
      frontMatter: args.frontMatter,
      skipExisting: args.skipExisting,
    });

    // Print summary
    console.error('\n' + '='.repeat(60));
    const parts = [`${results.succeeded} succeeded`, `${results.failed} failed`];
    if (results.skipped > 0) parts.push(`${results.skipped} skipped (cached)`);
    console.error(`Batch complete: ${parts.join(', ')}`);

    if (results.failures.length > 0) {
      console.error('\nFailed URLs:');
      for (const { url, error } of results.failures) {
        console.error(`  ${url}: ${error}`);
      }
    }

    // Update llms.txt index if requested
    if (args.updateIndex && results.fetched.length > 0) {
      updateLlmsIndex(results.fetched, args.outputDir);
    }

    // Exit with error if any failed
    if (results.failed > 0) {
      process.exit(1);
    }

  } else {
    // Single URL mode (backward compatible)
    const url = args.urls[0];

    // Pre-check with original URL for --skip-existing (best effort)
    const preCheckPath = args.output || (args.outputDir ? urlToOutputPath(url, args.outputDir) : null);
    if (args.skipExisting && preCheckPath && existsSync(preCheckPath)) {
      console.error(`[SKIP] ${url} (cached: ${preCheckPath})`);
      return;
    }

    console.error(`Fetching: ${url}`);

    const result = await fetchSingleUrl(url, {
      selector: args.selector,
      frontMatter: args.frontMatter
    });

    if (!result.success) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }

    // Use final URL (after redirects) for output path, unless explicit --output given
    const effectiveUrl = result.finalUrl || url;
    const outputPath = args.output || (args.outputDir ? urlToOutputPath(effectiveUrl, args.outputDir) : null);

    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, result.markdown);
      console.error(`Written to: ${outputPath}`);

      // Update llms.txt index if requested
      if (args.updateIndex) {
        updateLlmsIndex([{ url: effectiveUrl, outputPath, markdown: result.markdown }], args.outputDir || 'docs');
      }
    } else {
      console.log(result.markdown);
    }
  }
}

// Only run the CLI when this file is the entry point, so tests can import the
// pure helpers below without launching a fetch.
const isEntryPoint = process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  main()
    .then(disarmWatchdog)
    .catch(async (error) => {
      console.error('Error:', error.message);
      if (browser) await browser.close().catch(() => {});
      process.exit(1);
    });
}

export {
  TIMEOUTS,
  CONFIG,
  DISCOVERY,
  globalBudgetMs,
  isSoft404,
  convertToRawUrl,
  looksLikeMarkdown,
  isRelevantContent,
  titleMatchesContent,
  sameSource,
  urlToOutputPath,
  preferDefaultLocale,
  mapOutsideFences,
  cleanMarkdown,
  applyFrontMatter,
  parseSitemapXml,
  parseIndex,
  renderIndex,
  parseIndexPaths,
  updateLlmsIndex,
  findStaleDocs,
  parseArgs,
  runPool,
  createTurndownService,
};
