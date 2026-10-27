// Reads Claude Code session transcripts (~/.claude/projects/<cwd>/<session>.jsonl, plus
// <session>/subagents/agent-<id>.jsonl and .meta.json) into sessions, turns and requests.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { requestCost, baseModel } from './pricing.js';

export function readJsonl(path) {
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A line cut off by a live writer is skipped, not fatal.
    }
  }
  return out;
}

const text = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join(' ');

/** One-line label for what started a turn, e.g. the wake reason or the first words of a message. */
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m]);

export function promptLabel(content) {
  const t = text(content).replace(/\s+/g, ' ').trim();
  const wake = t.match(/<wake reason="([^"]+)"/);
  const msg = t.match(/<message [^>]*author="([^"]*)"[^>]*>([^<]{0,120})/);
  if (wake && msg) return `${wake[1]}: ${decode(msg[1])}: ${decode(msg[2].trim())}`;
  if (wake) return wake[1];
  if (t.startsWith('Another Claude session sent a message')) {
    const from = t.match(/from="([^"]+)"/);
    return `agent message${from ? ` from ${from[1]}` : ''}`;
  }
  return t.slice(0, 120);
}

/**
 * Parses one transcript's lines into requests (deduplicated by requestId: one API call can appear
 * as several assistant lines repeating the same usage), tool calls, and turns.
 */
export function parseLines(lines, { sessionId, kind = 'session' } = {}) {
  const requests = new Map();
  const tools = [];
  const turns = [];
  let turn = null;
  let costState = null;
  const startTurn = (index, line, origin) => {
    turn = {
      index,
      origin,
      label: promptLabel(line.message?.content),
      start: line.timestamp,
      end: line.timestamp,
      requests: [],
      tools: []
    };
    turns.push(turn);
  };
  for (const line of lines) {
    if (line.type === 'cost-state') costState = line;
    if (!line.timestamp) continue;
    if (line.type === 'user' && line.turnPosition && line.toolUseResult === undefined) {
      if (!turn || turn.index !== line.turnPosition.turnIndex)
        startTurn(line.turnPosition.turnIndex, line, line.turnOrigin ?? line.origin?.kind ?? 'unknown');
    }
    // Before the first numbered prompt (a subagent's transcript has none), the first real line opens turn 0.
    if (!turn && !line.isMeta && (line.type === 'user' || line.type === 'assistant')) startTurn(0, line, kind);
    if (!turn) continue;
    if (line.timestamp > turn.end) turn.end = line.timestamp;
    if (line.type === 'assistant' && line.message?.usage) {
      const id = line.requestId ?? line.message.id ?? line.uuid;
      if (!requests.has(id)) {
        const u = line.message.usage;
        const r = {
          id,
          turn: turn.index,
          at: line.timestamp,
          model: baseModel(line.message.model),
          input: u.input_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite5m: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
          cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cost: requestCost(line.message.model, u)
        };
        requests.set(id, r);
        turn.requests.push(id);
      }
      for (const c of line.message.content ?? []) {
        if (c.type !== 'tool_use') continue;
        const t = { id: c.id, name: c.name, at: line.timestamp, turn: turn.index, request: id };
        tools.push(t);
        turn.tools.push(c.id);
      }
    }
  }
  return { sessionId, kind, requests: [...requests.values()], tools, turns, costState };
}

const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) ?? 0), 0);

/** Totals for a set of requests. */
export function totals(requests) {
  return {
    requests: requests.length,
    input: sum(requests, (r) => r.input),
    cacheRead: sum(requests, (r) => r.cacheRead),
    cacheWrite: sum(requests, (r) => r.cacheWrite5m + r.cacheWrite1h),
    output: sum(requests, (r) => r.output),
    cost: sum(requests, (r) => r.cost),
    unpriced: requests.filter((r) => r.cost == null).length
  };
}

/** Reads a session transcript and its subagents, and attaches each subagent to the turn that started it. */
export function readSession(path) {
  const sessionId = basename(path, '.jsonl');
  const main = parseLines(readJsonl(path), { sessionId });
  const subDir = join(dirname(path), sessionId, 'subagents');
  const subagents = [];
  if (existsSync(subDir)) {
    for (const f of readdirSync(subDir).filter((f) => /^agent-.*\.jsonl$/.test(f)).sort()) {
      const agentId = f.slice('agent-'.length, -'.jsonl'.length);
      const metaPath = join(subDir, `agent-${agentId}.meta.json`);
      const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
      const parsed = parseLines(readJsonl(join(subDir, f)), { sessionId: agentId, kind: 'subagent' });
      const spawnedBy = main.tools.find((t) => t.id === meta.toolUseId);
      subagents.push({
        agentId,
        description: meta.description ?? '',
        agentType: meta.agentType ?? '',
        turn: spawnedBy?.turn ?? null,
        start: parsed.turns[0]?.start ?? null,
        end: parsed.turns.at(-1)?.end ?? null,
        requests: parsed.requests,
        tools: parsed.tools
      });
    }
  }
  return { ...main, subagents };
}

/** Builds the ledger: per session, per turn, with subagent work rolled into the turn that spawned it. */
export function buildLedger(paths) {
  const sessions = paths.map(readSession).map((s) => {
    const turns = s.turns.map((t) => {
      const own = s.requests.filter((r) => r.turn === t.index);
      const subs = s.subagents.filter((a) => a.turn === t.index);
      const toolNames = {};
      for (const tool of s.tools.filter((x) => x.turn === t.index)) toolNames[tool.name] = (toolNames[tool.name] ?? 0) + 1;
      return {
        index: t.index,
        origin: t.origin,
        label: t.label,
        start: t.start,
        end: t.end,
        durationMs: Date.parse(t.end) - Date.parse(t.start),
        own: totals(own),
        subagents: subs.map((a) => ({
          agentId: a.agentId,
          description: a.description,
          agentType: a.agentType,
          models: [...new Set(a.requests.map((r) => r.model))],
          durationMs: a.start && a.end ? Date.parse(a.end) - Date.parse(a.start) : 0,
          tools: a.tools.length,
          ...totals(a.requests)
        })),
        all: totals([...own, ...subs.flatMap((a) => a.requests)]),
        tools: toolNames,
        requests: own
      };
    });
    const allRequests = [...s.requests, ...s.subagents.flatMap((a) => a.requests)];
    return {
      sessionId: s.sessionId,
      start: turns[0]?.start ?? null,
      end: turns.at(-1)?.end ?? null,
      models: [...new Set(allRequests.map((r) => r.model))],
      totals: totals(allRequests),
      reportedCost: s.costState?.totalCostUSD ?? null,
      turns
    };
  });
  return { generatedAt: new Date().toISOString(), version: 1, sessions, usage: [] };
}

/** Finds session transcripts under a Claude projects directory (default ~/.claude/projects). */
export function findTranscripts(root) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of readdirSync(join(root, dir.name)))
      if (f.endsWith('.jsonl')) out.push(join(root, dir.name, f));
  }
  return out.sort();
}
