/**
 * Shared description generation and validation library.
 *
 * Single source of truth for llms.txt description logic.
 * Used by both fetch-docs.js (at fetch time) and fix-descriptions.js (cleanup).
 */

import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';

// ============================================================================
// Constants
// ============================================================================

export const MAX_DESCRIPTION_LENGTH = 120;

// ============================================================================
// Domain Prefix Mapping
// ============================================================================

const DOMAIN_MAP = {
  'pulumi.com': (parts) => {
    if (parts.includes('cloudflare')) return 'Pulumi Cloudflare — ';
    if (parts.includes('aws')) return 'Pulumi AWS — ';
    if (parts.includes('command')) return 'Pulumi Command — ';
    return 'Pulumi — ';
  },
  'langfuse.com': () => 'Langfuse — ',
  'better-auth.com': () => 'Better Auth — ',
  'docs.temporal.io': () => 'Temporal — ',
  'typescript.temporal.io': () => 'Temporal TypeScript SDK — ',
  'ui.shadcn.com': () => 'shadcn/ui — ',
  'jsx.email': () => 'JSX Email — ',
  'openrouter.ai': () => 'OpenRouter — ',
  'orm.drizzle.team': () => 'Drizzle ORM — ',
  'docs.docker.com': () => 'Docker — ',
  'docs.github.com': () => 'GitHub — ',
  'developer.mozilla.org': () => 'MDN — ',
  'learn.microsoft.com': (parts) => {
    if (parts.includes('azure')) return 'Azure — ';
    return 'Microsoft — ';
  },
  'cloud.google.com': () => 'GCP — ',
  'docs.cloud.google.com': () => 'GCP — ',
  'docs.astro.build': () => 'Astro — ',
  'www.oauth.com': () => 'OAuth — ',
  'raw.githubusercontent.com': () => '',
};

/**
 * Extract domain/library name prefix from file path.
 * "docs/pulumi.com/registry/packages/cloudflare/api-docs/zone.md" → "Pulumi Cloudflare — "
 */
export function extractDomainPrefix(filePath) {
  const parts = filePath.replace(/^docs\//, '').split('/');
  const domain = parts[0] || '';
  const fn = DOMAIN_MAP[domain];
  return fn ? fn(parts) : '';
}

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

// ============================================================================
// Content Extraction Helpers
// ============================================================================

/**
 * Strip inline markup from a description candidate.
 *
 * Headings lifted straight out of converted HTML carry their permalink anchors
 * (`venv — Creation of virtual environments[¶](#module-venv "Link to this
 * heading")`), which is noise in the index, hurts keyword search, and breaks the
 * `path: description` line format when the description contains a colon-bearing
 * title attribute.
 */
export function cleanInlineMarkup(text) {
  if (!text) return text;
  return text
    // Permalink/anchor links whose text is a symbol or empty: drop entirely
    .replace(/\[\s*[¶#§*↩︎↩]*\s*\]\([^)]*\)/g, '')
    // Images: keep the alt text only
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Ordinary links: keep the link text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Reference-style links
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    // Leftover HTML
    .replace(/<[^>]+>/g, '')
    // Emphasis / code markers
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim()
    .replace(/[\s\-–—:]+$/, '');
}

/**
 * Extract first meaningful paragraph from markdown content.
 */
function extractFirstParagraph(content) {
  // Skip frontmatter
  let text = content.replace(/^---\n[\s\S]*?\n---\n*/, '');
  // Skip headings and empty lines at start
  text = text.replace(/^(#[^\n]*\n|\s*\n)*/m, '');

  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('-') || trimmed.startsWith('*') || trimmed.startsWith('|')) continue;
    if (trimmed.startsWith('```')) continue;
    if (trimmed.startsWith('import ') || trimmed.startsWith('export ')) continue;
    // Clean markdown links and formatting
    const clean = trimmed
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (clean.length > 15) {
      return clean.length > 200 ? clean.slice(0, 197) + '...' : clean;
    }
  }
  return null;
}

/**
 * Read one scalar key out of a YAML front-matter block.
 *
 * Handles block scalars (`description: >-` followed by indented lines), which
 * VitePress, Docusaurus and Starlight all emit. A plain single-line regex
 * captures the literal `>-` for those and the real description is lost.
 */
function readYamlScalar(fm, key) {
  const lines = fm.split('\n');
  const idx = lines.findIndex(line => line.startsWith(`${key}:`));
  if (idx === -1) return null;

  const rest = lines[idx].slice(key.length + 1).trim();
  if (/^[>|][-+]?$/.test(rest)) {
    const folded = [];
    for (let i = idx + 1; i < lines.length; i++) {
      if (/^\s+\S/.test(lines[i])) folded.push(lines[i].trim());
      else if (lines[i].trim() === '') folded.push('');
      else break;
    }
    return folded.join(' ').replace(/\s+/g, ' ').trim() || null;
  }
  return rest.replace(/^["']|["']$/g, '').trim() || null;
}

/**
 * Parse YAML frontmatter, returning an object with title/description or null.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = match[1];
  return {
    title: cleanInlineMarkup(readYamlScalar(fm, 'title')) || null,
    description: cleanInlineMarkup(readYamlScalar(fm, 'description')) || null,
  };
}

/**
 * Truncate string to max length with ellipsis.
 */
export function truncate(s, len = MAX_DESCRIPTION_LENGTH) {
  if (s.length <= len) return s;
  return s.slice(0, len - 3) + '...';
}

// ============================================================================
// Main Description Generator
// ============================================================================

/**
 * Generate a search-optimized description for an llms.txt entry.
 *
 * Extraction chain (returns first good result):
 * 1. Frontmatter title + description combined
 * 2. First # heading + frontmatter description
 * 3. First # heading alone (if specific enough)
 * 4. Returns null — needs agent-assisted generation
 *
 * Every candidate is validated through isBadDescription() before returning.
 *
 * @param {string} filePath - Path like "docs/domain.com/path.md"
 * @param {string} markdownContent - Full markdown content of the file
 * @returns {string|null} Description or null if agent-assisted generation needed
 */
export function generateDescription(filePath, markdownContent) {
  if (!markdownContent) return null;

  const prefix = extractDomainPrefix(filePath);
  const fm = parseFrontmatter(markdownContent);
  const stem = basename(filePath, '.md').replace(/-/g, ' ');

  // Helper: test a candidate and return it if good
  const tryCandidate = (candidate) => {
    if (!candidate) return null;
    const desc = truncate(candidate);
    if (isBadDescription(desc, filePath)) return null;
    return desc;
  };

  // Strategy 1: Frontmatter title + description combined
  if (fm) {
    if (fm.title && fm.description && fm.description.length > 10) {
      const result = tryCandidate(`${prefix}${fm.title}: ${fm.description}`);
      if (result) return result;
    }
    // Title alone if specific enough (>3 words, not matching filename)
    if (fm.title && fm.title.split(/\s+/).length > 3 && fm.title.toLowerCase() !== stem.toLowerCase()) {
      const result = tryCandidate(`${prefix}${fm.title}`);
      if (result) return result;
    }
  }

  // Strategy 2: First # heading + frontmatter description
  const headingMatch = markdownContent.match(/^#\s+(.+)$/m);
  const heading = headingMatch ? cleanInlineMarkup(headingMatch[1]) || null : null;

  if (heading && fm?.description && fm.description.length > 10) {
    const result = tryCandidate(`${prefix}${heading}: ${fm.description}`);
    if (result) return result;
  }

  // Strategy 3: First # heading alone (if it doesn't match filename)
  if (heading && heading.toLowerCase() !== stem.toLowerCase()) {
    const result = tryCandidate(`${prefix}${heading}`);
    if (result) return result;
  }

  // Strategy 4: Frontmatter description alone (if specific enough)
  if (fm?.description && fm.description.length > 20) {
    const result = tryCandidate(`${prefix}${fm.description}`);
    if (result) return result;
  }

  // Strategy 5: First ## heading (some docs skip h1)
  const h2Match = markdownContent.match(/^##\s+(.+)$/m);
  if (h2Match) {
    const h2 = cleanInlineMarkup(h2Match[1]);
    if (h2.toLowerCase() !== stem.toLowerCase()) {
      const result = tryCandidate(`${prefix}${h2}`);
      if (result) return result;
    }
  }

  return null; // Needs agent-assisted generation
}

/**
 * Generate a description by reading the file from disk.
 * Convenience wrapper around generateDescription.
 *
 * @param {string} filePath - Path to the markdown file
 * @returns {string|null}
 */
export function generateDescriptionFromFile(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  return generateDescription(filePath, content);
}
