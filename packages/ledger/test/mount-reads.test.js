// #116: the Library is a FUSE mount, slow when cold. SubagentStart's bind finds its spawn in the store's state, not
// by reading every record in the session's calls folder (one record per recorded tool call: 3,737 took 8m10s cold),
// and SessionStart warms the folders the harness reads in a detached child, in parallel, without waiting for it.
// Reads are counted, never timed: a preload counts every file the hook and the CLI it runs open or list under the
// Library and the store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, openSync, writeSync, closeSync, constants } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(repo, 'packages/harness/bin/harness.js');
const SID = '5b0d6a3e-1c2f-4e8a-9d7b-116116116116';

function scratch() {
  const tmp = tempDir('mount-reads-');
  const lib = join(tmp, 'harness');
  mkdirSync(lib);
  writeFileSync(join(lib, 'install.json'), '{"installedAt":"2026-10-29"}');
  const root = join(tmp, 'plugin');
  cpSync(join(repo, 'plugins/harness'), root, { recursive: true });
  const env = { ...process.env, HARNESS_DISABLED: '' };
  for (const k of ['HARNESS_AGENT', 'HARNESS_CALL', 'HARNESS_ENFORCE', 'HARNESS_DIR', 'CLAUDE_CODE_SESSION_ID', 'NODE_OPTIONS']) delete env[k];
  const store = join(tmp, 'store');
  const s = { tmp, lib, root, store, calls: join(lib, 'ledger/sessions', SID, 'calls'), env: { ...env, HARNESS_LIBRARY_DIR: lib, HARNESS_BIN: BIN, HARNESS_DIR: store } };
  return s;
}
let n = 0;
// A harness call by the session, through the agent hook's record and stamp.
function cli(s, args) {
  const input = { session_id: SID, cwd: '/w', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `harness ${args.join(' ')}` }, tool_use_id: `toolu_b${++n}` };
  const r = spawnSync('node', [join(s.root, 'scripts', 'agent-actor.js')], { input: JSON.stringify(input), encoding: 'utf8', env: s.env });
  const stamp = JSON.parse(r.stdout).hookSpecificOutput.updatedInput.command.split('\n')[0];
  return spawnSync('bash', ['-c', `${stamp}\n"${process.execPath}" "${BIN}" "$@"`, 'x', ...args], { encoding: 'utf8', env: { ...s.env, CLAUDE_CODE_SESSION_ID: SID } });
}
const hook = (s, script, input, env = {}) => spawnSync('node', [join(s.root, 'scripts', script)], { input: JSON.stringify(input), encoding: 'utf8', env: { ...s.env, ...env } });

// A preload that logs each file a process opens or lists under the given folders, as "<call> <path>" lines.
function counter(s) {
  const file = join(s.tmp, 'count-bind-reads-spawns.mjs');
  const log = join(s.tmp, 'opened-bind-reads-spawns.log');
  writeFileSync(file, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const under = ${JSON.stringify([s.lib, s.store])};
const seen = [];
for (const name of ['readFileSync', 'openSync', 'readdirSync', 'opendirSync']) {
  const orig = fs[name];
  fs[name] = function (p, ...rest) {
    if (typeof p !== 'number' && under.some((d) => String(p).startsWith(d))) seen.push(name + ' ' + String(p));
    return orig.call(this, p, ...rest);
  };
}
syncBuiltinESMExports();
process.on('exit', () => fs.appendFileSync(${JSON.stringify(log)}, seen.map((l) => l + '\\n').join('')));
`);
  writeFileSync(log, '');
  return { NODE_OPTIONS: `--import=${pathToFileURL(file).href}`, read: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

// One recorded spawn in the store, `records` other call records in the session's calls folder, then SubagentStart.
function bindWith(records) {
  const s = scratch();
  assert.equal(cli(s, ['init']).status, 0);
  assert.equal(cli(s, ['send', JSON.stringify({ type: 'REQUEST_RECEIVED', request: { id: 'ledger' } })]).status, 0);
  const spawnId = 'toolu_spawn116';
  const gate = hook(s, 'gates.js', { session_id: SID, cwd: '/w', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'triage', prompt: 'Harness-Role: triager item:ledger\nTriage it.', subagent_type: 'general-purpose' }, tool_use_id: spawnId }, { HARNESS_ENFORCE: '1' });
  assert.equal(gate.stdout, '', `the spawn is recorded: ${gate.stdout}${gate.stderr}`);
  for (let i = 0; i < records; i++)
    writeFileSync(join(s.calls, `toolu_bash${i}.json`), JSON.stringify({ sessionId: SID, toolUseId: `toolu_bash${i}`, at: new Date(Date.now() - i).toISOString(), kind: 'bash', agentId: null, agentType: null, commandSha256: '0'.repeat(64), keySha256: '0'.repeat(64), enforced: false }));
  const count = counter(s);
  const r = hook(s, 'agent-actor.js', { session_id: SID, cwd: '/w', prompt_id: 'p', agent_id: 'a116', agent_type: 'general-purpose', hook_event_name: 'SubagentStart' }, { NODE_OPTIONS: count.NODE_OPTIONS });
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(readFileSync(join(s.store, 'state.json'), 'utf8'));
  const record = JSON.parse(readFileSync(join(s.lib, 'ledger/sessions', SID, 'agents', 'a116.json'), 'utf8'));
  return { s, spawnId, spawns: state.snapshot.children.ledger.snapshot.context.spawns, record, opened: count.read() };
}

test('bind finds its spawn with a fixed number of file reads, however many calls the session recorded', () => {
  const small = bindWith(10);
  const big = bindWith(2000);
  for (const { s, spawnId, spawns, record, opened } of [small, big]) {
    assert.equal(spawns[0].agent, `${SID}/a116`, 'the store bound the agent to its spawn');
    assert.deepEqual(record.bind, { item: 'ledger', spawn: spawnId, result: 'bound' });
    assert.deepEqual(opened.filter((l) => /^(readdirSync|opendirSync) /.test(l) && l.includes(s.calls)), [], 'the calls folder is never listed');
    const calls = new Set(opened.filter((l) => l.includes(s.calls)).map((l) => l.split(' ').slice(1).join(' ')));
    assert.ok(calls.size <= 3, `bind opens at most 3 call records, not ${calls.size}`);
  }
  assert.equal(new Set(big.opened.map((l) => l.split(' ').slice(1).join(' '))).size, new Set(small.opened.map((l) => l.split(' ').slice(1).join(' '))).size,
    'the same number of files is read with 2,000 call records as with 10');
});

test('SessionStart launches the warm in a detached child and returns at once; the walk reads its files concurrently', () => {
  const s = scratch();
  // Two named pipes in the session's calls folder: a read of one blocks until something writes to it, so a serial
  // walk would sit on the first and never open the second, and a walk the hook waited for would hang the hook.
  mkdirSync(s.calls, { recursive: true });
  const pipes = ['toolu_p1.json', 'toolu_p2.json'].map((f) => join(s.calls, f));
  for (const p of pipes) execFileSync('mkfifo', [p]);
  writeFileSync(join(s.calls, 'toolu_x.json'), '{}');
  const fds = [];
  try {
    const t0 = Date.now();
    const r = spawnSync('node', [join(s.root, 'scripts', 'session-start.js')], { input: JSON.stringify({ session_id: SID, cwd: s.tmp, hook_event_name: 'SessionStart', source: 'startup' }), encoding: 'utf8', env: s.env, timeout: 10000 });
    assert.equal(r.status, 0, `the hook exits by itself while the walk is blocked: ${r.error?.message ?? ''}${r.stderr}`);
    assert.match(r.stdout, /^harness \S+ commit .*, behind: \S+/);
    assert.ok(Date.now() - t0 < 6000, `returned in ${Date.now() - t0} ms`);
    // After the hook returned, both pipes gain a reader with neither written: the walk is still running, and its two
    // reads are in flight at once. Opening a pipe to write without blocking fails until a reader has it open.
    const deadline = Date.now() + 8000;
    while (fds.length < pipes.length && Date.now() < deadline) {
      try { fds.push(openSync(pipes[fds.length], constants.O_WRONLY | constants.O_NONBLOCK)); } catch { spawnSync('sleep', ['0.05']); }
    }
    assert.equal(fds.length, pipes.length, 'both pipes are open for reading at once, after the hook returned');
  } finally {
    for (const fd of fds) { try { writeSync(fd, '{}'); closeSync(fd); } catch {} }
    // Unblock any reader still waiting, so no child outlives the test.
    for (const p of pipes) { try { if (existsSync(p)) closeSync(openSync(p, constants.O_WRONLY | constants.O_NONBLOCK)); } catch {} }
  }
});
