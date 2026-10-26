/**
 * Page conversion: everything between "we have the bytes" and "we have the
 * markdown body". Pure with respect to the network — the fetch layer supplies
 * the HTML/markdown it got, which is also what makes offline re-conversion from
 * the raw cache (and the eval) possible.
 *
 *   convertHtmlPage   rendered/raw HTML → markdown via source choice,
 *                     content extraction (+ site profile) and the converter
 *   chooseOwner       decide between owner-published markdown and our HTML
 *                     conversion of the same page
 *
 * Each stage lives in its own module and is measured on its own (eval/):
 *   extract.mjs / profile.mjs   content root + template removal
 *   markdown.mjs                DOM → GitHub-flavoured markdown
 *   owner.mjs                   trust + clean-up of site-served markdown
 */

import { chooseHtmlSource } from './extract.mjs';
import { extractPage } from './profile.mjs';
import { toMarkdown } from './markdown.mjs';
import { assessOwnerMarkdown } from './owner.mjs';

/**
 * @param {object} o
 * @param {string} o.url            final URL of the page (base for links)
 * @param {string|null} o.rendered  browser DOM, when a browser was used
 * @param {string|null} o.raw       plain HTTP body
 * @param {{url: string, html: string}[]} [o.siblings]  other pages of the same site
 * @param {string|null} [o.profilesDir]  where site profiles are kept (`<root>/_profiles`)
 * @param {Function|null} [o.llm]   (prompt, {system}) → answer; null = hand back to the agent
 * @returns {Promise<{ok: true, markdown: string, title: string|null, source: string,
 *   method: string, confidence: number, needsProfile?: object}
 *   | {ok: false, reason: string}>}
 */
/** Text of the markdown's first H1, inline markup removed. */
export function markdownTitle(md) {
  const m = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(md.replace(/^---\n[\s\S]*?\n---\s*\n/, '').replace(/^(```|~~~)[\s\S]*?^\1/gm, ''));
  if (!m) return null;
  const t = m[1]
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\s*[¶#§🔗]?\s*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(^|[^\\])(\*\*|__)(?=\S)(.+?)(?<![\s\\])\2/g, '$1$3')
    .replace(/(^|[^\w*\\])[*_](?=\S)([^*_]+?)(?<!\\)[*_](?![\w*])/g, '$1$2')
    .replace(/\\([\\`*_{}\[\]()#+\-.!|<>])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
}

export async function convertHtmlPage({ url, rendered = null, raw = null, siblings = [], profilesDir = null, llm = null, minConfidence }) {
  const src = chooseHtmlSource({ rendered, raw, url });
  if (src.source === 'fail') return { ok: false, reason: src.reason };
  const html = src.source === 'raw' ? raw : rendered;
  const res = await extractPage({ html, url, siblings, profilesDir, llm, minConfidence });
  const markdown = toMarkdown(res.roots, { baseUrl: url, title: res.title || undefined });
  if (!markdown.trim()) return { ok: false, reason: 'no content extracted' };
  return {
    ok: true,
    markdown,
    // The title as written in the page's markdown: the H1 element's textContent can
    // carry UI inside the heading (bookmark buttons and their popups, anchors).
    title: markdownTitle(markdown) || res.title || null,
    source: src.source,
    method: res.method,
    confidence: res.confidence,
    ...(res.needsProfile ? { needsProfile: res.needsProfile } : {}),
  };
}

/**
 * Owner markdown wins when the assessor trusts it; our HTML conversion of the
 * same page is the completeness reference (and the fallback).
 *
 * @returns {{use: boolean, reason?: string, markdown?: string}}
 */
export function chooseOwner({ ownerMarkdown, how, contentType, url, htmlMarkdown, title }) {
  if (!ownerMarkdown) return { use: false, reason: 'none' };
  const verdict = assessOwnerMarkdown(ownerMarkdown, {
    url,
    how,
    contentType,
    htmlText: htmlMarkdown || undefined,
    title: title || undefined,
  });
  return verdict.use ? { use: true, markdown: verdict.markdown } : { use: false, reason: verdict.reason };
}
