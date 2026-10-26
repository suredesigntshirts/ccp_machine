/**
 * Page front matter: parse, merge, serialize.
 *
 * Every page opens with one YAML block carrying provenance (Source / Generated /
 * Updated) plus whatever the upstream page declared (title, description, …).
 * v1 manipulated this with line regexes, which broke on block scalars and — in
 * older versions — stacked a second block under the first, hiding the upstream
 * title/description from every parser. Here the `yaml` library does the parsing
 * and the writing, and the key order is fixed so output is stable and diffs on
 * refresh stay small.
 *
 * Parsing is lenient on purpose: a cached page with slightly invalid YAML (v1
 * wrote upstream keys through verbatim, e.g. `npm: @scope/pkg`) must still be
 * readable — its keys are recovered line by line and re-serialized validly.
 */

import YAML from 'yaml';

/**
 * Keys the tool owns. Always written first, in this order.
 *   Source  the URL that was requested (a refresh re-requests it, re-following any redirect)
 *   Final   where that request landed after redirects — only when it differs from
 *           Source. The file's path is derived from Final (else Source).
 */
export const PROVENANCE_KEYS = ['Source', 'Final', 'Generated', 'Updated'];

/** Optional keys the tool may add, written after the upstream title/description. */
export const TOOL_KEYS = ['DescriptionFrom', 'Library', 'DocsVersion', 'LibraryVersion', 'VersionMatch', 'Via'];

const KEY_ORDER = [...PROVENANCE_KEYS, 'title', 'description', ...TOOL_KEYS];

/**
 * Where a description came from, best first (lib/convert/describe.mjs). A description
 * with no `DescriptionFrom` (written by hand, carried over from a v1 index) ranks above
 * all of them: nothing replaces it automatically.
 */
export const DESCRIPTION_SOURCES = ['llms.txt', 'front-matter', 'meta', 'lead'];
const descriptionRank = (from) => { const i = DESCRIPTION_SOURCES.indexOf(from); return from == null || i === -1 ? -1 : i; };

// Opening `---`, the YAML (possibly empty), closing `---`. A BOM is tolerated.
const FM_RE = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

export function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Split a document into its front-matter text and body.
 * @returns {{yaml: string|null, block: string, body: string}}
 *   `yaml` is the text between the delimiters (null when there is no block);
 *   `block` is the whole block including delimiters (empty when none).
 */
export function splitFrontMatter(text) {
  const m = FM_RE.exec(text);
  if (!m) return { yaml: null, block: '', body: text };
  return { yaml: m[1] ?? '', block: m[0], body: text.slice(m[0].length) };
}

/**
 * Recover top-level `key: value` pairs from YAML the parser rejected.
 * Indented continuation lines are folded into the preceding value.
 */
function lenientParse(yamlText) {
  const data = {};
  let lastKey = null;
  for (const line of yamlText.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w.-]*)\s*:(?:\s+(.*)|\s*)$/.exec(line);
    if (m) {
      lastKey = m[1];
      if (lastKey in data) { lastKey = null; continue; } // duplicate key: first one wins
      let v = (m[2] ?? '').trim();
      if (/^[>|][-+]?$/.test(v)) v = '';
      data[lastKey] = v.replace(/^(["'])(.*)\1$/, '$2');
    } else if (lastKey && /^\s+\S/.test(line)) {
      data[lastKey] = `${data[lastKey]} ${line.trim()}`.trim();
    }
  }
  return data;
}

/**
 * @returns {{data: object, yaml: string|null, body: string, block: string, valid: boolean, error: string|null}}
 *   `data` is `{}` when there is no front matter. `valid` is false when the YAML
 *   had to be recovered leniently (the page is still usable).
 */
export function parseFrontMatter(text) {
  const { yaml, block, body } = splitFrontMatter(text);
  if (yaml === null) return { data: {}, yaml, body, block, valid: true, error: null };
  try {
    const data = YAML.parse(yaml) ?? {};
    if (typeof data !== 'object' || Array.isArray(data)) throw new Error('front matter is not a mapping');
    return { data, yaml, body, block, valid: true, error: null };
  } catch (err) {
    return { data: lenientParse(yaml), yaml, body, block, valid: false, error: String(err.message).split('\n')[0] };
  }
}

/** Order keys: provenance, title/description, tool keys, then the rest as they came. */
function ordered(data) {
  const out = {};
  for (const k of KEY_ORDER) if (data[k] !== undefined) out[k] = data[k];
  for (const [k, v] of Object.entries(data)) if (!(k in out) && v !== undefined) out[k] = v;
  return out;
}

/** Serialize to a `---` block (with trailing newline). Stable: same data → same bytes. */
export function serializeFrontMatter(data) {
  const yaml = YAML.stringify(ordered(data), {
    lineWidth: 0,          // never fold long descriptions across lines
    minContentWidth: 0,
  });
  return `---\n${yaml}---\n`;
}

/** Front matter + one blank line + body (leading blank lines of the body dropped). */
export function renderDocument(data, body) {
  return `${serializeFrontMatter(data)}\n${body.replace(/^(?:[ \t]*\r?\n)+/, '')}`;
}

/**
 * If the body itself opens with a second front-matter block (v1 before the fix
 * prepended provenance above the upstream block instead of merging), fold it into
 * the first. Only a block that parses as a YAML mapping counts, so a body that
 * merely starts with a `---` rule is left alone.
 *
 * @returns {{data: object, body: string, unstacked: boolean, valid: boolean}}
 */
export function parseUnstacked(text) {
  const first = parseFrontMatter(text);
  const rest = first.body.replace(/^(?:[ \t]*\r?\n)+/, '');
  const second = first.yaml === null ? null : splitFrontMatter(rest);
  if (second?.yaml != null) {
    let upstream = null;
    try {
      const d = YAML.parse(second.yaml);
      if (d && typeof d === 'object' && !Array.isArray(d)) upstream = d;
    } catch { /* not front matter after all */ }
    if (upstream) {
      // Keys from the outer (tool-written) block win: they are the provenance.
      return { data: { ...upstream, ...first.data }, body: second.body, unstacked: true, valid: first.valid };
    }
  }
  return { data: first.data, body: first.body, unstacked: false, valid: first.valid };
}

/**
 * Compute a page's front matter for a (re)write.
 *
 * Precedence, lowest first:
 *   previous  — the page already cached at this path (only `Generated` and the
 *               sticky keys below survive a refresh);
 *   upstream  — the fetched markdown's own front matter (title, description, …),
 *               merged into one block, never stacked;
 *   supplied  — what the caller passes (`Library`, `Via`, a better description…);
 *   provenance — Source / Final / Generated / Updated, always set by the tool
 *               (`final`: the post-redirect URL; recorded only when ≠ `url`).
 *
 * Sticky keys (`description`, `Library`) are kept from the previous version when
 * the new fetch doesn't provide them: a description carried over from the v1
 * index, or a `--lib` given on first fetch, shouldn't vanish on `--refresh`.
 * Pass `supplied: {description: null}` to drop one deliberately.
 *
 * A fetch that chose the description (`supplied.DescriptionFrom` present, null when
 * nothing qualified) decides it over the upstream front matter it already weighed,
 * but never replaces a previous description from a better source (DESCRIPTION_SOURCES).
 */
export const STICKY_KEYS = ['description', 'Library'];

export function mergeFrontMatter({ url, final, previous = {}, upstream = {}, supplied = {}, generated, now = new Date() }) {
  const today = todayIso(now);
  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !PROVENANCE_KEYS.includes(k)));
  const merged = { ...strip(upstream), ...strip(supplied) };
  for (const k of STICKY_KEYS) {
    if (!(k in supplied) && merged[k] == null && previous[k] != null) merged[k] = previous[k];
  }
  // `supplied: {key: null}` is how a caller deletes a key (including a sticky one).
  if (Object.prototype.hasOwnProperty.call(supplied, 'DescriptionFrom')) {
    const prev = previous.description ?? null;
    const prevFrom = prev == null ? null : (previous.DescriptionFrom ?? null);
    const next = supplied.description ?? null;
    const nextFrom = supplied.DescriptionFrom ?? null;
    delete merged.description; delete merged.DescriptionFrom;
    if (next != null && (prev == null || descriptionRank(nextFrom) <= descriptionRank(prevFrom) && descriptionRank(prevFrom) !== -1)) {
      merged.description = next;
      if (nextFrom) merged.DescriptionFrom = nextFrom;
    } else if (prev != null) {
      merged.description = prev;
      if (prevFrom) merged.DescriptionFrom = prevFrom;
    }
  }
  for (const [k, v] of Object.entries(supplied)) if (v === null && k !== 'description' && k !== 'DescriptionFrom') delete merged[k];
  if (!Object.prototype.hasOwnProperty.call(supplied, 'DescriptionFrom') && supplied.description === null) delete merged.description;
  const prevGenerated = previous.Generated == null ? null : String(previous.Generated);
  return {
    Source: url,
    ...(final && final !== url ? { Final: final } : {}),
    Generated: generated || supplied.Generated || prevGenerated || today,
    Updated: today,
    ...merged,
  };
}
