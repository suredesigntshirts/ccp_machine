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
import { openStore, init, apply, cardAddress, logPrecedents } from '../src/index.js';
import { scripted, postAndTap, verifyHead, SIM_HEAD, contractStore, contractHistory } from '../src/sim.js';

const { values: o } = parseArgs({ options: { out: { type: 'string' }, shots: { type: 'string' } } });
// Everything goes to a temp folder unless --out or --shots names another.
const out = o.out ?? mkdtempSync(join(tmpdir(), 'harness-pages-'));
const shots = o.shots ?? join(out, 'shots');
mkdirSync(shots, { recursive: true });

// A fixture with every kind of row: merged, cancelled, in flight, queued, one decision waiting on the person
// and one item waiting on the person because triage gave it no criteria (needsCriteria).
const store = openStore(join(out, 'store'));
init(store, { wipLimit: 3 }, '2026-10-26T08:00:00Z');
const at = (h) => `2026-10-26T${String(h).padStart(2, '0')}:00:00Z`;
const send = (event, to, h, id) => {
  const r = apply(store, { ...event, ...scripted(event.type, id ?? 'fixture') }, { to, now: at(h), id });
  if (r.refused) throw new Error(`fixture: ${r.why}`);
};
// The host posts the card the decision asked for (its ack names the message id), and the person taps it.
const tap = (choice, to, h) => {
  const r = postAndTap(store, store.pending().find((e) => e.name === 'postDecisionCard' && cardAddress(e) === to), choice, { now: at(h) });
  if (r.refused) throw new Error(`fixture: ${r.why}`);
};
const sure = { choice: 'approve', confidence: 0.95, reason: 'small and covered by tests' };
const pr = 'https://github.com/suredesigntshirts/ccp_machine_test/pull/1';
send({ type: 'ORCHESTRATOR_STARTED' }, undefined, 8);
send({ type: 'REQUEST_RECEIVED', request: { id: 'merged-item', title: 'A merged change with a long title that has to wrap on a phone screen without scrolling sideways', project: 'packages/harness', url: pr, expect: 'It merges' } }, undefined, 8);
send({ type: 'TRIAGED', tier: 1, criteria: ['It merges'] }, 'item:merged-item', 8);
send({ type: 'STAND_IN_ANSWERED', answer: sure }, 'item:merged-item/decision:merged-item:plan:1', 9);
tap('approve', 'item:merged-item/decision:merged-item:plan:1', 9);
send({ type: 'RUN_SUCCEEDED', pr }, 'item:merged-item', 9);
send({ type: 'CRITERION_CHECKED', criterion: 'It merges', verdict: 'met', evidence: 'CI green on the PR' }, 'item:merged-item', 10);
send({ type: 'CHECKS_PASSED', pr }, 'item:merged-item', 10);
send({ type: 'STAND_IN_ANSWERED', answer: sure }, 'item:merged-item/decision:merged-item:accept:2', 10);
tap('approve', 'item:merged-item/decision:merged-item:accept:2', 10);
verifyHead(store, 'item:merged-item', { now: at(10) });
send({ type: 'MERGED', pr, sha: SIM_HEAD }, 'item:merged-item', 10);
send({ type: 'REQUEST_RECEIVED', request: { id: 'needs-you', title: 'A tier-2 change', project: 'packages/harness' } }, undefined, 11);
send({ type: 'TRIAGED', tier: 2, criteria: ['it works'] }, 'item:needs-you', 11);
send({ type: 'STAND_IN_ANSWERED', answer: { ...sure, choice: 'revise', reason: 'too big for one PR' } }, 'item:needs-you/decision:needs-you:plan:1', 11);
send({ type: 'REQUEST_RECEIVED', request: { id: 'dropped' } }, undefined, 12);
send({ type: 'TRIAGED', tier: 2, criteria: ['it works'] }, 'item:dropped', 12);
send({ type: 'STAND_IN_ANSWERED', answer: sure }, 'item:dropped/decision:dropped:plan:1', 12);
tap('reject', 'item:dropped/decision:dropped:plan:1', 12);
send({ type: 'REQUEST_RECEIVED', request: { id: 'building', project: 'packages/ledger' } }, undefined, 13);
send({ type: 'TRIAGED', tier: 0, criteria: ['it works'] }, 'item:building', 13);
send({ type: 'REQUEST_RECEIVED', request: { id: 'no-criteria', title: 'Make the harness better', project: 'packages/harness' } }, undefined, 13);
send({ type: 'TRIAGED', tier: 1, criteria: [] }, 'item:no-criteria', 13);
send({ type: 'REQUEST_RECEIVED', request: { id: 'in-queue' } }, undefined, 13);
send({ type: 'REQUEST_RECEIVED', request: { id: 'in-queue-2' } }, undefined, 13);
logPrecedents(store);

const bin = fileURLToPath(new URL('../bin/harness.js', import.meta.url));
const page = join(out, 'site', 'mission-control.html');
const { files } = JSON.parse(execFileSync(process.execPath, [bin, 'page', '--dir', store.dir, '--html', page, '--sessions', join(out, 'no-sessions')], { encoding: 'utf8' }));
const pages = [page, ...files.map((f) => join(dirname(page), f))];

// The needsCriteria item is counted and listed under Needs you, beside the decision that waits on the person.
const failures = [];
{
  const html = readFileSync(page, 'utf8');
  const needsYou = html.slice(html.indexOf('<h2>Needs you'), html.indexOf('<h2>In flight'));
  if (!/<span class="eyebrow">Needs you<\/span><b>2<\/b>/.test(html)) failures.push('mission-control.html: Needs you does not count the needsCriteria item and the decision (2)');
  if (!needsYou.includes('Make the harness better') || !needsYou.includes('no criteria')) failures.push('mission-control.html: the needsCriteria item is not listed under Needs you');
}

const { chromium } = await import('playwright');
const browser = await chromium.launch();
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

// The live pages, on data the current code builds: live mission control on the sim's contract store, and the
// ledger on that store as a history (extract-store.mjs and join.mjs). The page script runs here with a stand-in for
// the Artifact runtime: files.read serves the page's file (or one whose schemaVersion the page does not read) and db
// keeps the timing rows. Pressing Refresh must read the file, re-render, show the new age and record one row with
// the data's size; an unsupported schemaVersion must show the red banner and no table.
const { store: liveStore } = await contractStore(join(out, 'live-store'));
const { dir: historyDir } = await contractHistory(join(out, 'live-history'));
const stateText = readFileSync(join(liveStore.dir, 'state.json'), 'utf8');
const historyText = readFileSync(join(historyDir, 'events.jsonl'), 'utf8');
const historyRows = historyText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const LIVE = [
  { page: 'mission-control', dir: liveStore.dir, files: 'harness/state/check/state.json', size: JSON.parse(stateText).version,
    variants: [['current', stateText, false], ['unsupported schemaVersion', JSON.stringify({ ...JSON.parse(stateText), schemaVersion: 99, version: 1e6 }), true]] },
  { page: 'ledger', dir: historyDir, files: 'harness/state/check/events.jsonl', size: historyRows.length,
    variants: [['current', historyText, false], ['unsupported schemaVersion', historyRows.map((r) => JSON.stringify({ ...r, schemaVersion: 99 }) + '\n').join(''), true]] }
];
const fakeRuntime = ({ text, path }) => {
  const rows = [];
  window.__rows = rows;
  window.__reads = [];
  const db = { collection: (name) => ({
    add: async (row) => { rows.push({ name, ...row }); return { id: `r${rows.length}` }; },
    orderBy: () => ({ limit: () => ({ get: async () => ({ docs: rows.filter((r) => r.name === name).slice().reverse().map((r) => ({ data: () => r })) }) }) })
  }) };
  const files = { read: async (p) => { window.__reads.push(p); if (p !== path) throw { code: 'not_found', message: p }; const bytes = new TextEncoder().encode(text); return { bytes, size: bytes.length, revision: '1' }; } };
  window.claude = { use: async (name) => (name === 'files' ? files : name === 'db' ? db : null) };
};
for (const live of LIVE) {
  const livePage = join(out, 'site', `${live.page}-live.html`);
  execFileSync(process.execPath, [bin, 'page', '--live', '--page', live.page, '--standalone', '--dir', live.dir, '--html', livePage, '--project', 'chan_check', '--files-path', 'harness/state/check'], { encoding: 'utf8' });
for (const [label, text, expectBanner] of live.variants) {
  for (const width of [400, 1200])
    for (const colorScheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme });
      const tab = await ctx.newPage();
      const errors = [];
      tab.on('pageerror', (e) => errors.push(e.message));
      await tab.addInitScript(fakeRuntime, { text, path: live.files });
      await tab.goto(pathToFileURL(livePage).href);
      const where = `${live.page}-live.html (${label}) at ${width}px ${colorScheme}`;
      const before = await tab.evaluate(() => ({ age: document.getElementById('data-age').textContent, reads: window.__reads.length, rows: window.__rows.length }));
      if (before.reads || before.rows) failures.push(`${where}: read the store or recorded a refresh before Refresh was pressed`);
      await tab.click('#refresh');
      await tab.waitForFunction(() => /Refreshed|Read in|Not refreshed/.test(document.getElementById('refresh-msg').textContent) && window.__rows.length > 0, null, { timeout: 5000 }).catch(() => {});
      const r = await tab.evaluate(() => ({
        title: document.title,
        msg: document.getElementById('refresh-msg').textContent,
        age: document.getElementById('data-age').textContent,
        banner: Boolean(document.querySelector('#view .banner.bad')),
        tables: document.querySelectorAll('#view table').length,
        rows: window.__rows,
        trend: document.querySelectorAll('#trend tr').length,
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth
      }));
      const row = r.rows[0];
      if (!r.title.trim()) failures.push(`${where}: no title`);
      if (r.scroll > r.inner + 1) failures.push(`${where}: scrolls sideways (${r.scroll} > ${r.inner})`);
      if (errors.length) failures.push(`${where}: script error ${errors[0]}`);
      if (r.rows.length !== 1 || row.name !== 'refreshes' || typeof row.ms !== 'number' || !row.at || row.page !== live.page) failures.push(`${where}: the refresh did not record one timing row (${JSON.stringify(r.rows)})`);
      if (r.trend < 2) failures.push(`${where}: the refresh trend does not show the recorded row`);
      if (expectBanner) {
        if (!r.banner || r.tables) failures.push(`${where}: no red banner, or data shown under it`);
        if (row?.ok !== false || row?.schemaVersion !== 99) failures.push(`${where}: the timing row does not record the unsupported schemaVersion (${JSON.stringify(row)})`);
      } else {
        if (r.banner || !r.tables) failures.push(`${where}: the refreshed page shows no data`);
        if (!/^Refreshed in \d+ ms/.test(r.msg)) failures.push(`${where}: refresh message "${r.msg}"`);
        if (r.age === before.age && !/v\d+|\d+ rows/.test(r.age)) failures.push(`${where}: the data age did not update`);
        if (row?.storeVersion !== live.size || typeof row?.bytes !== 'number' || row?.ok !== true) failures.push(`${where}: the timing row does not name the size it rendered (${JSON.stringify(row)})`);
      }
      const shot = { path: join(shots, `${live.page}-live-${label.replace(/\W+/g, '_')}-${width}-${colorScheme}.png`), fullPage: true };
      await tab.screenshot(shot).catch((e) => warnings.push(`${where}: no screenshot (${e.message.split('\n')[0]})`));
      await ctx.close();
      checked++;
    }
}
}
await browser.close();
console.log(`checked ${pages.length + LIVE.length} pages in ${checked} views; screenshots in ${shots}`);
for (const w of warnings) console.log(`WARN ${w}`);
for (const f of failures) console.log(`FAIL ${f}`);
if (failures.length) process.exitCode = 1;
