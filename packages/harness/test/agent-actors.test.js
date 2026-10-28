// #33: subagents are actors of their own. A subagent shares its parent's CLAUDE_CODE_SESSION_ID, so the
// spec names it as agent <session_id>/<agent_id> (harness meta.actors), the role guards compare that whole
// actor, the CLI records it when the plugin's PreToolUse hook hands it over (HARNESS_AGENT), and
// verify-actors checks it against the SubagentStart hook's record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
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
  // A well-formed agent passes the envelope, and is then judged by what its role allows: an agent files no request (agentEvents).
  assert.match(refused(store, { type: 'REQUEST_RECEIVED', request: { id: 'a' }, ...agent('filer') }, undefined, 'an agent files a request').why, /\(agentEvents\)/);
  for (const id of ['filer', `${LEAD}/`, `/x`, `${LEAD}/x/y`]) {
    const r = refused(store, { type: 'REQUEST_RECEIVED', request: { id: 'b' }, actor: { kind: 'agent', id }, source: { kind: 'cli', ref: 'x' } }, undefined, `agent id ${id}`);
    assert.match(r.why, /actor/);
  }
  refused(store, { type: 'REQUEST_RECEIVED', request: { id: 'b' }, ...session(`${LEAD}/filer`) }, undefined, 'a session id with a slash');
  refused(store, { type: 'ORCHESTRATOR_STARTED', ...agent('lead') }, undefined, 'an agent cannot be the orchestrator');
});

// A worker subagent sends item events once its spawn is recorded and bound (#36): the session spawns it, SubagentStart binds it.
const BRIEF = 'b'.repeat(64);
const spawn = (store, role, aid, sid = LEAD) => {
  const type = role === 'triager' ? 'general-purpose' : `harness:${role}`;
  taken(store, { type: 'WORKER_SPAWNED', role, briefSha256: BRIEF, agentType: type, ...session(sid) }, 'item:a', `${sid} spawns a ${role}`);
  taken(store, { type: 'WORKER_STARTED', agent: `${sid}/${aid}`, agentType: type, ...session(sid) }, 'item:a', `${sid}/${aid} starts`);
};

// The lead (the orchestrator session) with its triager, builder, checker and stand-in subagents: one session, five actors.
function lead(store) {
  taken(store, { type: 'REQUEST_RECEIVED', request: { id: 'a' }, ...session(LEAD) }, undefined, 'the lead files');
  spawn(store, 'triager', 'triager');
  taken(store, { type: 'TRIAGED', tier: 1, criteria: ['a works'], ...agent('triager') }, 'item:a', "the lead's triager subagent triages");
  spawn(store, 'stand-in', 'stand-in');
  taken(store, { type: 'STAND_IN_ANSWERED', answer: sure, ...agent('stand-in') }, decisionOf(store), "the lead's stand-in subagent answers");
  assert.ok(!decide(store, decisionOf(store), 'approve').refused);
  taken(store, { type: 'VERIFIER_BRIEF_FIXED', sha256: BRIEF, ...session(LEAD) }, 'item:a', 'the lead fixes the verifier brief');
  spawn(store, 'builder', 'builder');
  taken(store, { type: 'RUN_SUCCEEDED', ...agent('builder') }, 'item:a', "the lead's builder subagent reports a run: it is not the orchestrator");
  spawn(store, 'verifier', 'checker');
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
  spawn(store, 'verifier', 'builder', 'other-session');
  taken(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'test a', ...agent('builder', 'other-session') }, 'item:a', "another session's agent with the builder's agent_id is not the builder");
  assert.deepEqual(ctx(store).checkers, ['other-session/builder']);
});

test('an agent stand-in cannot answer for the item it built, checked or triaged', () => {
  const store = fresh();
  taken(store, { type: 'REQUEST_RECEIVED', request: { id: 'a' }, ...session(LEAD) });
  spawn(store, 'triager', 'triager');
  taken(store, { type: 'TRIAGED', tier: 1, criteria: ['a works'], ...agent('triager') }, 'item:a');
  refused(store, { type: 'STAND_IN_ANSWERED', answer: sure, ...agent('triager') }, decisionOf(store), 'the triager subagent answers the plan');
  spawn(store, 'stand-in', 'stand-in');
  taken(store, { type: 'STAND_IN_ANSWERED', answer: sure, ...agent('stand-in') }, decisionOf(store), 'another subagent answers the plan');
});

// The CLI, as a subagent's Bash call runs it once the plugin's PreToolUse hook has recorded the call and set
// HARNESS_CALL and HARNESS_AGENT (#36: the CLI believes the agent only when the hook's record names it).
const bin = new URL('../bin/harness.js', import.meta.url).pathname;
const LIB = tempDir('harness-lib-');
let calls = 0;
// The hook's record of one call, as plugins/harness/scripts/host.js writeCall files it: its key's sha256, and whether
// the hook ran under HARNESS_ENFORCE=1. Returns HARNESS_CALL as the hook stamps it, <tool_use_id>:<key>.
const recordCall = (sid, aid, { lib = LIB, enforced = false, id = `toolu_${++calls}`, kind = 'bash' } = {}) => {
  const key = randomBytes(16).toString('hex');
  const dir = join(lib, 'ledger', 'sessions', sid, 'calls');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ sessionId: sid, toolUseId: id, at: new Date().toISOString(), kind, agentId: aid ?? null, keySha256: createHash('sha256').update(key).digest('hex'), enforced }));
  return `${id}:${key}`;
};
const run = (env, ...args) => {
  const e = { ...process.env, HARNESS_LIBRARY_DIR: LIB, HARNESS_AGENT: undefined, HARNESS_CALL: undefined, HARNESS_ENFORCE: undefined, ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: e });
};
const rows = (dir) => readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const parent = { CLAUDE_CODE_SESSION_ID: 'lead' };
const sub = (aid, type = 'general-purpose') => ({ CLAUDE_CODE_SESSION_ID: 'lead', HARNESS_AGENT: `${aid}:${type}`, HARNESS_CALL: recordCall('lead', aid.split('/')[0]) });
function cliItem() {
  const dir = tempDir('harness-agents-cli-');
  assert.equal(run(parent, 'init', '--dir', dir).status, 0);
  assert.equal(run(parent, 'send', '{"type":"REQUEST_RECEIVED","request":{"id":"a"}}', '--dir', dir).status, 0);
  return dir;
}
// The lead spawns and binds a worker through the CLI, as the spawn gate and the SubagentStart hook do.
const cliSpawn = (dir, role, aid, type) => {
  for (const e of [{ type: 'WORKER_SPAWNED', role, briefSha256: BRIEF, agentType: type }, { type: 'WORKER_STARTED', agent: `lead/${aid}`, agentType: type }]) {
    const r = run(parent, 'send', JSON.stringify(e), '--to', 'item:a', '--dir', dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
};

test('CLI: the default actor is the agent when HARNESS_AGENT is set and the hook recorded the call, else the session as before', () => {
  const dir = cliItem();
  assert.deepEqual(rows(dir).at(-1).actor, { kind: 'session', id: 'lead' });
  cliSpawn(dir, 'triager', 'a1b2', 'my-plugin:reviewer');
  const r = run(sub('a1b2', 'my-plugin:reviewer'), 'send', '{"type":"TRIAGED","tier":0,"criteria":["a works"]}', '--to', 'item:a', '--dir', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(rows(dir).at(-1).actor, { kind: 'agent', id: 'lead/a1b2', type: 'my-plugin:reviewer' });
  assert.equal(run(parent, 'send', JSON.stringify({ type: 'VERIFIER_BRIEF_FIXED', sha256: BRIEF }), '--to', 'item:a', '--dir', dir).status, 0);
  cliSpawn(dir, 'builder', 'c3d4', 'harness:builder');
  // The plugin's call record names the subagent, so its run needs no --actor or --source.
  const w = run(sub('c3d4', 'harness:builder'), 'send', '{"type":"RUN_SUCCEEDED"}', '--to', 'item:a', '--dir', dir);
  assert.equal(w.status, 0, w.stderr);
  assert.deepEqual([rows(dir).at(-1).actor, rows(dir).at(-1).source], [{ kind: 'agent', id: 'lead/c3d4', type: 'harness:builder' }, { kind: 'cli', ref: 'harness send' }]);
  const unflagged = run({ ...parent, HARNESS_AGENT: 'c3d4:harness:builder' }, 'send', '{"type":"RUN_FAILED"}', '--to', 'item:a', '--dir', dir);
  assert.equal(unflagged.status, 1, 'without the record it is refused');
  assert.match(unflagged.stderr, /needs --actor/);
});

test('CLI: an agent the hook did not record is refused', () => {
  const dir = cliItem();
  cliSpawn(dir, 'triager', 'a1', 'general-purpose');
  const before = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  const triage = ['send', '{"type":"TRIAGED","tier":0,"criteria":["a works"]}', '--to', 'item:a', '--dir', dir];
  for (const [env, why] of [
    // An obfuscated HARNESS_AGENT reaches the CLI with no call record, or with the record of the real caller.
    [{ ...parent, HARNESS_AGENT: 'a1:general-purpose' }, /comes with no HARNESS_CALL/],
    [{ ...parent, HARNESS_AGENT: 'a1:general-purpose', HARNESS_CALL: recordCall('lead', null) }, /names session lead, not agent lead\/a1/],
    [{ ...parent, HARNESS_AGENT: 'a1:general-purpose', HARNESS_CALL: recordCall('lead', 'a9') }, /names agent lead\/a9, not agent lead\/a1/],
    [{ ...parent, HARNESS_AGENT: 'a1:general-purpose', HARNESS_CALL: 'toolu_nowhere:0123' }, /names no record/],
    [{ ...parent, HARNESS_AGENT: 'a1:general-purpose', HARNESS_CALL: recordCall('other', 'a1') }, /names no record/]
  ]) {
    const r = run(env, ...triage);
    assert.equal(r.status, 1, `${JSON.stringify(env)}: ${r.stderr}`);
    assert.match(r.stderr, why);
    assert.match(r.stderr, /nothing was written/);
  }
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), before, 'nothing was written');
  const ok = run(sub('a1'), ...triage);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(rows(dir).at(-1).actor, { kind: 'agent', id: 'lead/a1', type: 'general-purpose' });
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
    [{ HARNESS_AGENT: 'a1:general-purpose', CLAUDE_CODE_SESSION_ID: undefined }, [], /HARNESS_AGENT\S* .*CLAUDE_CODE_SESSION_ID/],
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

test("CLI: HARNESS_CALL is believed only with the key the hook stamped on that call, never an id the caller wrote", () => {
  const dir = cliItem();
  cliSpawn(dir, 'triager', 'a1', 'general-purpose');
  const before = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  const triage = ['send', '{"type":"TRIAGED","tier":0,"criteria":["a works"]}', '--to', 'item:a', '--dir', dir];
  const mine = recordCall('lead', 'a1');
  const [id] = mine.split(':');
  const start = recordCall('lead', null, { id: 'start-a1', kind: 'start' }); // the SubagentStart hook's own call
  for (const [env, why] of [
    [{ ...parent, HARNESS_AGENT: 'a1:general-purpose', HARNESS_CALL: id }, /carries no key/],
    [{ ...parent, HARNESS_AGENT: 'a1:general-purpose', HARNESS_CALL: `${id}:${'0'.repeat(32)}` }, /key .* not the one the plugin's hook stamped/],
    // The review's attack: a subagent names the start record (which names the session) and drops HARNESS_AGENT.
    [{ ...parent, HARNESS_CALL: 'start-a1' }, /carries no key/],
    [{ ...parent, HARNESS_CALL: `start-a1:${mine.split(':')[1]}` }, /not the one the plugin's hook stamped/]
  ]) {
    const r = run(env, ...triage);
    assert.equal(r.status, 1, `${JSON.stringify(env)}: ${r.stderr}`);
    assert.match(r.stderr, why);
    assert.match(r.stderr, /nothing was written/);
  }
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), before, 'nothing was written');
  assert.ok(start);
  const ok = run({ ...parent, HARNESS_AGENT: 'a1:general-purpose', HARNESS_CALL: mine }, ...triage);
  assert.equal(ok.status, 0, ok.stderr);
});

// An enforced store: a call the hook recorded under HARNESS_ENFORCE=1 marks it, and from then on it takes a write only
// from a recorded call, whatever the caller's environment says.
const leadCall = (enforced = false) => ({ ...parent, HARNESS_CALL: recordCall('lead', null, { enforced }) });
function enforcedItem({ building = false } = {}) {
  const dir = cliItem();
  if (building) { // triaged at tier 0 by another session, before the store is enforced
    const t = run({ CLAUDE_CODE_SESSION_ID: undefined }, 'send', '{"type":"TRIAGED","tier":0,"criteria":["a works"]}', '--to', 'item:a', '--actor', 'session:triager', '--source', 'cli:x', '--dir', dir);
    assert.equal(t.status, 0, t.stderr);
  }
  assert.equal(existsSync(join(dir, 'enforced.json')), false, 'a call recorded without HARNESS_ENFORCE marks nothing');
  const r = run(leadCall(true), 'send', JSON.stringify({ type: 'VERIFIER_BRIEF_FIXED', sha256: BRIEF }), '--to', 'item:a', '--dir', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, 'enforced.json'), 'utf8')).libraryDir, LIB, 'the store names the Library of its records');
  return dir;
}

test('CLI: an enforced store takes a write only from a recorded call; HARNESS_ENFORCE, the session id and the Library in the caller\'s environment change nothing', () => {
  const dir = enforcedItem();
  const before = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  const fake = tempDir('harness-lib-fake-');
  const forged = recordCall('lead', null, { lib: fake });
  const block = ['send', '{"type":"BLOCK"}', '--to', 'item:a', '--dir', dir];
  for (const [env, flags] of [
    [parent, []],
    [{ ...parent, HARNESS_ENFORCE: '0' }, []],
    [{ ...parent, HARNESS_ENFORCE: '' }, []],
    [{ CLAUDE_CODE_SESSION_ID: undefined }, ['--actor', 'session:lead', '--source', 'cli:x']], // no CLAUDE_CODE_SESSION_ID: not "outside Claude Code" here
    [{ ...parent, HARNESS_LIBRARY_DIR: fake, HARNESS_CALL: forged }, []] // a record filed in another Library
  ]) {
    const r = run(env, ...block, ...flags);
    assert.equal(r.status, 1, `${JSON.stringify(env)}: ${r.stderr}`);
    assert.match(r.stderr, /enforced|names no record/);
    assert.match(r.stderr, /nothing was written/);
  }
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), before, 'nothing was written');
  assert.equal(run(leadCall(), ...block).status, 0, 'a recorded call, even one recorded without HARNESS_ENFORCE');
});

test('#36 review: a no-role agent cannot forge its spawn and start as the lead, then report a run, in an enforced store', () => {
  const dir = enforcedItem({ building: true });
  const state = () => status(openStore(dir)).items.find((i) => i.id === 'a')?.state ?? JSON.stringify(status(openStore(dir)).items);
  const was = state();
  assert.equal(was, 'active.building');
  const before = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  recordCall('lead', null, { id: 'start-x1', kind: 'start', enforced: true }); // SubagentStart's own call for x1
  const own = () => ({ ...parent, HARNESS_AGENT: 'x1:general-purpose', HARNESS_CALL: recordCall('lead', 'x1', { enforced: true }) });
  const forge = [
    ['WORKER_SPAWNED', { type: 'WORKER_SPAWNED', role: 'builder', briefSha256: BRIEF, agentType: 'general-purpose' }],
    ['WORKER_STARTED', { type: 'WORKER_STARTED', agent: 'lead/x1', agentType: 'general-purpose' }]
  ];
  for (const [name, e] of forge)
    for (const env of [
      { ...parent, HARNESS_ENFORCE: '0' }, // an unseen call: no HARNESS_CALL, enforcement "off" inline
      { ...parent, HARNESS_CALL: 'start-x1' }, // the start record's id, without its key
      { ...parent, HARNESS_CALL: own().HARNESS_CALL } // its own recorded call, minus HARNESS_AGENT
    ]) {
      const r = run(env, 'send', JSON.stringify(e), '--to', 'item:a', '--dir', dir);
      assert.equal(r.status, 1, `${name} ${JSON.stringify(env)}: ${r.stdout}${r.stderr}`);
    }
  const r = run(own(), 'send', '{"type":"RUN_SUCCEEDED","pr":"https://github.com/o/r/pull/7"}', '--to', 'item:a', '--dir', dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /agentEvents/);
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), before, 'the store took none of it');
  assert.equal(state(), was);
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

// #79: a resume fires SubagentStart again. A record written before the hook kept the first start holds the resume's
// time, so the window starts at the earliest start a hook recorded: that record, or the bind's start-<agent> call.
test('verify-actors starts an agent\'s window at the earliest start a hook recorded: its record or its start call', () => {
  const lib = tempDir('harness-lib-');
  const dir = tempDir('harness-agents-');
  sessionLedger(lib, 'lead', '2026-10-27T10:00:00.000Z', '2026-10-27T12:00:00.000Z');
  for (const aid of ['r1', 'r2', 'r3']) agentRecord(lib, 'lead', aid, '2026-10-27T11:00:00.000Z'); // each rewritten at its resume
  const calls = join(lib, 'ledger', 'sessions', 'lead', 'calls');
  mkdirSync(calls, { recursive: true });
  const startCall = (aid, record) => writeFileSync(join(calls, `start-${aid}.json`), JSON.stringify({ sessionId: 'lead', toolUseId: `start-${aid}`, at: '2026-10-27T10:10:00.000Z', kind: 'start', agentId: null, agentType: null, item: 'a', agent: `lead/${aid}`, ...record }));
  startCall('r1');
  startCall('r2', { agent: 'lead/r9' }); // another agent's start call
  startCall('r3', { kind: 'bash' }); // not a start
  writeFileSync(join(dir, 'events.jsonl'), ['r1', 'r2', 'r3'].map((aid) => JSON.stringify(event('agent', `lead/${aid}`, '2026-10-27T10:30:00.000Z', 'general-purpose'))).join('\n') + '\n');
  const r = run({ HARNESS_LIBRARY_DIR: lib, ...parent }, 'verify-actors', '--store', dir);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /^ok agent:lead\/r1 \(1 event\)$/, r.stdout);
  assert.match(lines[1], /^outside window agent:lead\/r2: .* is not in 2026-10-27T11:00:00.000Z\.\./);
  assert.match(lines[2], /^outside window agent:lead\/r3: .* is not in 2026-10-27T11:00:00.000Z\.\./);
});
