/**
 * Redirect stubs: tiny HTML pages whose only job is to send the client
 * elsewhere, e.g. docs.pytorch.org `stable/…` →
 *
 *   <title>Redirecting…</title>
 *   <script>location.replace("../../2.14/generated/x.html" + location.hash)</script>
 *   <meta http-equiv="refresh" content="0; url=../../2.14/generated/x.html">
 *   <link rel="canonical" href="../../2.14/generated/x.html">
 *
 * A browser follows these by itself; a plain GET does not, and v1 cached the
 * stub ("Redirecting… Continue to …") as the page. The raw-GET path uses
 * `detectRedirectStub` to follow them (bounded, loop-safe) and never caches one.
 *
 * Pure and regex-based: stubs are tiny, and this runs on every raw GET, so it
 * must not parse a 30 MB real page to find out it isn't a stub.
 */

/** Visible text of an HTML document, roughly (scripts/styles/tags removed). */
export function roughText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Below this many characters of visible text a page can be a stub. */
export const STUB_MAX_TEXT = 400;

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

function decodeAttr(v) {
  return v.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'").trim();
}

function resolveTarget(raw, baseUrl) {
  if (!raw) return null;
  try {
    const u = new URL(decodeAttr(raw), baseUrl);
    if (!/^https?:$/.test(u.protocol)) return null;
    const a = new URL(baseUrl); a.hash = '';
    const b = new URL(u.href); b.hash = '';
    return a.href === b.href ? null : u.href;
  } catch {
    return null;
  }
}

/**
 * Is this HTML a redirect stub? Returns where it points, or null.
 * @param {string} html
 * @param {string} baseUrl  the URL the HTML was served from (targets resolve against it)
 * @returns {null | {target: string, how: 'meta-refresh'|'script'|'canonical'}}
 */
export function detectRedirectStub(html, baseUrl) {
  if (!html) return null;
  // A refresh inside <noscript> is the no-JS fallback of an app shell
  // (facebook.com: `?_fb_noscript=1`), not a redirect of the page.
  html = String(html).replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' ');
  const text = roughText(html);
  if (text.length > STUB_MAX_TEXT) return null;

  // <meta http-equiv="refresh" content="0; url=…"> (a short delay only: a 30 s
  // refresh on a real page is an auto-reload, not a redirect)
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/http-equiv\s*=\s*["']?refresh/i.test(tag)) continue;
    const content = attr(tag, 'content');
    if (!content) continue;
    const cm = /^\s*(\d+(?:\.\d+)?)?\s*[;,]?\s*(?:url\s*=\s*)?(['"]?)(.+?)\2\s*$/i.exec(decodeAttr(content));
    if (!cm || !cm[3] || Number(cm[1] || 0) > 5) continue;
    const target = resolveTarget(cm[3], baseUrl);
    if (target) return { target, how: 'meta-refresh' };
  }

  // location.replace("…") / location.assign('…') / location.href = "…" / window.location = "…"
  for (const s of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const code = s[1];
    const m = /\blocation(?:\.href)?\s*=\s*(["'`])([^"'`]+)\1/.exec(code)
      || /\blocation\.(?:replace|assign)\s*\(\s*(["'`])([^"'`]+)\1/.exec(code);
    if (m) {
      const target = resolveTarget(m[2], baseUrl);
      if (target) return { target, how: 'script' };
    }
  }

  // Canonical pointing elsewhere, on a page that says it is redirecting or only
  // links to that target. (Every real page has a canonical; the tiny-body gate
  // above plus this wording check keep a SPA shell from being "followed".)
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?canonical/i.test(tag)) continue;
    const target = resolveTarget(attr(tag, 'href'), baseUrl);
    if (!target) continue;
    const says = /redirect|moved|continue to|click here|if you are not/i.test(text);
    const links = [...html.matchAll(/<a\b[^>]*>/gi)]
      .map(a => resolveTarget(attr(a[0], 'href'), baseUrl)).filter(Boolean);
    if (says || (links.length > 0 && links.every(l => l === target))) return { target, how: 'canonical' };
  }
  return null;
}
