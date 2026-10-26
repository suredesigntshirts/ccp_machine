/**
 * Child process for concurrency.test.mjs. Many of these run at once against one
 * cache root and one machine dir, doing what parallel subagents do.
 *
 *   node store-worker.mjs '<json config>'
 *
 * mode "storm": fetch-dedupe, refresh storm, raw-map appends, lock-protected
 *               generated-file writes and browser slots, all overlapping. Prints
 *               a JSON summary on stdout.
 * mode "hold":  take one URL lock, print "locked", then wait to be killed.
 */

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  writePage, isCached, storeRaw, withUrlLock, withDomainLock, withGlobalLock,
  withBrowserSlot, writeFileAtomic,
} from '../../lib/store/index.mjs';

const cfg = JSON.parse(process.argv[2]);
process.env.DD_MACHINE_DIR = cfg.machineDir;

function pageBody(id, url, phase) {
  // Big enough (~60 KB) that a torn write would be visible, with markers at both ends.
  return `# ${url}\n\nwriter ${id} ${phase}\n\n${'lorem ipsum dolor sit amet '.repeat(2200)}\nEND ${id} ${phase}\n`;
}

async function rmw(file, line) {
  let text = '';
  try { text = await fsp.readFile(file, 'utf-8'); } catch { /* first writer */ }
  await sleep(Math.random() * 2); // widen the read→write window a racy writer would lose in
  await writeFileAtomic(file, `${text}${line}\n`);
}

async function storm() {
  const { root, id, urls, rawPerWorker, rmwPerWorker, browserRounds, startAt } = cfg;
  await sleep(Math.max(0, startAt - Date.now())); // start together
  const stats = { fetched: 0, skipped: 0 };

  const fetchThenRefresh = async () => {
    // Phase A: "fetch" each URL at most once across all processes.
    for (const url of urls) {
      await withUrlLock(root, url, async () => {
        if (await isCached(root, url)) { stats.skipped++; return; }
        await sleep(Math.random() * 5); // the network
        const body = pageBody(id, url, 'fetch');
        await storeRaw(root, body, { url, status: 200, contentType: 'text/html', kind: 'html' });
        await writePage(root, url, body, { frontMatter: { Via: 'html' } });
        stats.fetched++;
      });
    }
    // Phase B: everyone refreshes everything at once (writePage takes the lock itself).
    await Promise.all(urls.map(url => writePage(root, url, pageBody(id, url, 'refresh'))));
  };

  const rawAppends = async () => {
    for (let i = 0; i < rawPerWorker; i++) {
      // Every 5th record has a long URL, so lines vary from ~300 B to ~5 KB.
      const url = `https://raw.example/${id}/${i}${i % 5 === 0 ? `?q=${'x'.repeat(4500)}` : ''}`;
      await storeRaw(root, `blob ${id} ${i}`, { url, status: 200, kind: 'html' });
    }
  };

  const generated = async () => {
    for (let i = 0; i < rmwPerWorker; i++) {
      await withDomainLock(root, 'example.com', () => rmw(join(root, 'example.com', '_outline.md'), `${id}-${i}`));
      await withGlobalLock(root, 'catalog', () => rmw(join(root, 'catalog.md'), `${id}-${i}`));
    }
  };

  const browsers = async () => {
    for (let i = 0; i < browserRounds; i++) {
      await withBrowserSlot(async () => {
        const t = () => performance.timeOrigin + performance.now();
        await fsp.appendFile(cfg.browserLog, `${JSON.stringify({ id, e: 'in', t: t() })}\n`);
        await sleep(10);
        await fsp.appendFile(cfg.browserLog, `${JSON.stringify({ id, e: 'out', t: t() })}\n`);
      }, { max: cfg.maxBrowsers });
    }
  };

  await Promise.all([fetchThenRefresh(), rawAppends(), generated(), browsers()]);
  process.stdout.write(JSON.stringify(stats));
}

async function hold() {
  await withUrlLock(cfg.root, cfg.url, async () => {
    process.stdout.write('locked\n');
    setInterval(() => {}, 1000); // keep the process (and its lock refresh) alive
    await new Promise(() => {}); // until killed
  });
}

if (cfg.mode === 'hold') await hold();
else await storm();
