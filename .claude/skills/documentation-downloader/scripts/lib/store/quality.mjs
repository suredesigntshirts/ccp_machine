/**
 * Recognise cached pages that are not documentation: bot-check interstitials,
 * error pages and near-empty captures. v1 cached these as if they were real
 * (`# Just a moment...`), and an agent that later finds them "cached" never
 * re-fetches. The fetch pipeline should refuse to write such a page; migration
 * reports them so the user can re-fetch.
 *
 * Deliberately generic (phrases that interstitial/error templates use across
 * vendors), and conservative: a false positive on a real page costs a warning,
 * not data.
 */

import { parseFrontMatter } from './frontmatter.mjs';

// Titles/first headings produced by bot checks, WAFs, login walls and error pages.
const BAD_TITLE = new RegExp('^(?:' + [
  'just a moment',
  'verification successful',
  'attention required',
  'access denied',
  'checking (?:your|if the site connection is secure)',
  'please verify you are (?:a )?human',
  'are you a (?:human|robot)',
  'security check',
  'one more step',
  "(?:we're|we are) sorry",
  'ddos protection',
  'captcha',
  'too many requests',
  'page not found',
  '(?:error )?(?:403|404|429|500|502|503)(?:\\b|$)',
  'not found',
  'forbidden',
  'service unavailable',
  'internal server error',
  'a new version of .* is available',
  '(?:sign|log) ?in(?: to .*)?$',
].join('|') + ')', 'i');

// Phrases in the body that only interstitials contain.
const BAD_BODY = [
  /enable javascript and cookies to continue/i,
  /checking (?:if the site connection is secure|your browser before accessing)/i,
  /cf-(?:browser-verification|challenge|chl-)/i,
  /verify(?:ing)? you are (?:a )?human/i,
  /press (?:&|and) hold to confirm/i,
  /(?:ray id|performance & security by cloudflare)/i,
];

/** Characters of real content below which a page is almost certainly a stub. */
export const TINY_BODY_CHARS = 200;

function firstHeading(body) {
  const m = /^#{1,2}[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body);
  return m ? m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim() : null;
}

/**
 * @param {string} text  a page (front matter optional)
 * @returns {null | {reason: 'interstitial'|'error-page'|'tiny-body', detail: string}}
 */
export function detectBadPage(text) {
  const { data, body } = parseFrontMatter(text);
  const heading = firstHeading(body) ?? (typeof data.title === 'string' ? data.title : null);
  const compact = body.replace(/\s+/g, '');

  if (heading && BAD_TITLE.test(heading)) {
    // A long real page can legitimately be titled "Not Found errors" etc.;
    // only trust the title when the page is short.
    if (compact.length < 3000) {
      const interstitial = /moment|verif|attention|checking|human|robot|security|captcha|one more step|ddos|new version/i.test(heading);
      return { reason: interstitial ? 'interstitial' : 'error-page', detail: `title "${heading}"` };
    }
  }
  for (const re of BAD_BODY) {
    if (re.test(body) && compact.length < 3000) return { reason: 'interstitial', detail: `body matches ${re}` };
  }
  if (compact.length < TINY_BODY_CHARS) {
    return { reason: 'tiny-body', detail: `${compact.length} non-space characters` };
  }
  return null;
}
