// Files session ledgers in the Library, one file per session, the way the harness plugin's Stop hook
// does, for sessions the hook cannot reach: the orchestrator's own (its transcript may be split across
// project folders when its working directory changes) and workers seen only through list_events.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildLedger } from './transcript.js';
import { sessionsFromEvents } from './events.js';

export const SESSIONS_DIR = '/mnt/project-files/harness/ledger/sessions';

/** Merge sessions that share an id: turns in time order, totals summed, span widened. */
export function mergeSessions(sessions) {
  const by = new Map();
  for (const s of sessions) {
    const had = by.get(s.sessionId);
    if (!had) {
      by.set(s.sessionId, { ...s, turns: [...s.turns], totals: { ...s.totals }, models: [...(s.models ?? [])] });
      continue;
    }
    had.turns.push(...s.turns);
    had.turns.sort((a, b) => a.start.localeCompare(b.start));
    for (const [k, v] of Object.entries(s.totals ?? {})) if (typeof v === 'number') had.totals[k] = (had.totals[k] ?? 0) + v;
    had.models = [...new Set([...had.models, ...(s.models ?? [])])];
    if (s.start < had.start) had.start = s.start;
    if (s.end > had.end) had.end = s.end;
    had.reportedCost = (had.reportedCost ?? 0) + (s.reportedCost ?? 0) || had.reportedCost;
  }
  return [...by.values()];
}

/**
 * @param {string[]} paths transcripts (.jsonl) and saved list_events output (.json)
 * @returns {{sessionId: string, file: string, turns: number}[]}
 */
export function fileSessions(paths, { dir = SESSIONS_DIR, now = new Date().toISOString(), remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID ?? null } = {}) {
  const transcripts = paths.filter((p) => p.endsWith('.jsonl'));
  const saved = paths.filter((p) => !p.endsWith('.jsonl'));
  const local = transcripts.length ? buildLedger(transcripts).sessions : [];
  // This machine's transcripts belong to this cloud session, whose id list_events takes for usage readings.
  const here = new Set(local.map((s) => s.sessionId));
  const sessions = mergeSessions([
    ...local,
    ...(saved.length ? sessionsFromEvents(saved.map((p) => readFileSync(p, 'utf8'))) : [])
  ]);
  mkdirSync(dir, { recursive: true });
  return sessions.map((session) => {
    const id = String(session.sessionId).replace(/[^A-Za-z0-9_-]/g, '');
    const file = join(dir, `${id}.json`);
    const tmp = join(dir, `.${id}.${process.pid}.json.tmp`);
    writeFileSync(tmp, JSON.stringify({ filedAt: now, cwd: null, remoteSessionId: here.has(session.sessionId) ? remoteSessionId : null, session }));
    renameSync(tmp, file);
    return { sessionId: session.sessionId, file, turns: session.turns.length };
  });
}
