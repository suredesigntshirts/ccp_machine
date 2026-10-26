/**
 * The one HTML parser the conversion pipeline uses.
 *
 * domino (the DOM Turndown itself uses in Node) was measured on the corpus's
 * largest page (35 MB, ~1M elements): parse ≈ 8 s. linkedom took 90 s and
 * jsdom 32 s / 3 GB; parse5-based hast failed outright. Everything that walks
 * or queries the DOM goes through here so the choice can change in one place.
 */
import domino from '@mixmark-io/domino';

/**
 * @param {string} html
 * @param {string} [baseUrl]  used to resolve relative links/images
 * @returns {Document}
 */
export function parseHtml(html, baseUrl) {
  const doc = domino.createDocument(html);
  if (baseUrl) {
    // Respect a page's own <base href>; otherwise pin the document URL.
    let base = doc.querySelector('base[href]');
    if (!base) {
      base = doc.createElement('base');
      base.setAttribute('href', baseUrl);
      (doc.head || doc.documentElement).insertBefore(base, (doc.head || doc.documentElement).firstChild);
    } else {
      try { base.setAttribute('href', new URL(base.getAttribute('href'), baseUrl).href); } catch { /* keep */ }
    }
  }
  return doc;
}

/** Resolve an attribute URL against the document's base; null when unusable. */
export function absoluteUrl(value, baseUrl) {
  if (!value) return null;
  const v = value.trim();
  if (!v || v.startsWith('#') || /^(javascript|data|blob|about):/i.test(v)) return null;
  try { return new URL(v, baseUrl).href; } catch { return null; }
}
