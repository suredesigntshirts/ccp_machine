/**
 * Layer 3 of content extraction: an LLM-derived *site profile* — CSS selectors for
 * a host's content root(s), template to remove inside them, and the title — used
 * only when layers 1–2 (./extract.mjs) are not confident, and saved to
 * `<root>/_profiles/<host>.json` so later pages of that host reuse it for free.
 *
 * The model never sees raw HTML: it gets a compact DOM skeleton (buildSkeleton),
 * bounded in size whatever the page size. The model call is a plain function
 * argument (`llm(prompt) → Promise<{text, costUsd?, ms?, model?}>`), so tests stub
 * it, the CLI uses `claudeCli()` (Claude Code headless), and when no model is
 * available the pipeline hands the prompt back to the calling agent instead.
 *
 * A saved profile whose selectors stop matching FAILS LOUDLY (ProfileMismatch):
 * the page is not converted with a stale profile; the caller re-derives it, with
 * the failure as context for the model.
 */
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { parseHtml } from './dom.mjs';
import { extractContent, buildSkeleton, findTitleHeading, blockText } from './extract.mjs';

export const PROFILE_VERSION = 1;
/** Below this, layers 1–2 are not trusted and a profile is used/derived. */
export const DEFAULT_MIN_CONFIDENCE = 0.6;

export class ProfileMismatch extends Error {
  constructor(host, reason) {
    super(`site profile for ${host} no longer matches: ${reason}`);
    this.name = 'ProfileMismatch';
    this.host = host;
    this.reason = reason;
  }
}

// ─── storage ───────────────────────────────────────────────────────────────

export const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return null; } };
const profilePath = (dir, host) => join(dir, `${host.replace(/[^a-z0-9.-]/gi, '_')}.json`);

/** @param {string} dir  `<root>/_profiles` */
export async function loadProfile(dir, host) {
  if (!dir || !host) return null;
  try { return JSON.parse(await fsp.readFile(profilePath(dir, host), 'utf-8')); } catch { return null; }
}

/** Atomic write (temp + rename). Callers hold the domain lock (DESIGN.md "Concurrency"). */
export async function saveProfile(dir, host, profile) {
  await fsp.mkdir(dir, { recursive: true });
  const file = profilePath(dir, host);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(profile, null, 2) + '\n');
  await fsp.rename(tmp, file);
  return file;
}

// ─── prompt ────────────────────────────────────────────────────────────────

const SYSTEM = 'You locate the main content of documentation web pages from a DOM outline. Answer with one JSON object only.';

/**
 * @param {string} skeleton  buildSkeleton() output
 * @param {{url?:string, title?:string|null, heuristic?:object, failure?:string, previous?:object}} ctx
 */
export function buildProfilePrompt(skeleton, { url, title, heuristic, failure, previous } = {}) {
  const parts = [
    `Page: ${url || '(unknown URL)'}${title ? `\nTitle heading: ${JSON.stringify(title)}` : ''}`,
    '',
    'Below is an outline of the page\'s element tree (not raw HTML). One line per significant element:',
    '`tag#id.classes[role]` (single-child wrapper chains joined with " > ", "… >" = elements skipped),',
    'text = visible characters inside, links = share of that text inside links, h = headings inside,',
    'pre = code blocks inside, then the first characters of its text. [TITLE H1] marks the page title.',
    '',
    skeleton,
    '',
    'Task: give CSS selectors (valid for querySelectorAll; ids, stable class names and tag names only —',
    'never utility classes like "lg:flex" or hashed ones that look random) for this documentation site\'s',
    'template, generic enough to work on OTHER pages of the same site:',
    '- contentSelectors: the element(s) holding the page\'s own content — the title heading, intro, all',
    '  sections, code, tables, tab panels. Usually one element; several when the title or parts of the',
    '  content live outside the main body container. Exclude site navigation, sidebars, headers/footers.',
    '- removeSelectors: template INSIDE those elements to drop: breadcrumbs, "On this page" tables of',
    '  contents, feedback widgets ("Was this helpful"), copy/edit/share buttons, prev/next pagers,',
    '  banners, promos, related-content cards. Empty list if none. Never remove real content.',
    '- titleSelector: the page title heading.',
  ];
  if (heuristic) {
    parts.push('', `A statistical extractor chose ${JSON.stringify(heuristic.root)} (confidence ${heuristic.confidence?.toFixed?.(2)}), which may be wrong.`);
  }
  if (previous || failure) {
    parts.push('', `A previously saved profile for this site failed on this page: ${failure || ''}`,
      `Previous profile: ${JSON.stringify(previous || {})}`, 'Give selectors that work on this page and, ideally, the old pages too.');
  }
  parts.push('', 'Answer with JSON only: {"contentSelectors": ["…"], "removeSelectors": ["…"], "titleSelector": "…", "notes": "one short sentence"}');
  return { system: SYSTEM, prompt: parts.join('\n') };
}

/** First JSON object in a model's answer (tolerates ```json fences and prose around it). */
export function parseProfileAnswer(text) {
  if (!text) throw new Error('empty answer');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`no JSON object in answer: ${text.slice(0, 200)}`);
  const obj = JSON.parse(body.slice(start, end + 1));
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []).filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
  const out = { contentSelectors: arr(obj.contentSelectors), removeSelectors: arr(obj.removeSelectors), titleSelector: typeof obj.titleSelector === 'string' ? obj.titleSelector.trim() : null };
  if (!out.contentSelectors.length) throw new Error('answer has no contentSelectors');
  if (obj.notes) out.notes = String(obj.notes).slice(0, 300);
  return out;
}

// ─── validation ────────────────────────────────────────────────────────────

/**
 * Check a profile on a page (a fresh document — this mutates it): selectors are
 * valid and match; the content holds the title heading and a fair share of the
 * page's text; it is not a link list.
 * @returns {{ok:boolean, problems:string[], roots?:Element[], title?:string, text?:number}}
 */
export function validateProfile(doc, profile, { siblings = [] } = {}) {
  const problems = [];
  for (const sel of [...(profile.contentSelectors || []), ...(profile.removeSelectors || []), profile.titleSelector].filter(Boolean)) {
    try { doc.querySelector(sel); } catch (err) { problems.push(`invalid selector ${JSON.stringify(sel)}: ${err.message}`); }
  }
  if (problems.length) return { ok: false, problems };
  const { el: h1 } = findTitleHeading(doc);
  const body = doc.body || doc.documentElement;
  const pageText = collapsedLen(body);
  const r = extractContent(doc, { profile, siblings });
  if (r.method !== 'profile') return { ok: false, problems: [r.signals.profileFailure || 'profile did not apply'] };
  const text = r.roots.reduce((a, e) => a + collapsedLen(e), 0);
  const link = r.roots.reduce((a, e) => a + Array.from(e.querySelectorAll('a[href]')).reduce((b, x) => b + collapsedLen(x), 0), 0);
  if (h1 && !r.roots.some(e => e === h1 || e.contains(h1))) problems.push('the title heading is not inside the content');
  if (text < 0.1 * pageText && text < 500) problems.push(`content holds only ${text} of ${pageText} chars`);
  if (text && link / text > 0.75) problems.push(`content is ${Math.round(100 * link / text)}% link text (navigation?)`);
  return { ok: problems.length === 0, problems, roots: r.roots, title: r.title, text, removed: r.removed };
}

const collapsedLen = (el) => blockText(el).replace(/\s+/g, ' ').trim().length;

// ─── deriving ──────────────────────────────────────────────────────────────

/**
 * Ask the model for a profile of this page's site and validate it.
 * @param {string} html
 * @param {{url:string, llm:Function, heuristic?:object, failure?:string, previous?:object, maxLines?:number}} opts
 * @returns {Promise<{ok:boolean, profile?:object, problems?:string[], prompt:string, usage:object}>}
 */
export async function deriveProfile(html, { url, llm, heuristic, failure, previous, maxLines = 160 }) {
  const doc = parseHtml(html, url);
  const { text: title } = findTitleHeading(doc);
  const skeleton = buildSkeleton(doc, { maxLines });
  const { system, prompt } = buildProfilePrompt(skeleton, { url, title, heuristic, failure, previous });
  const t0 = Date.now();
  let answer;
  try {
    answer = await llm(prompt, { system });
  } catch (err) {
    return { ok: false, problems: [`model call failed: ${err.message}`], prompt, usage: { ms: Date.now() - t0, costUsd: null, model: null, promptChars: prompt.length } };
  }
  const usage = { ms: answer.ms ?? Date.now() - t0, costUsd: answer.costUsd ?? null, model: answer.model ?? null, promptChars: prompt.length };
  let profile;
  try { profile = parseProfileAnswer(answer.text); } catch (err) { return { ok: false, problems: [err.message], prompt, usage, answer: answer.text }; }
  const v = validateProfile(parseHtml(html, url), profile);
  const full = { version: PROFILE_VERSION, host: hostOf(url), derivedFrom: url, derivedAt: new Date().toISOString(), model: usage.model, ...profile };
  return { ok: v.ok, profile: full, problems: v.problems, prompt, usage };
}

// ─── the model call: Claude Code headless ──────────────────────────────────

/**
 * `llm` implementation over the Claude Code CLI in headless mode. Minimal system
 * prompt, no tools, no settings/MCP — the call is a pure text completion.
 * @param {{model?:string, bin?:string, timeoutMs?:number}} [o]
 */
export function claudeCli({ model = 'claude-haiku-4-5-20251001', bin = 'claude', timeoutMs = 180000, effort = 'low', thinkingTokens = 0 } = {}) {
  return (prompt, { system } = {}) => new Promise((resolve, reject) => {
    const args = ['-p', '--model', model, '--output-format', 'json', '--tools', '', '--no-session-persistence',
      '--strict-mcp-config', '--setting-sources', '', '--system-prompt', system || SYSTEM];
    // Thinking is not needed to read an outline: without these, a Haiku call spent
    // ~10k thinking tokens (96 s, $0.05) on one page.
    if (effort && !/haiku/.test(model)) args.push('--effort', effort);
    const env = { ...process.env, MAX_THINKING_TOKENS: String(thinkingTokens) };
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`claude timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let j;
      try { j = JSON.parse(out); } catch { return reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 300)}`)); }
      if (j.is_error) return reject(new Error(`claude error: ${String(j.result).slice(0, 300)}`));
      resolve({ text: j.result, costUsd: j.total_cost_usd ?? null, ms: j.duration_ms ?? null, model, usage: j.usage });
    });
    child.stdin.end(prompt);
  });
}

/** Is the `claude` CLI on PATH? */
export async function claudeAvailable(bin = 'claude') {
  return new Promise((resolve) => {
    const c = spawn(bin, ['--version'], { stdio: 'ignore' });
    c.on('error', () => resolve(false));
    c.on('close', (code) => resolve(code === 0));
  });
}

// ─── the pipeline: layers 1–3 together ─────────────────────────────────────

/**
 * Extract a page's content roots with all three layers:
 *   saved profile for the host → (fails loudly if stale) →
 *   statistics + siblings → if not confident: derive a profile with `llm`, validate, save.
 *
 * @param {object} o
 * @param {string} o.html
 * @param {string} o.url
 * @param {{url:string, html:string}[]} [o.siblings]
 * @param {string} [o.profilesDir]   `<root>/_profiles`; omit to neither read nor save profiles
 * @param {Function|null} [o.llm]    null → no model: low-confidence pages return `needsProfile`
 * @param {number} [o.minConfidence]
 * @returns {Promise<{doc, roots, title, method, confidence, signals, profile?, needsProfile?, llm?}>}
 */
export async function extractPage({ html, url, siblings = [], profilesDir = null, llm = null, minConfidence = DEFAULT_MIN_CONFIDENCE }) {
  const host = hostOf(url);
  const saved = await loadProfile(profilesDir, host);
  let failure = null;
  if (saved) {
    const doc = parseHtml(html, url);
    const v = validateProfile(doc, saved);
    if (v.ok) return { doc, roots: v.roots, title: v.title || findTitleHeading(doc).text, method: 'profile', confidence: 0.9, signals: { profile: profilePath(profilesDir, host) }, removed: v.removed };
    failure = v.problems.join('; ');
    if (!llm) throw new ProfileMismatch(host, failure);
  }

  const doc = parseHtml(html, url);
  const res = extractContent(doc, { url, siblings });
  if (!failure && res.confidence >= minConfidence) return { doc, ...res };

  const heuristic = { root: res.signals.root, confidence: res.confidence };
  if (!llm) {
    // hand the decision to the calling agent
    const d = parseHtml(html, url);
    const { system, prompt } = buildProfilePrompt(buildSkeleton(d), { url, title: res.title, heuristic });
    return { doc, ...res, needsProfile: { host, system, prompt, reason: `low confidence ${res.confidence.toFixed(2)}` } };
  }
  const derived = await deriveProfile(html, { url, llm, heuristic, failure, previous: saved });
  if (!derived.ok) {
    if (saved) throw new ProfileMismatch(host, `${failure}; re-derived profile also failed: ${derived.problems?.join('; ')}`);
    return { doc, ...res, llm: { ...derived.usage, ok: false, problems: derived.problems } };
  }
  if (profilesDir) await saveProfile(profilesDir, host, derived.profile);
  const d2 = parseHtml(html, url);
  const v = validateProfile(d2, derived.profile);
  return { doc: d2, roots: v.roots, title: v.title || res.title, method: saved ? 'profile-rederived' : 'profile-new', confidence: 0.85, signals: { ...res.signals, heuristicRoot: res.signals.root }, removed: v.removed, profile: derived.profile, llm: { ...derived.usage, ok: true } };
}
