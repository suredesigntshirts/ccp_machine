import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLedger, requestCost, samplesFromText, budgetStatus, estimateSample, liveSamples, renderReport } from '../src/index.js';

const usage = (o) => ({
  input_tokens: 10,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 200,
  cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 0 },
  output_tokens: 50,
  ...o
});
const assistant = (requestId, at, content, model = 'claude-opus-5-5') => ({
  type: 'assistant',
  requestId,
  timestamp: at,
  message: { model, usage: usage(), content }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const session = 'sess-1';
  const lines = [
    { type: 'user', isMeta: true, timestamp: '2026-10-26T10:00:00.000Z', message: { content: 'context' } },
    {
      type: 'user',
      timestamp: '2026-10-26T10:00:01.000Z',
      turnPosition: { promptIndex: 1, turnIndex: 1 },
      turnOrigin: 'human',
      message: { content: '<wake reason="mention"><message author="Sam" id="x">Please fix the &lt;login&gt; page</message></wake>' }
    },
    assistant('req-a', '2026-10-26T10:00:05.000Z', [{ type: 'thinking' }]),
    // Same API call again (one call can span several lines): must count once.
    assistant('req-a', '2026-10-26T10:00:06.000Z', [{ type: 'tool_use', id: 'tu-1', name: 'Bash' }]),
    { type: 'user', timestamp: '2026-10-26T10:00:09.000Z', toolUseResult: 'ok', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1' }] } },
    assistant('req-b', '2026-10-26T10:00:12.000Z', [{ type: 'tool_use', id: 'tu-2', name: 'Agent' }]),
    {
      type: 'user',
      timestamp: '2026-10-26T10:05:00.000Z',
      turnPosition: { promptIndex: 1, turnIndex: 2 },
      turnOrigin: 'peer',
      message: { content: 'Another Claude session sent a message: <agent-message from="agent-9">done</agent-message>' }
    },
    assistant('req-c', '2026-10-26T10:05:04.000Z', [{ type: 'text', text: 'ok' }]),
    'not json, a half-written line',
    { type: 'cost-state', totalCostUSD: 0.5 }
  ];
  writeFileSync(join(dir, `${session}.jsonl`), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  const sub = join(dir, session, 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find the login code', toolUseId: 'tu-2' }));
  writeFileSync(
    join(sub, 'agent-a1.jsonl'),
    [
      { type: 'user', isSidechain: true, timestamp: '2026-10-26T10:00:13.000Z', message: { content: 'find it' } },
      assistant('req-s1', '2026-10-26T10:00:20.000Z', [{ type: 'tool_use', id: 'tu-s1', name: 'Grep' }], 'claude-sonnet-5-5')
    ]
      .map((l) => JSON.stringify(l))
      .join('\n')
  );
  return join(dir, `${session}.jsonl`);
}

test('prices a request from its usage, splitting 1-hour and 5-minute cache writes', () => {
  // Opus 5.5: 10 x 4 + 200 x 8 (1h write) + 1000 x 0.2 + 50 x 20, per million tokens.
  assert.equal(requestCost('claude-opus-5-5[1m]', usage()), (40 + 1600 + 200 + 1000) / 1e6);
  assert.equal(requestCost('claude-unknown-1', usage()), null);
  const long = usage({ cache_read_input_tokens: 150_000 });
  assert.ok(requestCost('claude-haiku-5-5', long) > requestCost('claude-haiku-5-5', usage({ cache_read_input_tokens: 99_000 })) * 4);
});

test('splits a transcript into turns, counts each API call once and rolls subagents into their turn', () => {
  const ledger = buildLedger([fixture()]);
  const [s] = ledger.sessions;
  assert.equal(s.turns.length, 2);
  const [t1, t2] = s.turns;
  assert.equal(t1.label, 'mention: Sam: Please fix the <login> page');
  assert.equal(t2.label, 'agent message from agent-9');
  assert.equal(t1.own.requests, 2);
  assert.deepEqual(t1.tools, { Bash: 1, Agent: 1 });
  assert.equal(t1.durationMs, 11_000);
  assert.equal(t1.subagents.length, 1);
  assert.deepEqual([t1.subagents[0].description, t1.subagents[0].models], ['Find the login code', ['claude-sonnet-5-5']]);
  assert.equal(t1.all.requests, 3);
  assert.ok(t1.all.cost > t1.own.cost);
  assert.equal(s.totals.requests, 4);
  assert.equal(s.reportedCost, 0.5);
});

const event = (at, fiveHour, sevenDay, sevenDayResetsAt = 1793538000) => ({
  created_at: at,
  rate_limit_event: {
    internal_anthropic_catchall: {
      rate_limit_info: {
        unifiedWindows: {
          five_hour: { utilization: fiveHour, resetsAt: 1793051400 },
          seven_day: { utilization: sevenDay, resetsAt: sevenDayResetsAt }
        }
      }
    }
  }
});

test('reads usage samples from saved list_events output', () => {
  const page = JSON.stringify({ ccr: { data: [event('2026-10-26T17:22:45Z', 0.03, 0.07)], has_more: true } });
  const [s] = samplesFromText(page);
  assert.deepEqual(s, { at: '2026-10-26T17:22:45Z', fiveHour: 0.03, fiveHourResetsAt: 1793051400, sevenDay: 0.07, sevenDayResetsAt: 1793538000 });
  assert.equal(samplesFromText(`${JSON.stringify(event('a', 0.1, 0.2))}\n${JSON.stringify(event('b', 0.1, 0.3))}`).length, 2);
});

const samples = (...pts) => samplesFromText(JSON.stringify(pts.map(([at, f, s, r]) => event(at, f, s, r))));

test('budget follows the spec: 10% of the 7-day window a day, wrap up at 80%, pause at 100% or a full 5-hour window', () => {
  const day = (sevenDay, fiveHour = 0.1) =>
    budgetStatus(samples(['2026-10-25T23:00:00Z', 0.1, 0.3], ['2026-10-26T12:00:00Z', fiveHour, sevenDay])).mode;
  assert.equal(day(0.35), 'normal');
  assert.equal(day(0.39), 'wrappingUp');
  assert.equal(day(0.41), 'paused');
  assert.equal(day(0.31, 0.96), 'paused');
  const s = budgetStatus(samples(['2026-10-25T23:00:00Z', 0.1, 0.3], ['2026-10-26T12:00:00Z', 0.1, 0.35]));
  assert.deepEqual([s.dayStart, s.dayStartSevenDay, s.spentToday, s.shareOfSlice], ['2026-10-26T00:00:00.000Z', 0.3, 0.05, 0.5]);
});

test('budget counts spend on both sides of a 7-day reset that falls inside the day', () => {
  const s = budgetStatus(
    samples(['2026-10-26T01:00:00Z', 0.1, 0.9, 100], ['2026-10-26T09:00:00Z', 0.1, 0.95, 100], ['2026-10-26T13:00:00Z', 0.1, 0.02, 200])
  );
  assert.deepEqual([s.spentToday, s.shareOfSlice, s.mode], [0.07, 0.7, 'normal']);
});

test('the report shows the overview and every turn, and escapes what it prints', () => {
  const ledger = buildLedger([fixture()]);
  const html = renderReport(ledger, { title: 'Test <ledger>', budget: budgetStatus(samples(['2026-10-26T12:00:00Z', 0.2, 0.3])) });
  assert.ok(html.includes('<title>Test &lt;ledger&gt;</title>'));
  assert.ok(html.includes('id="turn-sess1-1"') && html.includes('id="turn-sess1-2"'));
  assert.ok(html.includes('Find the login code'));
  assert.ok(html.includes('Please fix the &lt;login&gt; page'));
  assert.ok(!html.includes('<!doctype'));
  assert.ok(renderReport(ledger, { standalone: true }).startsWith('<!doctype html>'));
});

test('builds sessions from saved list_events result events, for sessions not on disk', async () => {
  const { sessionsFromEvents } = await import('../src/index.js');
  const result = (uuid, at, ms, cost, extra = {}) => ({
    created_at: at,
    result: {
      uuid,
      internal_anthropic_catchall: {
        duration_ms: ms,
        num_turns: 2,
        stop_reason: 'end_turn',
        session_id: 'coord-1',
        total_cost_usd: 1,
        model_usage_since_last_result: {
          'claude-opus-5-5[1m]': { canonicalModel: 'claude-opus-5-5', inputTokens: 2, cacheReadInputTokens: 80000, cacheCreationInputTokens: 2000, outputTokens: 100, costUSD: cost }
        },
        ...extra
      }
    }
  });
  const page1 = JSON.stringify({ ccr: { data: [result('u1', '2026-10-26T17:18:35Z', 14000, 0.04, { origin: { kind: 'human' } })] } });
  const page2 = JSON.stringify({ ccr: { data: [result('u2', '2026-10-26T17:33:03Z', 21000, 0.07, { result: 'Round 2 is done.' }), result('u1', '2026-10-26T17:18:35Z', 14000, 0.04)] } });
  const [s] = sessionsFromEvents([page1, page2]);
  assert.equal(s.sessionId, 'coord-1');
  assert.equal(s.turns.length, 2, 'the same event on two pages counts once');
  assert.deepEqual([s.turns[0].origin, s.turns[0].start, s.turns[1].label], ['human', '2026-10-26T17:18:21.000Z', 'Round 2 is done.']);
  assert.equal(Number(s.totals.cost.toFixed(2)), 0.11);
  assert.deepEqual(s.models, ['claude-opus-5-5']);
});

test('with no fresh reading, the ledger estimates one from the cost of turns since the last', () => {
  const real = [
    { at: '2026-10-26T10:00:00Z', sevenDay: 0.05, fiveHour: 0.1, sevenDayResetsAt: 9 },
    { at: '2026-10-26T12:00:00Z', sevenDay: 0.07, fiveHour: 0.3, sevenDayResetsAt: 9 }
  ];
  const turn = (start, cost) => ({ start, all: { cost } });
  // $20 between the readings moved 7-day by 2 points and 5-hour by 20: 0.1 and 1 point per dollar.
  const ledger = { sessions: [{ turns: [turn('2026-10-26T11:00:00Z', 20), turn('2026-10-26T13:00:00Z', 5), turn('2026-10-26T14:30:00Z', 5)] }] };
  const est = estimateSample(real, ledger, '2026-10-26T15:00:00Z');
  assert.deepEqual([est.at, est.sevenDay, est.fiveHour, est.estimated, est.estimatedFrom, est.costSince], ['2026-10-26T15:00:00Z', 0.08, 0.4, true, '2026-10-26T12:00:00Z', 10]);
  assert.equal(estimateSample(real, { sessions: [] }, '2026-10-26T15:00:00Z'), null, 'nothing spent since');
  assert.equal(estimateSample(real.slice(1), ledger, '2026-10-26T15:00:00Z'), null, 'one reading gives no rate');
  // Estimates never feed the next one, and a newer real reading supersedes them.
  assert.equal(estimateSample([...real, est], ledger, '2026-10-26T15:00:00Z').sevenDay, 0.08);
  const later = { at: '2026-10-26T16:00:00Z', sevenDay: 0.075, fiveHour: 0.2, sevenDayResetsAt: 9 };
  assert.deepEqual(liveSamples([...real, est, later]).map((s) => s.at), [real[0].at, real[1].at, later.at]);
  assert.equal(budgetStatus([...real, est, later]).latest.estimated, undefined);
});

test('whole-percent readings with a flat 7-day window still estimate from the 5-hour window', () => {
  const r = (at, sevenDay, fiveHour) => ({ at, sevenDay, fiveHour, sevenDayResetsAt: 9, fiveHourResetsAt: 5 });
  const turn = (start, cost) => ({ start, all: { cost } });
  const ledger = { sessions: [{ turns: [turn('2026-10-26T18:30:00Z', 4), turn('2026-10-26T19:30:00Z', 2)] }] };
  // The live shape at 20:05: 7-day stuck at 8%, 5-hour 5% to 9%.
  const flat = [r('2026-10-26T18:14:00Z', 0.08, 0.05), r('2026-10-26T18:49:00Z', 0.08, 0.08), r('2026-10-26T19:11:00Z', 0.08, 0.09)];
  const est = estimateSample(flat, ledger, '2026-10-26T20:05:00Z');
  assert.deepEqual([est.fiveHour, est.sevenDay, est.basis.fiveHour, est.basis.sevenDay], [0.11, 0.08, 'measured since 2026-10-26T18:14:00Z', 'last reading (too coarse to measure)']);
  // An older, lower 7-day reading in the same window widens the span until a rise shows.
  const both = [r('2026-10-26T17:00:00Z', 0.07, 0.01), ...flat];
  const ledger2 = { sessions: [{ turns: [turn('2026-10-26T17:30:00Z', 4), ...ledger.sessions[0].turns] }] };
  const e2 = estimateSample(both, ledger2, '2026-10-26T20:05:00Z');
  assert.equal(e2.basis.sevenDay, 'measured since 2026-10-26T17:00:00Z');
  assert.equal(e2.basis.sessions, 1);
});
