#!/usr/bin/env node
// pages:check: render every harness page from a fixture store and open each in Chromium, so a page
// change cannot quietly break what the person reads. Fails on horizontal scroll, a broken link, a
// missing title or a page over 1 MB, at 400 and 1200 px wide in light and dark.
import { mkdtempSync, existsSync, statSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
// Time and tokens: a session ledger for the history's agents (its first agent stops after a call and is resumed),
// built into usage.jsonl by usage.mjs, which the ledger page reads when an item's section is opened.
const sessionsDir = join(out, 'live-sessions');
const started = historyRows.filter((r) => r.event.type === 'WORKER_STARTED');
const lead = started[0].event.agent.split('/')[0];
const plus = (iso, m) => new Date(Date.parse(iso) + m * 60000).toISOString();
const counts = (n) => ({ requests: n, input: n, cacheRead: 1000 * n, cacheWrite: 100 * n, output: 10 * n, cost: n / 10, unpriced: 0 });
const agents = started.map((r, i) => ({ agentId: r.event.agent.split('/')[1], description: '', agentType: r.event.agentType, models: ['claude-opus-5-5'], durationMs: 8 * 60000, tools: 1, ...counts(5 + i) }));
mkdirSync(join(sessionsDir, lead, 'agents'), { recursive: true });
mkdirSync(join(sessionsDir, lead, 'calls'), { recursive: true });
writeFileSync(join(sessionsDir, `${lead}.json`), JSON.stringify({ session: { sessionId: lead, turns: [{ index: 1, start: historyRows[0].at, end: historyRows.at(-1).at, durationMs: Date.parse(historyRows.at(-1).at) - Date.parse(historyRows[0].at), own: counts(3), subagents: agents }] } }));
writeFileSync(join(sessionsDir, lead, 'agents', `${agents[0].agentId}.json`), JSON.stringify({ sessionId: lead, agentId: agents[0].agentId, agentType: agents[0].agentType, at: started[0].at, resumes: [plus(started[0].at, 5)] }));
writeFileSync(join(sessionsDir, lead, 'calls', 'toolu_check.json'), JSON.stringify({ sessionId: lead, toolUseId: 'toolu_check', at: plus(started[0].at, 2), kind: 'bash', agentId: agents[0].agentId }));
const usageText = execFileSync(process.execPath, [fileURLToPath(new URL('./history/usage.mjs', import.meta.url)), sessionsDir, join(historyDir, 'events.jsonl')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const usageItem = /^item:(.+)$/.exec(started[0].to)[1];
// The introspection page reads usage.jsonl beside the history at render and on refresh (reads.with).
writeFileSync(join(historyDir, 'usage.jsonl'), usageText);
const LIVE = [
  { page: 'mission-control', dir: liveStore.dir, files: 'harness/state/check/state.json', size: JSON.parse(stateText).version,
    variants: [['current', stateText, false], ['unsupported schemaVersion', JSON.stringify({ ...JSON.parse(stateText), schemaVersion: 99, version: 1e6 }), true]] },
  { page: 'ledger', dir: historyDir, files: 'harness/state/check/events.jsonl', size: historyRows.length, usage: { 'harness/state/check/usage.jsonl': usageText },
    variants: [['current', historyText, false], ['unsupported schemaVersion', historyRows.map((r) => JSON.stringify({ ...r, schemaVersion: 99 }) + '\n').join(''), true]] },
  { page: 'introspection', dir: historyDir, files: 'harness/state/check/events.jsonl', size: historyRows.length, more: { 'harness/state/check/usage.jsonl': usageText },
    variants: [['current', historyText, false], ['unsupported schemaVersion', historyRows.map((r) => JSON.stringify({ ...r, schemaVersion: 99 }) + '\n').join(''), true]] }
];
const fakeRuntime = ({ text, path, more }) => {
  const rows = [];
  window.__rows = rows;
  window.__reads = [];
  const db = { collection: (name) => ({
    add: async (row) => { rows.push({ name, ...row }); return { id: `r${rows.length}` }; },
    orderBy: () => ({ limit: () => ({ get: async () => ({ docs: rows.filter((r) => r.name === name).slice().reverse().map((r) => ({ data: () => r })) }) }) })
  }) };
  const served = { ...more, [path]: text };
  const files = { read: async (p) => { window.__reads.push(p); if (!(p in served)) throw { code: 'not_found', message: p }; const bytes = new TextEncoder().encode(served[p]); return { bytes, size: bytes.length, revision: '1' }; } };
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
      // Once without the usage file (light, 400 px): its section must say so and leave the page as it is.
      const lacking = live.usage && width === 400 && colorScheme === 'light';
      await tab.addInitScript(fakeRuntime, { text, path: live.files, more: lacking ? {} : live.usage ?? live.more ?? {} });
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
      if (live.usage && !expectBanner) {
        await tab.click(`details[data-usage="${usageItem}"] summary`);
        await tab.waitForFunction((i) => /data-run|data-usage-error/.test(document.querySelector(`details[data-usage="${i}"] [data-usage-body]`).innerHTML), usageItem, { timeout: 5000 }).catch(() => {});
        const u = await tab.evaluate((i) => { const d = document.querySelector(`details[data-usage="${i}"]`); d.scrollIntoView(); return { runs: d.querySelectorAll('[data-run]').length, segments: d.querySelectorAll('[data-segment]').length, waiting: d.querySelectorAll('[data-waiting]').length, error: Boolean(d.querySelector('[data-usage-error]')), tables: document.querySelectorAll('#view table').length, scroll: document.documentElement.scrollWidth, inner: window.innerWidth }; }, usageItem);
        if (lacking ? !u.error || u.tables < 2 : u.error || u.runs !== 1 || u.segments !== 2 || !u.waiting) failures.push(`${where}: the Time and tokens section of ${usageItem} ${lacking ? 'does not say usage.jsonl cannot be read, or the page lost its tables' : 'does not show one run of two segments with a waiting gap'} (${JSON.stringify(u)})`);
        if (u.scroll > u.inner + 1) failures.push(`${where}: scrolls sideways with Time and tokens open (${u.scroll} > ${u.inner})`);
        await tab.screenshot({ path: join(shots, `${live.page}-live-usage${lacking ? '-unreadable' : ''}-${width}-${colorScheme}.png`) }).catch((e) => warnings.push(`${where}: no usage screenshot (${e.message.split('\n')[0]})`));
      }
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
// The introspection page (#143) at 390 and 1280 px, light and dark: a session row of the timeline expands (its runs
// shown, what it hid no longer said) and collapses again, an item selected shows its runs and lead turns, and
// nothing scrolls sideways: the tables and the timeline scroll inside their own box.
{
  const page = join(out, 'site', 'introspection-live.html');
  for (const width of [390, 1280])
    for (const colorScheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme });
      const tab = await ctx.newPage();
      const errors = [];
      tab.on('pageerror', (e) => errors.push(e.message));
      await tab.goto(pathToFileURL(page).href);
      const where = `introspection-live.html at ${width}px ${colorScheme}`;
      const state = () => tab.evaluate(() => {
        const t = document.querySelector('[data-toggle]');
        const id = t && t.dataset.toggle;
        return { toggle: Boolean(t), runs: [...document.querySelectorAll('[data-parent]')].filter((r) => r.dataset.parent === id && r.offsetParent).length,
          hides: [...document.querySelectorAll('[data-hides]')].some((h) => h.dataset.hides === id && h.offsetParent),
          details: [...document.querySelectorAll('[data-detail]')].filter((d) => d.offsetParent).map((d) => d.dataset.detail),
          scroll: document.documentElement.scrollWidth, inner: window.innerWidth };
      });
      const shut = await state();
      if (!shut.toggle || shut.runs || !shut.hides) failures.push(`${where}: the timeline has no collapsed session row that says what it hides (${JSON.stringify(shut)})`);
      await tab.click('[data-toggle]');
      const open = await state();
      if (!open.runs || open.hides) failures.push(`${where}: expanding a session row does not show its runs (${JSON.stringify(open)})`);
      await tab.screenshot({ path: join(shots, `introspection-live-expanded-${width}-${colorScheme}.png`), fullPage: true }).catch((e) => warnings.push(`${where}: no screenshot (${e.message.split('\n')[0]})`));
      await tab.click('[data-toggle]');
      const again = await state();
      if (again.runs || !again.hides) failures.push(`${where}: collapsing a session row does not hide its runs (${JSON.stringify(again)})`);
      const item = await tab.getAttribute('[data-pick]', 'data-pick');
      await tab.click('[data-pick]');
      const picked = await state();
      if (JSON.stringify(picked.details) !== JSON.stringify([item])) failures.push(`${where}: selecting ${item} does not show its runs and lead turns alone (${JSON.stringify(picked.details)})`);
      for (const s of [shut, open, again, picked]) if (s.scroll > s.inner + 1) { failures.push(`${where}: scrolls sideways (${s.scroll} > ${s.inner})`); break; }
      if (errors.length) failures.push(`${where}: script error ${errors[0]}`);
      await tab.screenshot({ path: join(shots, `introspection-live-item-${width}-${colorScheme}.png`), fullPage: true }).catch((e) => warnings.push(`${where}: no screenshot (${e.message.split('\n')[0]})`));
      await ctx.close();
      checked++;
    }
}
// The design log's paging and calendar (#131), clicked through in the browser on a history of more than 50 rows over
// five days in two months: page 2 and back, a September day's rows and cards, the busiest day's second page, all days.
{
  const fixture = fileURLToPath(new URL('../test/fixtures/history-design-log/', import.meta.url));
  const logPage = join(out, 'site', 'design-log-live.html');
  execFileSync(process.execPath, [bin, 'page', '--live', '--page', 'design-log', '--standalone', '--dir', fixture, '--html', logPage], { encoding: 'utf8' });
  const steps = [
    [null, 50, 3, 'page 1 of 2 · rows 1 to 50 of 91', '2026-10'],
    ['[data-page="next"]', 41, 3, 'page 2 of 2 · rows 51 to 91 of 91', '2026-10'],
    ['[data-page="first"]', 50, 3, 'page 1 of 2 · rows 1 to 50 of 91', '2026-10'],
    ['[data-month="prev"]', 50, 3, 'page 1 of 2 · rows 1 to 50 of 91', '2026-09'],
    ['[data-day="2026-09-30"]', 20, 2, 'page 1 of 1 · rows 1 to 20 of 20', '2026-09'],
    ['[data-month="next"]', 20, 2, 'page 1 of 1 · rows 1 to 20 of 20', '2026-10'],
    ['[data-day="2026-10-28"]', 50, 1, 'page 1 of 2 · rows 1 to 50 of 54', '2026-10'],
    ['[data-page="last"]', 4, 1, 'page 2 of 2 · rows 51 to 54 of 54', '2026-10'],
    ['[data-day=""]', 50, 3, 'page 1 of 2 · rows 1 to 50 of 91', '2026-10']
  ];
  for (const width of [390, 1280])
    for (const colorScheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme });
      const tab = await ctx.newPage();
      const errors = [];
      tab.on('pageerror', (e) => errors.push(e.message));
      await tab.goto(pathToFileURL(logPage).href);
      const where = `design-log-live.html at ${width}px ${colorScheme}`;
      for (const [click, rows, cards, pos, month] of steps) {
        if (click) await tab.click(`#view ${click}:visible`);
        const r = await tab.evaluate(() => ({
          rows: [...document.querySelectorAll('#view tr[data-on]')].filter((x) => x.offsetParent).length,
          cards: [...document.querySelectorAll('#view [data-oob]')].filter((x) => x.offsetParent).length,
          pos: document.querySelector('#view [data-pos]').textContent,
          month: [...document.querySelectorAll('#view [data-cal]')].filter((x) => x.offsetParent).map((x) => x.dataset.cal).join(),
          scroll: document.documentElement.scrollWidth,
          inner: window.innerWidth
        }));
        const got = [r.rows, r.cards, r.pos, r.month];
        if (JSON.stringify(got) !== JSON.stringify([rows, cards, pos, month])) failures.push(`${where}: after ${click ?? 'opening'}, ${JSON.stringify(got)}, not ${JSON.stringify([rows, cards, pos, month])}`);
        if (r.scroll > r.inner + 1) failures.push(`${where}: after ${click ?? 'opening'}, scrolls sideways (${r.scroll} > ${r.inner})`);
        if (click === '[data-day="2026-09-30"]') await tab.screenshot({ path: join(shots, `design-log-live-day-${width}-${colorScheme}.png`), fullPage: true }).catch((e) => warnings.push(`${where}: no screenshot (${e.message.split('\n')[0]})`));
      }
      if (errors.length) failures.push(`${where}: script error ${errors[0]}`);
      await tab.screenshot({ path: join(shots, `design-log-live-${width}-${colorScheme}.png`), fullPage: true }).catch((e) => warnings.push(`${where}: no screenshot (${e.message.split('\n')[0]})`));
      await ctx.close();
      checked++;
    }
}
await browser.close();
console.log(`checked ${pages.length + LIVE.length + 1} pages in ${checked} views; screenshots in ${shots}`);
for (const w of warnings) console.log(`WARN ${w}`);
for (const f of failures) console.log(`FAIL ${f}`);
if (failures.length) process.exitCode = 1;
