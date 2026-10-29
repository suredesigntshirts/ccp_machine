#!/usr/bin/env node
// E2 (epic #59): the session extractor. Reads one session's folder of the salvage archive (harness/archive/sessions/
// <session id>/: manifest.json and events.jsonl.gz, one list_events record per line) and writes, through the shared
// candidate writer (candidates.mjs), the work the session did that no store may have recorded, each row recovered
// and `from` naming the archive ref and the line of the record it was read from:
// - one WORKER_SPAWNED per Agent call (toolUseId, agentType, model, briefSha256 = sha256 of the prompt as sent, as
//   the spawn gate records it), its role and item from the brief's one `Harness-Role: <role> item:<id>` line;
// - one CARD_POSTED per request_decision call the platform posted (the card's message id from the call's result,
//   question, options, recommended index), and one PERSON_DECIDED per tap on one of those cards that reached the
//   session: a decision-chosen wake, tied to its card by the card's message id it names (decision_id);
// - one MERGED per merge_pull_request call whose result says it landed (the PR, the head the call pinned, the merge
//   commit the result names).
// What the session does not hold is a labelled legacy placeholder: the harness release and source (no harness read
// it), an item when no Harness-Role line names one (a card, tap or merge call never does), the actor of a call a
// subagent made. The events file is checked against the manifest's gzSha256, sha256 and count before it is read, and
// a mismatch refuses the archive, writing nothing. It only reads. Rows go to stdout as JSONL; stderr has one line per
// Agent, request_decision and merge_pull_request call and per tap, each with its row id or skip reason, and the count.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { candidates } from './candidates.mjs';

const [dir, ref] = process.argv.slice(2);
if (!dir || !ref) {
  console.error('usage: extract-session.mjs <archive session dir> <archive ref>');
  process.exit(2);
}
const fail = (msg) => {
  console.error(`extract-session: ${msg}; nothing written`);
  process.exit(1);
};
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
} catch (e) {
  fail(`${join(dir, 'manifest.json')} cannot be read: ${e.message}`);
}
const m = manifest.events ?? {};
if (m.file !== 'events.jsonl.gz' || !m.sha256 || !m.gzSha256) fail('the manifest names no events.jsonl.gz with its sha256 and gzSha256');
let gz;
try {
  gz = readFileSync(join(dir, m.file));
} catch {
  fail(`${m.file}: the manifest lists it and the archive does not hold it`);
}
if (sha256(gz) !== m.gzSha256) fail(`${m.file}: its bytes' sha256 ${sha256(gz)} is not the manifest's ${m.gzSha256}`);
const raw = gunzipSync(gz);
if (sha256(raw) !== m.sha256) fail(`${m.file}: its JSONL's sha256 ${sha256(raw)} is not the manifest's ${m.sha256}`);
const records = raw.toString('utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
if (records.length !== m.count) fail(`${m.file} holds ${records.length} events, the manifest counts ${m.count}`);

const at = (i) => records[i].created_at;
const from = (i) => ({ source: 'session', ref: `${ref}/${m.file}`, line: i + 1 });
const legacy = (why) => ({ legacy: `recovered from a session transcript: ${why}` });
const LEGACY = { source: legacy('no harness source read it'), harness: legacy('no harness applied it, so no harness version') };
const text = (content) => (typeof content === 'string' ? content : (content ?? []).map((c) => c.text ?? '').join(''));
const json = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

// The tool calls (in the assistant records) and their results (in later user records), by tool use id; the wakes.
const TOOLS = { Agent: spawn, mcp__hearthbot__request_decision: card, mcp__github__merge_pull_request: landing };
const calls = [];
const results = new Map();
const wakes = [];
records.forEach((r, i) => {
  const a = r.assistant?.internal_anthropic_catchall;
  for (const b of a?.message?.content ?? []) if (b.type === 'tool_use' && TOOLS[b.name]) calls.push({ i, block: b, session: a.session_id, parent: a.parent_tool_use_id ?? null });
  const u = r.user?.internal_anthropic_catchall;
  const content = u?.message?.content;
  if (Array.isArray(content)) for (const b of content) if (b.type === 'tool_result' && !results.has(b.tool_use_id)) results.set(b.tool_use_id, { i, text: text(b.content), error: b.is_error === true });
  if (u?.wake_envelope?.reason === 'decision-chosen') wakes.push({ i, uuid: r.user.uuid, notes: u.wake_envelope.notes ?? [] });
});
// The session id the harness records (CLAUDE_CODE_SESSION_ID): the one its assistant records name.
const sessions = [...new Set(calls.map((c) => c.session).filter((s) => typeof s === 'string' && s && !s.includes('/')))];
const relayedBy = sessions.length === 1 ? sessions[0] : undefined;
const actorOf = (c) =>
  c.parent
    ? legacy(`a subagent made this call (in Agent call ${c.parent}), and the record does not name its agent id`)
    : typeof c.session === 'string' && c.session && !c.session.includes('/')
      ? { kind: 'session', id: c.session }
      : legacy('the record names no session id');

const out = candidates(ref);
let version = 0; // the rows' order in this candidate file; the join numbers the history
const counts = Object.fromEntries(Object.keys(TOOLS).map((k) => [k, 0]));
const cards = new Map();
for (const c of calls) {
  counts[c.block.name]++;
  const where = { ref: from(c.i).ref, line: c.i + 1, call: c.block.name, toolUseId: c.block.id };
  const res = results.get(c.block.id);
  if (res?.error) {
    out.skip(where, `the call was refused: ${res.text.slice(0, 200)}`);
    continue;
  }
  const made = TOOLS[c.block.name](c, res);
  if (typeof made === 'string') {
    out.skip(where, made);
    continue;
  }
  if (out.write({ ...made, version: ++version, actor: actorOf(c), ...LEGACY }, { origin: 'recovered', from: from(c.i), where })) out.say({ call: c.block.name, toolUseId: c.block.id, line: c.i + 1, row: made.id });
}

// A tap: the wake names the card's message id; a card this session posted ties it to its question and options.
for (const w of wakes) {
  const note = (k) => w.notes.find((n) => n.startsWith(`${k}=`))?.slice(k.length + 1);
  const id = note('decision_id');
  const option = Number(note('option_index'));
  const where = { ref: from(w.i).ref, line: w.i + 1, tap: id ?? null };
  const posted = cards.get(id);
  if (!posted) {
    out.skip(where, 'no request_decision call in this session posted the card it answers');
    continue;
  }
  const choice = posted.event.options?.[option]?.label;
  if (!Number.isInteger(option) || choice === undefined) {
    out.skip(where, `the wake names option ${note('option_index')}, which the card does not have`);
    continue;
  }
  const person = note('actor_account_id');
  const row = {
    id: `tap-${w.uuid}`,
    version: ++version,
    at: at(w.i),
    to: 'harness',
    actor: person ? { kind: 'person', id: person } : legacy('the wake names no member'),
    source: { kind: 'tap', ref: id },
    ...(relayedBy && { relayedBy }),
    harness: LEGACY.harness,
    event: { type: 'PERSON_DECIDED', choice, option, card: id, item: legacy('the card it answers names no item') },
  };
  if (out.write(row, { origin: 'recovered', from: from(w.i), where })) out.say({ tap: id, line: w.i + 1, row: row.id });
}
out.done({ calls: counts, taps: wakes.length });

// The brief's role line, as the spawn gate reads it (plugins/harness/scripts/gates.js): one line naming a role and an
// item, or a reason there is none.
function roleOf(prompt) {
  const lines = prompt.split('\n').filter((l) => /^[ \t>*]*harness-role\s*:/i.test(l));
  if (!lines.length) return 'the brief has no Harness-Role: line, so the session names no item';
  if (lines.length > 1) return `the brief has ${lines.length} Harness-Role: lines, so it names no one item`;
  const r = /^Harness-Role: (\S+) item:([A-Za-z0-9_.-]+)$/.exec(lines[0].trim());
  return r ? { role: r[1], item: r[2] } : `the role line "${lines[0].trim()}" is not "Harness-Role: <role> item:<id>"`;
}

function spawn(c) {
  const { prompt, subagent_type, model } = c.block.input ?? {};
  if (typeof prompt !== 'string') return 'the call has no prompt';
  const role = roleOf(prompt);
  const named = typeof role === 'object';
  return {
    id: `spawn-${c.block.id}`,
    at: at(c.i),
    to: named ? `item:${role.item}` : 'harness',
    event: {
      type: 'WORKER_SPAWNED',
      role: named ? role.role : legacy(role),
      agentType: subagent_type ?? legacy('the call named no subagent_type'),
      model: model ?? legacy('the call named no model'),
      briefSha256: sha256(prompt),
      toolUseId: c.block.id,
      ...(!named && { item: legacy(role) }),
    },
  };
}

function card(c, res) {
  if (!res) return 'the session holds no result for the call, so no card is known to be posted';
  const id = json(res.text)?.message_id;
  if (typeof id !== 'string' || !id.startsWith('cmsg_')) return `the result names no card: ${res.text.slice(0, 200)}`;
  const { question, options, recommended } = c.block.input ?? {};
  const row = { id: `card-${id}`, at: at(c.i), to: 'harness', event: { type: 'CARD_POSTED', card: id, question, options, recommended, item: legacy('a request_decision call names no item') } };
  cards.set(id, row);
  return row;
}

function landing(c, res) {
  if (!res) return 'the session holds no result for the call, so it is not known to have landed';
  const r = json(res.text);
  if (r?.merged !== true) return `the result does not say it landed: ${res.text.slice(0, 200)}`;
  const { owner, repo, pullNumber, expectedHeadSha, sha } = c.block.input ?? {};
  if (!owner || !repo || pullNumber == null) return 'the call names no owner, repo and pullNumber';
  const head = expectedHeadSha ?? sha;
  return {
    id: `merge-${c.block.id}`,
    at: at(res.i),
    to: 'harness',
    event: {
      type: 'MERGED',
      pr: `https://github.com/${owner}/${repo}/pull/${pullNumber}`,
      sha: head ?? legacy('the call pinned no head (expectedHeadSha or sha), and the result names only the merge commit'),
      commit: r.sha,
      item: legacy("a merge_pull_request call names no item (GitHub's record binds the PR: extract-github.mjs)"),
    },
  };
}
