#!/usr/bin/env node
// Time and tokens by item (#132): usage.jsonl, beside a history, as history.schema.json usage declares (its
// description is the rules). Reads the session ledgers the Stop hook files (<sessions>/<id>.json), the agent records
// and call records beside them (<sessions>/<id>/agents/, <sessions>/<id>/calls/) and a store's or a history's
// events.jsonl, and writes one row per agent segment, one per lead turn that wrote rows for an item and one per session
// ledger (naming the subagents it lists that no item could be tied to). It only reads:
// rows go to stdout as JSONL; each subagent it cannot tie to an item, each row the schema refuses and the counts go to
// stderr, one JSON object per line.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { usageProblems } from '../../src/history.js';

const read = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const files = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')) : []);
const legacy = (why) => ({ legacy: why });
const iso = (ms) => new Date(ms).toISOString();
const COUNTS = ['requests', 'input', 'cacheRead', 'cacheWrite', 'output', 'cost'];
const counts = (u) => Object.fromEntries(COUNTS.map((k) => [k, typeof u?.[k] === 'number' ? u[k] : legacy(`the session ledger has no ${k}`)]));
const itemOf = (to) => /^item:([^/]+)/.exec(typeof to === 'string' ? to : '')?.[1];

/** The usage rows of these session ledgers and store rows: { rows, unbound: [{unbound, description, reason}] }. */
export function usageRows(sessionsDir, events) {
  const started = new Map(events.filter((r) => r.event?.type === 'WORKER_STARTED').map((r) => [r.event.agent, r]));
  const spawned = new Map(events.filter((r) => r.event?.type === 'WORKER_SPAWNED' && r.event.toolUseId).map((r) => [r.event.toolUseId, r]));
  const rows = [];
  const unbound = [];
  for (const f of files(sessionsDir)) {
    const session = read(join(sessionsDir, f))?.session;
    if (!session?.sessionId || !Array.isArray(session.turns)) continue;
    const S = session.sessionId;
    const records = new Map(files(join(sessionsDir, S, 'agents')).map((a) => read(join(sessionsDir, S, 'agents', a))).filter(Boolean).map((a) => [a.agentId, a]));
    const calls = files(join(sessionsDir, S, 'calls')).map((c) => read(join(sessionsDir, S, 'calls', c))).filter((c) => c?.agentId && c.at);
    // The session row: this ledger was read, with each subagent it lists that no item could be tied to.
    const mine = [];
    rows.push({ kind: 'session', session: S, unbound: mine });
    // Each agent, with every listing of it (the turn that lists it and the ledger's counts).
    const agents = new Map();
    for (const t of session.turns) for (const a of t.subagents ?? []) agents.set(a.agentId, [...(agents.get(a.agentId) ?? []), { turn: t, a }]);
    for (const [agentId, listings] of agents) {
      const { a } = listings.reduce((best, l) => ((l.a.requests ?? 0) >= (best.a.requests ?? 0) ? l : best));
      const record = records.get(agentId);
      const start = started.get(`${S}/${agentId}`);
      const item = record?.bind?.item ?? itemOf(start?.to);
      if (!item) {
        const reason = record ? `its record agents/${agentId}.json binds no item${record.bind?.result ? ` (${record.bind.result})` : ''} and no WORKER_STARTED row names ${S}/${agentId}` : `no record agents/${agentId}.json and no WORKER_STARTED row names ${S}/${agentId}`;
        unbound.push({ unbound: `${S}/${agentId}`, description: a.description ?? '', reason });
        mine.push({ agentId, agentType: a.agentType || record?.agentType || legacy('the session ledger has no agentType for this agent'), reason, cost: counts(a).cost });
        continue;
      }
      const spawn = spawned.get(record?.bind?.spawn);
      const role = spawn?.event?.role ?? legacy(record?.bind?.spawn ? `no WORKER_SPAWNED row has toolUseId ${record.bind.spawn}` : 'no spawn is bound to this agent');
      const first = start?.at ?? listings[0].turn.start;
      const end = Date.parse(first) + (a.durationMs ?? 0);
      const starts = [first, ...(record?.resumes ?? []).filter((r) => r > first)].sort();
      starts.forEach((at, i) => {
        const last = i === starts.length - 1;
        const next = starts[i + 1];
        const call = last ? null : calls.filter((c) => c.agentId === agentId && c.at >= at && c.at < next).map((c) => c.at).sort().at(-1);
        const stop = last ? (end >= Date.parse(at) ? iso(end) : legacy('the session ledger was filed before this segment ended')) : call ?? legacy(`no call of this agent is recorded between this start and its resume at ${next}`);
        rows.push({
          kind: 'segment', item, role,
          agentType: a.agentType || record?.agentType || legacy('the session ledger has no agentType for this agent'),
          model: (a.models ?? []).join(', ') || legacy('the session ledger lists no model for this agent'),
          agentId, session: S, segment: i + 1, start: at, end: stop,
          activeMs: typeof stop === 'string' ? Date.parse(stop) - Date.parse(at) : legacy('this segment has no recorded end'),
          ...(last ? counts(a) : Object.fromEntries(COUNTS.map((k) => [k, legacy('the session ledger counts this agent once, on its last segment')])))
        });
      });
    }
    // The lead's turns: those in which this session wrote rows for an item.
    for (const t of session.turns) {
      const items = [...new Set(events.filter((r) => r.actor?.kind === 'session' && r.actor.id === S && r.at >= t.start && r.at <= t.end)
        .map((r) => itemOf(r.to) ?? (r.event?.type === 'REQUEST_RECEIVED' ? r.event.request?.id : undefined)).filter(Boolean))].sort();
      if (items.length) rows.push({ kind: 'lead', items, session: S, turn: t.index, start: t.start, end: t.end, activeMs: t.durationMs ?? Date.parse(t.end) - Date.parse(t.start), ...counts(t.own) });
    }
  }
  return { rows, unbound };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [sessionsDir, eventsFile] = process.argv.slice(2);
  if (!sessionsDir || !eventsFile) {
    console.error('usage: usage.mjs <ledger sessions dir> <events.jsonl of a store or a history>');
    process.exit(2);
  }
  const events = readFileSync(eventsFile, 'utf8').split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const { rows, unbound } = usageRows(sessionsDir, events);
  const say = (o) => process.stderr.write(JSON.stringify(o) + '\n');
  for (const u of unbound) say(u);
  const kept = rows.filter((r) => { const p = usageProblems(r); if (p.length) say({ skip: `${r.session}/${r.agentId ?? (r.kind === 'session' ? 'session' : `turn ${r.turn}`)}`, reason: p.join('; ') }); return !p.length; });
  for (const r of kept) process.stdout.write(JSON.stringify(r) + '\n');
  const segs = kept.filter((r) => r.kind === 'segment');
  say({ runs: new Set(segs.map((r) => `${r.session}/${r.agentId}`)).size, segments: segs.length, leadTurns: kept.filter((r) => r.kind === 'lead').length, sessions: kept.filter((r) => r.kind === 'session').length, unbound: unbound.length, items: new Set(kept.flatMap((r) => r.items ?? (r.item ? [r.item] : []))).size, skips: rows.length - kept.length });
}
