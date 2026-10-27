// harness verify-actors: check every session actor in the event log against the platform's record of
// sessions. A session's id is CLAUDE_CODE_SESSION_ID, and the Stop hook (plugins/harness file-turns.js)
// files that session's ledger after each turn, outside the model's choice, at
// $HARNESS_LIBRARY_DIR/ledger/sessions/<id>.json. An id no session ran under has no ledger, and an event
// dated outside its session's window was not sent by that session then. It reads the log and the ledgers
// only, and never writes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where the Stop hook files session ledgers (HARNESS_LIBRARY_DIR as plugins/harness/scripts/host.js reads it). */
export const ledgerDir = () => join(process.env.HARNESS_LIBRARY_DIR ?? '/mnt/project-files/harness', 'ledger', 'sessions');
/** Slack around a session's filed window: clocks differ, and the window ends with the last filed turn. */
export const WINDOW_TOLERANCE_MS = 5 * 60_000;

const plural = (n) => `${n} event${n === 1 ? '' : 's'}`;

/**
 * One result per session actor, in order of first appearance:
 * [{result: 'ok'|'no ledger'|'outside window', id, events, why?}].
 */
export function verifyActors(store, { dir = ledgerDir(), toleranceMs = WINDOW_TOLERANCE_MS } = {}) {
  const byId = new Map();
  for (const row of store.events()) if (row.actor?.kind === 'session') byId.set(row.actor.id, [...(byId.get(row.actor.id) ?? []), row]);
  return [...byId].map(([id, rows]) => {
    const events = rows.length;
    // The hook names the file after the id with anything but [A-Za-z0-9_-] removed; another id has no file.
    if (!/^[A-Za-z0-9_-]+$/.test(String(id))) return { result: 'no ledger', id, events, why: 'the id cannot name a ledger file' };
    const file = join(dir, `${id}.json`);
    let session;
    try {
      session = JSON.parse(readFileSync(file, 'utf8')).session;
    } catch {
      return { result: 'no ledger', id, events, why: `no ${file}` };
    }
    const start = Date.parse(session?.start);
    const end = Date.parse(session?.end);
    if (session?.sessionId !== id || !(start <= end)) return { result: 'no ledger', id, events, why: `${file} holds no window for this session` };
    const outside = rows.filter((r) => !(Date.parse(r.at) >= start - toleranceMs && Date.parse(r.at) <= end + toleranceMs));
    if (!outside.length) return { result: 'ok', id, events, window: [session.start, session.end] };
    const [first] = outside;
    return { result: 'outside window', id, events, why: `${first.id} at ${first.at} is not in ${session.start}..${session.end}${outside.length > 1 ? `, and ${plural(outside.length - 1)} more` : ''}` };
  });
}

/** One line per session actor: `<ok|no ledger|outside window> session:<id>` with its count or the reason. */
export const verifyActorsText = (results) =>
  results.map((r) => (r.result === 'outside window' ? `${r.result} session:${r.id}: ${r.why}` : `${r.result} session:${r.id} (${plural(r.events)})${r.why ? `: ${r.why}` : ''}`)).join('\n');
