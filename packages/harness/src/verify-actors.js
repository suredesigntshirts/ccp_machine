// harness verify-actors: check every session and agent actor in the event log against the platform's record
// of sessions and subagents. A session's id is CLAUDE_CODE_SESSION_ID, and the Stop hook (plugins/harness file-turns.js)
// files that session's ledger after each turn, outside the model's choice, at
// $HARNESS_LIBRARY_DIR/ledger/sessions/<id>.json. An id no session ran under has no ledger, and an event
// dated outside its session's window was not sent by that session then. A subagent (agent actor) has the
// SubagentStart hook's record beside its session's ledger. It reads the log and the ledgers only, and never writes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where the Stop hook files session ledgers (HARNESS_LIBRARY_DIR as plugins/harness/scripts/host.js reads it). */
export const ledgerDir = () => join(process.env.HARNESS_LIBRARY_DIR ?? '/mnt/project-files/harness', 'ledger', 'sessions');
/** Slack around a session's filed window: clocks differ, and the window ends with the last filed turn. */
export const WINDOW_TOLERANCE_MS = 5 * 60_000;

const plural = (n) => `${n} event${n === 1 ? '' : 's'}`;

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
// The hooks name files after ids with anything but [A-Za-z0-9_-] removed; another id has no file.
const SAFE = /^[A-Za-z0-9_-]+$/;
// ok when every event falls in start..end (give or take the tolerance), else outside window.
const within = (rows, start, end, toleranceMs, base) => {
  const outside = rows.filter((r) => !(Date.parse(r.at) >= Date.parse(start) - toleranceMs && Date.parse(r.at) <= Date.parse(end) + toleranceMs));
  if (!outside.length) return { ...base, result: 'ok', window: [start, end] };
  const [first] = outside;
  return { ...base, result: 'outside window', why: `${first.id} at ${first.at} is not in ${start}..${end}${outside.length > 1 ? `, and ${plural(outside.length - 1)} more` : ''}` };
};

/**
 * One result per session or agent actor, in order of first appearance:
 * [{result: 'ok'|'no ledger'|'no record'|'outside window', kind, id, events, why?}]. An agent (<session_id>/<agent_id>)
 * is checked against the SubagentStart hook's record, <dir>/<session_id>/agents/<agent_id>.json: its window runs
 * from the agent's earliest recorded start (that record's, its bind's start call <dir>/<session_id>/calls/
 * start-<agent_id>.json, or this store's WORKER_STARTED row naming the agent sent by session <session_id>,
 * whichever is earliest) to its session's last filed turn, and its agent_type must be the recorded one.
 */
export function verifyActors(store, { dir = ledgerDir(), toleranceMs = WINDOW_TOLERANCE_MS } = {}) {
  const byActor = new Map();
  const bound = new Map(); // agent id -> the at of each WORKER_STARTED row its parent session sent for it
  for (const row of store.events()) {
    const agent = row.event?.type === 'WORKER_STARTED' && row.event.agent;
    if (agent && row.actor?.kind === 'session' && row.actor.id === String(agent).split('/')[0]) bound.set(agent, [...(bound.get(agent) ?? []), row.at]);
    if (['session', 'agent'].includes(row.actor?.kind)) byActor.set(`${row.actor.kind}:${row.actor.id}`, [...(byActor.get(`${row.actor.kind}:${row.actor.id}`) ?? []), row]);
  }
  return [...byActor.values()].map((rows) => {
    const { kind, id } = rows[0].actor;
    const base = { kind, id, events: rows.length };
    if (kind === 'agent') {
      const no = (why) => ({ ...base, result: 'no record', why });
      const [sid, aid, ...more] = String(id).split('/');
      if (!SAFE.test(sid) || !SAFE.test(aid ?? '') || more.length) return no('the id cannot name a record file');
      const file = join(dir, sid, 'agents', `${aid}.json`);
      const record = readJson(file);
      if (!record) return no(`no ${file}`);
      if (record.sessionId !== sid || record.agentId !== aid || !Date.parse(record.at)) return no(`${file} is not this agent's record`);
      const other = rows.find((r) => r.actor.type != null && r.actor.type !== record.agentType);
      if (other) return no(`${file} records a ${record.agentType} subagent, not a ${other.actor.type} (${other.id})`);
      const session = readJson(join(dir, `${sid}.json`))?.session;
      if (session?.sessionId !== sid || !(Date.parse(session.end) >= Date.parse(session.start))) return no(`no ${join(dir, `${sid}.json`)} holding its session's window`);
      // The bind's start call (plugin agent-actor.js) is the other hook record of this agent's start, and the
      // parent's WORKER_STARTED row in this store the bind it sent; an agent bound before call records has only that.
      const call = readJson(join(dir, sid, 'calls', `start-${aid}.json`));
      const starts = [record.at, ...(call?.kind === 'start' && call.sessionId === sid && call.agent === `${sid}/${aid}` ? [call.at] : []), ...(bound.get(`${sid}/${aid}`) ?? [])];
      const started = starts.filter((at) => Date.parse(at)).reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
      return within(rows, started, session.end, toleranceMs, base);
    }
    if (!SAFE.test(String(id))) return { ...base, result: 'no ledger', why: 'the id cannot name a ledger file' };
    const file = join(dir, `${id}.json`);
    const session = readJson(file)?.session;
    if (!session) return { ...base, result: 'no ledger', why: `no ${file}` };
    if (session.sessionId !== id || !(Date.parse(session.start) <= Date.parse(session.end))) return { ...base, result: 'no ledger', why: `${file} holds no window for this session` };
    return within(rows, session.start, session.end, toleranceMs, base);
  });
}

/** One line per actor: `<ok|no ledger|no record|outside window> <kind>:<id>` with its count or the reason. */
export const verifyActorsText = (results) =>
  results.map((r) => (r.result === 'outside window' ? `${r.result} ${r.kind}:${r.id}: ${r.why}` : `${r.result} ${r.kind}:${r.id} (${plural(r.events)})${r.why ? `: ${r.why}` : ''}`)).join('\n');
