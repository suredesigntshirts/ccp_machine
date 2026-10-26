/**
 * v1 conversion logic, kept only as the TEMPORARY placeholder converter behind
 * `lib/convert/index.mjs` (see there). The v2 converter modules
 * (convert/markdown.mjs, extract.mjs, owner.mjs, split.mjs) replace all of this;
 * nothing new should build on it.
 *
 * Moved out of v1 `scripts/fetch-docs.js` with behaviour unchanged, except that
 * content extraction runs on a DOM parsed in Node (lib/convert/dom.mjs) instead
 * of inside the browser page.
 */

import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const MIN_MARKDOWN_LENGTH = 50;

const PATTERNS = {
  // Markdown validation patterns
  MD_HEADER: /^#{1,6}\s+\S/m,
  MD_CODE_FENCE: /^```/m,
  MD_UNORDERED_STAR: /^\*\s+\S/m,
  MD_UNORDERED_DASH: /^-\s+\S/m,
  MD_ORDERED: /^\d+\.\s+\S/m,
  MD_LINK: /\[.+\]\(.+\)/,
  MD_BOLD: /\*\*\S.*\S\*\*/,
  MD_BLOCKQUOTE: /^>\s+\S/m,
  MD_TABLE: /^\|.+\|/m,
  MD_HR: /^---$/m,

  // MDX patterns
  MDX_IMPORT: /^import\s+.*from\s+['"][@\w]/m,
  MDX_EXPORT: /^export\s+(default|const|let)/m,
  MDX_JSX: /<[A-Z][a-zA-Z]*[\s/>]/,
  MDX_COMMENT: /\{\/\*.*\*\/\}/,

  // HTML detection
  HTML_DOCTYPE: /^<!DOCTYPE|^<html|^<\?xml/i,
};

/**
 * Check if content looks like valid markdown or MDX (not HTML)
 */
export function looksLikeMarkdown(text) {
  if (!text || text.length < MIN_MARKDOWN_LENGTH) return false;

  // Reject if it's clearly HTML
  const trimmed = text.trim();
  if (PATTERNS.HTML_DOCTYPE.test(trimmed)) {
    return false;
  }

  // Reject if it's a PDF
  if (trimmed.startsWith('%PDF-')) {
    return false;
  }

  // MDX-specific patterns - if these are found, it's likely MDX
  const mdxPatterns = [
    PATTERNS.MDX_IMPORT,
    PATTERNS.MDX_EXPORT,
    PATTERNS.MDX_JSX,
    PATTERNS.MDX_COMMENT,
  ];

  const isMdx = mdxPatterns.some(pattern => pattern.test(text));

  // Count markdown indicators using pre-compiled patterns
  const mdPatterns = [
    PATTERNS.MD_HEADER,
    PATTERNS.MD_CODE_FENCE,
    PATTERNS.MD_UNORDERED_STAR,
    PATTERNS.MD_UNORDERED_DASH,
    PATTERNS.MD_ORDERED,
    PATTERNS.MD_LINK,
    PATTERNS.MD_BOLD,
    PATTERNS.MD_BLOCKQUOTE,
    PATTERNS.MD_TABLE,
    PATTERNS.MD_HR,
  ];

  const matchCount = mdPatterns.filter(pattern => pattern.test(text)).length;

  // MDX files may have fewer traditional markdown indicators but are still valid
  if (isMdx) {
    return matchCount >= 1;
  }

  return matchCount >= (text.length < 500 ? 2 : 3);
}

// Generic content selectors that work across many documentation sites
// Ordered by likelihood - most common matches first for faster detection
export const DEFAULT_CONTENT_SELECTORS = [
  // Most common patterns (check these first)
  'main article',
  'article',
  'main',
  '[role="main"]',

  // GitHub / markdown platforms
  'article.markdown-body',
  '.markdown-body',

  // Documentation platform specific
  'article.documentation',
  'article.docs-content',
  '.docs-content',
  '.documentation-content',
  '.doc-content',
  '.content-body',

  // Mintlify / GitBook / ReadMe style
  '[data-testid="content"]',
  '.prose',                       // Tailwind prose
  '.article-content',
  '.page-content',

  // Less common patterns
  'article[role="main"]',
  '.main-content',
  '#main-content',
  '.content',
  '#content',

  // Fallbacks
  '.container article',
  '.wrapper article'
];

// Elements to remove from content (generic patterns)
export const REMOVE_SELECTORS = [
  // Navigation
  'nav',
  '[role="navigation"]',
  '.nav',
  '.navigation',
  '.sidebar',
  '.side-nav',
  '.sidenav',
  '.toc',
  '.table-of-contents',
  '.breadcrumb',
  '.breadcrumbs',

  // Headers/Footers (site-level, not content)
  'header:not(article header)',
  'footer',
  '[role="banner"]',
  '[role="contentinfo"]',
  '.site-header',
  '.site-footer',
  '.page-header:not(.doc-header)',
  '.page-footer',

  // Interactive elements
  '.feedback',
  '.feedback-buttons',
  '.rating',
  '.share-buttons',
  '.social-share',
  '.comments',
  '.comment-section',

  // Promotional/UI
  '.cookie-banner',
  '.cookie-consent',
  '.announcement',
  '.banner',
  '.popup',
  '.modal',
  '.newsletter',
  '.signup',
  '.cta',
  '.advertisement',
  '.ad',

  // Code UI elements
  '[data-copy-button]',
  '.copy-button',
  '.code-copy',
  'button[aria-label*="Copy"]',
  'button[aria-label*="copy"]',

  // Scripts and styles
  'script',
  'style',
  'noscript',
  'iframe:not([src*="youtube"]):not([src*="vimeo"])',

  // Search
  '.search',
  '.search-box',
  '[role="search"]',

  // Misc
  '.hidden',
  '[hidden]',
  '.sr-only',
  '.visually-hidden'
];

/**
 * Configure Turndown for GitHub-flavored markdown
 */
export function createTurndownService() {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined'
  });

  // Use GitHub-flavored markdown plugin
  turndown.use(gfm);

  // Use Turndown's native remove() for elements we don't want
  turndown.remove(['script', 'style', 'noscript']);

  // Remove empty links using Turndown's remove() with filter function
  turndown.remove((node) => {
    return node.nodeName === 'A' && !node.textContent.trim();
  });

  // Custom rule for code blocks with language
  turndown.addRule('codeBlockWithLanguage', {
    filter: (node) => {
      return node.nodeName === 'PRE' && node.querySelector('code');
    },
    replacement: (content, node) => {
      const code = node.querySelector('code');
      let language = '';

      // Try to detect language from class
      const classes = code.className || node.className || '';
      const langMatch = classes.match(/language-(\w+)|lang-(\w+)|(\w+)-code|highlight-(\w+)/);
      if (langMatch) {
        language = langMatch[1] || langMatch[2] || langMatch[3] || langMatch[4];
      }

      // Try data-language attribute
      if (!language) {
        language = code.getAttribute('data-language') ||
                   node.getAttribute('data-language') ||
                   code.getAttribute('data-lang') ||
                   node.getAttribute('data-lang') ||
                   code.closest('[data-language]')?.getAttribute('data-language') || '';
      }

      // Try to detect from content if still unknown
      const text = code.textContent || '';

      if (!language) {
        language = detectLanguageFromContent(text);
      }

      // Map common variations
      const langMap = {
        'js': 'javascript',
        'ts': 'typescript',
        'py': 'python',
        'sh': 'bash',
        'shell': 'bash',
        'zsh': 'bash',
        'golang': 'go',
        'yml': 'yaml',
        'rb': 'ruby',
        'cs': 'csharp',
        'objective-c': 'objc',
        'objectivec': 'objc'
      };
      language = langMap[language.toLowerCase()] || language.toLowerCase();

      return `\n\n\`\`\`${language}\n${text.trim()}\n\`\`\`\n\n`;
    }
  });

  // Helper function to detect language from code content
  function detectLanguageFromContent(text) {
    // Python patterns
    if (/^from\s+\w+\s+import|^import\s+\w+|^def\s+\w+\(|^class\s+\w+[:(]|print\(/.test(text)) {
      return 'python';
    }
    // JavaScript/TypeScript patterns
    if (/^import\s*{|^import\s+\w+\s+from|^const\s+\w+\s*=|^let\s+\w+\s*=|^var\s+\w+\s*=|async\s+function|=>\s*{|\.then\(/.test(text)) {
      return 'javascript';
    }
    // Go patterns
    if (/^package\s+\w+|^func\s+\w+|:=\s*|fmt\.|^import\s*\(/.test(text)) {
      return 'go';
    }
    // Rust patterns
    if (/^fn\s+\w+|^let\s+mut\s+|^use\s+\w+::|^impl\s+/.test(text)) {
      return 'rust';
    }
    // Ruby patterns
    if (/^require\s+['"]|^def\s+\w+|^class\s+\w+\s*<|\.each\s+do/.test(text)) {
      return 'ruby';
    }
    // Curl/bash patterns (including $pip, $npm, etc. without space)
    if (/^curl\s|^#.*\n.*\w|^\$\s*\w|^npm\s|^pip\s|^brew\s|^export\s/.test(text)) {
      return 'bash';
    }
    // JSON patterns
    if (/^\s*[{\[]/.test(text) && /[}\]]\s*$/.test(text)) {
      try {
        JSON.parse(text);
        return 'json';
      } catch {}
    }
    // YAML patterns
    if (/^\w+:\s*\n|^\s+-\s+\w+:/.test(text)) {
      return 'yaml';
    }
    // SQL patterns
    if (/^SELECT\s|^INSERT\s|^UPDATE\s|^CREATE\s|^DROP\s/i.test(text)) {
      return 'sql';
    }
    // GraphQL patterns
    if (/^query\s+\w+|^mutation\s+\w+|^type\s+\w+\s*{|^fragment\s+/.test(text)) {
      return 'graphql';
    }
    // HTML patterns
    if (/^<!DOCTYPE|^<html|^<div|^<span|^<p\b/.test(text)) {
      return 'html';
    }

    return '';
  }

  // Custom rule for inline code - needed because Turndown doesn't escape
  // backticks inside code elements (per docs: "text in code elements is never passed to escape")
  turndown.addRule('inlineCode', {
    filter: (node) => {
      return node.nodeName === 'CODE' &&
             node.parentNode.nodeName !== 'PRE';
    },
    replacement: (content) => {
      const cleaned = content.replace(/`/g, "'").trim();
      return cleaned ? `\`${cleaned}\`` : '';
    }
  });

  // Handle tables with rowspan/colspan
  turndown.addRule('complexTable', {
    filter: 'table',
    replacement: (content, node) => {
      const hasComplexStructure = node.querySelector('[rowspan], [colspan]');

      if (hasComplexStructure) {
        return cleanHtmlTable(node);
      }

      return convertSimpleTable(node);
    }
  });

  // Helper: Clean and keep HTML table
  function cleanHtmlTable(table) {
    let html = table.outerHTML;
    html = html
      .replace(/\s+(class|style|id|data-[^=]+)="[^"]*"/gi, '')
      .replace(/\s+(class|style|id|data-[^=]+)='[^']*'/gi, '')
      .replace(/>\s+</g, '><')
      .replace(/<tr/g, '\n<tr')
      .replace(/<\/table>/g, '\n</table>')
      .replace(/<thead/g, '\n<thead')
      .replace(/<tbody/g, '\n<tbody')
      .replace(/<\/thead>/g, '\n</thead>')
      .replace(/<\/tbody>/g, '\n</tbody>');

    return '\n\n' + html.trim() + '\n\n';
  }

  // Helper: Get cell text (preserving links as markdown)
  function getCellText(cell) {
    let html = cell.innerHTML || '';

    // Convert <a> tags to markdown links BEFORE stripping other tags
    // Match <a href="...">text</a> and convert to [text](href)
    html = html.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi,
      (match, href, text) => `[${text.trim()}](${href})`);

    // Handle <a> tags with nested elements (like <code>)
    html = html.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (match, href, innerHtml) => {
        // Strip inner tags to get text
        const text = innerHtml.replace(/<[^>]+>/g, '').trim();
        return `[${text}](${href})`;
      });

    // Convert <code> to backticks
    html = html.replace(/<code[^>]*>([^<]*)<\/code>/gi, '`$1`');

    html = html.replace(/<br\s*\/?>/gi, ' | ');
    html = html.replace(/<\/(p|div|li|tr)>/gi, ' | ');
    html = html.replace(/<(p|div|li|tr)[^>]*>/gi, '');
    html = html.replace(/<[^>]+>/g, '');
    html = html.replace(/&nbsp;/g, ' ')
               .replace(/&amp;/g, '&')
               .replace(/&lt;/g, '<')
               .replace(/&gt;/g, '>')
               .replace(/&quot;/g, '"');

    let text = html
      .split('|')
      .map(part => part.trim())
      .filter(part => part)
      .join(' | ');

    return text.trim();
  }

  // Helper: Convert simple table to markdown
  function convertSimpleTable(table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length === 0) return '';

    const firstRow = rows[0];
    const firstRowCells = Array.from(firstRow.querySelectorAll('th, td'));
    const colCount = firstRowCells.length;

    if (colCount === 0) return '';

    let result = '\n\n';
    let hasHeader = false;

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('th, td'));
      const isHeaderRow = row.querySelector('th') !== null;

      let rowStr = '|';
      for (let i = 0; i < colCount; i++) {
        const cell = cells[i];
        const text = cell ? getCellText(cell).replace(/\|/g, ',') : '';
        rowStr += ` ${text} |`;
      }
      result += rowStr + '\n';

      if (isHeaderRow && !hasHeader) {
        hasHeader = true;
        result += '|' + ' --- |'.repeat(colCount) + '\n';
      }
    }

    if (!hasHeader && rows.length > 0) {
      const lines = result.trim().split('\n');
      if (lines.length > 0) {
        const separator = '|' + ' --- |'.repeat(colCount);
        lines.splice(1, 0, separator);
        result = '\n\n' + lines.join('\n') + '\n';
      }
    }

    return result + '\n';
  }

  // Handle images
  turndown.addRule('images', {
    filter: 'img',
    replacement: (content, node) => {
      const alt = node.getAttribute('alt') || '';
      let src = node.getAttribute('src') || node.getAttribute('data-src') || '';

      // Skip tracking pixels and icons
      if (src.includes('tracking') || src.includes('pixel') ||
          (node.width && node.width < 20) || (node.height && node.height < 20)) {
        return '';
      }

      return src ? `![${alt}](${src})` : '';
    }
  });

  return turndown;
}

/**
 * Split markdown into fenced and unfenced runs, apply `fn` to the unfenced runs
 * only, and reassemble. Fenced blocks come back byte-identical.
 *
 * Every prose cleanup below is destructive inside a code block: the heading rule
 * injects a blank line before every `#` comment in a bash/python/yaml sample, the
 * blank-line collapse eats deliberate spacing, and the `---` rule rewrites SQL
 * comment rules. Code samples are the single most valuable part of a cached doc,
 * so they are left exactly as the converter produced them.
 */
export function mapOutsideFences(markdown, fn) {
  const lines = markdown.split('\n');
  const parts = [];
  let current = [];
  let fenceChar = null; // non-null while inside a fence

  const flush = (fenced) => {
    if (current.length > 0) parts.push({ fenced, lines: current });
    current = [];
  };

  for (const line of lines) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceChar === null) {
      if (fence) {
        flush(false);          // close the prose run before the fence opens
        fenceChar = fence[1][0];
      }
      current.push(line);
    } else {
      current.push(line);
      // A fence closes only on the same marker character (``` cannot close ~~~).
      if (fence && fence[1][0] === fenceChar) {
        flush(true);
        fenceChar = null;
      }
    }
  }
  // An unterminated fence is still treated as code — safer than mangling it.
  flush(fenceChar !== null);

  return parts.map(p => (p.fenced ? p.lines.join('\n') : fn(p.lines.join('\n')))).join('\n');
}

/**
 * Clean up markdown output (prose only — fenced code is never touched)
 */
export function cleanMarkdown(markdown) {
  const cleaned = mapOutsideFences(markdown, (prose) => prose
    // Remove common UI text artifacts
    .replace(/^(Send feedback|Give feedback|Was this helpful\?|Rate this page)\s*$/gim, '')
    .replace(/^\s*(content_copy|Copy|Copied!)\s*$/gm, '')
    // Remove "Edit this page" links
    .replace(/\[Edit this page.*?\]\([^)]+\)/gi, '')
    .replace(/\[Edit on GitHub.*?\]\([^)]+\)/gi, '')
    // Remove excessive blank lines
    .replace(/\n{4,}/g, '\n\n\n')
    // Fix heading spacing
    .replace(/\n(#{1,6})/g, '\n\n$1')
    // Remove trailing whitespace
    .replace(/[ \t]+$/gm, '')
    // Remove lines that are just whitespace
    .replace(/^\s+$/gm, '')
    // Clean up multiple dashes (often from removed content)
    .replace(/^-{3,}$/gm, '---')
  );

  // Ensure file ends with single newline
  return cleaned.trim() + '\n';
}

const TITLE_SELECTORS = ['h1', 'article h1', '.page-title', '.doc-title', '.title', '[data-title]', 'title'];

/**
 * v1's in-page extraction (title, remove template selectors, first content
 * selector with > 200 chars of HTML, else body), run on a DOM parsed in Node.
 * Mutates `doc`.
 * @param {Document} doc
 * @returns {{title: string|null, element: Element, selector: string}}
 */
export function extractTitleAndContent(doc) {
  let title = null;
  for (const selector of TITLE_SELECTORS) {
    try {
      const el = doc.querySelector(selector);
      if (el && el.textContent.trim()) { title = el.textContent.trim(); break; }
    } catch { /* unsupported selector */ }
  }
  for (const selector of REMOVE_SELECTORS) {
    // domino's NodeList has no forEach: iterate a copy.
    try { for (const el of Array.from(doc.querySelectorAll(selector))) el.remove(); } catch { /* unsupported selector */ }
  }
  for (const selector of DEFAULT_CONTENT_SELECTORS) {
    try {
      const el = doc.querySelector(selector);
      if (el && el.innerHTML.trim().length > 200) return { title, element: el, selector };
    } catch { /* unsupported selector */ }
  }
  return { title, element: doc.body ?? doc.documentElement, selector: 'body (fallback)' };
}
