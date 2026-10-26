/**
 * Third-party dependency loading.
 *
 * Why this file exists: a plain `import { chromium } from 'playwright'` at the
 * top of a script fails, when the skill has not been installed yet, with a
 * twenty-line ERR_MODULE_NOT_FOUND stack trace that mentions neither
 * package.json nor any command that would fix it. Both humans and agents read
 * that trace and conclude the skill is broken or has no manifest.
 *
 * ESM static imports are resolved before any module body runs, so the check
 * cannot happen inside the importing module — the deps have to be pulled in
 * dynamically, which is what `loadFetchDeps()` does. Everything here is
 * node-builtin only, so this module itself can never be the thing that fails.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root — this file is at <root>/scripts/lib/deps.mjs. */
export const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const RULE = '─'.repeat(74);

/** The one-time bootstrap, as an exact copy-pasteable command. */
export function setupCommand() {
  return `cd ${JSON.stringify(SKILL_ROOT)} && npm run setup`;
}

/** True once `npm install` has produced a node_modules for this skill. */
export function dependenciesInstalled() {
  return existsSync(join(SKILL_ROOT, 'node_modules'));
}

function reportMissing(packageName) {
  const lines = [
    '',
    RULE,
    '  documentation-downloader is not installed yet',
    RULE,
    '',
    `  Missing package: ${packageName}`,
    '',
    '  This skill ships source only — no vendored dependencies. Run the',
    '  one-time setup below, then re-run your command unchanged:',
    '',
    `      ${setupCommand()}`,
    '',
    '  That runs two steps, and BOTH are required:',
    '',
    '    npm install              turndown + playwright (~28 MB)',
    '    npm run install-browsers the actual browser binary (~150 MB) —',
    '                             npm install does NOT download it',
    '',
    `  The manifest is at ${join(SKILL_ROOT, 'package.json')}`,
    '  (the skill root — not the directory you are running from).',
    '',
    '  Check the install at any time with:',
    '',
    `      cd ${JSON.stringify(SKILL_ROOT)} && npm run doctor`,
    '',
    RULE,
    '',
  ];
  console.error(lines.join('\n'));
}

/**
 * Load the third-party packages `fetch-docs.js` needs.
 *
 * Exits the process with an instruction on a missing install rather than
 * letting an unhandled module-resolution rejection reach the terminal.
 */
export async function loadFetchDeps() {
  try {
    const [playwright, turndown, gfmPlugin] = await Promise.all([
      import('playwright'),
      import('turndown'),
      import('turndown-plugin-gfm'),
    ]);
    return {
      chromium: playwright.chromium,
      TurndownService: turndown.default,
      gfm: gfmPlugin.gfm,
    };
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    // "Cannot find package 'playwright' imported from ..." — recover the name.
    const named = /package '([^']+)'/.exec(err.message);
    reportMissing(named ? named[1] : 'playwright');
    process.exit(1);
  }
}

/**
 * Turn Playwright's "Executable doesn't exist" into the skill's own command.
 * `npm install` fetches the library but never the browser binary, so this is
 * the most common second-stage failure.
 */
export function explainBrowserLaunchFailure(err) {
  const message = String(err?.message || err);
  if (!/Executable doesn't exist|please run the following command/i.test(message)) {
    return null;
  }
  return [
    '',
    RULE,
    '  The browser binary is missing (the npm packages are installed).',
    RULE,
    '',
    '  Install it with:',
    '',
    `      cd ${JSON.stringify(SKILL_ROOT)} && npm run install-browsers`,
    '',
    RULE,
    '',
  ].join('\n');
}
