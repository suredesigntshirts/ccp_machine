// Sessions whose transcripts are not in this container (other threads, the coordinator) are read
// through the claude-code-remote `list_events` tool. Its `result` events close each turn and carry
// the turn's duration, step count, stop reason and per-model usage since the previous result.
// This file turns saved pages of that output into ledger sessions shaped like buildLedger()'s.
import { baseModel } from './pricing.js';
import { totals } from './transcript.js';

function* resultEvents(value) {
  if (Array.isArray(value)) {
    for (const v of value) yield* resultEvents(v);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const r = value.result?.internal_anthropic_catchall;
  if (r && typeof r === 'object' && 'duration_ms' in r) {
    yield { at: value.created_at, uuid: value.result.uuid, ...r };
    return;
  }
  for (const v of Object.values(value)) yield* resultEvents(v);
}

const parseAll = (texts) =>
  texts.flatMap((t) => {
    try {
      return [JSON.parse(t)];
    } catch {
      return t.split('\n').filter(Boolean).flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
    }
  });

/** Builds ledger sessions from saved list_events output (any mix of pages, JSON or JSONL). */
export function sessionsFromEvents(texts) {
  const byUuid = new Map();
  for (const doc of parseAll(texts))
    for (const e of resultEvents(doc)) {
      // The same event can arrive on overlapping pages, some with fewer fields: merge, don't replace.
      const key = e.uuid ?? `${e.session_id}|${e.at}`;
      byUuid.set(key, { ...byUuid.get(key), ...e });
    }
  const bySession = new Map();
  for (const e of [...byUuid.values()].sort((a, b) => a.at.localeCompare(b.at))) {
    const id = e.session_id ?? 'unknown';
    if (!bySession.has(id)) bySession.set(id, []);
    bySession.get(id).push(e);
  }
  return [...bySession].map(([sessionId, events]) => {
    const turns = events.map((e, i) => {
      const requests = Object.entries(e.model_usage_since_last_result ?? {}).map(([model, u]) => ({
        id: `${e.uuid}:${model}`,
        turn: i + 1,
        at: e.at,
        model: baseModel(u.canonicalModel ?? model),
        input: u.inputTokens ?? 0,
        cacheRead: u.cacheReadInputTokens ?? 0,
        cacheWrite5m: 0,
        cacheWrite1h: u.cacheCreationInputTokens ?? 0,
        output: u.outputTokens ?? 0,
        cost: u.costUSD ?? null
      }));
      const end = e.at;
      const start = new Date(Date.parse(end) - (e.duration_ms ?? 0)).toISOString();
      const t = totals(requests);
      return {
        index: i + 1,
        origin: e.origin?.kind ?? 'continuation',
        label: (e.result || `${e.stop_reason ?? 'turn'} after ${e.num_turns ?? '?'} steps`).replace(/\s+/g, ' ').slice(0, 120),
        start,
        end,
        durationMs: e.duration_ms ?? 0,
        own: t,
        subagents: [],
        all: t,
        tools: {},
        requests,
        source: 'events'
      };
    });
    const all = turns.flatMap((t) => t.requests);
    return {
      sessionId,
      start: turns[0]?.start ?? null,
      end: turns.at(-1)?.end ?? null,
      models: [...new Set(all.map((r) => r.model))],
      totals: totals(all),
      reportedCost: events.at(-1)?.total_cost_usd ?? null,
      turns,
      source: 'events'
    };
  });
}
