// #36: the plugin's gates (scripts/gates.js), run as the host runs them on a copy of the committed plugin, against a
// scratch store through the real harness CLI. The spawn gate records an item-role spawn in the store or, under
// HARNESS_ENFORCE=1, denies it when the machine refuses it; SubagentStart binds the agent; the merge gate denies a
// merge the item's machine would not take. Each deny names its rule. Without HARNESS_ENFORCE nothing is denied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(repo, 'packages/harness/bin/harness.js');
const SID = '2ce18a8f-fd3a-507a-82d3-2dea2ed3db49';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const HEAD = 'a'.repeat(40);
const VERIFIER_BRIEF = 'Harness-Role: verifier item:a\nVerify PR o/r#7 at its head against issue #1.';
const BUILDER_BRIEF = 'Harness-Role: builder item:a\nBuild issue #1.';

const clean = () => {
  const env = { ...process.env, HARNESS_DISABLED: '' };
  for (const k of ['HARNESS_AGENT', 'HARNESS_CALL', 'HARNESS_ENFORCE', 'HARNESS_DIR', 'CLAUDE_CODE_SESSION_ID']) delete env[k];
  return env;
};
function scratch() {
  const tmp = tempDir('gates-hook-');
  const lib = join(tmp, 'harness');
  mkdirSync(lib);
  writeFileSync(join(lib, 'install.json'), '{"installedAt":"2026-10-27"}');
  const root = join(tmp, 'plugin');
  cpSync(join(repo, 'plugins/harness'), root, { recursive: true });
  const store = join(tmp, 'store');
  const env = { ...clean(), HARNESS_LIBRARY_DIR: lib, HARNESS_BIN: BIN, HARNESS_DIR: store };
  const cli = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...env, CLAUDE_CODE_SESSION_ID: SID, ...extra } });
    for (const k of Object.keys(extra)) if (extra[k] === undefined) delete r[k];
    return r;
  };
  // The item: filed by this session, triaged by another, at tier 0, so it is building.
  assert.equal(cli(['init']).status, 0);
  assert.equal(cli(['send', '{"type":"REQUEST_RECEIVED","request":{"id":"a"}}']).status, 0);
  const t = spawnSync(process.execPath, [BIN, 'send', '{"type":"TRIAGED","tier":0,"criteria":["a works"]}', '--to', 'item:a', '--actor', 'session:triager'], { encoding: 'utf8', env });
  assert.equal(t.status, 0, t.stderr);
  return { tmp, lib, root, store, env, cli };
}
const hook = (s, input, extra = {}, script = 'gates.js') => {
  const r = spawnSync('node', [join(s.root, 'scripts', script)], { input: JSON.stringify(input), encoding: 'utf8', env: { ...s.env, ...extra } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
};
const enforce = { HARNESS_ENFORCE: '1' };
let n = 0;
const spawnInput = (prompt, subagent_type = 'harness:builder') => ({ session_id: SID, cwd: '/w', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'x', prompt, subagent_type, model: 'opus' }, tool_use_id: `toolu_s${++n}` });
const startInput = (agent_id, agent_type) => ({ session_id: SID, cwd: '/w', prompt_id: 'p', agent_id, agent_type, hook_event_name: 'SubagentStart' });
const bashInput = (command) => ({ session_id: SID, cwd: '/w', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: `toolu_b${++n}` });
const mcpInput = (tool_input) => ({ session_id: SID, cwd: '/w', hook_event_name: 'PreToolUse', tool_name: 'mcp__github__merge_pull_request', tool_input, tool_use_id: `toolu_m${++n}` });
const events = (s) => readFileSync(join(s.store, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const denied = (o, rule, why, label) => {
  assert.equal(o?.permissionDecision, 'deny', `${label}: ${JSON.stringify(o)}`);
  assert.ok(o.permissionDecisionReason.startsWith(`harness (${rule}): `), `${label}: ${o.permissionDecisionReason}`);
  if (why) assert.match(o.permissionDecisionReason, why, label);
};
const callRecord = (s, id) => JSON.parse(readFileSync(join(s.lib, 'ledger/sessions', SID, 'calls', `${id}.json`), 'utf8'));
// A subagent's harness call, through the agent hook (it records the call and stamps it) and then bash.
const asAgent = (s, aid, type, args) => {
  const o = hook(s, { ...bashInput(`harness ${args.map((a) => `'${a}'`).join(' ')}`), agent_id: aid, agent_type: type }, {}, 'agent-actor.js');
  const stamp = o.updatedInput.command.split('\n')[0];
  return spawnSync('bash', ['-c', `${stamp}\n"${process.execPath}" "${BIN}" "$@"`, 'x', ...args], { encoding: 'utf8', env: { ...s.env, CLAUDE_CODE_SESSION_ID: SID } });
};

test('hooks.json runs the gates before Agent, Bash and the GitHub merge tool', () => {
  const { hooks } = JSON.parse(readFileSync(join(repo, 'plugins/harness/hooks/hooks.json'), 'utf8'));
  for (const m of ['Agent|Task', 'Bash', 'mcp__github__merge_pull_request'])
    assert.ok(hooks.PreToolUse.find((h) => h.matcher === m).hooks.some((h) => h.args[0] === '${CLAUDE_PLUGIN_ROOT}/scripts/gates.js'), m);
});

test('spawn gate: a builder before the verifier brief is denied naming the guard; after it, the spawn is recorded and SubagentStart binds the agent', () => {
  const s = scratch();
  const before = events(s).length;
  denied(hook(s, spawnInput(BUILDER_BRIEF), enforce), 'machine', /WORKER_SPAWNED in active\.building \(noVerifierBrief\)/, 'builder before the brief');
  assert.equal(events(s).length, before, 'nothing in the store');
  assert.equal(s.cli(['send', JSON.stringify({ type: 'VERIFIER_BRIEF_FIXED', sha256: sha256(VERIFIER_BRIEF) }), '--to', 'item:a']).status, 0);
  const input = spawnInput(BUILDER_BRIEF);
  assert.equal(hook(s, input, enforce), null, 'allowed: no output');
  const spawn = events(s).at(-1);
  assert.deepEqual([spawn.id, spawn.actor, spawn.event.type, spawn.event.role, spawn.event.briefSha256, spawn.event.agentType, spawn.event.model, spawn.event.toolUseId], [`spawn-${input.tool_use_id}`, { kind: 'session', id: SID }, 'WORKER_SPAWNED', 'builder', sha256(BUILDER_BRIEF), 'harness:builder', 'opus', input.tool_use_id]);
  assert.equal(spawn.event.definition.sha256, sha256(readFileSync(join(repo, 'plugins/harness/agents/builder.md'), 'utf8')), 'the standing definition, by content');
  assert.equal(spawn.event.harness.version, JSON.parse(readFileSync(join(repo, 'plugins/harness/.claude-plugin/plugin.json'), 'utf8')).version);
  assert.deepEqual([callRecord(s, input.tool_use_id).decision, callRecord(s, input.tool_use_id).recorded], ['allowed', true]);
  assert.equal(hook(s, startInput('b1', 'harness:builder'), {}, 'agent-actor.js'), null);
  const start = events(s).at(-1);
  assert.deepEqual([start.event.type, start.event.agent], ['WORKER_STARTED', `${SID}/b1`]);
  // The bound builder reports its run from its own Bash call, through the agent hook's record.
  const run = asAgent(s, 'b1', 'harness:builder', ['send', '{"type":"RUN_SUCCEEDED","pr":"https://github.com/o/r/pull/7"}', '--to', 'item:a', '--actor', `agent:${SID}/b1`, '--source', 'cli:run']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(events(s).at(-1).actor.id, `${SID}/b1`);
});

test('spawn gate: role lines, agent types, other items and edited verifier briefs are denied with their rule; no role is allowed and recorded nowhere', () => {
  const s = scratch();
  assert.equal(s.cli(['send', JSON.stringify({ type: 'VERIFIER_BRIEF_FIXED', sha256: sha256(VERIFIER_BRIEF) }), '--to', 'item:a']).status, 0);
  const before = events(s).length;
  denied(hook(s, spawnInput('Build issue #1.'), enforce), 'roleLine', /has none/, 'a harness:builder with no role line');
  denied(hook(s, spawnInput('Build issue #1.', 'harness:verifier'), enforce), 'roleLine', /has none/, 'a harness:verifier with no role line');
  denied(hook(s, spawnInput('harness-role: builder item:a\nBuild.'), enforce), 'roleLine', /is not/, 'a misspelled role line');
  denied(hook(s, spawnInput('Harness-Role: builder\nBuild.'), enforce), 'roleLine', /is not/, 'a role line without its item');
  denied(hook(s, spawnInput(`${BUILDER_BRIEF}\nHarness-Role: verifier item:a`), enforce), 'roleLine', /2 role lines/, 'two role lines');
  denied(hook(s, spawnInput('Harness-Role: buidler item:a\nBuild.'), enforce), 'machine', /spawnOverreaches/, 'a misspelled role');
  denied(hook(s, spawnInput('Harness-Role: builder item:zzz\nBuild.'), enforce), 'roleLine', /no actor at "item:zzz"/, 'an item not in the store');
  denied(hook(s, spawnInput(BUILDER_BRIEF, 'general-purpose'), enforce), 'machine', /agentTypeIsNot/, 'a builder of another agent type');
  denied(hook(s, spawnInput(VERIFIER_BRIEF, 'harness:verifier'), enforce), 'machine', /roleNotHere/, 'a verifier while building');
  assert.equal(events(s).length, before, 'nothing written');
  assert.equal(hook(s, spawnInput('Look something up.', 'general-purpose'), enforce), null, 'no role: allowed');
  assert.equal(hook(s, spawnInput('Look something up.', 'Explore'), enforce), null);
  assert.equal(events(s).length, before, 'and recorded nowhere');

  // Built: the verifier spawn takes only the fixed brief.
  assert.equal(hook(s, spawnInput(BUILDER_BRIEF), enforce), null);
  hook(s, startInput('b1', 'harness:builder'), {}, 'agent-actor.js');
  assert.equal(asAgent(s, 'b1', 'harness:builder', ['send', '{"type":"RUN_SUCCEEDED","pr":"https://github.com/o/r/pull/7"}', '--to', 'item:a', '--actor', `agent:${SID}/b1`, '--source', 'cli:run']).status, 0);
  denied(hook(s, spawnInput(`${VERIFIER_BRIEF}\nAlso read the builder's report.`, 'harness:verifier'), enforce), 'machine', /briefDiffers/, 'an edited verifier brief');
  assert.equal(hook(s, spawnInput(VERIFIER_BRIEF, 'harness:verifier'), enforce), null, 'the fixed brief');
  // A roleless agent cannot send an item event: no spawn binds it.
  hook(s, startInput('x1', 'general-purpose'), {}, 'agent-actor.js');
  const r = asAgent(s, 'x1', 'general-purpose', ['send', '{"type":"CRITERION_CHECKED","criterion":"a works","verdict":"met","evidence":"e"}', '--to', 'item:a']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unspawnedAgent/);
});

test('merge gate: each route is denied without a verdict, without a pinned head, or for a PR bound to no item; the rule is named', () => {
  const s = scratch();
  assert.equal(s.cli(['send', JSON.stringify({ type: 'VERIFIER_BRIEF_FIXED', sha256: sha256(VERIFIER_BRIEF) }), '--to', 'item:a']).status, 0);
  hook(s, spawnInput(BUILDER_BRIEF), enforce);
  hook(s, startInput('b1', 'harness:builder'), {}, 'agent-actor.js');
  assert.equal(asAgent(s, 'b1', 'harness:builder', ['send', '{"type":"RUN_SUCCEEDED","pr":"https://github.com/o/r/pull/7"}', '--to', 'item:a', '--actor', `agent:${SID}/b1`, '--source', 'cli:run']).status, 0);
  const routes = (sha) => [
    mcpInput({ owner: 'o', repo: 'r', pullNumber: 7, ...(sha && { expectedHeadSha: sha }) }),
    bashInput(`gh pr merge 7 --repo o/r --squash${sha ? ` --match-head-commit ${sha}` : ''}`),
    bashInput(`gh pr merge https://github.com/o/r/pull/7${sha ? ` --match-head-commit=${sha}` : ''}`),
    bashInput(`gh api -X PUT repos/o/r/pulls/7/merge -f merge_method=squash${sha ? ` -f sha=${sha}` : ''}`)
  ];
  for (const input of routes(null)) denied(hook(s, input, enforce), 'pinnedHead', /pins no full head sha/, JSON.stringify(input.tool_input));
  for (const input of routes(HEAD)) denied(hook(s, input, enforce), 'machine', /MERGED in active\.verifying/, JSON.stringify(input.tool_input));
  denied(hook(s, mcpInput({ owner: 'o', repo: 'r', pullNumber: 8, expectedHeadSha: HEAD }), enforce), 'mergeBound', /bound to no item/, 'another PR');
  denied(hook(s, bashInput(`gh api repos/o/r/pulls/8/merge -X PUT -F sha=${HEAD}`), enforce), 'mergeBound', /bound to no item/, 'another PR by gh api');
  const call = callRecord(s, `toolu_m${n - 1}`);
  assert.deepEqual([call.kind, call.pr, call.decision, call.rule], ['merge', 'o/r#8', 'denied', 'mergeBound']);
  // Not merges: untouched.
  for (const c of ['gh pr view 7', 'git merge main', 'echo pr merge']) assert.equal(hook(s, bashInput(c), enforce), null, c);
});

test('without HARNESS_ENFORCE nothing is denied: the gates only record', () => {
  const s = scratch();
  const spawn = spawnInput(BUILDER_BRIEF);
  assert.equal(hook(s, spawn), null);
  assert.deepEqual([callRecord(s, spawn.tool_use_id).decision, callRecord(s, spawn.tool_use_id).rule], ['would deny', 'machine']);
  for (const input of [spawnInput('Build.'), mcpInput({ owner: 'o', repo: 'r', pullNumber: 7 }), bashInput('gh pr merge 7 --repo o/r')]) assert.equal(hook(s, input), null);
  assert.equal(hook(s, spawnInput(BUILDER_BRIEF), { HARNESS_BIN: '/nowhere/harness.js' }), null, 'an unreachable CLI');
});

test('under HARNESS_ENFORCE=1 a gate that cannot reach the store denies; without the marker the gates do nothing', () => {
  const s = scratch();
  for (const extra of [{ HARNESS_BIN: '/nowhere/harness.js' }, { HARNESS_DIR: join(s.tmp, 'empty') }]) {
    denied(hook(s, spawnInput(BUILDER_BRIEF), { ...enforce, ...extra }), 'storeReachable', null, `spawn ${JSON.stringify(extra)}`);
    const merge = hook(s, mcpInput({ owner: 'o', repo: 'r', pullNumber: 7, expectedHeadSha: HEAD }), { ...enforce, ...extra });
    assert.equal(merge.permissionDecision, 'deny', JSON.stringify(extra));
  }
  const bare = { ...s, env: { ...s.env, HARNESS_LIBRARY_DIR: join(s.tmp, 'no-marker') } };
  for (const input of [spawnInput(BUILDER_BRIEF), mcpInput({ owner: 'o', repo: 'r', pullNumber: 7 })]) assert.equal(hook(bare, input, enforce), null);
  for (const bad of ['not json', '{}']) assert.equal(spawnSync('node', [join(s.root, 'scripts/gates.js')], { input: bad, encoding: 'utf8', env: { ...s.env, ...enforce } }).stdout, '');
  assert.ok(readdirSync(s.lib).includes('install.json'));
});
