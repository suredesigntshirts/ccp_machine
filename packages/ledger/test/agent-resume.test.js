// #79: a resumed subagent (SendMessage to an agent that already ran) fires SubagentStart again. The hook used to
// write the agent's record afresh, so its start time moved to the resume, its bind was redone (and could take a
// newer spawn of its type), and harness verify-actors saw every event the agent sent before the resume as outside
// its window. Run through the plugin's hooks as the host runs them, on a copy of the committed plugin, the real
// harness CLI and a scratch store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, verifyActors } from '../../harness/src/index.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(repo, 'packages/harness/bin/harness.js');
const SID = '7c1f0a52-2b8e-5d3a-9f4e-1a2b3c4d5e6f';

function scratch(items) {
  const tmp = tempDir('agent-resume-');
  const lib = join(tmp, 'harness');
  mkdirSync(lib);
  writeFileSync(join(lib, 'install.json'), '{"installedAt":"2026-10-28"}');
  const root = join(tmp, 'plugin');
  cpSync(join(repo, 'plugins/harness'), root, { recursive: true });
  const env = { ...process.env, HARNESS_DISABLED: '' };
  for (const k of ['HARNESS_AGENT', 'HARNESS_CALL', 'HARNESS_ENFORCE', 'HARNESS_DIR', 'CLAUDE_CODE_SESSION_ID']) delete env[k];
  const s = { lib, root, store: join(tmp, 'store'), env: { ...env, HARNESS_LIBRARY_DIR: lib, HARNESS_BIN: BIN, HARNESS_DIR: join(tmp, 'store') } };
  s.cli = (args, aid = null, type = null) => asCall(s, aid, type, args);
  assert.equal(s.cli(['init']).status, 0);
  for (const id of items) assert.equal(s.cli(['send', JSON.stringify({ type: 'REQUEST_RECEIVED', request: { id } })]).status, 0, id);
  return s;
}
const hook = (s, script, input, extra = {}) => {
  const r = spawnSync('node', [join(s.root, 'scripts', script)], { input: JSON.stringify(input), encoding: 'utf8', env: { ...s.env, ...extra } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
};
let n = 0;
const spawnInput = (item) => ({ session_id: SID, cwd: '/w', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: `triage ${item}`, prompt: `Harness-Role: triager item:${item}\nTriage ${item}.`, subagent_type: 'general-purpose' }, tool_use_id: `toolu_${item}_${++n}` });
const startInput = (agent_id) => ({ session_id: SID, cwd: '/w', prompt_id: 'p', agent_id, agent_type: 'general-purpose', hook_event_name: 'SubagentStart' });
function asCall(s, aid, type, args) {
  const input = { session_id: SID, cwd: '/w', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `harness ${args.join(' ')}` }, tool_use_id: `toolu_b${++n}`, ...(aid && { agent_id: aid, agent_type: type }) };
  const stamp = hook(s, 'agent-actor.js', input).updatedInput.command.split('\n')[0];
  return spawnSync('bash', ['-c', `${stamp}\n"${process.execPath}" "${BIN}" "$@"`, 'x', ...args], { encoding: 'utf8', env: { ...s.env, CLAUDE_CODE_SESSION_ID: SID } });
}
const agentRecord = (s, aid) => JSON.parse(readFileSync(join(s.lib, 'ledger/sessions', SID, 'agents', `${aid}.json`), 'utf8'));
const spawnsOf = (s, item) => JSON.parse(readFileSync(join(s.store, 'state.json'), 'utf8')).snapshot.children[item].snapshot.context.spawns;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test('a resumed agent keeps its first start and bind, and what it sent between its two starts verifies ok', () => {
  const s = scratch(['ledger', 'tour']);
  const enforce = { HARNESS_ENFORCE: '1' };
  assert.equal(hook(s, 'gates.js', spawnInput('ledger'), enforce), null, 'the ledger triager spawn is recorded');
  hook(s, 'agent-actor.js', startInput('a1'));
  const first = agentRecord(s, 'a1');
  assert.equal(first.bind?.result, 'bound', JSON.stringify(first));
  pause(20);
  const t = s.cli(['send', '{"type":"TRIAGED","tier":0,"criteria":["it works"]}', '--to', 'item:ledger'], 'a1', 'general-purpose');
  assert.equal(t.status, 0, t.stdout + t.stderr);
  pause(20);
  // The lead spawns a triager for another item, and resumes a1 before that one starts.
  assert.equal(hook(s, 'gates.js', spawnInput('tour'), enforce), null, 'the tour triager spawn is recorded');
  const resumedAt = Date.now();
  hook(s, 'agent-actor.js', startInput('a1'));

  // The session's ledger, as the Stop hook files it, and verify-actors with no slack, so the window start decides.
  const dir = join(s.lib, 'ledger', 'sessions');
  writeFileSync(join(dir, `${SID}.json`), JSON.stringify({ session: { sessionId: SID, start: '2026-01-01T00:00:00.000Z', end: new Date(Date.now() + 60_000).toISOString() } }));
  const store = openStore(s.store);
  const sent = store.events().find((e) => e.actor?.id === `${SID}/a1`);
  assert.ok(Date.parse(sent.at) > Date.parse(first.at) && Date.parse(sent.at) < resumedAt, 'sent between the two starts');
  const ok = verifyActors(store, { dir, toleranceMs: 0 }).find((r) => r.id === `${SID}/a1`);
  assert.equal(ok.result, 'ok', JSON.stringify(ok));

  const resumed = agentRecord(s, 'a1');
  assert.equal(resumed.at, first.at, 'the first start time is kept');
  assert.deepEqual(resumed.bind, first.bind, 'the first bind is kept');
  assert.equal(resumed.resumes?.length, 1, `the resume is added: ${JSON.stringify(resumed)}`);
  assert.ok(Date.parse(resumed.resumes[0]) > Date.parse(first.at));
  assert.deepEqual(spawnsOf(s, 'tour').map((x) => x.agent), [null], 'the resume took no newer spawn');
  hook(s, 'agent-actor.js', startInput('a2'));
  assert.deepEqual(spawnsOf(s, 'tour').map((x) => x.agent), [`${SID}/a2`], 'the agent spawned for it binds it');

  const early = { ...sent, id: 'early', at: new Date(Date.parse(first.at) - 3_600_000).toISOString() };
  const withEarly = { events: () => [...store.events(), early] };
  const out = verifyActors(withEarly, { dir, toleranceMs: 0 }).find((r) => r.id === `${SID}/a1`);
  assert.equal(out.result, 'outside window', JSON.stringify(out));
  assert.match(out.why, /^early at /);
});
