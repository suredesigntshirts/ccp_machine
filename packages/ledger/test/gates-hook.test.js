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
  const s = { tmp, lib, root, store, env };
  // This session's own harness calls, through the agent hook like any other: once a gate has run under
  // HARNESS_ENFORCE=1 the store takes writes only from recorded calls.
  s.cli = (args) => asAgent(s, null, null, args);
  // The item: filed by this session, triaged by another, at tier 0, so it is building.
  assert.equal(s.cli(['init']).status, 0);
  assert.equal(s.cli(['send', '{"type":"REQUEST_RECEIVED","request":{"id":"a"}}']).status, 0);
  const t = spawnSync(process.execPath, [BIN, 'send', '{"type":"TRIAGED","tier":0,"criteria":["a works"]}', '--to', 'item:a', '--actor', 'session:triager'], { encoding: 'utf8', env });
  assert.equal(t.status, 0, t.stderr);
  return s;
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
  const o = hook(s, { ...bashInput(`harness ${args.map((a) => `'${a}'`).join(' ')}`), ...(aid && { agent_id: aid, agent_type: type }) }, {}, 'agent-actor.js');
  const stamp = o.updatedInput.command.split('\n')[0];
  return spawnSync('bash', ['-c', `${stamp}\n"${process.execPath}" "${BIN}" "$@"`, 'x', ...args], { encoding: 'utf8', env: { ...s.env, CLAUDE_CODE_SESSION_ID: SID } });
};
// A subagent's Bash command as written, through the agent hook under HARNESS_ENFORCE=1 and then bash; $N is node and
// $B the harness CLI, so the command need not name harness.
const agentBash = (s, aid, type, command) => {
  const o = hook(s, { ...bashInput(command), agent_id: aid, agent_type: type }, enforce, 'agent-actor.js');
  if (o?.permissionDecision) return { status: 1, stdout: '', stderr: o.permissionDecisionReason };
  return spawnSync('bash', ['-c', o?.updatedInput?.command ?? command], { encoding: 'utf8', env: { ...s.env, CLAUDE_CODE_SESSION_ID: SID, N: process.execPath, B: BIN } });
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
  assert.match(r.stdout + r.stderr, /agentEvents/);
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
    bashInput(`gh pr merge 7 --repo=o/r${sha ? ` --match-head-commit=${sha}` : ''} --delete-branch`),
    bashInput(`gh api -X PUT repos/o/r/pulls/7/merge -f merge_method=squash${sha ? ` -f sha=${sha}` : ''}`)
  ];
  for (const input of routes(null)) denied(hook(s, input, enforce), 'pinnedHead', /pins no full head sha/, JSON.stringify(input.tool_input));
  for (const input of routes(HEAD)) denied(hook(s, input, enforce), 'machine', /MERGED in active\.verifying/, JSON.stringify(input.tool_input));
  denied(hook(s, mcpInput({ owner: 'o', repo: 'r', pullNumber: 8, expectedHeadSha: HEAD }), enforce), 'mergeBound', /bound to no item/, 'another PR');
  denied(hook(s, bashInput(`gh api -X PUT repos/o/r/pulls/8/merge -f sha=${HEAD}`), enforce), 'mergeBound', /bound to no item/, 'another PR by gh api');
  const call = callRecord(s, `toolu_m${n - 1}`);
  assert.deepEqual([call.kind, call.pr, call.decision, call.rule], ['merge', 'o/r#8', 'denied', 'mergeBound']);
  // Not merges: untouched.
  for (const c of ['gh pr view 7', 'git merge main', 'echo pr merge']) assert.equal(hook(s, bashInput(c), enforce), null, c);
});

test('merge gate (third review): a command naming a merge and gh, curl, wget, api or graphql is denied unless it is exactly a gated form', () => {
  const s = scratch();
  assert.equal(s.cli(['send', JSON.stringify({ type: 'VERIFIER_BRIEF_FIXED', sha256: sha256(VERIFIER_BRIEF) }), '--to', 'item:a']).status, 0);
  hook(s, spawnInput(BUILDER_BRIEF), enforce);
  hook(s, startInput('b1', 'harness:builder'), {}, 'agent-actor.js');
  assert.equal(asAgent(s, 'b1', 'harness:builder', ['send', '{"type":"RUN_SUCCEEDED","pr":"https://github.com/o/r/pull/7"}', '--to', 'item:a', '--actor', `agent:${SID}/b1`, '--source', 'cli:run']).status, 0);
  const pin = `--match-head-commit ${HEAD}`;
  const merge = `gh pr merge 7 --repo o/r ${pin}`;
  const notGated = [
    // The third review: compound shell, prefixes and reordered words.
    `{ ${merge}; }`, `if true; then ${merge}; fi`, `for i in 1; do ${merge}; done`, `while true; do ${merge}; break; done`, `! ${merge}`,
    `f(){ ${merge}; }; f`, `echo "${merge}" | bash`, `bash -c -- '${merge}'`, `setsid ${merge}`, `stdbuf -oL ${merge}`, `flock /tmp/l ${merge}`,
    `ionice -c3 ${merge}`, `find . -maxdepth 0 -exec ${merge} \\;`, `gh pr --repo o/r merge 7 ${pin}`, `${merge} && echo done`, `${merge}\necho done`,
    `bash -c "${merge}"`, `echo $(${merge})`, `env GH_DEBUG=1 command ${merge}`, 'echo 7 | xargs gh pr merge --repo o/r', `g""h pr merge 7 --repo o/r ${pin}`,
    `gh pr merge 7 --repo o/r ${pin} --auto`, `gh pr merge 7 --repo o/r ${pin} --admin`, `gh pr merge https://github.com/o/r/pull/7 ${pin}`, `gh pr merge 7 ${pin}`,
    // The second review: other spellings of the merge path.
    ...['repos/o/r/pulls/7/merge?x=1', "'repos/o/r/pulls/7/merge#x'", 'repos/o/r/pulls/7/mer%67e', 'repos/o/r//pulls/7/merge', 'repos/o/r/pulls/../pulls/7/merge',
      '/repos/o/r/pulls/7/merge', 'REPOS/o/r/PULLS/7/MERGE', 'https://api.github.com/repos/o/r/pulls/7/merge', 'repositories/123/pulls/7/merge', 'repos/{owner}/{repo}/pulls/7/merge']
      .map((p) => `gh api -X PUT ${p} -f sha=${HEAD}`),
    `gh api --method PUT repos/o/r/pulls/7/merge -f sha=${HEAD}`, `gh api -X PUT repos/o/r/pulls/7/merge -f sha=${HEAD} --input body.json`,
    `curl -X PUT https://api.github.com/repos/o/r/pulls/7/merge -d '{"sha":"${HEAD}"}'`, `wget --method=PUT https://api.github.com/repos/o/r/pulls/7/mer%67e`,
    "gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'", 'gh api repos/o/r/pulls/7/merge'
  ];
  for (const c of notGated) {
    const o = hook(s, bashInput(c), enforce);
    denied(o, 'readableGitHubWrite', /gh pr merge <number> --repo <owner>\/<repo> --match-head-commit <sha>/, c);
    assert.match(o.permissionDecisionReason, /gh api -X PUT repos\/<owner>\/<repo>\/pulls\/<number>\/merge -f sha=<sha>/, c);
  }
  // Exactly a gated form: judged, and the machine refuses MERGED without the verifier's PASS.
  for (const c of [merge, `gh pr merge 7 --squash --repo o/r ${pin} --subject 'Merge it' --delete-branch`, `gh api -X PUT repos/o/r/pulls/7/merge -f sha=${HEAD} -f merge_method=squash`])
    denied(hook(s, bashInput(c), enforce), 'machine', /MERGED in active\.verifying/, c);
  denied(hook(s, bashInput('gh pr merge 7 --repo o/r --squash'), enforce), 'pinnedHead', null, 'a gated form without its pin');
  // Commands that name no merge with a GitHub tool are left to the rest of the gate.
  for (const c of ['git merge main', 'echo pr merge', 'gh pr view 7', 'gh api -X POST repos/o/r/issues/7/comments -f body=hi', 'gh --version'])
    assert.equal(hook(s, bashInput(c), enforce), null, c);
});

test('#36 review: a no-role agent cannot forge its spawn and start as the lead and then report its run, by any unseen or borrowed call', () => {
  const s = scratch();
  assert.equal(s.cli(['send', JSON.stringify({ type: 'VERIFIER_BRIEF_FIXED', sha256: sha256(VERIFIER_BRIEF) }), '--to', 'item:a']).status, 0);
  // The lead spawns a no-role general-purpose agent under enforcement; the gate's call marks the store enforced.
  assert.equal(hook(s, spawnInput('Look something up.', 'general-purpose'), enforce), null);
  assert.equal(hook(s, spawnInput(BUILDER_BRIEF), enforce), null, 'and a builder, whose start record names the lead');
  hook(s, startInput('b1', 'harness:builder'), enforce, 'agent-actor.js');
  hook(s, startInput('x1', 'general-purpose'), enforce, 'agent-actor.js');
  assert.ok(readFileSync(join(s.store, 'enforced.json'), 'utf8'));
  const before = events(s).length;
  const spawned = `'${JSON.stringify({ type: 'WORKER_SPAWNED', role: 'builder', briefSha256: sha256(BUILDER_BRIEF), agentType: 'general-purpose' })}'`;
  const started = `'${JSON.stringify({ type: 'WORKER_STARTED', agent: `${SID}/x1`, agentType: 'general-purpose' })}'`;
  for (const ev of [spawned, started])
    for (const command of [
      `HARNESS_ENFORCE=0 env -u "HARNESS_""CALL" -u "HARNESS_""AGENT" "$N" "$B" send ${ev} --to item:a`,
      `env -u "HARNESS_""AGENT" "HARNESS_""CALL=start-b1" "$N" "$B" send ${ev} --to item:a`,
      `env -u "HARNESS_""AGENT" -u CLAUDE_CODE_SESSION_ID HARNESS_ENFORCE= "$N" "$B" send ${ev} --to item:a --actor session:${SID} --source cli:x`,
      `env -u "HARNESS_""AGENT" "$N" "$B" send ${ev} --to item:a`
    ]) {
      const r = agentBash(s, 'x1', 'general-purpose', command);
      assert.equal(r.status, 1, `${command}: ${r.stdout}${r.stderr}`);
    }
  const run = agentBash(s, 'x1', 'general-purpose', `"$N" "$B" send '{"type":"RUN_SUCCEEDED","pr":"https://github.com/o/r/pull/7"}' --to item:a`);
  assert.equal(run.status, 1);
  assert.match(run.stdout + run.stderr, /agentEvents/);
  assert.equal(events(s).length, before, 'the store took none of it');
  assert.equal(JSON.parse(s.cli(['status']).stdout).items.find((i) => i.id === 'a').state, 'active.building');
});

test('merge gate: a GitHub write it cannot read is denied (readableGitHubWrite); a literal merge in any wrapper is judged as a merge; literal writes and reads pass', () => {
  const s = scratch();
  for (const c of [
    `N=7; gh api -X PUT repos/o/r/pulls/$N/merge -f sha=${HEAD}`,
    `S=merge; gh pr $S 7 --repo o/r --match-head-commit ${HEAD}`,
    `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "PR_1", expectedHeadOid: "${HEAD}"}) { clientMutationId } }'`,
    'Q=$(cat q.graphql); gh api graphql -f query="$Q"',
    `G=gh; $G pr merge 7 --repo o/r --match-head-commit ${HEAD}`,
    'gh m 7',
    `M=PUT; gh api -X $M repos/o/r/pulls/7/merge -f sha=${HEAD}`,
    `curl -X PUT -H "Authorization: token x" https://api.github.com/repos/o/r/pulls/7/merge -d '{"sha":"${HEAD}"}'`,
    `U=https://api.github.com/repos/o/r/pulls/7/merge; curl -X PUT "$U"`
  ]) denied(hook(s, bashInput(c), enforce), 'readableGitHubWrite', null, c);
  for (const c of [
    'bash -c "gh pr merge 7 --repo o/r"',
    'echo $(gh pr merge 7 --repo o/r)',
    'cd /w && env GH_DEBUG=1 command gh pr merge 7 --repo o/r',
    'echo 7 | xargs gh pr merge --repo o/r'
  ]) denied(hook(s, bashInput(c), enforce), 'readableGitHubWrite', /gh pr merge <number>/, c); // not a gated form
  for (const c of [
    'gh pr view $N', 'gh api "repos/o/r/pulls/$N"','gh api graphql -f query=\'query { viewer { login } }\'',
    'gh pr create --title x --body y', 'gh api -X POST repos/o/r/issues/7/comments -f body=hi', 'curl -s https://api.github.com/repos/o/r',
    'git merge main', 'echo pr merge', 'gh --version'
  ]) assert.equal(hook(s, bashInput(c), enforce), null, c);
});

test('#64: the word merge in arguments, strings, jq filters or heredoc text is no merge; a merge, or one hidden where the gate cannot read, is still denied', () => {
  const s = scratch();
  const pin = `--match-head-commit ${HEAD}`;
  // The three calls denied on 28 Oct, and the same word in other data positions: none of them merges.
  for (const c of [
    "gh api repos/suredesigntshirts/ccp_machine/pulls/60 --jq '{merged,merged_at}'",
    "cat > packages/ledger/test/fixture.js <<'EOF'\n// Once PR 60 is merged, gh api reports merged: true and merged_at.\n// A fixture: nothing here runs.\nexport const pr = { merged: true };\nEOF",
    'harness answer --reason "Approved: the plan holds once #62 is merged; gh shows it green"',
    'HARNESS_DIR=/s node /h/packages/harness/bin/harness.js answer --reason "ok to merge once #62 lands; gh api shows it"',
    "gh api repos/o/r/pulls/7 --jq '.merged'", 'gh pr view 7 --json mergeable,mergedAt', 'gh pr comment 7 --body "ready to merge once CI is green"',
    'echo "gh pr merge needs the verifier\'s PASS"', "printf '%s\\n' 'merge after review, gh says' 2>&1 | jq -R .",
    "cat <<EOF 2>/dev/null\nWe merge with gh pr merge after the PASS.\nEOF", 'gh issue create --title "gate reads merge as a word" --body "gh api ... merge"',
    'curl -s https://api.github.com/repos/o/r/pulls/7 | jq .merged',
    // Round 2 (review 5683080803): a bare argument that is just the word, and an endpoint named outside gh api's path.
    'gh pr comment 7 --body merge', 'gh pr list --search merge', 'gh pr view 7 --json merge', 'gh issue comment 7 --body "endpoint is /merge"',
    // A word the shell expands only after a literal start, in quotes, stays one word that cannot be a flag.
    `gh api repos/o/r/commits/"$SHA"/check-runs`, 'gh pr view 7 --json files --jq ".files[] | {path}"', 'gh api "repos/o/r/pulls/$N" --jq .merged'
  ]) {
    const o = hook(s, bashInput(c), enforce);
    assert.equal(o, null, `${c}: ${JSON.stringify(o)}`);
  }
  // Every merge form the gate takes today is still gated: exactly a gated form is judged by harness merge-gate (here
  // the PR is bound to no item), any other merge denied (the third review's list above).
  for (const c of [`gh pr merge 7 --repo o/r ${pin}`, `gh api -X PUT repos/o/r/pulls/7/merge -f sha=${HEAD}`])
    denied(hook(s, bashInput(c), enforce), 'mergeBound', null, c);
  denied(hook(s, mcpInput({ owner: 'o', repo: 'r', pullNumber: 7, expectedHeadSha: HEAD }), enforce), 'mergeBound', null, 'the MCP merge tool');
  // A merge hidden behind eval, sh -c, a variable, a heredoc or a script file is denied: the gate denies what it cannot read.
  for (const c of [
    `eval "gh pr merge 7 --repo o/r ${pin}"`, `sh -c 'gh pr merge 7 --repo o/r ${pin}'`, `M=merge; gh pr $M 7 --repo o/r ${pin}`,
    `echo 'gh pr merge 7 --repo o/r ${pin}' > m.sh; bash m.sh`, `echo 'gh pr merge 7 --repo o/r ${pin}' >> m.sh`, `printf 'gh pr merge 7' | tee m.sh`,
    `cat > m.sh <<'EOF'\ngh pr merge 7 --repo o/r ${pin}\nEOF`,`cat > m.sh <<'EOF'\ngh pr merge 7 --repo o/r ${pin}\nEOF\nchmod +x m.sh && ./m.sh`,
    `bash <<'EOF'\ngh pr merge 7 --repo o/r ${pin}\nEOF`, `cat <<EOF\n$(gh pr merge 7 --repo o/r ${pin})\nEOF`, `cat <<'EOF'; gh pr merge 7 --repo o/r ${pin}\nbody\nEOF`,
    `node -e "require('child_process').execSync('gh pr merge 7 --repo o/r ${pin}')"`, `echo "gh api -X PUT repos/o/r/pulls/7/merge" | sh`,
    `gh api -X POST repos/o/r/merges -f base=main -f head=feat`, "gh alias set m 'pr merge'", `gh pr -R o/r merge 7 ${pin}`, `gh pr view 7 && gh pr merge 7 --repo o/r ${pin}`,
    "node -e \"fetch('https://api.github.com/graphql', {method: 'POST', body: 'mutation { enablePullRequestAutoMerge }'})\"",
    // Round 2 (review 5683080803): a word bash rewrites before gh sees it is unreadable, like a variable. Brace
    // expansion, tilde, globs (* ? [ and extglob), word splitting of an unquoted expansion, and a quoted expansion
    // that may start with a dash (a flag), wherever they decide what gh, curl or wget does.
    `gh pr {merge,} 7 --repo o/r ${pin}`, `gh pr m{e,}rge 7 --repo o/r ${pin}`, `gh pr {m,}erge 7 --repo o/r ${pin}`,
    `gh api -X PUT repos/o/r/pulls/7/{merge,} -f sha=${HEAD}`, `gh api -X PUT repos/o/r/pulls/7/m{e,}rge -f sha=${HEAD}`,
    `gh pr mer? 7 --repo o/r ${pin}`, `gh pr mer* 7 --repo o/r ${pin}`, `gh pr [m]erge 7 --repo o/r ${pin}`, `gh pr @(merge) 7 --repo o/r ${pin}`,
    `gh pr ~merge 7 --repo o/r ${pin}`, `gh pr -R{,} o/r merge 7 ${pin}`, `gh api repos/o/r/pulls/7/m* -X PUT -f sha=${HEAD}`,
    `gh api {-X,PUT} repos/o/r/pulls/7/m{e,}rge`, 'gh api repos/o/r/pulls/$N', 'gh api "$A" "$B"', `gh api "$P" -f sha=${HEAD}`,
    'curl "$A" "$B"', `gh api "repos/o/r/pulls/7/m$@"`, 'gh api "x${a[@]}"','curl {-XPUT,} https://api.github.com/repos/o/r/pulls/7/m{e,}rge', 'wget $W',
    // Round 3 (review 5683445725): a gh command that runs an argument as a command (codespace ssh), or may run one
    // later or through git (config, repo clone), is not data: its text falls to the word rule.
    'gh codespace ssh -c x -- gh pr merge 7', "gh codespace ssh -c x -- 'gh pr merge 7 --repo o/r'", 'gh codespace ssh -c x "gh pr merge 7"',
    "gh codespace ssh -c x -- sh -c 'gh pr merge 7'", "gh config set editor 'gh pr merge 7 --repo o/r #'",
    "gh repo clone o/r -- -c core.sshCommand='gh pr merge 7'", 'gh cs ssh -- gh pr merge 7'
  ]) denied(hook(s, bashInput(c), enforce), 'readableGitHubWrite', /gh pr merge <number>/, c);
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
