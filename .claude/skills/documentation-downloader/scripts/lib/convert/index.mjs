/**
 * The conversion interface the fetch pipeline (lib/fetch/pipeline.mjs) calls,
 * backed by the v2 modules:
 *   assessOwner / cleanOwner       → owner.mjs  (trust + clean site-served markdown)
 *   chooseSource / htmlToMarkdown  → extract.mjs, profile.mjs, markdown.mjs via page.mjs
 *
 * Interface (all may be sync or async; the pipeline awaits each):
 *
 *   assessOwner({ url, finalUrl, how, markdown, contentType, headers, html })
 *       → { use: boolean, reason: string }
 *     Should owner-published markdown be used instead of converting the HTML?
 *     how: 'variant' (<url>.md) | 'accept' (Accept: text/markdown) | 'direct'
 *     (the requested URL itself served markdown). html: the page's raw HTML
 *     (plain GET, redirect stubs followed) or null — for an identity check.
 *
 *   cleanOwner({ url, finalUrl, how, markdown })
 *       → { markdown: string, title: string|null }
 *     Light cleanup of accepted owner markdown (MDX residue, injected preambles).
 *     May keep upstream front matter; the store merges it.
 *
 *   chooseSource({ url, raw, rendered })
 *       raw, rendered: { html, status, finalUrl } | null (raw may also carry
 *       `requestedUrl` before rendering)
 *       → { source: 'raw'|'rendered'|'render'|null, reason: string }
 *     Which HTML to convert. Called twice at most:
 *       - with `rendered` undefined (not rendered yet): 'raw' means the plain GET
 *         is sufficient and no browser is launched; 'render' asks for a render.
 *         (Acted on unless the pipeline's sourcePolicy is 'render'; then its
 *         answer is only recorded as a measurement.)
 *       - after rendering (`rendered` null when the render failed): 'raw' or
 *         'rendered' (e.g. raw when the browser rendered an app-error page), or
 *         null when neither is usable.
 *
 *   htmlToMarkdown({ url, finalUrl, html, siblings })
 *       siblings: Array<{ url, html }> — other pages of the same site, for
 *       cross-page template detection (may be empty)
 *       → { markdown: string, title: string|null }
 *     Pure: no network, no browser. The whole page's markdown body (a leading
 *     front matter block is allowed and merged by the store).
 *
 * Site profiles (DESIGN.md "Boilerplate removal", layer 3):
 *   DD_PROFILES_DIR   where profiles live — the fetch command sets <root>/_profiles.
 *                     A saved profile for the host is always used.
 *   DD_PROFILE_LLM    haiku | sonnet | <model id> — derive a new profile with
 *                     `claude -p` when extraction is not confident. Off by default:
 *                     on the eval it was a wash (dev 98.5→98.0, test 99.6→99.8)
 *                     because model answers vary between runs.
 */

import { convertHtmlPage } from './page.mjs';
import { assessOwnerMarkdown, cleanOwnerMarkdown } from './owner.mjs';
import { chooseHtmlSource, classifyHtml } from './extract.mjs';
import { claudeCli } from './profile.mjs';

const MODELS = { haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-5-5' };

function profileOptions() {
  const dir = process.env.DD_PROFILES_DIR || null;
  const want = process.env.DD_PROFILE_LLM;
  const llm = want && want !== 'off' ? claudeCli({ model: MODELS[want] || want }) : null;
  return { profilesDir: dir, llm };
}

// assessOwner already produces the cleaned text; hand it to cleanOwner without redoing it.
const cleaned = new Map();

/** Owner markdown is judged against our own conversion of the plain-GET HTML — no browser needed. */
export async function assessOwner({ url, finalUrl, how, markdown, contentType, headers, html }) {
  let htmlText, title;
  if (html) {
    try {
      const c = await convertHtmlPage({ url: finalUrl || url, raw: html });
      if (c.ok) { htmlText = c.markdown; title = c.title; }
    } catch { /* no reference: the assessor falls back to intrinsic checks */ }
  }
  const v = assessOwnerMarkdown(markdown, { url: finalUrl || url, how, contentType, headers, htmlText, title });
  if (v.use && v.markdown) cleaned.set(markdown, v.markdown);
  return { use: !!v.use, reason: v.reason };
}

export function cleanOwner({ url, finalUrl, markdown }) {
  const md = cleaned.get(markdown) ?? cleanOwnerMarkdown(markdown, { url: finalUrl || url });
  cleaned.delete(markdown);
  const m = /^#[ \t]+(.+?)[ \t#]*$/m.exec(md);
  return { markdown: md, title: m ? m[1].trim() : null };
}

/** Server HTML with real text is enough before rendering; after rendering, broken renders fall back to it. */
/** Query parameters the server added on its way to the final URL (`?hl=pt-br`): a variant of the page, not the page. */
function addedParams(requested, final) {
  try {
    const a = new URL(requested).searchParams;
    return [...new URL(final).searchParams.keys()].filter(k => !a.has(k));
  } catch { return []; }
}

export function chooseSource({ raw, rendered }) {
  if (rendered === undefined) {
    const added = raw?.requestedUrl && raw.finalUrl ? addedParams(raw.requestedUrl, raw.finalUrl) : [];
    if (added.length) return { source: 'render', reason: `server redirected to a variant (?${added.join('&')})` };
    const c = raw ? classifyHtml(raw.html) : null;
    return c?.kind === 'ok' && c.text >= 2000
      ? { source: 'raw', reason: 'server HTML has content' }
      : { source: 'render', reason: c?.reason || (c ? `server HTML has only ${c.text} chars of text` : 'no server HTML') };
  }
  const s = chooseHtmlSource({ rendered: rendered?.html ?? null, raw: raw?.html ?? null });
  return s.source === 'fail' ? { source: null, reason: s.reason } : { source: s.source, reason: s.reason };
}

export async function htmlToMarkdown({ finalUrl, html, siblings }) {
  const c = await convertHtmlPage({ url: finalUrl, rendered: html, siblings, ...profileOptions() });
  if (!c.ok) throw new Error(c.reason);
  return { markdown: c.markdown, title: c.title };
}

export default { assessOwner, cleanOwner, chooseSource, htmlToMarkdown };
