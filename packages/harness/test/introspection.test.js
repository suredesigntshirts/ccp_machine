// The introspection page (#143): where the time and money went, from a history's events.jsonl and usage.jsonl beside
// it (pages/introspection/needs.json reads.with). These tests build usage.jsonl from fixture ledgers and store rows
// with scripts/history/usage.mjs and hold the page's figures to them: each run counted once, a shared lead turn
// counted once, overhead share following the declared roles, a resumed agent one run, and what is left out said.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.js';
import { usageProblems } from '../src/history.js';
import { loadNeeds, checkPage, renderLivePage } from '../src/pages.js';
import { parseLog, costsOf } from '../src/live.js';

const USAGE = fileURLToPath(new URL('../scripts/history/usage.mjs', import.meta.url));
const S = 'aaaaaaaa-0000-5000-8000-000000000001';
// A session the history names (it sent a row) whose ledger was never filed.
const GONE = 'bbbbbbbb-0000-5000-8000-000000000002';
const t = (hm) => `2026-10-29T${hm}:00.000Z`;
const use = (requests, input, cacheRead, cacheWrite, output, cost) => ({ requests, input, cacheRead, cacheWrite, output, cost, unpriced: 0 });

// Builder A of alpha stops at 10:12 and is resumed at 10:25 (one run, two segments). V verifies alpha, C builds beta
// (bound only by its WORKER_STARTED row, so its role is a placeholder), X is tied to no item. Lead turn 1 writes rows
// for alpha and beta, turn 2 for alpha alone. Alpha merges as PR 7.
const A = { agentId: 'a0000000000000001', description: 'Builder: alpha', agentType: 'harness:builder', models: ['claude-opus-5-5'], durationMs: 30 * 60000, tools: 40, ...use(20, 10, 5000, 500, 300, 2) };
const V = { agentId: 'a0000000000000002', description: 'Verifier: alpha', agentType: 'harness:verifier', models: ['claude-sonnet-5-5'], durationMs: 10 * 60000, tools: 9, ...use(5, 4, 2000, 100, 80, 0.5) };
const C = { agentId: 'a0000000000000003', description: 'Builder: beta', agentType: 'harness:builder', models: ['claude-opus-5-5'], durationMs: 5 * 60000, tools: 7, ...use(6, 6, 900, 60, 40, 0.25) };
const X = { agentId: 'a0000000000000004', description: 'An old helper', agentType: 'general-purpose', models: ['claude-sonnet-5-5'], durationMs: 60000, tools: 2, ...use(2, 2, 100, 10, 5, 0.75) };
const T1 = { index: 1, origin: 'peer', label: 'wake', start: t('10:00'), end: t('10:20'), durationMs: 20 * 60000, own: use(10, 100, 1000, 200, 50, 1), subagents: [A, V, C, X], requests: [] };
const T2 = { index: 2, origin: 'peer', label: 'wake', start: t('10:40'), end: t('10:50'), durationMs: 10 * 60000, own: use(4, 20, 400, 40, 30, 0.25), subagents: [A], requests: [] };
const PR = 'https://github.com/suredesigntshirts/ccp_machine/pull/7';
const envelope = (at, to, event, actor = { kind: 'session', id: S }, n = 0) => ({ id: `${event.type}-${at}-${n}`, version: n + 1, at, to, actor, source: { kind: 'cli', ref: 'harness send' }, harness: { version: '0' }, event, provenance: { origin: 'live', from: { source: 'store', ref: 'fixture' } } });

function fixture(scale = 1) {
  const dir = tempDir('harness-introspection-');
  const sessions = join(dir, 'sessions');
  mkdirSync(join(sessions, S, 'agents'), { recursive: true });
  mkdirSync(join(sessions, S, 'calls'), { recursive: true });
  const k = (a) => ({ ...a, cost: a.cost * scale });
  const turns = [{ ...T1, own: k(T1.own), subagents: [A, V, C, X].map(k) }, { ...T2, own: k(T2.own), subagents: [k(A)] }];
  writeFileSync(join(sessions, `${S}.json`), JSON.stringify({ filedAt: t('10:51'), session: { sessionId: S, start: T1.start, end: T2.end, turns } }));
  const agent = (a, at, extra) => writeFileSync(join(sessions, S, 'agents', `${a.agentId}.json`), JSON.stringify({ sessionId: S, agentId: a.agentId, agentType: a.agentType, at, ...extra }));
  agent(A, t('10:01'), { bind: { item: 'alpha', spawn: 'toolu_A', result: 'bound' }, resumes: [t('10:25')] });
  agent(V, t('10:15'), { bind: { item: 'alpha', spawn: 'toolu_V', result: 'bound' } });
  agent(X, t('10:02'), {});
  for (const [id, at] of [['toolu_c1', '10:05'], ['toolu_c2', '10:12'], ['toolu_c3', '10:28']])
    writeFileSync(join(sessions, S, 'calls', `${id}.json`), JSON.stringify({ sessionId: S, toolUseId: id, at: t(at), kind: 'bash', agentId: A.agentId, agentType: A.agentType }));
  const rows = [
    envelope(t('09:59'), { legacy: 'fixture' }, { type: 'REQUEST_RECEIVED', request: { id: 'beta' } }, { kind: 'session', id: GONE }),
    envelope(t('10:00'), 'item:alpha', { type: 'WORKER_SPAWNED', role: 'builder', agentType: 'harness:builder', model: 'opus', toolUseId: 'toolu_A' }),
    envelope(t('10:01'), 'item:alpha', { type: 'WORKER_STARTED', agent: `${S}/${A.agentId}`, agentType: 'harness:builder' }),
    envelope(t('10:14'), 'item:alpha', { type: 'WORKER_SPAWNED', role: 'verifier', agentType: 'harness:verifier', model: 'sonnet', toolUseId: 'toolu_V' }),
    envelope(t('10:15'), 'item:alpha', { type: 'WORKER_STARTED', agent: `${S}/${V.agentId}`, agentType: 'harness:verifier' }),
    envelope(t('10:16'), 'item:beta', { type: 'WORKER_SPAWNED', role: 'builder', agentType: 'harness:builder', model: 'opus', toolUseId: 'toolu_C' }),
    envelope(t('10:17'), 'item:beta', { type: 'WORKER_STARTED', agent: `${S}/${C.agentId}`, agentType: 'harness:builder' }),
    envelope(t('10:30'), 'item:alpha', { type: 'RUN_SUCCEEDED', pr: PR }, { kind: 'agent', id: `${S}/${A.agentId}` }),
    envelope(t('10:45'), 'item:alpha', { type: 'CHECKS_PASSED', pr: PR }),
    envelope(t('10:48'), 'item:alpha', { type: 'MERGED', pr: PR, sha: 'f'.repeat(40) }, { kind: 'github', id: 'suredesigntshirts' })
  ].map((r, n) => ({ ...r, id: `${r.event.type}-${n}`, version: n + 1 }));
  writeFileSync(join(dir, 'events.jsonl'), rows.map((r) => JSON.stringify(r) + '\n').join(''));
  const run = spawnSync(process.execPath, [USAGE, sessions, join(dir, 'events.jsonl')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  writeFileSync(join(dir, 'usage.jsonl'), run.stdout);
  return { usage: parseLog(run.stdout), rows, dir };
}

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const attr = (html, name) => [...html.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((m) => m[1]);
const body = (html) => html.slice(0, html.indexOf('<script'));
const needs = () => loadNeeds('introspection');

test('usage.mjs writes one session row per ledger it read, naming each subagent tied to no item with its cost', () => {
  const { usage } = fixture();
  for (const r of usage) assert.deepEqual(usageProblems(r), [], JSON.stringify(r));
  const sessions = usage.filter((r) => r.kind === 'session');
  assert.deepEqual(sessions.map((r) => r.session), [S]);
  assert.deepEqual(sessions[0].unbound.map((u) => [u.agentId, u.agentType, u.cost]), [[X.agentId, X.agentType, X.cost]]);
  assert.match(sessions[0].unbound[0].reason, /WORKER_STARTED/);
});

test('totals count each run once, a resumed agent is one run, and a lead turn shared by two items once', () => {
  const { usage, rows } = fixture();
  const c = costsOf(usage, rows, needs());
  const total = A.cost + V.cost + C.cost + T1.own.cost + T2.own.cost;
  close(c.total.cost, total);
  assert.equal(c.runs.length, 3, 'A paused and resumed: one run of two segments, not two');
  const a = c.runs.find((r) => r.agentId === A.agentId);
  assert.equal(a.segments.length, 2);
  assert.equal(a.gaps.length, 1);
  close(a.cost, A.cost);
  close(c.total.activeMs, 17 * 60000 + V.durationMs + C.durationMs + T1.durationMs + T2.durationMs);
  // By item: alpha's runs and its own turn; beta's run; the shared turn once, on a row of its own.
  const by = Object.fromEntries(c.items.map((i) => [i.item, i]));
  close(by.alpha.cost, A.cost + V.cost + T2.own.cost);
  close(by.beta.cost, C.cost);
  close(c.shared.cost, T1.own.cost);
  close(c.items.reduce((x, i) => x + i.cost, 0) + c.shared.cost, total);
  assert.deepEqual(by.alpha.lead.map((l) => l.turn), [1, 2], 'a shared turn is listed under each of its items');
  assert.deepEqual(by.beta.lead.map((l) => l.turn), [1]);
  // By role and by model add up to the total, each run once.
  close(Object.values(c.byRole).reduce((x, v) => x + v, 0), total);
  close(Object.values(c.byModel).reduce((x, v) => x + v, 0), total);
  close(c.byRole.lead, T1.own.cost + T2.own.cost);
  // The lead session is one row of the tree, its own cost its turns, with children its agents too.
  assert.equal(c.sessions.length, 1);
  close(c.sessions[0].own.cost, T1.own.cost + T2.own.cost);
  close(c.sessions[0].withChildren, total);
});

test('overhead share follows the roles the needs file declares', () => {
  const { usage, rows } = fixture();
  const n = needs();
  assert.deepEqual(n.view.overheadRoles, ['verifier', 'triager', 'stand-in']);
  const total = A.cost + V.cost + C.cost + T1.own.cost + T2.own.cost;
  close(costsOf(usage, rows, n).overhead.share, V.cost / total);
  const builders = structuredClone(n);
  builders.view.overheadRoles = ['builder'];
  close(costsOf(usage, rows, builders).overhead.share, A.cost / total, 'C\'s role is a placeholder, so it is no builder');
});

test('cost per landed PR, the last hour and day, and what the numbers cannot see', () => {
  const { usage, rows } = fixture();
  const c = costsOf(usage, rows, needs());
  const total = A.cost + V.cost + C.cost + T1.own.cost + T2.own.cost;
  assert.equal(c.landed, 1);
  close(c.perPr, total);
  assert.equal(c.newest, t('10:50'));
  // Rows that ended in the hour before the newest end (09:50 to 10:50): every one here.
  close(c.lastHour, total);
  close(c.lastDay, total);
  assert.deepEqual([c.unbound.count, c.unbound.cost], [1, X.cost]);
  assert.deepEqual(c.noLedger, [GONE]);
  const fields = Object.fromEntries(c.placeholders.map((p) => [p.field, p.count]));
  assert.equal(fields.role, 1, 'C\'s role');
  assert.ok(fields.cost >= 1, 'A\'s first segment keeps its counts on its last');
});

test('the rendered page shows each section from the data, and no dollar figure is typed into the markup', () => {
  const one = fixture(1);
  const two = fixture(2);
  const html = renderLivePage(one.rows, { page: 'introspection', also: { 'usage.jsonl': one.usage }, project: 'chan_x', path: 'harness/history' });
  const page = body(html);
  for (const h of ['Cost by role', 'Cost by model', 'Cost by item', 'Timeline', 'Every run', 'Coverage']) assert.match(page, new RegExp(`<h2>${h}`));
  assert.match(page, /verifier, triager and stand-in/, 'the overhead roles are named');
  assert.deepEqual(attr(page, 'data-pick'), ['alpha', 'beta'], 'each item can be selected');
  assert.match(page, new RegExp(`href="${PR}"`), 'alpha links to its PR');
  assert.ok(attr(page, 'data-toggle').length >= 1, 'a timeline row expands and collapses');
  assert.ok(page.includes('data-hidden-cost'), 'a collapsed row shows the cost of what it hides');
  assert.ok(page.includes('data-waiting'), 'the resumed agent shows its waiting gap');
  const th = [...page.slice(page.indexOf('<h2>Every run')).matchAll(/<th>([^<]*)<\/th>/g)].map((m) => m[1]).slice(0, 14);
  assert.deepEqual(th, ['Run', 'Role', 'Item', 'Model', 'Start', 'Wall', 'Active', 'Requests', 'Input', 'Cache read', 'Cache write', 'Output', 'Own cost', 'With children']);
  assert.match(html, /harness\/history\/usage\.jsonl/, 'the refresh reads usage.jsonl beside the history');
  const dollars = (h) => [...body(h).replace(/<[^>]*>/g, ' ').matchAll(/\$(\d+\.\d\d)/g)].map((m) => Number(m[1]));
  const twice = dollars(renderLivePage(two.rows, { page: 'introspection', also: { 'usage.jsonl': two.usage } }));
  const once = dollars(html);
  assert.ok(once.length > 10);
  assert.deepEqual(twice, once.map((x) => Math.round(x * 200) / 100), 'doubling every cost doubles every dollar figure');
});

test('the introspection page meets its needs: fields the schema declares, roles the spec names, and nothing it does not declare', () => {
  const { usage, rows } = fixture();
  assert.deepEqual(checkPage('introspection', { history: rows, also: { 'usage.jsonl': usage } }), []);
  const n = needs();
  assert.deepEqual(Object.keys(n.reads.with), ['usage.jsonl']);
  const lacking = structuredClone(n);
  lacking.reads.with['usage.jsonl'].push('tokensGuessed');
  assert.ok(checkPage('introspection', { history: rows, also: { 'usage.jsonl': usage }, needs: lacking }).some((p) => p.startsWith('introspection: ') && p.includes('tokensGuessed')));
  const role = structuredClone(n);
  role.view.overheadRoles.push('critic');
  assert.ok(checkPage('introspection', { history: rows, needs: role }).some((p) => p.startsWith('introspection: ') && p.includes('critic')));
  const narrow = structuredClone(n);
  narrow.reads.with['usage.jsonl'] = narrow.reads.with['usage.jsonl'].filter((f) => f !== 'cost');
  assert.ok(checkPage('introspection', { history: rows, also: { 'usage.jsonl': usage }, needs: narrow }).some((p) => p.includes('usage.jsonl field cost')), 'a field the page reads and does not declare fails');
});

test('a page without usage.jsonl beside the history shows the banner and no figures', () => {
  const { rows } = fixture();
  const page = body(renderLivePage(rows, { page: 'introspection' }));
  assert.match(page, /class="banner bad"/);
  assert.match(page, /usage\.jsonl/);
  assert.doesNotMatch(page, /<h2>Cost by role/);
});
