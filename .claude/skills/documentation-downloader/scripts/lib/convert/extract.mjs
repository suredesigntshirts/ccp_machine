/**
 * Content extraction: find the element(s) holding a documentation page's own
 * content and drop the site template around (and inside) them.
 *
 * Layered, generic mechanisms (DESIGN.md "Boilerplate removal"):
 *   1. semantics & statistics — ARIA landmarks, link/text density, headings;
 *   2. cross-page template — text that repeats on same-site sibling pages;
 *   3. an LLM site profile (see ./profile.mjs), used by the caller when 1–2
 *      are not confident.
 *
 * Everything here is a pure function of a parsed DOM (./dom.mjs, domino).
 * `extractContent` MUTATES the document: template found inside the chosen
 * roots is detached (and returned in `removed`), so the caller can convert the
 * roots as they are. Parse again if the untouched DOM is needed.
 */

// ─── vocabulary ────────────────────────────────────────────────────────────

/** Never text: their contents are code/data/graphics, not page words. */
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'head', 'link', 'meta']);
const HEADING = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** Interactive/UI controls: their text is UI, not content (tabs are the exception). */
const UI_TAGS = new Set(['button', 'select', 'option', 'input', 'textarea', 'dialog', 'menu']);
const TEMPLATE_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'dialog', 'alertdialog', 'menu', 'menubar', 'toolbar', 'tooltip']);
/** Class/id words used for template regions across generators (Readability-style). */
// Print-only blocks (Jupyter Book's `onlyprint`, Bootstrap's `visible-print-*`) repeat the
// page's title and contents for paper; screen CSS hides them.
const NEG_WORDS = String.raw`onlyprint|only-print|print-?only|visible-print(?:-block|-inline)?|nav|navbar|navigation|menu|menubar|sidebar|side-bar|sidenav|toc|breadcrumbs?|crumbs?|footer|masthead|banner|cookies?|consent|gdpr|pagination|pager|prev-next|feedback|rating|helpful|share|sharing|social|related|edit-?page|edit-?link|skip-?link|announcement|promo|newsletter|subscribe|search|searchbox|header|topbar|top-bar|toolbar|copy-?page|page-?actions|ask-?ai|version-?switcher|language-?switcher|lang-?switcher|theme-?toggle`;
const NEG_RE = new RegExp(String.raw`(?:^|[\s_-])(?:${NEG_WORDS})(?=$|[\s_-])`, 'i');
/** Words that name a content container. */
const POS_RE = /(?:^|[\s_-])(?:content|main|main-content|article|article-body|articlebody|markdown|markdown-body|prose|doc|docs|doc-content|documentation|post|entry|body|page-body|md-content|rst-content|theme-doc-markdown)(?=$|[\s_-])/i;
/** Short UI strings that are never content on their own. */
const UI_TEXT_RE = /^(?:copy|copied!?|copy code|copy page|copy link|copy for llms?|copy as markdown|view as markdown|view markdown|open in (?:chatgpt|claude|cursor)|ask ai|edit this page|edit on github|edit page|suggest (?:an? )?edits?|suggest changes(?: to this page)?|report an issue|raise issue|rate this page|thanks for (?:your )?feedback!?|send feedback|give feedback|share|print|on this page|in this article|table of contents|previous|next|prev|back to top|scroll to top|skip to (?:main )?content|(?:last )?updated(?: on)?:? .{0,30}\d{4}.{0,10}|reload|fork|show more|show less|toggle navigation|try it in your browser!?|open in tab|go back)$/i;

const tagOf = (el) => (el.localName || el.nodeName || '').toLowerCase();
const collapse = (s) => s.replace(/\s+/g, ' ').trim();

function classAndId(el) {
  const c = el.getAttribute('class') || '';
  const i = el.getAttribute('id') || '';
  return i ? `${c} ${i}` : c;
}

/** ARIA-in-HTML: header/footer/aside are landmarks only when scoped to the body. */
function scopedToBody(el) {
  for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) {
    const t = tagOf(p);
    if (t === 'article' || t === 'aside' || t === 'main' || t === 'nav' || t === 'section') return false;
    const r = p.getAttribute('role');
    if (r === 'main' || r === 'article') return false;
  }
  return true;
}

/** Inside a table data/header cell (not crossing into another table's boundary). */
export function inTableCell(el) {
  for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) {
    const t = tagOf(p);
    if (t === 'td' || t === 'th') return true;
    if (t === 'table' || t === 'body') return false;
  }
  return false;
}

/** Why an element is template by its own markup (null when it is not). */
function templateMark(el) {
  const t = tagOf(el);
  const role = (el.getAttribute('role') || '').toLowerCase();
  if (role === 'tab' || role === 'tablist' || role === 'tabpanel') return null;
  if (role && TEMPLATE_ROLES.has(role)) return `role=${role}`;
  if (t === 'nav') return 'nav';
  // A button that is a table cell's content (interactive data tables: compatibility,
  // pricing matrices) carries data, not a UI label.
  if (UI_TAGS.has(t)) return t === 'button' && inTableCell(el) ? null : t;
  if ((t === 'header' || t === 'footer' || t === 'aside') && scopedToBody(el)) return t;
  const ci = classAndId(el);
  if (ci && NEG_RE.test(ci)) return 'class';
  // custom elements name themselves (devsite-content-footer, site-header, docs-toc)
  if (t.includes('-') && (NEG_RE.test(t) || /(?:^|-)(?:tooltip|popout|popover)(?:$|-)/.test(t))) return 'custom-tag';
  const label = (el.getAttribute('aria-label') || '').toLowerCase();
  if (label && /breadcrumb|table of contents|on this page|pagination|navigation|sidebar|footer/.test(label)) return 'aria-label';
  return null;
}

// ─── statistics pass ───────────────────────────────────────────────────────

/**
 * One walk over the body. Per element (by index): text chars, link chars,
 * "good" chars (not in a link, not in template markup, not cross-page template),
 * template-marked chars, cross-page repeated chars, headings, <pre>, punctuation.
 */
class Stats {
  constructor() {
    this.els = [];
    this.text = []; this.link = []; this.good = []; this.bad = []; this.rep = [];
    this.heads = []; this.pres = []; this.punct = []; this.count = []; this.parent = [];
  }
  idx(el) { return el.__ddi; }
}

function computeStats(body, opts = {}) {
  const st = walkStats(body, opts, null);
  // A template mark on an element that holds most of the page (a wrapper named
  // "has-sidebar", a <header> around everything) is wrong: veto it and walk again.
  const veto = new Set();
  const total = st.text[0];
  for (let i = 1; i < st.els.length; i++) {
    if (st.els[i].__ddmark && st.text[i] >= 0.5 * total && total > 0) veto.add(st.els[i]);
  }
  if (!veto.size) return st;
  for (const el of st.els) el.__ddmark = undefined;
  return walkStats(body, opts, veto);
}

function walkStats(body, { h1 = null, repeated = null, badMarks = true, protect = null } = {}, veto) {
  const st = new Stats();
  // never mark the title heading's or the main landmark's ancestors as template
  const keep = new Set();
  for (const x of [h1, ...(protect || [])]) for (let p = x; p; p = p.parentNode) keep.add(p);
  const walk = (el, parentIdx, inLink, inBad, inPre) => {
    const i = st.els.length;
    el.__ddi = i;
    el.__ddmark = undefined;
    st.els.push(el); st.parent.push(parentIdx);
    st.text.push(0); st.link.push(0); st.good.push(0); st.bad.push(0); st.rep.push(0);
    st.heads.push(0); st.pres.push(0); st.punct.push(0); st.count.push(1);
    const t = tagOf(el);
    if (t === 'a' && el.hasAttribute('href')) inLink = true;
    if (t === 'pre') { inPre = true; st.pres[i] = 1; }
    if (HEADING.has(t)) st.heads[i] = 1;
    let mark = null;
    if (!inBad && badMarks && !keep.has(el) && !(veto && veto.has(el))) mark = templateMark(el);
    if (mark) { el.__ddmark = mark; inBad = true; }
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        const raw = c.data;
        if (!raw) continue;
        const s = collapse(raw);
        const n = s.length;
        if (!n) continue;
        st.text[i] += n;
        if (inLink) st.link[i] += n;
        if (inBad) st.bad[i] += n;
        let r = false;
        if (repeated && !inPre && n >= 3 && repeated.has(s.toLowerCase())) { st.rep[i] += n; r = true; }
        if (!inLink && !inBad && !r) st.good[i] += n;
        const p = s.match(/[.,;:!?](?=\s|$)/g);
        if (p) st.punct[i] += p.length;
      } else if (c.nodeType === 1) {
        const ct = tagOf(c);
        if (SKIP.has(ct)) continue;
        const j = walk(c, i, inLink, inBad, inPre);
        st.text[i] += st.text[j]; st.link[i] += st.link[j]; st.good[i] += st.good[j];
        st.bad[i] += st.bad[j]; st.rep[i] += st.rep[j];
        st.heads[i] += st.heads[j]; st.pres[i] += st.pres[j]; st.punct[i] += st.punct[j];
        st.count[i] += st.count[j];
      }
    }
    return i;
  };
  walk(body, -1, false, false, false);
  return st;
}

function containsFast(a, b) {
  for (let p = b; p; p = p.parentNode) if (p === a) return true;
  return false;
}

// ─── title ─────────────────────────────────────────────────────────────────

function docTitleCandidates(doc) {
  const out = [];
  const t = doc.querySelector('title');
  if (t) out.push(collapse(t.textContent));
  for (const sel of ['meta[property="og:title"]', 'meta[name="twitter:title"]']) {
    const m = doc.querySelector(sel);
    if (m?.getAttribute('content')) out.push(collapse(m.getAttribute('content')));
  }
  return out.filter(Boolean);
}

const words = (s) => s.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);

/** The page's title heading: the <h1> that best matches <title>/og:title; else the first sensible one. */
export function findTitleHeading(doc) {
  const body = doc.body || doc.documentElement;
  const h1s = Array.from(body.querySelectorAll('h1')).filter(h => collapse(h.textContent).length > 0);
  const titles = docTitleCandidates(doc);
  if (!h1s.length) return { el: null, text: titles[0] || null };
  let best = null, bestScore = -Infinity;
  h1s.forEach((h, k) => {
    const ht = collapse(h.textContent);
    const hw = new Set(words(ht));
    let s = 0;
    for (const t of titles) {
      const tw = new Set(words(t));
      if (!tw.size || !hw.size) continue;
      let hit = 0;
      for (const w of hw) if (tw.has(w)) hit++;
      // most of the heading's words are in the title (titles add " | Site"); the more
      // of the title it covers the better (a logo h1 matches only the site-name part)
      const v = hit / hw.size + 0.3 * hit / tw.size + (t.toLowerCase().startsWith(ht.toLowerCase().slice(0, 40)) ? 0.1 : 0);
      s = Math.max(s, v);
    }
    // inside template markup (logo h1 in a header or sidebar) → weaker
    let inTpl = false;
    for (let p = h.parentNode; p && p.nodeType === 1 && tagOf(p) !== 'body'; p = p.parentNode) {
      const t = tagOf(p);
      if (t === 'main' || t === 'article' || p.getAttribute('role') === 'main') break;
      if (templateMark(p)) { inTpl = true; break; }
    }
    const score = s - (inTpl ? 0.5 : 0) - k * 0.001;
    if (score > bestScore) { bestScore = score; best = h; }
  });
  return { el: best, text: collapse(best.textContent) };
}

// ─── candidate scoring ─────────────────────────────────────────────────────

export const PARAMS = {
  LINK_W: 0.6,        // link text inside a candidate costs this much per char
  LINK_W_MAIN: 0,     // … inside the page's main landmark (link lists there are usually content)
  BAD_W: 1.0,         // template-marked text inside a candidate
  REP_W: 1.0,         // text repeated on sibling pages
  MAIN_MIN_GOOD: 0.3, // the main landmark must hold this share of the page's good text to be trusted
  TITLE_DESCEND: 0.95, // move the root down toward the title while the child keeps this share of good text
  REP_PRUNE_MIN: 30,  // prune a block inside the root when ≥ this many chars …
  REP_PRUNE_SHARE: 0.85, // … and this share of them repeat on sibling pages
  REP_PRUNE_MAX_SHARE: 0.3, // … but never a block this big a share of the root: template inside a
                            // content root is small (breadcrumbs, pagers); a big repeated block is
                            // content the siblings share (a section's link list, generated API text)
  REP_EDGE_SHARE: 0.1,      // … and only at the root's edges: < this share of its good text before or after
  REP_ROOT_MIN_KEEP: 0.6,   // siblings may narrow the root below this share of the no-sibling root…
  REP_ROOT_MAX_LD: 0.3,     // …only when what they cut is link-dense (navigation), not prose
};
// Experiments: DD_EXTRACT_PARAMS='{"LINK_W_MAIN":0.1}'
if (typeof process !== 'undefined' && process.env?.DD_EXTRACT_PARAMS) Object.assign(PARAMS, JSON.parse(process.env.DD_EXTRACT_PARAMS));

function isAncestorIdx(st, a, i) {
  for (let k = i; k >= 0; k = st.parent[k]) if (k === a) return true;
  return false;
}

function score(st, i, scope) {
  const nonLinkBad = st.bad[i] - Math.min(st.bad[i], st.link[i]);
  const lw = scope && isAncestorIdx(st, scope.idx, i) ? PARAMS.LINK_W_MAIN : PARAMS.LINK_W;
  return st.good[i] - lw * st.link[i] - PARAMS.BAD_W * nonLinkBad - PARAMS.REP_W * st.rep[i];
}

/**
 * The page's main landmark (<main> / role=main), when there is exactly one and it
 * holds a fair share of the page's non-template text. Content roots are then
 * searched inside it only (on the corpus the gold root is inside it on every page).
 * One that holds the title heading is accepted whatever its share of the text.
 */
function mainLandmark(st, h1 = null) {
  const found = [];
  for (let i = 0; i < st.els.length; i++) {
    const el = st.els[i];
    if (tagOf(el) === 'main' || el.getAttribute('role') === 'main') found.push(i);
  }
  // nested mains (a role=main inside <main>) → the outermost
  const outer = found.filter(i => !found.some(j => j !== i && isAncestorIdx(st, j, i)));
  if (outer.length !== 1) return null;
  const idx = outer[0];
  // A <main> holding the page's title is the content landmark however much text the
  // sidebars and footers around it carry (an index page: an intro and a link list).
  if (st.good[idx] < PARAMS.MAIN_MIN_GOOD * st.good[0] && !(h1 && containsFast(st.els[idx], h1))) return null;
  return { idx };
}

/** Best-scoring element; ties → the outermost (stable across pages). */
function bestCandidate(st, scope) {
  let best = scope ? scope.idx : 0, bestS = -Infinity;
  const lo = scope ? scope.idx : 0;
  const hi = scope ? scope.idx + st.count[scope.idx] : st.els.length; // pre-order: subtree is contiguous
  for (let i = lo; i < hi; i++) {
    if (st.good[i] < 20) continue;
    const s = score(st, i, scope);
    if (s > bestS + 1e-9) { bestS = s; best = i; }
  }
  // Climb while the parent scores the same (a wrapper adding nothing).
  let i = best;
  while (st.parent[i] > 0 && i !== lo && score(st, st.parent[i], scope) >= score(st, i, scope) - 1e-9) i = st.parent[i];
  return i;
}

// ─── pruning inside roots ──────────────────────────────────────────────────

function isTabThing(el) {
  const role = el.getAttribute('role');
  if (role === 'tab' || role === 'tablist' || role === 'tabpanel') return true;
  for (let p = el.parentNode, d = 0; p && p.nodeType === 1 && d < 3; p = p.parentNode, d++) {
    if (p.getAttribute('role') === 'tablist') return true;
  }
  return false;
}

/**
 * Template inside a root: landmarks/UI/negative-class blocks that are small
 * relative to the root, short UI strings, and (with siblings) blocks whose text
 * repeats across the site.
 */
function pruneRoot(root, st, rootIdx, h1, removed, signals) {
  const rootText = st.text[rootIdx] || 1;
  const ai = aiBlocks(root, st, rootText);
  const edge = edgeTest(st, rootIdx);
  const visit = (el) => {
    for (let c = el.firstElementChild; c; ) {
      const next = c.nextElementSibling;
      let why = ai.has(c) ? 'ai-summary' : pruneReason(c, st, rootText, h1);
      // Template inside a content root wraps the content (breadcrumbs, pagers,
      // feedback): text the siblings share that sits between content blocks is
      // content the pages share (a recurring tip, a common parameter note).
      if (why === 'repeated' && c.__ddi !== undefined && !edge(c.__ddi)) why = null;
      if (why) {
        removed.push(c);
        signals.pruned[why] = (signals.pruned[why] || 0) + 1;
        c.parentNode.removeChild(c);
      } else if (!SKIP.has(tagOf(c))) {
        visit(c);
      }
      c = next;
    }
  };
  visit(root);
}

/**
 * (i) → is element i at an edge of the root: less than EDGE_SHARE of the root's
 * good text before it, or after it? Pre-order indices make each subtree a
 * contiguous range, so this is two prefix-sum lookups.
 */
function edgeTest(st, r) {
  const end = r + st.count[r];
  const own = new Float64Array(end - r);
  for (let j = r; j < end; j++) {
    own[j - r] += st.good[j];
    const p = st.parent[j];
    if (j !== r && p >= r) own[p - r] -= st.good[j];
  }
  const prefix = new Float64Array(end - r + 1);
  for (let j = 0; j < own.length; j++) prefix[j + 1] = prefix[j] + own[j];
  const total = prefix[own.length] || 1;
  const lim = PARAMS.REP_EDGE_SHARE * total;
  return (i) => prefix[i - r] < lim || total - prefix[i - r + st.count[i]] < lim;
}

/** Table cells, list items, definitions, code: a "Yes"/"Close"/"Next" there is content. */
const STRUCTURAL = new Set(['td', 'th', 'tr', 'li', 'dt', 'dd', 'code', 'pre', 'kbd', 'samp', 'var', 'caption']);
function insideStructural(el) {
  for (let p = el.parentNode, d = 0; p && p.nodeType === 1 && d < 6; p = p.parentNode, d++) {
    const t = tagOf(p);
    if (t === 'table' || t === 'pre' || t === 'code' || t === 'dl') return true;
  }
  return false;
}
const FEEDBACK_RE = /^(?:was|is|did|how) (?:this|the) (?:page|article|doc(?:ument(?:ation)?)?|content|section|information|guide|tutorial|answer)? ?(?:helpful|useful|help(?:ful)? you|clear)\b.{0,90}$/i;
const AI_RE = /\b(?:generated (?:with|by|using) (?:ai|an? (?:llm|language model))|ai[- ]generated|ai summary)\b/i;

const AI_ATTRS = ['title', 'aria-label', 'data-tooltip', 'aria-description', 'data-title'];

/**
 * Blocks whose own markup says they are AI-generated (summary panels): not the
 * page's words. The note sits on the block or on its heading; the block is the
 * highest ancestor below the root that is still small.
 */
function aiBlocks(root, st, rootText) {
  const out = new Set();
  const cands = root.querySelectorAll(AI_ATTRS.map(a => `[${a}]`).join(', '));
  const limit = Math.min(3000, 0.3 * rootText);
  for (let k = 0; k < cands.length; k++) {
    const e = cands[k];
    if (!AI_ATTRS.some(a => AI_RE.test(e.getAttribute(a) || ''))) continue;
    let block = e;
    for (let p = e.parentNode; p && p !== root && p.nodeType === 1; p = p.parentNode) {
      const i = p.__ddi;
      if (i === undefined || st.text[i] > limit) break;
      block = p;
    }
    out.add(block);
  }
  return out;
}

function pruneReason(el, st, rootText, h1) {
  const i = el.__ddi;
  if (i === undefined) return null;
  if (el === h1 || (h1 && containsFast(el, h1))) return null;
  const t = tagOf(el);
  if (t === 'pre' || t === 'code' || t === 'table' || HEADING.has(t)) return null;
  if (isTabThing(el)) return null;
  const text = st.text[i];
  const share = text / rootText;
  const ld = text ? st.link[i] / text : 0;
  const mark = templateMark(el);
  if (mark && share < 0.25 && t !== 'summary') {
    if (mark === 'class' || mark === 'header' || mark === 'footer' || mark === 'aside') {
      // a named/landmark block with code, prose, or a content heading is content
      if (st.pres[i] > 0) return null;
      if (ld < 0.3 && st.punct[i] >= 4 && share > 0.02) return null;
      if (st.heads[i] > 0 && ld < 0.5 && mark !== 'aside') return null;
    }
    return mark;
  }
  if (t === 'label' && (el.hasAttribute('for') || el.querySelector('select, input, textarea'))) return 'label';
  if (text <= 120 && st.pres[i] === 0 && !STRUCTURAL.has(t) && !insideStructural(el)) {
    const s = collapse(el.textContent);
    if (s && text <= 60 && UI_TEXT_RE.test(s)) return 'ui-text';
    if (s && FEEDBACK_RE.test(s)) return 'feedback';
  }
  // cross-page: a block whose text is (almost) all repeated on sibling pages
  if (text >= PARAMS.REP_PRUNE_MIN && st.rep[i] >= PARAMS.REP_PRUNE_SHARE * text && st.pres[i] === 0 && st.heads[i] === 0
      && share < PARAMS.REP_PRUNE_MAX_SHARE) return 'repeated';
  return null;
}

// ─── cross-page template ───────────────────────────────────────────────────

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k in ENT) return ENT[k];
    try {
      if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
    } catch { /* fallthrough */ }
    return m;
  });
}

/**
 * Text pieces of an HTML string (text between tags, scripts/styles dropped),
 * without building a DOM — cheap enough to run over several sibling pages.
 */
export function htmlTextPieces(html) {
  const out = new Set();
  const s = html.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  for (const piece of s.split(/<[^>]*>/)) {
    const t = collapse(decodeEntities(piece));
    if (t.length >= 3) out.add(t.toLowerCase());
  }
  return out;
}

/**
 * Text pieces occurring on at least `minPages` of the sibling pages (default:
 * one when there are ≤2 siblings, else two).
 */
export function repeatedPieces(siblings, { minPages } = {}) {
  const sibs = (siblings || []).filter(s => s && s.html);
  if (!sibs.length) return null;
  const need = minPages || (sibs.length <= 2 ? 1 : 2);
  const counts = new Map();
  for (const s of sibs.slice(0, 5)) {
    for (const p of htmlTextPieces(s.html)) counts.set(p, (counts.get(p) || 0) + 1);
  }
  const rep = new Set();
  for (const [p, n] of counts) if (n >= need) rep.add(p);
  return rep;
}

/** Pieces long enough to be sentences of content (templates are mostly short labels). */
const SAME_DOC_MIN_CHARS = 60;
const SAME_DOC_SHARE = 0.5;
function sameDocumentPieces(body) {
  const out = new Set();
  const walk = (n) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        const t = collapse(c.data || '');
        if (t.length >= SAME_DOC_MIN_CHARS) out.add(t.toLowerCase());
      } else if (c.nodeType === 1 && !/^(?:script|style|noscript|template|svg)$/.test(tagOf(c))) walk(c);
    }
  };
  walk(body);
  return out.size >= 3 ? out : null;
}
function isSameDocument(own, html) {
  if (!html) return false;
  const theirs = htmlTextPieces(html);
  let shared = 0;
  for (const p of own) if (theirs.has(p)) shared++;
  return shared >= SAME_DOC_SHARE * own.size;
}

// ─── public API ────────────────────────────────────────────────────────────

/**
 * @param {Document} doc  parsed with ./dom.mjs (mutated: template inside roots is detached)
 * @param {object} [opts]
 * @param {string} [opts.url]
 * @param {{url:string, html:string}[]} [opts.siblings]  same-site pages (raw or rendered HTML)
 * @param {{contentSelectors:string[], removeSelectors?:string[], titleSelector?:string}|null} [opts.profile]
 * @returns {{roots: Element[], title: string|null, confidence: number, method: string,
 *            removed: Element[], signals: object}}
 */
export function extractContent(doc, opts = {}) {
  const t0 = Date.now();
  const body = doc.body || doc.documentElement;
  const signals = { pruned: {} };
  const removed = [];
  const { el: h1, text: titleText } = findTitleHeading(doc);

  // A "sibling" holding most of this page's sentences is this page under another URL
  // (an alias, a redirect twin): everything would look repeated and real sections at
  // the root's edges would be pruned as template. Such copies are not siblings.
  let sibs = opts.siblings?.length ? opts.siblings : null;
  if (sibs) {
    const own = sameDocumentPieces(body);
    const kept = own ? sibs.filter(sb => !isSameDocument(own, sb?.html)) : sibs;
    signals.sameDocumentSiblings = sibs.length - kept.length;
    sibs = kept.length ? kept : null;
  }
  let repeated = sibs ? repeatedPieces(sibs) : null;
  signals.siblings = sibs?.length || 0;

  if (opts.profile) {
    const r = applyProfile(doc, opts.profile, { h1 });
    if (r.ok) {
      // the generic in-root pruning still applies inside a profile's roots
      const st = computeStats(body, { h1, repeated, protect: r.roots });
      for (const root of r.roots) if (root.__ddi !== undefined && root !== h1) pruneRoot(root, st, root.__ddi, h1, r.removed, signals);
      signals.ms = Date.now() - t0;
      signals.profile = r.checks;
      return { roots: r.roots, title: r.title || titleText, confidence: 0.9, method: 'profile', removed: r.removed, signals };
    }
    // caller decides whether to re-derive; we fall through to the heuristics
    signals.profileFailure = r.reason;
  }

  const protect = Array.from(body.querySelectorAll('main, [role=main]'));
  const pickRoot = (st) => {
    const scope = mainLandmark(st, h1);
    const best = bestCandidate(st, scope);
    return { scope, best, ri: descendTowardTitle(st, best, h1, {}) };
  };
  let st = computeStats(body, { h1, repeated, protect });
  let pick = pickRoot(st);
  if (repeated) {
    // Pages built from one template share real text too (generated API reference,
    // a section's link list). If the siblings made the root much smaller and what
    // they cut is prose rather than navigation, they are wrong about this page.
    const st0 = computeStats(body, { h1, repeated: null, protect });
    const p0 = pickRoot(st0);
    // Same for a root narrowed to a part without the page's title (an index page
    // whose content is the section's link list — the siblings' sidebar).
    const cut = st0.text[p0.ri] - st.text[pick.ri];
    const cutLinks = st0.link[p0.ri] - st0.link[pick.ri];
    const r0 = st0.els[p0.ri], r1 = st.els[pick.ri];
    const lostTitle = h1 && containsFast(r0, h1) && !containsFast(r1, h1);
    // …or moved it elsewhere altogether (a sidebar box) away from the title.
    const movedAway = lostTitle && !containsFast(r0, r1) && !containsFast(r1, r0);
    // …or cut whole sections: headings the page alone keeps (reference pages built from
    // one template share their section skeleton — "Reading", "Creating: You can't
    // perform this operation" — which is the page's content, not the site's chrome).
    const inner = containsFast(r0, r1) && r1.__ddi !== undefined && st0.els[r1.__ddi] === r1 ? r1.__ddi : null;
    const lostHeads = inner === null ? 0
      : st0.heads[p0.ri] - st0.heads[inner] - (h1 && containsFast(r0, h1) && !containsFast(r1, h1) ? 1 : 0);
    const cutSections = lostHeads > 0 && cut > 0 && cutLinks / cut < PARAMS.REP_ROOT_MAX_LD;
    if (movedAway || cutSections || (st.text[pick.ri] < PARAMS.REP_ROOT_MIN_KEEP * st0.text[p0.ri] && cut > 0
        && (cutLinks / cut < PARAMS.REP_ROOT_MAX_LD || (lostTitle && containsFast(r0, r1))))) {
      signals.siblingsOverruled = `root ${st.text[pick.ri]} vs ${st0.text[p0.ri]} chars without siblings; ` +
        (movedAway ? 'moved away from the title' : cutSections ? `cut ${lostHeads} section heading(s)`
          : lostTitle ? 'narrowed past the title' : `cut text link density ${(cutLinks / cut).toFixed(2)}`);
      repeated = null;
      st = st0;
      pick = p0;
    }
  }
  const scope = pick.scope;
  signals.main = scope ? describe(st.els[scope.idx]) : null;
  signals.best = describe(st.els[pick.best]);
  let ri = descendTowardTitle(st, pick.best, h1, signals);
  const root = st.els[ri];
  signals.root = describe(root);
  signals.pageText = st.text[0];
  signals.rootText = st.text[ri];
  signals.rootGoodShare = st.good[0] ? st.good[ri] / st.good[0] : 0;
  signals.rootLinkDensity = st.text[ri] ? st.link[ri] / st.text[ri] : 0;
  signals.rootSemantic = semanticKind(root);
  signals.titleBranchShare = titleBranchShare(st, ri, h1);
  signals.rootRepShare = st.text[ri] ? st.rep[ri] / st.text[ri] : 0;

  const roots = [root];
  // Title heading outside the root: pull in its header block (title, subtitle) or just the
  // heading — it belongs to the page, not the template.
  if (h1 && !containsFast(root, h1) && !containsFast(h1, root)) {
    const hb = titleBlock(st, h1, ri);
    roots.unshift(hb);
    signals.h1Outside = hb === h1 ? 'h1' : describe(hb);
    if (hb !== h1) pruneRoot(hb, st, hb.__ddi, h1, removed, signals);
  }
  pruneRoot(root, st, ri, h1, removed, signals);
  signals.h1 = !!h1;
  const confidence = scoreConfidence(signals, st, ri);
  signals.ms = Date.now() - t0;
  return { roots: orderRoots(roots), title: titleText, confidence, method: repeated ? 'stats+siblings' : 'stats', removed, signals };
}

/**
 * Content starts at the title: when the chosen root contains the title heading and
 * the child on the way to it holds (nearly) all of the root's text, that child is
 * the root — what sits beside it (promo boxes, version banners, repo chrome) is not.
 */
function descendTowardTitle(st, ri, h1, signals) {
  if (!h1 || !containsFast(st.els[ri], h1)) return ri;
  const good = st.good[ri];
  const path = [];
  for (let p = h1.parentNode; p && p !== st.els[ri]; p = p.parentNode) path.unshift(p);
  let cur = ri;
  for (const el of path) {
    const i = el.__ddi;
    if (i === undefined) break;
    if (st.good[i] < PARAMS.TITLE_DESCEND * good) break;
    cur = i;
  }
  if (cur !== ri) signals.descended = true;
  return cur;
}

/**
 * Share of the root's good text in the root's child that leads to the title
 * heading (1 when the title is outside the root or is a direct child). Low values
 * mean the root holds big blocks beside the title's branch — either content split
 * across siblings (MDN header/body) or template beside it (arXiv side panels).
 */
function titleBranchShare(st, ri, h1) {
  const root = st.els[ri];
  if (!h1 || !containsFast(root, h1) || h1.parentNode === root) return 1;
  let c = h1;
  while (c.parentNode && c.parentNode !== root) c = c.parentNode;
  const i = c.__ddi;
  return i === undefined || !st.good[ri] ? 1 : st.good[i] / st.good[ri];
}

/** The title heading's own block (title + subtitle/description) when it sits outside the root. */
function titleBlock(st, h1, ri) {
  const root = st.els[ri];
  // lowest common ancestor of the heading and the root
  const anc = new Set();
  for (let p = root; p; p = p.parentNode) anc.add(p);
  let child = h1;
  for (let p = h1.parentNode; p && !anc.has(p); p = p.parentNode) child = p;
  if (child === h1) return h1;
  const i = child.__ddi;
  if (i === undefined) return h1;
  const text = st.text[i];
  const small = text <= Math.max(600, 0.15 * st.text[ri]);
  const linky = text && st.link[i] / text >= 0.5;
  // header blocks come before the content
  const before = child.compareDocumentPosition(root) & 4;
  return small && !linky && before ? child : h1;
}

function orderRoots(roots) {
  // document order, no nesting
  const uniq = roots.filter((r, i) => !roots.some((o, j) => j !== i && o !== r && containsFast(o, r)));
  return uniq.sort((a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1));
}

function semanticKind(el) {
  const t = tagOf(el);
  if (t === 'main' || el.getAttribute('role') === 'main') return 'main';
  if (t === 'article') return 'article';
  if (POS_RE.test(classAndId(el))) return 'named';
  return null;
}

/**
 * How much to trust layers 1–2 on this page (0..1). Each doubt lowers it; below
 * DEFAULT_MIN_CONFIDENCE (profile.mjs) the pipeline asks for a site profile.
 */
function scoreConfidence(sig, st, ri) {
  let c = 0.9;
  const doubts = [];
  const doubt = (w, why) => { c -= w; doubts.push(why); };
  if (!sig.siblings) doubt(0.15, 'no sibling pages: cross-page template detection did not run');
  if (!sig.rootSemantic) doubt(0.1, 'root is not a main/article/content-named element');
  // big blocks beside the title's branch: split content, or template next to it
  if (sig.titleBranchShare >= 0.2 && sig.titleBranchShare <= 0.7) doubt(0.25, `title branch holds only ${Math.round(100 * sig.titleBranchShare)}% of the root`);
  if (sig.rootLinkDensity > 0.4) doubt(0.2, `root is ${Math.round(100 * sig.rootLinkDensity)}% link text`);
  if (sig.rootGoodShare < 0.6) doubt(0.2, `root holds ${Math.round(100 * sig.rootGoodShare)}% of the page's content-like text`);
  if (st.text[ri] < 400) doubt(0.3, `root is tiny (${st.text[ri]} chars)`);
  if (!sig.h1) doubt(0.2, 'no title heading');
  sig.doubts = doubts;
  return Math.max(0, Math.min(1, c));
}

// ─── DOM skeleton (for the LLM profile step and for debugging) ────────────

const fmtN = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * A compact outline of the page's element tree: one line per significant element
 * (tag#id.classes[role], text chars, link-text share, headings/pre counts, a
 * short text sample), single-child wrapper chains collapsed, runs of similar
 * siblings summarised. Never raw HTML; bounded by `maxLines` whatever the page size.
 */
export function buildSkeleton(doc, { maxLines = 180, minShare = 0.004, sample = 60, stats = null } = {}) {
  const body = doc.body || doc.documentElement;
  const { el: h1 } = findTitleHeading(doc);
  const st = stats || computeStats(body, { h1 });
  const total = st.text[0] || 1;
  const minText = Math.max(40, total * minShare);
  const lines = [];
  const sig = (el) => {
    const i = el.__ddi;
    if (i === undefined) return false;
    const t = tagOf(el);
    return st.text[i] >= minText || el === h1 || (el.__ddmark && st.text[i] >= 20) || (t === 'main' || t === 'article') || (h1 && containsFast(el, h1));
  };
  const sampleOf = (el) => {
    // first `sample` chars of the element's text, with block boundaries as spaces (bounded walk)
    let out = '';
    const walk = (n) => {
      if (out.length > sample + 20) return;
      if (n.nodeType === 3) { out += n.data; return; }
      if (n.nodeType !== 1 || SKIP.has(tagOf(n))) return;
      const b = BLOCK_TAGS.has(tagOf(n));
      if (b) out += ' ';
      for (let c = n.firstChild; c && out.length <= sample + 20; c = c.nextSibling) walk(c);
      if (b) out += ' ';
    };
    walk(el);
    const s = collapse(out);
    return s.length > sample ? JSON.stringify(s.slice(0, sample) + '…') : JSON.stringify(s);
  };
  const line = (el, path, depth) => {
    const i = el.__ddi;
    const bits = [`${'  '.repeat(depth)}${path}`, `text=${fmtN(st.text[i])}`];
    if (st.text[i]) bits.push(`links=${Math.round(100 * st.link[i] / st.text[i])}%`);
    if (st.heads[i]) bits.push(`h=${st.heads[i]}`);
    if (st.pres[i]) bits.push(`pre=${st.pres[i]}`);
    if (el === h1) bits.push('[TITLE H1]');
    else if (h1 && containsFast(el, h1)) bits.push('[has title H1]');
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') bits.push('[hidden]');
    bits.push(sampleOf(el));
    lines.push(bits.join(' '));
  };
  const visit = (el, depth) => {
    if (lines.length >= maxLines) return;
    // collapse wrapper chains: el > only-significant-child with ~all of el's text
    const chain = [el];
    let cur = el;
    for (;;) {
      const kids = [];
      for (let c = cur.firstElementChild; c; c = c.nextElementSibling) if (sig(c)) kids.push(c);
      if (kids.length === 1 && cur !== h1 && st.text[kids[0].__ddi] >= 0.97 * st.text[cur.__ddi] && kids[0] !== h1 && !(h1 && cur === h1.parentNode)) {
        cur = kids[0];
        chain.push(cur);
        continue;
      }
      break;
    }
    // long wrapper chains: keep the ends (and any named/landmark element in between)
    const shown = chain.length <= 4 ? chain
      : chain.filter((e, k) => k === 0 || k >= chain.length - 2 || semanticKind(e) === 'main' || semanticKind(e) === 'article' || e.getAttribute('id'));
    const path = shown.map((e, k) => (k > 0 && chain.indexOf(e) !== chain.indexOf(shown[k - 1]) + 1 ? '… > ' : '') + describeForSelector(e)).join(' > ');
    line(cur, path, depth);
    if (cur === h1) return;
    // don't expand navigation-like blocks: one line says enough
    const ci = cur.__ddi;
    if (st.text[ci] && st.link[ci] / st.text[ci] >= 0.85 && depth > 0) return;
    // leaf-like blocks: their inside (code tokens, table cells, inline markup) says nothing about layout
    if (LEAFY.has(tagOf(cur))) return;
    let kids = [];
    let kidText = 0;
    for (let c = cur.firstElementChild; c; c = c.nextElementSibling) if (sig(c)) { kids.push(c); kidText += st.text[c.__ddi]; }
    // a big element made of many small blocks: show its children anyway (runs get summarised)
    if (kidText < 0.5 * st.text[ci] && st.text[ci] >= 4 * minText) {
      kids = [];
      for (let c = cur.firstElementChild; c; c = c.nextElementSibling) if (c.__ddi !== undefined && st.text[c.__ddi] > 0) kids.push(c);
    }
    let k = 0;
    while (k < kids.length && lines.length < maxLines) {
      // runs of same-shaped siblings: show 2, summarise the rest
      let j = k + 1;
      const shape = (e) => `${tagOf(e)}.${(e.getAttribute('class') || '').split(/\s+/).slice(0, 2).join('.')}`;
      while (j < kids.length && shape(kids[j]) === shape(kids[k])) j++;
      const run = j - k;
      const show = run > 4 ? 2 : run;
      for (let m = k; m < k + show; m++) visit(kids[m], depth + 1);
      if (run > show) {
        let tx = 0;
        for (let m = k + show; m < j; m++) tx += st.text[kids[m].__ddi];
        lines.push(`${'  '.repeat(depth + 1)}… ${run - show} more ${shape(kids[k])} siblings, text=${fmtN(tx)}`);
      }
      k = j;
    }
  };
  visit(body, 0);
  if (lines.length >= maxLines) lines.push('… (truncated)');
  return lines.join('\n');
}

const LEAFY = new Set(['pre', 'code', 'p', 'table', 'thead', 'tbody', 'tr', 'span', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'button', 'select', 'blockquote', 'figure']);

/** Like describe(), but only class names usable in a plain CSS selector (no Tailwind `lg:x`, `w-[3px]`). */
function describeForSelector(el) {
  let s = tagOf(el);
  const id = el.getAttribute('id');
  if (id) s += /^[A-Za-z_][\w-]*$/.test(id) ? `#${id}` : `[id="${id.replace(/"/g, '\\"')}"]`;
  const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(c => /^[A-Za-z_][\w-]*$/.test(c) && c.length <= 40).slice(0, 4);
  if (cls.length) s += '.' + cls.join('.');
  const role = el.getAttribute('role');
  if (role) s += `[role=${role}]`;
  return s;
}

/** Debug: the top-scoring candidates with their score parts. */
export function debugCandidates(doc, { siblings = null, top = 12 } = {}) {
  const body = doc.body || doc.documentElement;
  const { el: h1 } = findTitleHeading(doc);
  const repeated = siblings?.length ? repeatedPieces(siblings) : null;
  const st = computeStats(body, { h1, repeated });
  const scope = mainLandmark(st, h1);
  const rows = [];
  for (let i = 0; i < st.els.length; i++) {
    if (st.good[i] < 20) continue;
    rows.push({ i, s: score(st, i, scope) });
  }
  rows.sort((a, b) => b.s - a.s);
  return { scope: scope ? describe(st.els[scope.idx]) : null, rows: rows.slice(0, top).map(({ i, s }) => ({ el: describe(st.els[i]), score: Math.round(s), text: st.text[i], good: st.good[i], link: st.link[i], bad: st.bad[i], rep: st.rep[i], mark: st.els[i].__ddmark || null })) };
}

/** Compact tag#id.class[role] description of an element. */
export function describe(el) {
  if (!el || el.nodeType !== 1) return '';
  let s = tagOf(el);
  const id = el.getAttribute('id');
  if (id) s += `#${id}`;
  const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 4);
  if (cls.length) s += '.' + cls.join('.');
  const role = el.getAttribute('role');
  if (role) s += `[role=${role}]`;
  return s;
}

// ─── choosing between the browser render and the server HTML ──────────────

const ERROR_RE = /Application error: a client-side exception has occurred|\b(?:500|502|503|504) (?:Internal (?:Server )?Error|Bad Gateway|Service (?:Temporarily )?Unavailable|Gateway Time-?out)\b|Unhandled Runtime Error|This page could not be found\.?|Sorry, something went wrong\.?/i;
const BOTCHECK_TITLE_RE = /^(?:just a moment\.*|attention required!? \| cloudflare|access denied|please wait\.*|checking your browser.*|ddos-guard|verify(?:ing)? you are (?:a )?human.*|are you a robot\??|security check.*|robot check)$/i;
const BOTCHECK_BODY_RE = /_cf_chl_opt|cf-browser-verification|Enable JavaScript and cookies to continue|Checking (?:if the site connection is secure|your browser before accessing)|g-recaptcha[^>]*data-sitekey[\s\S]{0,4000}(?:verify|robot)|px-captcha|captcha-delivery\.com/i;

/** Visible text of an HTML string, without a DOM (fast on huge pages). */
export function visibleText(html) {
  if (!html) return '';
  const body = /<body\b[^>]*>([\s\S]*)$/i.exec(html)?.[1] ?? html;
  return collapse(decodeEntities(body
    .replace(/<(script|style|noscript|template|svg|head|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')));
}

/**
 * What a captured HTML document is: a usable page, or one of the failure kinds a
 * fetcher must never cache.
 * @returns {{kind:'ok'|'empty'|'shell'|'botcheck'|'error'|'redirect', reason:string|null, text:number, error?:boolean, redirectTo?:string}}
 */
export function classifyHtml(html) {
  if (!html || !html.trim()) return { kind: 'empty', reason: 'no HTML', text: 0 };
  const title = collapse(decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || ''));
  const text = visibleText(html);
  const n = text.length;
  if ((BOTCHECK_TITLE_RE.test(title) || BOTCHECK_BODY_RE.test(html.slice(0, 200000))) && n < 3000) {
    return { kind: 'botcheck', reason: `bot check / interstitial (title ${JSON.stringify(title)})`, text: n };
  }
  const refresh = /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']?\s*\d+\s*;\s*url=([^"'>\s]+)/i.exec(html)
    || /<meta[^>]+content=["']?\s*\d+\s*;\s*url=([^"'>\s]+)[^>]*http-equiv=["']?refresh/i.exec(html);
  const jsRedirect = /(?:window\.)?location(?:\.href)?\s*(?:=|\.replace\(|\.assign\()\s*["'`]([^"'`]+)/.exec(html);
  if ((refresh || jsRedirect) && n < 400) {
    const to = (refresh || jsRedirect)[1];
    return { kind: 'redirect', reason: `redirect stub → ${to}`, text: n, redirectTo: decodeEntities(to) };
  }
  const errorHit = ERROR_RE.exec(text);
  if (errorHit && n < 1500) return { kind: 'error', reason: `error page: "${errorHit[0]}"`, text: n, error: true };
  if (n < 200) return { kind: 'shell', reason: `almost no visible text (${n} chars) — JS shell or blank render`, text: n };
  return { kind: 'ok', reason: null, text: n, error: !!errorHit, errorText: errorHit?.[0] };
}

/**
 * Which captured HTML to convert: the browser render (default), the server HTML
 * when the render is broken but the server HTML is fine, or neither.
 * @param {{rendered?:string|null, raw?:string|null, url?:string}} input
 * @returns {{source:'rendered'|'raw'|'fail', reason:string|null, rendered?:object, raw?:object}}
 */
export function chooseHtmlSource({ rendered, raw }) {
  const r = rendered ? classifyHtml(rendered) : null;
  const w = raw ? classifyHtml(raw) : null;
  const ok = (c) => c && c.kind === 'ok';
  if (ok(r)) {
    // An error message inside an otherwise normal-looking render (content replaced by
    // "500 Internal Error" while the chrome survived) → the server HTML if it is much richer.
    if (r.error && ok(w) && !w.error && w.text >= 2 * r.text) {
      return { source: 'raw', reason: `render shows an error (${r.errorText}); server HTML has ${w.text} chars vs ${r.text}`, rendered: r, raw: w };
    }
    return { source: 'rendered', reason: null, rendered: r, raw: w };
  }
  if (ok(w)) return { source: 'raw', reason: r ? `render unusable: ${r.reason}` : 'no render', rendered: r, raw: w };
  const why = [r && `render: ${r.reason}`, w && `server: ${w.reason}`].filter(Boolean).join('; ') || 'no HTML';
  return { source: 'fail', reason: why, rendered: r, raw: w };
}

// ─── text helpers ──────────────────────────────────────────────────────────

const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'caption', 'option', 'button']);

/** Text of an element with newlines at block boundaries (scripts/styles/svg skipped). */
export function blockText(el) {
  const out = [];
  const walk = (node) => {
    if (node.nodeType === 3) { out.push(node.data); return; }
    if (node.nodeType !== 1) return;
    const t = tagOf(node);
    if (SKIP.has(t)) return;
    const block = BLOCK_TAGS.has(t);
    if (block) out.push('\n');
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
    if (block) out.push('\n');
  };
  walk(el);
  return out.join('');
}

// ─── profiles (applied here; derived in ./profile.mjs) ─────────────────────

export function applyProfile(doc, profile, { h1 } = {}) {
  const checks = {};
  const removedEls = [];
  let roots = [];
  for (const sel of profile.contentSelectors || []) {
    try { roots.push(...Array.from(doc.querySelectorAll(sel))); } catch (err) { return { ok: false, reason: `invalid selector ${sel}: ${err.message}` }; }
  }
  roots = orderRoots([...new Set(roots)]);
  if (!roots.length) return { ok: false, reason: `content selectors matched nothing: ${JSON.stringify(profile.contentSelectors)}` };
  for (const sel of profile.removeSelectors || []) {
    let els;
    try { els = Array.from(doc.querySelectorAll(sel)); } catch { continue; }
    for (const e of els) if (roots.some(r => r !== e && containsFast(r, e))) { removedEls.push(e); e.parentNode?.removeChild(e); }
  }
  let title = null;
  if (profile.titleSelector) {
    try {
      const t = doc.querySelector(profile.titleSelector);
      if (t) {
        title = collapse(t.textContent);
        if (!roots.some(r => containsFast(r, t))) roots = orderRoots([t, ...roots]);
      }
    } catch { /* ignore */ }
  }
  const text = roots.reduce((a, r) => a + collapse(r.textContent).length, 0);
  checks.text = text;
  if (text < 50) return { ok: false, reason: `content selectors matched only ${text} chars` };
  return { ok: true, roots, title, removed: removedEls, checks };
}
