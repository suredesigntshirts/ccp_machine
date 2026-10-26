/**
 * Is a description usable? Shared checks for descriptions taken from what a site
 * published (lib/convert/describe.mjs) and from v1 llms.txt indexes (store/migrate.mjs).
 *
 * The tool never writes descriptions itself; v1's generator (first sentence plus a
 * per-site prefix table) is gone.
 */

import { basename } from 'path';

export const MAX_DESCRIPTION_LENGTH = 120;

// ============================================================================
// Bad Description Detection
// ============================================================================

/**
 * Check if a description is bad. Returns a reason string if bad, null if good.
 */
export function isBadDescription(desc, filePath) {
  if (!desc || desc.length === 0) return 'empty';

  // URL path as description
  if (/^\/?(docs\/|api\/|guides\/)/.test(desc)) return 'url_path';
  if (desc.startsWith('/')) return 'url_path';

  // Single word under 30 chars
  if (/^\w+$/.test(desc) && desc.length < 30) return 'single_word';

  // Filename with dashes converted to spaces
  const stem = basename(filePath, '.md').replace(/-/g, ' ');
  if (desc.toLowerCase() === stem.toLowerCase()) return 'filename_derived';
  if (desc.replace(/\s+/g, '').toLowerCase() === stem.replace(/\s+/g, '').toLowerCase()) return 'filename_derived';

  // YAML key prefixes
  if (/^(title|description|sidebarTitle):\s/i.test(desc)) return 'yaml_prefix';

  // YAML/HTML fragments
  if (/^-\s*type:|^<\w+/.test(desc)) return 'fragment';

  // Unrendered markdown/HTML markup leaked in from the source page
  if (/\]\(|<\/?[a-z][^>]*>/i.test(desc)) return 'raw_markup';

  // Site UI text
  if (/copy for llm|view as|edit this page|on this page/i.test(desc)) return 'ui_text';

  // 404 page
  if (/404/i.test(desc) && desc.length < 30) return '404_page';

  // Too generic (just a label with no context)
  if (/^(overview|introduction|guide|getting started|readme|index|home)$/i.test(desc)) return 'too_generic';

  // Namespace/module format without context
  if (/^(namespace|module|class|interface):\s*\w+$/i.test(desc)) return 'too_generic';

  // Too long from local extraction (truncated sentences are worse than short titles)
  if (desc.length > MAX_DESCRIPTION_LENGTH) return 'too_long';

  return null;
}

/**
 * isBadDescription plus failure modes seen in real v1 llms.txt indexes, which
 * isBadDescription lets through:
 *   invisible_chars       `[` + zero-width space — a mangled heading permalink
 *   no_words              `0.3.160` — no word of three or more letters
 *   unbalanced_brackets   a description cut through a link or parenthesis
 *
 * `handWritten: true` relaxes one rule, `too_long`. That rule exists because
 * descriptions EXTRACTED from page text get cut mid-sentence; a long index entry
 * written on purpose (by an agent or a person — often the most informative line
 * in a v1 index) is kept unless it is itself truncated (ends in `...`/`…`).
 * Consumers truncate for display.
 *
 * isBadDescription itself is unchanged; existing callers are unaffected.
 *
 * @returns {string|null} reason if bad, null if good
 */
export function descriptionProblem(desc, filePath, { handWritten = false } = {}) {
  const r = isBadDescription(desc, filePath);
  if (r === 'too_long') {
    if (!handWritten || /(?:\.\.\.|…)$/.test(desc.trim())) return r;
  } else if (r) {
    return r;
  }
  if (/[\u200b-\u200f\u2060\uFEFF]/.test(desc)) return 'invisible_chars';
  if (!/\p{L}{3,}/u.test(desc)) return 'no_words';
  const count = (c) => desc.split(c).length - 1;
  if (count('[') !== count(']') || count('(') !== count(')')) return 'unbalanced_brackets';
  return null;
}
