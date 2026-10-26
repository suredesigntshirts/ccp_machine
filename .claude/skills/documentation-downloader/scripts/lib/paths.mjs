/**
 * URL ↔ cache path mapping. The URL is the cache key.
 *
 *   https://www.example.com/docs/guide.html?x=1#y  →  example.com/docs/guide.md
 *   https://example.com/                           →  example.com/index.md
 *   https://example.com/api/                       →  example.com/api.md
 *
 * Paths returned are relative to the cache root and always use `/`.
 */

const TRACKING_PARAM = /^(utm_[a-z]+|gclid|fbclid|mc_[a-z]+|ref_src)$/i;

/** Canonical form of a URL for caching: no fragment, no tracking params. */
export function canonicalUrl(url) {
  const u = new URL(url);
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
  }
  return u.href;
}

export function hostKey(url) {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

// ─── names the tool writes itself ────────────────────────────────────────────
//
// DESIGN.md → Cache layout. These are never pages: walkers skip exactly these
// and nothing else — a URL segment that merely starts with `_` or `.`
// (docs.python.org `__main__`, Sphinx `_modules/`, `.well-known/`) is a page.

/** Files at the root: the generated catalog and the cache marker. */
export const ROOT_GENERATED_FILES = ['catalog.md', '.docs-cache.json'];
/** Directories at the root: site extraction profiles. */
export const ROOT_GENERATED_DIRS = ['_profiles'];
/** Files directly in a domain folder: its generated outline. */
export const DOMAIN_GENERATED_FILES = ['_outline.md'];
/** Directories skipped wherever they are: derived state, VCS metadata. */
export const DERIVED_DIRS = ['.cache', '.git'];
/** Marks an in-flight atomic write's temp file (store/atomic.mjs). */
export const TEMP_FILE_MARK = '.tmp-dd-';

/** Is this root-relative directory (`/`-separated) derived — never walked for pages? */
export function isDerivedDir(relDir) {
  const segs = relDir.split('/');
  if (segs.length === 1 && ROOT_GENERATED_DIRS.includes(segs[0])) return true;
  return segs.some(seg => DERIVED_DIRS.includes(seg));
}

/**
 * Is this root-relative file path something the tool generated or derived
 * (catalog, outline, marker, profiles, `.cache/`, temp files) — never a page?
 * `<page>.parts/` files are not derived: they are indexed like pages.
 */
export function isDerivedFile(rel) {
  const segs = rel.split('/');
  const name = segs[segs.length - 1];
  if (name.includes(TEMP_FILE_MARK)) return true;
  if (segs.length === 1 && ROOT_GENERATED_FILES.includes(name)) return true;
  if (segs.length === 2 && DOMAIN_GENERATED_FILES.includes(name)) return true;
  return segs.length > 1 && isDerivedDir(segs.slice(0, -1).join('/'));
}

// A URL may not map onto a generated name: such a segment gets one more `_`.
// Names already ending in `_` get one too (`_outline_` → `_outline__`), so the
// mapping stays one-to-one. Case-insensitive, for case-insensitive filesystems.
const RESERVED_HOST = /^(?:catalog\.md|\.docs-cache\.json|_profiles|\.cache|\.git)_*$/i;
const RESERVED_DIR = /^(?:\.cache|\.git)_*$|\.parts_*$/i; // `<page>.parts/` holds that page's parts
const RESERVED_DOMAIN_FILE = /^_outline_*$/i;              // <domain>/_outline.md

/** Decoded pathname; a malformed %-escape (`%E0`) keeps the raw pathname. */
function decodePath(pathname) {
  try { return decodeURIComponent(pathname); } catch { return pathname; }
}

/**
 * Relative cache path for a URL (query string and fragment are not part of the path).
 * Segments that would land on a name the tool writes itself are escaped with a
 * trailing `_`: `https://host/_outline` → `host/_outline_.md` (not the domain's
 * generated outline), a `/x.parts/` directory → `x.parts_/` (not `x`'s parts),
 * a `.cache`/`.git` directory → `.cache_`/`.git_`, and a host named like a
 * root file (`catalog.md`, `_profiles`, …) likewise.
 */
export function urlToRelPath(url) {
  const u = new URL(url);
  let path = decodePath(u.pathname)
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
  path = path.replace(/\.mdx?$/i, '').replace(/\.(html?|php|aspx?)$/i, '');
  if (!path) path = '/index';
  // Keep every segment filesystem-safe without changing ordinary names.
  const segments = path.split('/').filter(Boolean).map(seg =>
    seg.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/^\.+$/, '_'));
  const last = segments.length - 1;
  const escaped = segments.map((seg, i) => {
    if (i < last) return RESERVED_DIR.test(seg) ? `${seg}_` : seg;
    return i === 0 && RESERVED_DOMAIN_FILE.test(seg) ? `${seg}_` : seg;
  });
  let host = hostKey(url);
  if (RESERVED_HOST.test(host)) host += '_';
  return `${host}/${escaped.join('/')}.md`;
}

/** Cache path joined onto a root given as a relative or absolute directory. */
export function urlToOutputPath(url, root) {
  return `${root.replace(/\/+$/, '')}/${urlToRelPath(url)}`;
}
