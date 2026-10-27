// #33: the plugin's agent hooks (scripts/agent-actor.js), run as the host runs them on a copy of the
// committed plugin. PreToolUse on Bash hands a subagent's agent to every harness call in its command
// (HARNESS_AGENT, via updatedInput) and denies a command that sets HARNESS_AGENT itself; SubagentStart files
// the agent's record in this session's ledger. Like every hook: silent and a no-op unless installed, exit 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync, chmodSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const plugin = join(repo, 'plugins/harness');

function scratch() {
  const tmp = tempDir('agent-hook-');
  const lib = join(tmp, 'harness');
  mkdirSync(lib);
  const root = join(tmp, 'harness~g2 x');
  cpSync(plugin, root, { recursive: true });
  // A fake `harness` CLI on PATH that prints the agent it was handed, so a rewritten command can be run.
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'harness'), '#!/bin/sh\necho "agent=${HARNESS_AGENT:-none}"\n');
  // A fake that prints the call record it was handed (#36).
  writeFileSync(join(bin, 'harness-call'), '#!/bin/sh\necho "call=${HARNESS_CALL:-none} agent=${HARNESS_AGENT:-none}"\n');
  chmodSync(join(bin, 'harness-call'), 0o755);
  chmodSync(join(bin, 'harness'), 0o755);
  return { tmp, lib, root, bin, install: () => writeFileSync(join(lib, 'install.json'), '{"installedAt":"2026-10-27"}') };
}
const hook = (root, env, input) => {
  const r = spawnSync('node', [join(root, 'scripts', 'agent-actor.js')], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { ...process.env, HARNESS_DISABLED: '', ...env } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  return r.stdout;
};
const SID = '2ce18a8f-fd3a-507a-82d3-2dea2ed3db49';
// Hook input as measured on Claude Code 2.1.311: a subagent's PreToolUse has agent_id and agent_type, the parent's neither.
const bash = (command, sub = { agent_id: 'a076db74e73211f3e', agent_type: 'general-purpose' }) => ({
  session_id: SID, transcript_path: '/t.jsonl', cwd: '/w', permission_mode: 'default', ...sub, effort: 'high',
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'run it', timeout: 60000 }, tool_use_id: 'toolu_1'
});
const parentBash = (command) => bash(command, {});
const started = (agent_id = 'a076db74e73211f3e', agent_type = 'general-purpose') => ({ session_id: SID, transcript_path: '/t.jsonl', cwd: '/w', prompt_id: 'p1', agent_id, agent_type, hook_event_name: 'SubagentStart' });
const out = (stdout) => JSON.parse(stdout).hookSpecificOutput;
const runCommand = (command, bin) => execFileSync('bash', ['-c', command], { encoding: 'utf8', env: { ...process.env, HARNESS_AGENT: '', PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'ignore'] });

test('hooks.json lists the agent hooks: PreToolUse on Bash and SubagentStart, both agent-actor.js', () => {
  const { hooks } = JSON.parse(readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8'));
  const pre = hooks.PreToolUse.find((h) => h.matcher === 'Bash').hooks[0];
  assert.deepEqual([pre.command, pre.args], ['node', ['${CLAUDE_PLUGIN_ROOT}/scripts/agent-actor.js']]);
  const start = hooks.SubagentStart[0].hooks[0];
  assert.deepEqual([start.command, start.args], ['node', ['${CLAUDE_PLUGIN_ROOT}/scripts/agent-actor.js']]);
  assert.ok(pre.timeout <= 10 && start.timeout <= 30);
});

test('without the install marker, or disabled, both hooks print nothing and write nothing', () => {
  const { lib, root, install } = scratch();
  const inputs = [bash('harness send x'), bash('HARNESS_AGENT=x:y harness send x'), parentBash('export HARNESS_AGENT=x:y'), started()];
  for (const input of inputs) assert.equal(hook(root, { HARNESS_LIBRARY_DIR: lib }, input), '', input.tool_input?.command ?? input.hook_event_name);
  install();
  for (const input of inputs) assert.equal(hook(root, { HARNESS_LIBRARY_DIR: lib, HARNESS_DISABLED: '1' }, input), '');
  assert.deepEqual(readdirSync(lib), ['install.json'], 'no writes');
});

test('PreToolUse: every harness call in a subagent command carries its agent, nested or chained', () => {
  const { lib, root, bin, tmp, install } = scratch();
  install();
  const sourced = join(tmp, 'forge.sh');
  writeFileSync(sourced, 'export HARN""ESS_AGENT=forged:x 2>/dev/null\nHARNESS_AGENT=forged:x\n');
  for (const command of [
    'harness send x',
    'true && harness send x',
    'cd / ; harness status',
    'bash -c "harness send x"',
    "sh -c 'harness send x'",
    'echo go | (harness send x)',
    `source ${sourced}; harness send x`
  ]) {
    const o = out(hook(root, { HARNESS_LIBRARY_DIR: lib }, bash(command)));
    assert.equal(o.hookEventName, 'PreToolUse');
    assert.equal(o.permissionDecision, undefined, 'no decision: the permission rules still apply to the command');
    assert.deepEqual({ ...o.updatedInput, command: null }, { command: null, description: 'run it', timeout: 60000 }, 'the other fields are kept');
    assert.ok(o.updatedInput.command.endsWith(command), 'the command itself is unchanged after the prefix');
    assert.equal(runCommand(o.updatedInput.command, bin).trim(), 'agent=a076db74e73211f3e:general-purpose', command);
  }
});

test('PreToolUse: other commands are left unchanged; the parent session\'s harness calls carry only the call record', () => {
  const { lib, root, bin, install } = scratch();
  install();
  for (const command of ['ls -la', 'echo hi && git status', 'npm test']) assert.equal(hook(root, { HARNESS_LIBRARY_DIR: lib }, bash(command)), '', command);
  assert.equal(hook(root, { HARNESS_LIBRARY_DIR: lib }, parentBash('ls')), '', 'ls');
  for (const command of ['harness-call send x', 'bash -c "harness-call send x"']) {
    const o = out(hook(root, { HARNESS_LIBRARY_DIR: lib }, parentBash(command)));
    assert.equal(runCommand(o.updatedInput.command, bin).trim(), 'call=toolu_1 agent=none', command);
  }
  assert.equal(hook(root, { HARNESS_LIBRARY_DIR: lib }, { ...bash('harness send x'), tool_name: 'Read' }), '', 'only Bash');
});

test('PreToolUse: every harness call is recorded first (session, agent_id, tool_use_id, command hash, time) and named by HARNESS_CALL', () => {
  const { lib, root, bin, install } = scratch();
  install();
  const o = out(hook(root, { HARNESS_LIBRARY_DIR: lib }, bash('harness-call send x')));
  assert.equal(runCommand(o.updatedInput.command, bin).trim(), 'call=toolu_1 agent=a076db74e73211f3e:general-purpose');
  const record = JSON.parse(readFileSync(join(lib, 'ledger/sessions', SID, 'calls', 'toolu_1.json'), 'utf8'));
  assert.deepEqual({ ...record, at: null }, { sessionId: SID, toolUseId: 'toolu_1', at: null, kind: 'bash', agentId: 'a076db74e73211f3e', agentType: 'general-purpose', commandSha256: createHash('sha256').update('harness-call send x').digest('hex') });
  out(hook(root, { HARNESS_LIBRARY_DIR: lib }, { ...parentBash('harness send y'), tool_use_id: 'toolu_2' }));
  assert.equal(JSON.parse(readFileSync(join(lib, 'ledger/sessions', SID, 'calls', 'toolu_2.json'), 'utf8')).agentId, null, "the parent's call names no agent");
});

test('PreToolUse: a command that sets HARNESS_AGENT itself is denied with a reason, from a subagent or the parent', () => {
  const { lib, root, install } = scratch();
  install();
  for (const command of [
    'HARNESS_AGENT=other:general-purpose harness send x',
    'export HARNESS_AGENT=other:x; harness send x',
    'export HARNESS_AGENT; harness send x',
    'env HARNESS_AGENT=other:x harness send x',
    'env -u HARNESS_AGENT harness send x',
    'unset HARNESS_AGENT && harness send x',
    'declare -x HARNESS_AGENT=other:x; harness send x',
    'bash -c "HARNESS_AGENT=other:x harness send x"',
    'true && HARNESS_AGENT=x:y harness send x',
    'HARNESS_AGENT+=x harness send x',
    'HARNESS_CALL=toolu_9 harness send x',
    'env HARNESS_CALL=toolu_9 harness send x'
  ])
    for (const input of [bash(command), parentBash(command)]) {
      const o = out(hook(root, { HARNESS_LIBRARY_DIR: lib }, input));
      assert.equal(o.permissionDecision, 'deny', command);
      assert.match(o.permissionDecisionReason, /^harness \(setsHarnessAgent\): .*HARNESS_AGENT/);
      assert.equal(o.updatedInput, undefined);
    }
});

test('SubagentStart: files agent_id, agent_type and the time in this session\'s ledger, and prints nothing', () => {
  const { lib, root, install } = scratch();
  install();
  const before = Date.now();
  assert.equal(hook(root, { HARNESS_LIBRARY_DIR: lib }, started('a1', 'my-plugin:reviewer')), '');
  const record = JSON.parse(readFileSync(join(lib, 'ledger/sessions', SID, 'agents', 'a1.json'), 'utf8'));
  assert.deepEqual({ ...record, at: null }, { sessionId: SID, agentId: 'a1', agentType: 'my-plugin:reviewer', at: null });
  assert.ok(Date.parse(record.at) >= before - 1000 && Date.parse(record.at) <= Date.now() + 1000);
});

test('the hooks exit 0 on their own failure: bad input, odd ids and types, an unwritable Library', () => {
  const { lib, root, bin, install } = scratch();
  install();
  for (const input of ['not json', '', '{}', JSON.stringify({ hook_event_name: 'SubagentStart' }), JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })])
    assert.equal(hook(root, { HARNESS_LIBRARY_DIR: lib }, input), '');
  // A type that is not a plain name is never pasted into the shell as code.
  const o = out(hook(root, { HARNESS_LIBRARY_DIR: lib }, bash('harness send x', { agent_id: 'a1', agent_type: "x'; echo pwned; '" })));
  assert.equal(runCommand(o.updatedInput.command, bin), 'agent=a1:xechopwned\n', 'the type is reduced to a name, and nothing in it runs');
  // An agent id that cannot name a file writes nothing outside the session's folder.
  assert.equal(hook(root, { HARNESS_LIBRARY_DIR: lib }, started('../../x', 'general-purpose')), '');
  assert.ok(!existsSync(join(lib, 'ledger', 'x.json')) && !existsSync(join(lib, 'x.json')));
  const other = scratch();
  other.install();
  writeFileSync(join(other.lib, 'ledger'), 'a file where the folder should be');
  assert.equal(hook(other.root, { HARNESS_LIBRARY_DIR: other.lib }, started()), '');
});
