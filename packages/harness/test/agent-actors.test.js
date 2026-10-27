// #33: subagents are actors of their own. A subagent shares its parent's CLAUDE_CODE_SESSION_ID, so the
// spec names it as agent <session_id>/<agent_id> (harness meta.actors), the role guards compare that whole
// actor, the CLI records it when the plugin's PreToolUse hook hands it over (HARNESS_AGENT), and
// verify-actors checks it against the SubagentStart hook's record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, init, status } from '../src/index.js';
import { specs } from '../src/machines.js';
import { apply, start, decide } from './send.js';
import { tempDir } from './tmp.js';

const LEAD = 'sim-orchestrator'; // the session start() makes the orchestrator
const agent = (aid, sid = LEAD, type = 'general-purpose') => ({ actor: { kind: 'agent', id: `${sid}/${aid}`, type }, source: { kind: 'cli', ref: 'harness send' } });
const session = (id) => ({ actor: { kind: 'session', id }, source: { kind: 'cli', ref: 'harness send' } });
const sure = { choice: 'approve', confidence: 0.95, reason: 'small' };
const fresh = () => {
  const store = openStore(tempDir('harness-agents-'));
  init(store);
  start(store);
  return store;
};
const ctx = (store, id = 'a') => store.read().snapshot.children[id].snapshot.context;
const decisionOf = (store, id = 'a') => `item:${id}/${ctx(store, id).decisionId}`;
const counts = (store) => [store.read().version, store.events().length, store.outbox().length];
const refused = (store, event, to, label) => {
  const before = counts(store);
  const r = apply(store, event, { to });
  assert.equal(r.refused, true, label);
  assert.deepEqual(counts(store), before, `${label}: nothing written`);
  return r;
};
const taken = (store, event, to, label) => assert.ok(!apply(store, event, { to }).refused, label);

test('the spec defines the agent actor: kind agent, id <session_id>/<agent_id>, holding roles like a session; SPEC.md shows it', () => {
  const { actors } = specs.harness.meta;
  assert.deepEqual(Object.keys(actors).sort(), ['agent', 'github', 'person', 'session', 'timer']);
  assert.equal(actors.agent.roles, true);
  assert.equal(actors.session.roles, true);
  assert.ok(!actors.person.roles && !actors.github.roles && !actors.timer.roles);
  const id = new RegExp(actors.agent.id);
  assert.ok(id.test('s1/a1') && !id.test('s1') && !id.test('s1/a1/x') && !id.test('/a1'));
  assert.ok(new RegExp(actors.session.id).test('s1') && !new RegExp(actors.session.id).test('s1/a1'), 'a session id and an agent id never coincide');
  const md = readFileSync(new URL('../spec/SPEC.md', import.meta.url), 'utf8');
  assert.match(md, /^- `agent` \(id `\^\[\^\/\]\+\/\[\^\/\]\+\$`\), holds roles: A subagent of a session: id <session_id>\/<agent_id>/m);
});

test('the envelope takes an agent actor and refuses one that does not name both a session and an agent', () => {
  const store = fresh();
  taken(store, { type: 'REQUEST_RECEIVED', request: { id: 'a' }, ...agent('filer') }, undefined, 'an agent files a request');
  assert.equal(ctx(store).requester, `${LEAD}/filer`);
  for (const id of ['filer', `${LEAD}/`, `/x`, `${LEAD}/x/y`]) {
    const r = refused(store, { type: 'REQUEST_RECEIVED', request: { id: 'b' }, actor: { kind: 'agent', id }, source: { kind: 'cli', ref: 'x' } }, undefined, `agent id ${id}`);
    assert.match(r.why, /actor/);
  }
  refused(store, { type: 'REQUEST_RECEIVED', request: { id: 'b' }, ...session(`${LEAD}/filer`) }, undefined, 'a session id with a slash');
  refused(store, { type: 'ORCHESTRATOR_STARTED', ...agent('lead') }, undefined, 'an agent cannot be the orchestrator');
});

// The lead (the orchestrator session) with its triager, builder, checker and stand-in subagents: one session, five actors.
function lead(store) {
  taken(store, { type: 'REQUEST_RECEIVED', request: { id: 'a' }, ...session(LEAD) }, undefined, 'the lead files');
  taken(store, { type: 'TRIAGED', tier: 1, criteria: ['a works'], ...agent('triager') }, 'item:a', "the lead's triager subagent triages");
  taken(store, { type: 'STAND_IN_ANSWERED', answer: sure, ...agent('stand-in') }, decisionOf(store), "the lead's stand-in subagent answers");
  assert.ok(!decide(store, decisionOf(store), 'approve').refused);
  taken(store, { type: 'RUN_SUCCEEDED', ...agent('builder') }, 'item:a', "the lead's builder subagent reports a run: it is not the orchestrator");
  return store;
}

test('two subagents of one session are distinct from each other and from their parent: each plays its own part', () => {
  const store = lead(fresh());
  taken(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'test a', ...agent('checker') }, 'item:a', "the lead's checker subagent checks");
  const c = ctx(store);
  assert.deepEqual([c.requester, c.triagers, c.workers, c.checkers, c.answerers], [LEAD, [`${LEAD}/triager`], [`${LEAD}/builder`], [`${LEAD}/checker`], [`${LEAD}/stand-in`]]);
  assert.match(status(store).items[0].state, /verifying/);
});

test('the role guards hold for agents: each agent keeps its one part, and the parent is not its subagents', () => {
  const store = lead(fresh());
  refused(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'mine', ...agent('builder') }, 'item:a', 'the builder subagent checks its own work');
  refused(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'mine', ...agent('triager') }, 'item:a', 'the triager subagent checks');
  refused(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'mine', ...agent('stand-in') }, 'item:a', 'the stand-in subagent checks');
  refused(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'mine', ...session(LEAD) }, 'item:a', 'the parent (orchestrator) checks');
  refused(store, { type: 'RUN_SUCCEEDED', ...agent('triager') }, 'item:a', 'the triager subagent builds');
  refused(store, { type: 'RUN_SUCCEEDED', ...session(LEAD) }, 'item:a', 'the parent reports a run');
  // The same agent id under another session is another actor; the same agent kind under the same session is the same one.
  taken(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'test a', ...agent('builder', 'other-session') }, 'item:a', "another session's agent with the builder's agent_id is not the builder");
  assert.deepEqual(ctx(store).checkers, ['other-session/builder']);
});

test('an agent stand-in cannot answer for the item it built, checked or triaged', () => {
  const store = fresh();
  taken(store, { type: 'REQUEST_RECEIVED', request: { id: 'a' }, ...session(LEAD) });
  taken(store, { type: 'TRIAGED', tier: 1, criteria: ['a works'], ...agent('triager') }, 'item:a');
  refused(store, { type: 'STAND_IN_ANSWERED', answer: sure, ...agent('triager') }, decisionOf(store), 'the triager subagent answers the plan');
  taken(store, { type: 'STAND_IN_ANSWERED', answer: sure, ...agent('stand-in') }, decisionOf(store), 'another subagent answers the plan');
});

// The CLI, as a subagent's Bash call runs it once the plugin's PreToolUse hook has set HARNESS_AGENT.
const bin = new URL('../bin/harness.js', import.meta.url).pathname;
const run = (env, ...args) => {
  const e = { ...process.env, HARNESS_LIBRARY_DIR: tempDir('harness-lib-'), HARNESS_AGENT: undefined, ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: e });
};
const rows = (dir) => readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const parent = { CLAUDE_CODE_SESSION_ID: 'lead' };
const sub = (aid, type = 'general-purpose') => ({ CLAUDE_CODE_SESSION_ID: 'lead', HARNESS_AGENT: `${aid}:${type}` });
function cliItem() {
  const dir = tempDir('harness-agents-cli-');
  assert.equal(run(parent, 'init', '--dir', dir).status, 0);
  assert.equal(run(parent, 'send', '{"type":"REQUEST_RECEIVED","request":{"id":"a"}}', '--dir', dir).status, 0);
  return dir;
}

test('CLI: the default actor is the agent when HARNESS_AGENT is set, else the session as before', () => {
  const dir = cliItem();
  assert.deepEqual(rows(dir).at(-1).actor, { kind: 'session', id: 'lead' });
  const r = run(sub('a1b2', 'my-plugin:reviewer'), 'send', '{"type":"TRIAGED","tier":1,"criteria":["a works"]}', '--to', 'item:a', '--dir', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(rows(dir).at(-1).actor, { kind: 'agent', id: 'lead/a1b2', type: 'my-plugin:reviewer' });
  const w = run(sub('c3d4'), 'send', '{"type":"RUN_SUCCEEDED"}', '--to', 'item:a', '--actor', 'agent:lead/c3d4', '--source', 'cli:handback', '--dir', dir);
  assert.equal(w.status, 0, w.stderr);
  assert.deepEqual(rows(dir).at(-1).actor, { kind: 'agent', id: 'lead/c3d4', type: 'general-purpose' });
});

test('CLI: a subagent cannot record as its parent or another subagent, and the parent cannot record as a subagent', () => {
  const dir = cliItem();
  const before = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  for (const [env, args, why] of [
    [sub('a1'), ['--actor', 'session:lead'], /--actor session:lead .*subagent/],
    [sub('a1'), ['--actor', 'session:other'], /--actor session:other .*subagent/],
    [sub('a1'), ['--actor', 'agent:lead/a2'], /--actor agent:lead\/a2 is not this subagent/],
    [sub('a1'), ['--actor', 'agent:other/a1'], /--actor agent:other\/a1 is not this subagent/],
    [parent, ['--actor', 'agent:lead/a1'], /--actor agent:lead\/a1 .*not a subagent/],
    [{ HARNESS_AGENT: 'a1:general-purpose', CLAUDE_CODE_SESSION_ID: undefined }, [], /HARNESS_AGENT .*CLAUDE_CODE_SESSION_ID/],
    [{ ...parent, HARNESS_AGENT: 'no-type' }, [], /HARNESS_AGENT/],
    [{ ...parent, HARNESS_AGENT: 'a/b:general-purpose' }, [], /HARNESS_AGENT/]
  ]) {
    const r = run(env, 'send', '{"type":"TRIAGED","tier":1,"criteria":["a works"]}', '--to', 'item:a', ...args, '--dir', dir);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, why);
    assert.equal(r.stdout, '');
  }
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), before, 'nothing was written');
});

// The hooks' records: the Stop hook's session ledger and the SubagentStart hook's agent record beside it.
const sessionLedger = (lib, id, start, end) => {
  const dir = join(lib, 'ledger', 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ filedAt: end, session: { sessionId: id, start, end, turns: [] } }));
};
const agentRecord = (lib, sid, aid, at, type = 'general-purpose') => {
  const dir = join(lib, 'ledger', 'sessions', sid, 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${aid}.json`), JSON.stringify({ sessionId: sid, agentId: aid, agentType: type, at }));
};
const event = (kind, id, at, type) => ({ id: `e-${id}-${at}`, version: 1, at, to: 'item:a', actor: { kind, id, ...(type && { type }) }, source: { kind: 'cli', ref: 'harness send' }, event: { type: 'BLOCK' } });

test('verify-actors checks each agent actor against the SubagentStart records: ok, no record, outside window', () => {
  const lib = tempDir('harness-lib-');
  const dir = tempDir('harness-agents-');
  sessionLedger(lib, 'lead', '2026-10-27T10:00:00.000Z', '2026-10-27T12:00:00.000Z');
  agentRecord(lib, 'lead', 'a1', '2026-10-27T10:10:00.000Z');
  agentRecord(lib, 'lead', 'a2', '2026-10-27T11:00:00.000Z');
  agentRecord(lib, 'lead', 'a3', '2026-10-27T10:10:00.000Z', 'Explore');
  const log = [
    event('session', 'lead', '2026-10-27T10:05:00.000Z'),
    event('agent', 'lead/a1', '2026-10-27T10:30:00.000Z', 'general-purpose'),
    event('agent', 'lead/a2', '2026-10-27T10:30:00.000Z', 'general-purpose'), // before its subagent started
    event('agent', 'lead/a9', '2026-10-27T10:30:00.000Z', 'general-purpose'), // no subagent ran under that id
    event('agent', 'other/a1', '2026-10-27T10:30:00.000Z', 'general-purpose'), // that agent id under another session
    event('agent', 'lead/a3', '2026-10-27T10:30:00.000Z', 'general-purpose'), // the record says another agent_type
    event('agent', 'lead/a1', '2026-10-27T13:00:00.000Z', 'general-purpose') // after the session's last filed turn
  ];
  writeFileSync(join(dir, 'events.jsonl'), log.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const r = run({ HARNESS_LIBRARY_DIR: lib, ...parent }, 'verify-actors', '--store', dir);
  assert.equal(r.status, 1, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 6, r.stdout);
  assert.match(lines[0], /^ok session:lead \(1 event\)/);
  assert.match(lines[1], /^outside window agent:lead\/a1: e-lead\/a1-2026-10-27T13:00:00.000Z at 2026-10-27T13:00:00.000Z is not in 2026-10-27T10:10:00.000Z\.\.2026-10-27T12:00:00.000Z/);
  assert.match(lines[2], /^outside window agent:lead\/a2: .* is not in 2026-10-27T11:00:00.000Z\.\./);
  assert.match(lines[3], /^no record agent:lead\/a9 \(1 event\)/);
  assert.match(lines[4], /^no record agent:other\/a1 \(1 event\)/);
  assert.match(lines[5], /^no record agent:lead\/a3 \(1 event\): .*Explore/);
  assert.match(r.stderr, /5 agent actors: 0 ok, 3 no record, 2 outside window/);

  writeFileSync(join(dir, 'events.jsonl'), [log[0], log[1]].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const ok = run({ HARNESS_LIBRARY_DIR: lib, ...parent }, 'verify-actors', '--store', dir);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^ok agent:lead\/a1 \(1 event\)$/m);
});
