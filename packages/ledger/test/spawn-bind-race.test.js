// #57: the 03:56Z race, through the plugin's hooks as the host runs them (a copy of the committed plugin, the real
// harness CLI, a scratch store, HARNESS_ENFORCE=1). SubagentStart's input names the agent and its type but not the
// Agent call, so the hook binds a new agent to the one spawn of its type the session has waiting. The lead spawned two
// general-purpose triagers for two items; both SubagentStart hooks ran within 200 ms and both picked the first spawn.
// Now the spawn gate denies a second spawn of a type while one waits (oneUnboundSpawn), a refused bind writes nothing
// on the spawn's record, and a spawn whose agent never started is closed (SPAWN_CLOSED).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(repo, 'packages/harness/bin/harness.js');
const SID = '1e845063-f2a5-57f9-9224-c9474c15ad70';
const enforce = { HARNESS_ENFORCE: '1' };

function scratch(items) {
  const tmp = tempDir('spawn-bind-race-');
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
// A hook run as the host runs it, on its own process, so several can run at once.
const hook = (s, input, extra = {}, script = 'gates.js') => new Promise((ok, fail) => {
  const p = spawn('node', [join(s.root, 'scripts', script)], { env: { ...s.env, ...extra } });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.on('error', fail);
  p.on('close', (code) => (code === 0 ? ok(out ? JSON.parse(out).hookSpecificOutput : null) : fail(new Error(`${script} exited ${code}`))));
  p.stdin.end(JSON.stringify(input));
});
let n = 0;
const spawnInput = (item, subagent_type = 'general-purpose') => ({ session_id: SID, cwd: '/w', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: `triage ${item}`, prompt: `Harness-Role: triager item:${item}\nTriage ${item}.`, subagent_type }, tool_use_id: `toolu_${item}_${++n}` });
const startInput = (agent_id, agent_type = 'general-purpose') => ({ session_id: SID, cwd: '/w', prompt_id: 'p', agent_id, agent_type, hook_event_name: 'SubagentStart' });
// A harness call by the session (aid null) or one of its subagents, through the agent hook's record and stamp.
function asCall(s, aid, type, args) {
  const input = { session_id: SID, cwd: '/w', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `harness ${args.join(' ')}` }, tool_use_id: `toolu_b${++n}`, ...(aid && { agent_id: aid, agent_type: type }) };
  const r = spawnSync('node', [join(s.root, 'scripts', 'agent-actor.js')], { input: JSON.stringify(input), encoding: 'utf8', env: s.env });
  const stamp = JSON.parse(r.stdout).hookSpecificOutput.updatedInput.command.split('\n')[0];
  return spawnSync('bash', ['-c', `${stamp}\n"${process.execPath}" "${BIN}" "$@"`, 'x', ...args], { encoding: 'utf8', env: { ...s.env, CLAUDE_CODE_SESSION_ID: SID } });
}
const triage = (s, aid, item) => s.cli(['send', '{"type":"TRIAGED","tier":0,"criteria":["it works"]}', '--to', `item:${item}`], aid, 'general-purpose');
const calls = (s) => {
  const dir = join(s.lib, 'ledger/sessions', SID, 'calls');
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
};
const spawnsOf = (s, item) => JSON.parse(readFileSync(join(s.store, 'state.json'), 'utf8')).snapshot.children[item].snapshot.context.spawns;
const allowedOrDenied = (o, label) => {
  if (o === null) return true;
  assert.equal(o.permissionDecision, 'deny', label);
  assert.match(o.permissionDecisionReason, /^harness \(oneUnboundSpawn\): /, `${label}: denied by the named rule, not ${o.permissionDecisionReason}`);
  return false;
};

test('the 03:56Z race: two same-type triager spawns, then their SubagentStart hooks at once; each agent sends on its own item, or its spawn was denied by a named rule', async () => {
  const s = scratch(['ledger', 'tour']);
  const agents = { ledger: 'a1ed9e7', tour: 'a70c4a1' };
  const allowed = [];
  for (const item of ['ledger', 'tour']) if (allowedOrDenied(await hook(s, spawnInput(item), enforce), item)) allowed.push(item);
  assert.equal(allowed[0], 'ledger', 'the first spawn is recorded');
  // Every agent whose spawn was let through starts, all at once, as the two did at 03:56Z.
  await Promise.all(allowed.map((item) => hook(s, startInput(agents[item]), {}, 'agent-actor.js')));
  for (const item of allowed) {
    const r = triage(s, agents[item], item);
    assert.equal(r.status, 0, `${item}'s triager sends on its own item: ${r.stdout}${r.stderr}`);
  }
  const unbound = calls(s).filter((c) => c.kind === 'spawn' && c.recorded === true && !c.boundAgent);
  assert.deepEqual(unbound, [], 'no recorded spawn is left unbound');
});

test('three parallel same-type spawns: one is recorded and two are denied by oneUnboundSpawn, and each in turn binds its own agent', async () => {
  const s = scratch(['x', 'y', 'z']);
  const outs = await Promise.all(['x', 'y', 'z'].map((item) => hook(s, spawnInput(item), enforce)));
  const first = ['x', 'y', 'z'].filter((item, i) => allowedOrDenied(outs[i], item));
  assert.equal(first.length, 1, `one spawn waits at a time: ${JSON.stringify(outs)}`);
  await hook(s, startInput(`a${first[0]}`), {}, 'agent-actor.js');
  assert.equal(triage(s, `a${first[0]}`, first[0]).status, 0);
  for (const item of ['x', 'y', 'z'].filter((i) => i !== first[0])) {
    assert.equal(await hook(s, spawnInput(item), enforce), null, `${item}, once the one before is bound`);
    await hook(s, startInput(`a${item}`), {}, 'agent-actor.js');
    const r = triage(s, `a${item}`, item);
    assert.equal(r.status, 0, `${item}: ${r.stdout}${r.stderr}`);
  }
});

test('a refused bind never overwrites another agent\'s bind in the call record', async () => {
  const s = scratch(['ledger']);
  const input = spawnInput('ledger');
  assert.equal(await hook(s, input, enforce), null);
  // Two agents of the type start at once: the store binds one, and refuses the other.
  await Promise.all(['a1', 'a2'].map((aid) => hook(s, startInput(aid), {}, 'agent-actor.js')));
  const [spawned] = spawnsOf(s, 'ledger');
  assert.ok(spawned.agent, 'the store bound one');
  const record = calls(s).find((c) => c.toolUseId === input.tool_use_id);
  assert.equal(record.boundAgent, spawned.agent, 'the call record names the agent the store bound');
});

test('a spawn whose agent never started is closed by the lead, and binds no later agent', async () => {
  const s = scratch(['ledger', 'tour']);
  const ledger = spawnInput('ledger');
  assert.equal(await hook(s, ledger, enforce), null);
  // Its agent never starts. The next general-purpose spawn is denied, naming the spawn that waits and how to close it.
  const denied = await hook(s, spawnInput('tour'), enforce);
  assert.match(denied?.permissionDecisionReason ?? '', new RegExp(`oneUnboundSpawn.*${ledger.tool_use_id} on item:ledger.*SPAWN_CLOSED`, 's'));
  const r = s.cli(['send', JSON.stringify({ type: 'SPAWN_CLOSED', toolUseId: ledger.tool_use_id }), '--to', 'item:ledger']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(await hook(s, spawnInput('tour'), enforce), null, 'closed: the next spawn is recorded');
  await hook(s, startInput('a70c4a1'), {}, 'agent-actor.js');
  const t = triage(s, 'a70c4a1', 'tour');
  assert.equal(t.status, 0, t.stdout + t.stderr);
  assert.deepEqual(spawnsOf(s, 'ledger').map((x) => x.agent), [null], 'the closed spawn bound no one');
});
