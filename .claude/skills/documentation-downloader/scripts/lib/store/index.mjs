/**
 * The cache store: everything that writes into a cache root, and the
 * machine-wide limits shared by concurrent docs processes.
 *
 * Principle: one writer per domain; anything shared is SQLite, write-once, or
 * regenerated. Page files are the source of truth; generated files and `.cache/`
 * are rebuildable. See DESIGN.md → "Cache layout", "Concurrency", "Migration".
 *
 * How the fetch pipeline uses it, per URL:
 *
 *   await withUrlLock(root, url, async () => {        // dedupes in-flight fetches
 *     if (!refresh && await isCached(root, url)) return 'cached';
 *     const res = await withHostSlot(url, () => get(url));   // or withBrowserSlot
 *     await storeRaw(root, res.bytes, { url, finalUrl: res.url, status, contentType, kind });
 *     if (detectBadPage(markdown)) throw new Error('bot check / error page');  // never cache it
 *     // path from the final URL; Source: stays the requested URL (+ Final: when they differ)
 *     return writePage(root, res.url, markdown, { source: url, frontMatter: { Via, Library, … } });
 *   });
 *
 * `latestRaw(root, url).finalUrl` tells a later run where a redirecting URL landed,
 * so a skip check can look at the final URL's page too.
 */

export { writeFileAtomic, sweepTempFiles, sha256, sha256File, TEMP_MARK } from './atomic.mjs';
export {
  withUrlLock, withPageLock, withDomainLock, withGlobalLock, withLockFile, acquireLockFile,
  lockFileFor, domainKey, holdsLock, LockTimeoutError, LOCK_DEFAULTS,
} from './locks.mjs';
export {
  parseFrontMatter, splitFrontMatter, serializeFrontMatter, renderDocument,
  mergeFrontMatter, parseUnstacked, todayIso, PROVENANCE_KEYS, TOOL_KEYS, STICKY_KEYS,
} from './frontmatter.mjs';
export { writePage, readPage, isCached, pagePath, listPages, findStalePages, ensureRootOnce } from './pages.mjs';
export { putRaw, readRaw, recordRaw, storeRaw, readRawMap, parseRawMap, latestRaw, rawPath } from './raw.mjs';
export {
  withBrowserSlot, acquireBrowserSlot, withHostSlot, acquireSlot, machineDir, limitsConfig, SlotTimeoutError,
} from './limits.mjs';
export { ensureRoot } from './root.mjs';
export { detectBadPage } from './quality.mjs';
