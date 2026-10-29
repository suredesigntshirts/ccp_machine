// Time and tokens by item on the ledger page (#132). scripts/history/usage.mjs joins the session ledgers the Stop
// hook files (turns, their own usage and the subagents each started), the agents' bindings and call records beside
// them and the store's WORKER_SPAWNED and WORKER_STARTED rows into usage.jsonl (history.schema.json usage); the
// ledger page reads that file only when a viewer opens an item's "Time and tokens" section. These tests build it
// from fixture ledgers and store rows and check the runs, segments, lead turns and totals the section shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.js';
import { HISTORY, usageProblems } from '../src/history.js';
import { loadNeeds, checkPage, renderLivePage } from '../src/pages.js';
import { parseLog, usageOf, renderUsage } from '../src/live.js';

const USAGE = fileURLToPath(new URL('../scripts/history/usage.mjs', import.meta.url));
const GOLDEN = fileURLToPath(new URL('./fixtures/history-golden/events.jsonl', import.meta.url));
const S = 'aaaaaaaa-0000-5000-8000-000000000001';
const t = (hm) => `2026-10-29T${hm}:00.000Z`;
const use = (requests, input, cacheRead, cacheWrite, output, cost) => ({ requests, input, cacheRead, cacheWrite, output, cost, unpriced: 0 });
const tokens = (u) => u.input + u.cacheRead + u.cacheWrite + u.output;

// The builder A of item alpha stops at 10:12 (its last recorded call) and is resumed at 10:25; the ledger lists it
// twice (the same transcript filed again), with the counts of its whole transcript each time. V verifies alpha. C
// builds beta, bound only by its WORKER_STARTED row. X is bound to nothing. Turn 1 of the lead writes rows for alpha
// and beta, turn 2 for alpha alone.
const A = { agentId: 'a0000000000000001', description: 'Builder: alpha', agentType: 'harness:builder', models: ['claude-opus-5-5'], durationMs: 30 * 60000, tools: 40, ...use(20, 10, 5000, 500, 300, 2) };
const V = { agentId: 'a0000000000000002', description: 'Verifier: alpha', agentType: 'harness:verifier', models: ['claude-sonnet-5-5'], durationMs: 10 * 60000, tools: 9, ...use(5, 4, 2000, 100, 80, 0.5) };
const C = { agentId: 'a0000000000000003', description: 'Builder: beta', agentType: 'harness:builder', models: ['claude-opus-5-5'], durationMs: 5 * 60000, tools: 7, ...use(6, 6, 900, 60, 40, 0.25) };
const X = { agentId: 'a0000000000000004', description: 'An old helper', agentType: 'general-purpose', models: ['claude-sonnet-5-5'], durationMs: 60000, tools: 2, ...use(2, 2, 100, 10, 5, 0.01) };
const T1 = { index: 1, origin: 'peer', label: 'wake', start: t('10:00'), end: t('10:20'), durationMs: 20 * 60000, own: use(10, 100, 1000, 200, 50, 1), subagents: [A, V, C, X], requests: [] };
const T2 = { index: 2, origin: 'peer', label: 'wake', start: t('10:40'), end: t('10:50'), durationMs: 10 * 60000, own: use(4, 20, 400, 40, 30, 0.25), subagents: [A], requests: [] };
const row = (at, to, event, actor = { kind: 'session', id: S }) => ({ id: `${event.type}-${at}`, at, to, actor, source: { kind: 'cli', ref: 'harness send' }, event });

function fixture() {
  const dir = tempDir('harness-usage-');
  const sessions = join(dir, 'sessions');
  mkdirSync(join(sessions, S, 'agents'), { recursive: true });
  mkdirSync(join(sessions, S, 'calls'), { recursive: true });
  writeFileSync(join(sessions, `${S}.json`), JSON.stringify({ filedAt: t('10:51'), session: { sessionId: S, start: T1.start, end: T2.end, turns: [T1, T2] } }));
  const agent = (a, at, extra) => writeFileSync(join(sessions, S, 'agents', `${a.agentId}.json`), JSON.stringify({ sessionId: S, agentId: a.agentId, agentType: a.agentType, at, ...extra }));
  agent(A, t('10:01'), { bind: { item: 'alpha', spawn: 'toolu_A', result: 'bound' }, resumes: [t('10:25')] });
  agent(V, t('10:15'), { bind: { item: 'alpha', spawn: 'toolu_V', result: 'bound' } });
  agent(X, t('10:02'), {});
  for (const [id, at] of [['toolu_c1', '10:05'], ['toolu_c2', '10:12'], ['toolu_c3', '10:28']])
    writeFileSync(join(sessions, S, 'calls', `${id}.json`), JSON.stringify({ sessionId: S, toolUseId: id, at: t(at), kind: 'bash', agentId: A.agentId, agentType: A.agentType }));
  const rows = [
    row(t('10:00'), 'item:alpha', { type: 'WORKER_SPAWNED', role: 'builder', agentType: 'harness:builder', model: 'opus', toolUseId: 'toolu_A' }),
    row(t('10:01'), 'item:alpha', { type: 'WORKER_STARTED', agent: `${S}/${A.agentId}`, agentType: 'harness:builder' }),
    row(t('10:14'), 'item:alpha', { type: 'WORKER_SPAWNED', role: 'verifier', agentType: 'harness:verifier', model: 'sonnet', toolUseId: 'toolu_V' }),
    row(t('10:15'), 'item:alpha', { type: 'WORKER_STARTED', agent: `${S}/${V.agentId}`, agentType: 'harness:verifier' }),
    row(t('10:16'), 'item:beta', { type: 'WORKER_SPAWNED', role: 'builder', agentType: 'harness:builder', model: 'opus', toolUseId: 'toolu_C' }),
    row(t('10:17'), 'item:beta', { type: 'WORKER_STARTED', agent: `${S}/${C.agentId}`, agentType: 'harness:builder' }),
    row(t('10:30'), 'item:alpha', { type: 'RUN_SUCCEEDED', pr: 'https://example.test/pr/1' }, { kind: 'agent', id: `${S}/${A.agentId}` }),
    row(t('10:45'), 'item:alpha', { type: 'CHECKS_PASSED', pr: 'https://example.test/pr/1' })
  ];
  writeFileSync(join(dir, 'events.jsonl'), rows.map((r) => JSON.stringify(r) + '\n').join(''));
  const run = spawnSync(process.execPath, [USAGE, sessions, join(dir, 'events.jsonl')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return { usage: parseLog(run.stdout), report: parseLog(run.stderr), dir };
}

const attr = (html, name) => [...html.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((m) => m[1]);

test('usage.mjs writes one row per agent segment and per lead turn, each a usage row history.schema.json declares', () => {
  const { usage } = fixture();
  assert.equal(HISTORY.usage.file, 'usage.jsonl');
  for (const r of usage) assert.deepEqual(usageProblems(r), [], JSON.stringify(r));
  const segs = usage.filter((r) => r.kind === 'segment');
  assert.deepEqual(segs.map((r) => [r.item, r.agentId, r.segment]).sort(), [['alpha', A.agentId, 1], ['alpha', A.agentId, 2], ['alpha', V.agentId, 1], ['beta', C.agentId, 1]].sort());
  const v = segs.find((r) => r.agentId === V.agentId);
  // Start is the WORKER_STARTED time and end is start plus durationMs; the model is the ledger's, the role the spawn's.
  assert.deepEqual({ start: v.start, end: v.end, activeMs: v.activeMs, role: v.role, model: v.model, agentType: v.agentType, session: v.session }, { start: t('10:15'), end: t('10:25'), activeMs: V.durationMs, role: 'verifier', model: 'claude-sonnet-5-5', agentType: 'harness:verifier', session: S });
  assert.deepEqual([v.requests, v.input, v.cacheRead, v.cacheWrite, v.output, v.cost], [V.requests, V.input, V.cacheRead, V.cacheWrite, V.output, V.cost]);
  // C has no binding file: its item is its WORKER_STARTED row's, and no spawn names it, so its role is a placeholder.
  const c = segs.find((r) => r.agentId === C.agentId);
  assert.equal(c.item, 'beta');
  assert.equal(typeof c.role.legacy, 'string', JSON.stringify(c.role));
});

test('an agent that paused and resumed is one run with two segments and a waiting gap, its tokens counted once', () => {
  const { usage } = fixture();
  const segs = usage.filter((r) => r.agentId === A.agentId).sort((a, b) => a.segment - b.segment);
  assert.equal(segs.length, 2, 'one segment per start: the first and the resume, not one per ledger listing');
  assert.deepEqual(segs.map((s) => [s.start, s.end]), [[t('10:01'), t('10:12')], [t('10:25'), t('10:31')]]);
  const { runs } = usageOf(usage, 'alpha');
  const run = runs.find((r) => r.agentId === A.agentId);
  assert.equal(run.segments.length, 2);
  assert.equal(run.wallMs, A.durationMs, 'wall span: first start to last end');
  assert.equal(run.activeMs, 17 * 60000, 'active: the sum of the segments');
  assert.deepEqual(run.gaps.map((g) => [g.from, g.to]), [[t('10:12'), t('10:25')]]);
  assert.equal(run.tokens, tokens(A), 'tokens of the agent once, though the ledger lists it twice and it ran twice');
  assert.equal(run.cost, A.cost);
  const html = renderUsage(usage, 'alpha');
  const one = html.slice(html.indexOf(`data-run="${S}/${A.agentId}"`));
  assert.match(one, /data-waiting/);
  assert.match(html, /waiting/);
  assert.equal(attr(html, 'data-segment').filter((x) => x.startsWith(`${S}/${A.agentId}#`)).length, 2, 'one bar per segment on the timeline');
});

test('an item\'s runs and totals; a lead turn shared by two items is listed under both, named, and counted once in the page total', () => {
  const { usage } = fixture();
  const alpha = usageOf(usage, 'alpha');
  const beta = usageOf(usage, 'beta');
  assert.deepEqual(alpha.lead.map((l) => [l.turn, l.shared]), [[1, ['beta']], [2, []]]);
  assert.deepEqual(beta.lead.map((l) => [l.turn, l.shared]), [[1, ['alpha']]]);
  // An item's total: its runs and its own lead turns; a shared turn is shown, and in neither item's total.
  assert.equal(alpha.total.tokens, tokens(A) + tokens(V) + tokens(T2.own));
  assert.equal(beta.total.tokens, tokens(C));
  assert.equal(Math.round(alpha.total.cost * 100), Math.round((A.cost + V.cost + T2.own.cost) * 100));
  // The page total counts every run and every lead turn once.
  const all = tokens(A) + tokens(V) + tokens(C) + tokens(T1.own) + tokens(T2.own);
  assert.equal(alpha.all.tokens, all);
  assert.equal(beta.all.tokens, all);
  const html = renderUsage(usage, 'alpha');
  assert.match(html, /lead turns/i);
  assert.deepEqual(attr(html, 'data-lead'), [`${S}#1`, `${S}#2`]);
  assert.match(html.slice(html.indexOf(`data-lead="${S}#1"`)), /^[^]*?beta/, 'the shared turn names the other item');
  assert.deepEqual(attr(html, 'data-total-tokens'), [String(alpha.total.tokens)]);
  assert.deepEqual(attr(html, 'data-page-tokens'), [String(all)]);
  assert.deepEqual(attr(html, 'data-run'), [`${S}/${A.agentId}`, `${S}/${V.agentId}`], 'runs in time order');
});

test('usage.mjs reports every subagent it cannot tie to an item, with the reason', () => {
  const { usage, report } = fixture();
  assert.ok(!usage.some((r) => r.agentId === X.agentId));
  const x = report.find((r) => r.unbound === `${S}/${X.agentId}`);
  assert.ok(x && /binding|WORKER_STARTED/.test(x.reason), JSON.stringify(report));
  const count = report.at(-1);
  assert.deepEqual({ runs: count.runs, segments: count.segments, leadTurns: count.leadTurns, unbound: count.unbound, items: count.items }, { runs: 3, segments: 4, leadTurns: 2, unbound: 1, items: 2 });
});

test('the ledger page declares usage.jsonl as a file it reads on demand, and a field the schema drops fails naming the page and the field', () => {
  const needs = loadNeeds('ledger');
  assert.ok(needs.reads.onDemand?.['usage.jsonl']?.length, 'pages/ledger/needs.json reads.onDemand names usage.jsonl');
  assert.deepEqual(checkPage('ledger', { history: parseLog(readFileSync(GOLDEN, 'utf8')) }), []);
  const lacking = structuredClone(needs);
  lacking.reads.onDemand['usage.jsonl'].push('tokensGuessed');
  const problems = checkPage('ledger', { history: parseLog(readFileSync(GOLDEN, 'utf8')), needs: lacking });
  assert.ok(problems.some((p) => /^ledger: /.test(p) && p.includes('tokensGuessed') && p.includes('usage')), problems.join('\n'));
});

test('each item on the rendered ledger page has a Time and tokens section, empty until opened, that reads usage.jsonl beside the history', () => {
  const rows = parseLog(readFileSync(GOLDEN, 'utf8'));
  const html = renderLivePage(rows, { page: 'ledger', project: 'chan_x', path: 'harness/history' });
  const page = html.slice(0, html.indexOf('<script'));
  const items = attr(page, 'data-item');
  assert.ok(items.length);
  assert.deepEqual(attr(page, 'data-usage'), items, 'one section per item');
  for (const s of page.matchAll(/<details data-usage="[^"]*">(.*?)<\/details>/g)) {
    assert.match(s[1], /<summary>Time and tokens<\/summary>/);
    assert.match(s[1], /<div data-usage-body><\/div>/, 'nothing is read or shown until it is opened');
  }
  assert.match(html, /harness\/history\/usage\.jsonl/);
});
