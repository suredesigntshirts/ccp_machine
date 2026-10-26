#!/usr/bin/env node
// pages:check: render every harness page from a fixture store and open each in Chromium, so a page
// change cannot quietly break what the person reads. Fails on horizontal scroll, a broken link, a
// missing title or a page over 1 MB, at 400 and 1200 px wide in light and dark.
import { mkdtempSync, existsSync, statSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openStore, init, apply, logPrecedents } from '../src/index.js';

const { values: o } = parseArgs({ options: { out: { type: 'string' }, shots: { type: 'string' } } });
const SIM = '/mnt/project-files/harness/state/sim';
const out = o.out ?? mkdtempSync(join(tmpdir(), 'harness-pages-'));
const shots = o.shots ?? (existsSync(dirname(SIM)) ? join(SIM, 'shots') : join(out, 'shots'));
mkdirSync(shots, { recursive: true });

// A fixture with every kind of row: merged, cancelled, in flight, queued and one waiting on the person.
const store = openStore(join(out, 'store'));
init(store, { wipLimit: 3 }, '2026-10-26T08:00:00Z');
const at = (h) => `2026-10-26T${String(h).padStart(2, '0')}:00:00Z`;
const send = (event, to, h, id) => apply(store, event, { to, now: at(h), id });
const sure = { choice: 'approve', confidence: 0.95, threshold: 0.9, autonomy: 'act', reason: 'small and covered by tests' };
const pr = 'https://github.com/suredesigntshirts/ccp_machine_test/pull/1';
send({ type: 'REQUEST_RECEIVED', request: { id: 'merged-item', title: 'A merged change with a long title that has to wrap on a phone screen without scrolling sideways', project: 'packages/harness', tier: 1, url: pr, expect: 'It merges' } }, undefined, 8);
send({ type: 'RUN_SUCCEEDED' }, 'item:merged-item', 8);
send({ type: 'STAND_IN_ANSWERED', answer: sure }, 'item:merged-item/decision:merged-item:plan:1', 9);
send({ type: 'RUN_SUCCEEDED', pr }, 'item:merged-item', 9);
send({ type: 'CHECKS_PASSED', pr }, 'item:merged-item', 10);
send({ type: 'STAND_IN_ANSWERED', answer: sure }, 'item:merged-item/decision:merged-item:accept:2', 10);
send({ type: 'MERGED', pr }, 'item:merged-item', 10);
send({ type: 'REQUEST_RECEIVED', request: { id: 'needs-you', title: 'A tier-2 change', project: 'packages/harness', tier: 2 } }, undefined, 11);
send({ type: 'RUN_SUCCEEDED' }, 'item:needs-you', 11);
send({ type: 'STAND_IN_ANSWERED', answer: { ...sure, choice: 'revise', reason: 'too big for one PR' } }, 'item:needs-you/decision:needs-you:plan:1', 11);
send({ type: 'REQUEST_RECEIVED', request: { id: 'dropped', tier: 2 } }, undefined, 12);
send({ type: 'RUN_SUCCEEDED' }, 'item:dropped', 12);
send({ type: 'STAND_IN_ANSWERED', answer: sure }, 'item:dropped/decision:dropped:plan:1', 12);
send({ type: 'PERSON_DECIDED', choice: 'reject', person: true }, 'item:dropped/decision:dropped:plan:1', 12);
send({ type: 'REQUEST_RECEIVED', request: { id: 'building', tier: 0, project: 'packages/ledger' } }, undefined, 13);
send({ type: 'RUN_SUCCEEDED' }, 'item:building', 13);
send({ type: 'REQUEST_RECEIVED', request: { id: 'in-queue', tier: 0 } }, undefined, 13);
send({ type: 'REQUEST_RECEIVED', request: { id: 'in-queue-2', tier: 0 } }, undefined, 13);
logPrecedents(store);

const bin = fileURLToPath(new URL('../bin/harness.js', import.meta.url));
const page = join(out, 'site', 'mission-control.html');
const { files } = JSON.parse(execFileSync(process.execPath, [bin, 'page', '--dir', store.dir, '--html', page, '--sessions', join(out, 'no-sessions')], { encoding: 'utf8' }));
const pages = [page, ...files.map((f) => join(dirname(page), f))];

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const failures = [];
const warnings = [];
let checked = 0;
for (const file of pages) {
  const name = file.slice(dirname(page).length + 1);
  if (statSync(file).size > 1_000_000) failures.push(`${name}: ${statSync(file).size} bytes, over 1 MB`);
  for (const width of [400, 1200])
    for (const colorScheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme });
      const tab = await ctx.newPage();
      await tab.goto(pathToFileURL(file).href);
      const r = await tab.evaluate(() => ({
        title: document.title,
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
        links: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))
      }));
      const where = `${name} at ${width}px ${colorScheme}`;
      if (!r.title.trim()) failures.push(`${where}: no title`);
      if (r.scroll > r.inner + 1) failures.push(`${where}: scrolls sideways (${r.scroll} > ${r.inner})`);
      if (width === 400 && colorScheme === 'light')
        for (const href of r.links) {
          if (/^(https?:|mailto:|#)/.test(href)) continue;
          const target = fileURLToPath(new URL(href.split('#')[0], pathToFileURL(file)));
          if (!existsSync(target)) failures.push(`${name}: link ${href} goes nowhere`);
        }
      // Screenshots are review material, not the check: retry a failed capture once, then warn and go on.
      const shot = { path: join(shots, `${name.replace(/[/.]/g, '_')}-${width}-${colorScheme}.png`), fullPage: true };
      await tab.screenshot(shot).catch(() => tab.screenshot(shot)).catch((e) => warnings.push(`${where}: no screenshot (${e.message.split('\n')[0]})`));
      await ctx.close();
      checked++;
    }
}
await browser.close();
console.log(`checked ${pages.length} pages in ${checked} views; screenshots in ${shots}`);
for (const w of warnings) console.log(`WARN ${w}`);
for (const f of failures) console.log(`FAIL ${f}`);
if (failures.length) process.exitCode = 1;
