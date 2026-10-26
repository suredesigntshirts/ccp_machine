/**
 * Which files in a cache root are pages, and what each page contributes to the
 * index (metadata + search units with pre-tokenized fields).
 */

import { readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseDocument, cleanHeading } from './markdown.mjs';
import { isDerivedDir, isDerivedFile } from '../paths.mjs';
import { tokenize, extractSymbols, headingSymbols, fold } from './tokenize.mjs';

/**
 * Bump whenever analysis output changes (parsing, tokenization, fields, symbols):
 * an index built by another version is rebuilt in full on its next refresh, since
 * the usual (mtime, size) check cannot see that the analyzer changed.
 */
export const ANALYZER_VERSION = 9;

// Root-level files that are about the cache, not pages in it.
const ROOT_NON_PAGES = new Set(['catalog.md', 'claude.md', 'readme.md', 'agents.md', 'llms.md']);

/**
 * Is this root-relative path a cached page (vs a generated or foreign file)?
 * Only the tool's own names are excluded (paths.mjs isDerivedFile); a URL
 * segment starting with `_` or `.` (`__main__`, `_modules/`) is a page.
 */
export function isPagePath(rel) {
  if (!rel.endsWith('.md')) return false;
  if (isDerivedFile(rel)) return false;
  const segs = rel.split('/');
  if (segs.length === 1) {
    // v1 wrote a site's root page as `<host>.md` at the top level.
    const name = segs[0];
    if (ROOT_NON_PAGES.has(name.toLowerCase())) return false;
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+\.md$/i.test(name);
  }
  return true;
}

/** Domain (first path segment) of a page; `fly.io.md` → `fly.io`. */
export function domainOf(rel) {
  const i = rel.indexOf('/');
  return i === -1 ? rel.replace(/\.md$/, '') : rel.slice(0, i);
}

/**
 * Every page under the root with its stat, keyed by root-relative path.
 * @returns {Map<string, {mtime:number, size:number}>}
 */
export function scanPages(rootAbs) {
  const out = new Map();
  const walk = (dirAbs, relDir) => {
    let entries;
    try { entries = readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (isDerivedDir(rel)) continue;
        walk(join(dirAbs, e.name), rel);
      } else if (e.isFile() && isPagePath(rel)) {
        try {
          const st = statSync(join(dirAbs, e.name));
          out.set(rel, { mtime: Math.floor(st.mtimeMs), size: st.size });
        } catch { /* vanished mid-scan */ }
      }
    }
  };
  walk(rootAbs, '');
  return out;
}

export function hashText(text) {
  return createHash('sha1').update(text).digest('hex');
}

// Text that goes into the body field: HTML tags and link targets removed. Link
// targets are noise for ranking (every Google Ads row links to
// /google-ads/api/fields/…, so "google ads fields" would match every row of every
// table). Bare URLs stay: there they are content (OAuth scopes, endpoints).
export function bodyText(line) {
  if (line.length > 20000) line = line.slice(0, 20000);
  return line
    .replace(/<wbr\s*\/?>/gi, '')
    .replace(/\\([_*])/g, '$1') // markdown-escaped identifiers: app\_uninstalled
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '] ')
    .replace(/&(?:amp|lt|gt|quot|nbsp|#\d+|#x[0-9a-f]+);/gi, ' ');
}

/** A heading reduced to the name it defines, if it is a definition heading. */
function definitionName(text) {
  return text
    .replace(/\s*\(.*\)\s*$/, '')
    .replace(/^(?:class|def|async|function|method|property|attribute|interface|type|enum|const|module|package)\s+/i, '')
    .replace(/^[A-Za-z ]{1,20}:\s+/, '') // "Method: x", "Resource: X"
    .trim();
}

export function pathText(rel) {
  return rel.replace(/\.md$/, '').replace(/[/_\-.]+/g, ' ');
}

/**
 * Analyze one page: metadata, outline-ready sections and search units.
 * @param {string} rel root-relative path
 * @param {string} text file content
 */
export function analyzePage(rel, text) {
  const doc = parseDocument(text);
  const { lines } = doc;
  const inFence = new Uint8Array(lines.length + 2);
  for (const [s, e] of doc.fences) for (let l = s; l <= e; l++) inFence[l] = 1;

  // Page-level context (path + title) lives in the path field, once per unit; the
  // heading field holds only the unit's heading path. (Measured: title in the
  // heading field instead was no better, and bloats every unit of long pages.)
  const pathTerms = tokenize(`${pathText(rel)} ${doc.title || ''}`).join(' ');
  const units = [];
  for (const u of doc.units) {
    const hp = u.path;
    const hTerms = [];
    for (const h of hp) hTerms.push(...tokenize(h));

    // folded name → 2: the heading *is* this name (a definition: `metrics.cost_micros`,
    // `useEdgesState()`, `class a.b.C()`, `Method: models.embedContent`); 1: the name is
    // one word of the heading ("GraphQL query"); 0: it appears in code.
    const syms = new Map();
    const headLines = new Set();
    for (const h of u.heads) {
      headLines.add(h.line);
      const bare = fold(definitionName(cleanHeading(h.raw)));
      for (const s of headingSymbols(h.raw)) {
        const f = fold(s);
        const def = f === bare || bare.endsWith('.' + f) ? 2 : 1;
        if ((syms.get(f) || 0) < def) syms.set(f, def);
      }
    }
    const body = [];
    const code = [];
    for (let l = u.start; l <= u.end; l++) {
      const line = lines[l - 1];
      if (inFence[l]) { code.push(line); body.push(line); continue; }
      if (headLines.has(l)) continue; // heading lines are in the heading field
      body.push(bodyText(line));
      if (line.includes('`')) for (const m of line.matchAll(/`([^`\n]{2,100})`/g)) code.push(m[1]);
    }
    if (u.tableHeader) body.unshift(bodyText(u.tableHeader));
    const codeSyms = extractSymbols(code.join('\n'));
    for (const s of codeSyms) { const f = fold(s); if (!syms.has(f)) syms.set(f, 0); }

    const symTerms = [];
    for (const s of syms.keys()) symTerms.push(...tokenize(s));

    units.push({
      start: u.start,
      end: u.end,
      spanEnd: u.spanEnd,
      level: u.level,
      heading: hp.join(' › '),
      window: u.window ? 1 : 0,
      fields: [pathTerms, hTerms.join(' '), symTerms.join(' '), tokenize(body.join('\n')).join(' ')],
      symbols: [...syms].slice(0, 200),
    });
  }
  return {
    meta: {
      path: rel,
      domain: domainOf(rel),
      lines: doc.lineCount,
      title: doc.title || rel.split('/').pop().replace(/\.md$/, ''),
      description: doc.description || null,
      source: doc.frontMatter.source || null,
    },
    units,
  };
}
