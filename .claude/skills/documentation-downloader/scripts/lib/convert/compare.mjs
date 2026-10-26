/**
 * Do two conversions of one page say the same thing? Used to check that the
 * server's HTML (plain GET, no browser) converts to what the browser render
 * converts to, before trusting the plain GET for a site (DESIGN.md "Fetch
 * pipeline" → raw-first). No gold involved: the render is the reference.
 *
 *   compareConversions(rawMarkdown, renderedMarkdown)
 *     → { same, reason, coverage, extra, code, headings, title }
 *
 *   coverage   share of the render's words (as a multiset) also in the raw one —
 *              content only the browser produced (JS-rendered text, lazy tabs)
 *   extra      share of the raw conversion's words that the render also has —
 *              text the page's scripts remove (placeholders, "loading…", another locale)
 *   code       share of the render's code-block characters found verbatim in the raw
 *              conversion's code blocks
 *   headings   share of the render's headings present in the raw conversion
 *   title      the first H1 matches
 */

export const SAME_THRESHOLDS = { coverage: 0.97, extra: 0.9, code: 0.98, headings: 0.95 };

const stripFrontMatter = (md) => md.replace(/^---\n[\s\S]*?\n---\s*\n/, '');

/** Fenced code blocks' contents, and the markdown with them removed. */
function splitCode(md) {
  const code = [];
  const lines = md.split('\n');
  const prose = [];
  let fence = null;
  let buf = [];
  for (const line of lines) {
    if (fence) {
      if (line.trimStart().startsWith(fence) && line.trim().replace(/[`~]/g, '') === '') {
        code.push(buf.join('\n'));
        fence = null;
        buf = [];
      } else buf.push(line);
      continue;
    }
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) { fence = m[1]; continue; }
    prose.push(line);
  }
  if (fence) code.push(buf.join('\n'));
  return { code, prose: prose.join('\n') };
}

const words = (text) => text
  .replace(/<[^>]+>/g, ' ')
  .replace(/\]\([^)]*\)/g, ']')           // link targets: absolute vs relative is not a content difference
  .toLowerCase()
  .match(/[\p{L}\p{N}_]+/gu) ?? [];

function multiset(list) {
  const m = new Map();
  for (const w of list) m.set(w, (m.get(w) || 0) + 1);
  return m;
}

/** Share of `a`'s items (multiset) that `b` also has. 1 when `a` is empty. */
function contained(a, b) {
  const total = a.length;
  if (!total) return 1;
  const mb = multiset(b);
  let hit = 0;
  for (const [w, n] of multiset(a)) hit += Math.min(n, mb.get(w) || 0);
  return hit / total;
}

const headingsOf = (prose) => prose.split('\n')
  .map(l => /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l)?.[1])
  .filter(Boolean)
  .map(h => words(h).join(' '))
  .filter(Boolean);

const squash = (s) => s.replace(/\s+/g, ' ').trim();

export function compareConversions(rawMarkdown, renderedMarkdown, thresholds = SAME_THRESHOLDS) {
  const raw = splitCode(stripFrontMatter(rawMarkdown || ''));
  const ren = splitCode(stripFrontMatter(renderedMarkdown || ''));

  const rawWords = words(raw.prose);
  const renWords = words(ren.prose);
  const coverage = contained(renWords, rawWords);
  const extra = contained(rawWords, renWords);

  const rawCode = raw.code.map(squash).join('\n');
  const renCodeChars = ren.code.reduce((n, c) => n + squash(c).length, 0);
  const codeHit = ren.code.reduce((n, c) => { const s = squash(c); return n + (s && rawCode.includes(s) ? s.length : 0); }, 0);
  const code = renCodeChars ? codeHit / renCodeChars : 1;

  const renHeads = headingsOf(ren.prose);
  const rawHeads = new Set(headingsOf(raw.prose));
  const headings = renHeads.length ? renHeads.filter(h => rawHeads.has(h)).length / renHeads.length : 1;
  const title = (headingsOf(raw.prose.split('\n').filter(l => /^#\s/.test(l)).join('\n'))[0] ?? '')
    === (headingsOf(ren.prose.split('\n').filter(l => /^#\s/.test(l)).join('\n'))[0] ?? '');

  const fails = [];
  if (coverage < thresholds.coverage) fails.push(`server HTML misses ${(100 * (1 - coverage)).toFixed(1)}% of the render's text`);
  if (extra < thresholds.extra) fails.push(`${(100 * (1 - extra)).toFixed(1)}% of the server HTML's text is not in the render`);
  if (code < thresholds.code) fails.push(`${(100 * (1 - code)).toFixed(1)}% of the render's code differs`);
  if (headings < thresholds.headings) fails.push(`${(100 * (1 - headings)).toFixed(0)}% of the render's headings missing`);
  if (!title) fails.push('different title');
  return { same: fails.length === 0, reason: fails.join('; ') || null, coverage, extra, code, headings, title };
}
