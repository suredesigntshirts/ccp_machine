/**
 * Browser launch — the single place every Playwright launch goes through.
 *
 * Launch is resolved, not assumed. The environments this skill runs in disagree
 * about which browser exists and which one can reach the network:
 *
 *   - A normal machine after `npm run setup`: Playwright's own managed build.
 *   - A Claude Code cloud session: Playwright may be a newer version than the
 *     browsers pre-installed under PLAYWRIGHT_BROWSERS_PATH, so the managed
 *     build it asks for "doesn't exist" while a perfectly good Chromium sits
 *     next to it. Some older cloud VMs could only navigate through the egress
 *     proxy with system Chrome plus a TLS 1.2 pin; current ones work with the
 *     bundled Chromium. Hardcoding either one broke the other.
 *
 * So we try an ordered list of candidates and keep the first that launches.
 * Override everything with DD_BROWSER_PATH=/path/to/chrome.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const IS_CLOUD = process.env.CLAUDE_CODE_REMOTE === 'true';

const SYSTEM_CHROME = '/opt/google/chrome/chrome';

/** Chromium executables already on disk, newest build first. */
export function findInstalledChromiums() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), '.cache', 'ms-playwright'),
    '/opt/pw-browsers',
  ].filter(Boolean);
  const found = [];
  for (const root of roots) {
    let entries;
    try { entries = readdirSync(root); } catch { continue; }
    for (const name of entries) {
      const m = /^chromium-(\d+)$/.exec(name);
      if (!m) continue;
      for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
        'chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) {
        const exe = join(root, name, rel);
        if (existsSync(exe)) found.push({ build: Number(m[1]), exe });
      }
    }
  }
  const seen = new Set();
  return found
    .sort((a, b) => b.build - a.build)
    .map(f => f.exe)
    .filter(exe => (seen.has(exe) ? false : seen.add(exe)));
}

function proxyOption() {
  const server = process.env.HTTPS_PROXY || process.env.https_proxy;
  return server ? { proxy: { server, bypass: 'localhost,127.0.0.1' } } : {};
}

/**
 * Ordered launch candidates for this environment. Pure — unit tested.
 *
 * In a cloud session the egress proxy intercepts TLS 1.3 with a certificate from
 * its own CA (the page fails with ERR_CERT_AUTHORITY_INVALID, or crawls with
 * ignoreHTTPSErrors) and passes TLS 1.2 through untouched. `--ssl-version-max=tls1.2`
 * is honoured by full Chrome/Chromium builds but ignored by Playwright's default
 * headless launch (`chromium_headless_shell`). So in the cloud every full browser
 * gets the pin and uses its own network (`network: 'browser'`: 1–3 s per page,
 * real origin certificates); the default launch is last and has its requests
 * re-issued from Node instead (`network: 'node'`, lib/fetch/render.mjs).
 * Measured with the negotiated protocol read from the response, not inferred from
 * flags (eval/.runs probes; the harempants.com handbook CLOUD-BROWSER-AUTOMATION.md).
 */
export function launchCandidates(env = process.env, installed = findInstalledChromiums(), hasSystemChrome = existsSync(SYSTEM_CHROME)) {
  const cloud = env.CLAUDE_CODE_REMOTE === 'true';
  const baseArgs = ['--disable-dev-shm-usage', ...(cloud ? ['--no-sandbox'] : [])];
  const pinned = cloud ? [...baseArgs, '--ssl-version-max=tls1.2'] : baseArgs;
  const full = cloud ? { network: 'browser' } : {};
  const candidates = [];

  if (env.DD_BROWSER_PATH) {
    candidates.push({ label: `DD_BROWSER_PATH (${env.DD_BROWSER_PATH})`, executablePath: env.DD_BROWSER_PATH, args: pinned, ...full });
  }
  if (cloud) {
    if (hasSystemChrome) candidates.push({ label: 'system Chrome + TLS 1.2 pin', channel: 'chrome', args: pinned, ...full });
    for (const exe of installed) {
      candidates.push({ label: `installed Chromium + TLS 1.2 pin (${exe})`, executablePath: exe, args: pinned, ...full });
    }
    candidates.push({ label: 'Playwright managed Chromium (headless shell; Node networking)', args: baseArgs, network: 'node' });
    return candidates;
  }
  candidates.push({ label: 'Playwright managed Chromium', args: baseArgs });
  for (const exe of installed) {
    candidates.push({ label: `installed Chromium (${exe})`, executablePath: exe, args: baseArgs });
  }
  if (hasSystemChrome) {
    candidates.push({ label: 'system Chrome', channel: 'chrome', args: baseArgs });
  }
  return candidates;
}

let resolvedLabel = null;
let resolvedNetwork = null;

/** Which candidate the last successful launch used (for doctor / debugging). */
export function launchedWith() {
  return resolvedLabel;
}

/**
 * The render network the launched browser works best with, when its candidate
 * says ('browser' | 'node'), else null (lib/fetch/render.mjs decides).
 */
export function launchedNetwork() {
  return resolvedNetwork;
}

/**
 * Launch a headless browser, trying each candidate in order.
 * @param {import('playwright').BrowserType} chromium
 */
export async function launchBrowser(chromium, extra = {}) {
  const errors = [];
  for (const candidate of launchCandidates()) {
    const { label, args, network = null, ...opts } = candidate;
    try {
      const browser = await chromium.launch({
        headless: true,
        ...(IS_CLOUD ? proxyOption() : {}),
        ...opts,
        ...extra,
        args,
      });
      resolvedLabel = label;
      resolvedNetwork = network;
      return browser;
    } catch (err) {
      errors.push(`  - ${label}: ${String(err.message).split('\n')[0]}`);
    }
  }
  const error = new Error(`No usable browser found. Tried:\n${errors.join('\n')}`);
  error.code = 'DD_NO_BROWSER';
  throw error;
}

/**
 * A lazily launched, shared browser. Nothing is launched until a page actually
 * needs rendering — a batch whose pages all resolve to published markdown never
 * starts a browser at all, and so cannot be failed by a missing one.
 */
export function createLazyBrowser(chromium) {
  let promise = null;
  let instance = null;
  return {
    get: () => {
      if (!promise) {
        promise = launchBrowser(chromium).then(b => { instance = b; return b; });
        promise.catch(() => { promise = null; });
      }
      return promise;
    },
    close: async () => {
      const b = instance;
      instance = null;
      promise = null;
      if (b) await b.close().catch(() => {});
    },
    get launched() { return instance !== null; },
  };
}
