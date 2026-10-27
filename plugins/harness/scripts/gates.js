#!/usr/bin/env node
// PreToolUse hook: the spawn gate (Agent) and the merge gate (mcp__github__merge_pull_request, and Bash running
// `gh pr merge` or `gh api` on a pull's merge endpoint). The rules are the spec's: the workItem machine judges, asked
// through the harness CLI, and the host invariants the spec names (harness meta.invariants) cover the rest. Every
// deny names its rule. Under HARNESS_ENFORCE=1 a gate denies; without it, it only records and never denies.
// - Spawn: a brief names its item role in one line `Harness-Role: <role> item:<id>`. A spawn naming one is sent to
//   the store as WORKER_SPAWNED (role, sha256 of the prompt, agent type, model, agent definition, harness version)
//   by this session; the machine takes it or refuses it (no verifier brief yet, an edited verifier brief, ...), and a
//   refused spawn is denied. A spawn with no role line is allowed and recorded nowhere: its agent can send no item
//   event. A malformed or repeated role line, or a harness:builder or harness:verifier spawn without one, is denied
//   (roleLine). SubagentStart (agent-actor.js) binds the started agent to the spawn.
// - Merge: the PR must be bound to an item (mergeBound), the call must pin the head sha (pinnedHead), the item's
//   machine must take MERGED of that head (its verifier's PASS), and the PR must carry the PASS as a review on that
//   sha (reviewOnHead): `harness merge-gate` answers.
// Each gated call is recorded at $HARNESS_LIBRARY_DIR/ledger/sessions/<session>/calls/<tool_use_id>.json with what
// the gate decided. A gate that cannot reach the store or the CLI denies under HARNESS_ENFORCE=1 (storeReachable).
// It does nothing unless the project has installed the harness (host.js); on its own failure it exits 0, and denies
// only under HARNESS_ENFORCE=1 when the call was one it gates.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { gate, deny, enforced, safeId, writeCall, runHarness, pluginRoot, version } from './host.js';

const ROLE_LINE = /^[ \t>*]*harness-role\s*:/gim;
const ROLE = /^Harness-Role: (\S+) item:([A-Za-z0-9_.-]+)$/;
const sha256 = (s) => createHash('sha256').update(String(s ?? '')).digest('hex');
const answer = (out) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...out } }));

let gated = false; // set once the call is one a gate judges, so a failure after it denies under enforcement
try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const ask = input.hook_event_name === 'PreToolUse' && (['Agent', 'Task'].includes(input.tool_name) ? spawnCall(input) : mergeCall(input));
  if (ask && (await gate(1000)) === 'installed') {
    gated = true;
    const call = safeId(input.tool_use_id) || `${ask.kind}-${sha256(JSON.stringify(input.tool_input)).slice(0, 32)}`;
    const mine = { kind: ask.kind, agentId: safeId(input.agent_id) || null, agentType: input.agent_type ?? null };
    writeCall(input.session_id, call, { ...mine, pending: true }); // the CLI believes this call's actor only from its record
    const { rule, why, record } = ask.judge({ session: input.session_id, call, cwd: input.cwd, agent: input.agent_id ? `${safeId(input.agent_id)}:${String(input.agent_type ?? '').replace(/[^A-Za-z0-9_.:-]/g, '')}` : null });
    writeCall(input.session_id, call, { ...mine, ...record, decision: rule ? (enforced() ? 'denied' : 'would deny') : 'allowed', rule: rule ?? null, why });
    if (rule && enforced()) answer(denyFor(rule, why));
  }
} catch (e) {
  if (gated && enforced()) answer(deny('storeReachable', `the gate could not judge this call: ${e.message}`));
}
process.exit(0);

// Every deny names its rule (a guard or a host invariant), through host.js deny().
function denyFor(rule, why) {
  if (rule === 'roleLine') return deny('roleLine', why);
  if (rule === 'mergeBound') return deny('mergeBound', why);
  if (rule === 'pinnedHead') return deny('pinnedHead', why);
  if (rule === 'reviewOnHead') return deny('reviewOnHead', why);
  if (rule === 'machine') return deny('machine', why);
  return deny('storeReachable', why);
}

// The CLI's answer as a rule: the machine's refusal, the CLI's own rule, or an unreachable store.
function fromCli(r, ok) {
  if (ok) return null;
  if (r.out?.rule) return r.out.rule;
  if (r.out?.refused) return 'machine';
  return /no actor at/.test(r.err) ? 'roleLine' : 'storeReachable';
}

function spawnCall(input) {
  const prompt = String(input.tool_input?.prompt ?? '');
  const agentType = String(input.tool_input?.subagent_type || 'general-purpose');
  const lines = prompt.match(ROLE_LINE) ? prompt.split('\n').filter((l) => /^[ \t>*]*harness-role\s*:/i.test(l)) : [];
  const standing = ['harness:builder', 'harness:verifier'].includes(agentType);
  if (!lines.length && !standing) return null; // no item role: allowed, recorded nowhere
  return {
    kind: 'spawn',
    judge(how) {
      const m = lines.length === 1 && ROLE.exec(lines[0].trim());
      const base = { agentType, briefSha256: sha256(prompt), model: input.tool_input?.model ?? null };
      if (!m) return { rule: 'roleLine', record: { ...base, recorded: false }, why: !lines.length ? `a ${agentType} spawn names its item role in one line "Harness-Role: <role> item:<id>"; this brief has none` : lines.length > 1 ? `the brief has ${lines.length} role lines; it names one` : `the role line "${lines[0].trim()}" is not "Harness-Role: <role> item:<id>"` };
      const [, role, item] = m;
      const definition = agentType.startsWith('harness:') ? definitionOf(agentType) : null;
      const { version: v, commit } = version();
      const event = { type: 'WORKER_SPAWNED', role, ...base, toolUseId: how.call, definition, harness: { version: v, commit } };
      const r = runHarness(['send', JSON.stringify(event), '--to', `item:${item}`, '--id', `spawn-${how.call}`], how);
      const ok = r.status === 0 && r.out && !r.out.refused;
      return { rule: fromCli(r, ok), record: { ...base, role, item, recorded: ok }, why: ok ? `recorded the ${role} spawn on item ${item}` : r.out?.why ?? r.err };
    }
  };
}

// The standing agent definition the spawn names, by its content's sha256 and the plugin version that ships it.
function definitionOf(agentType) {
  const file = join(pluginRoot(), 'agents', `${agentType.split(':')[1]}.md`);
  return existsSync(file) ? { agentType, file: `agents/${agentType.split(':')[1]}.md`, sha256: sha256(readFileSync(file, 'utf8')), version: version().version } : { agentType, file: null, sha256: null };
}

// The PR and pinned head of a merge call: the MCP tool, `gh pr merge`, or `gh api` on .../pulls/<n>/merge.
function mergeCall(input) {
  const t = input.tool_input ?? {};
  let pr = null, sha = null;
  if (input.tool_name === 'mcp__github__merge_pull_request') {
    pr = t.owner && t.repo && t.pullNumber != null ? `${t.owner}/${t.repo}#${t.pullNumber}` : '';
    sha = t.expectedHeadSha ?? null;
  } else if (input.tool_name === 'Bash' && typeof t.command === 'string') {
    const c = t.command;
    const api = /repos\/([\w.-]+)\/([\w.-]+)\/pulls\/(\d+)\/merge\b/.exec(c);
    if (api) {
      pr = `${api[1]}/${api[2]}#${api[3]}`;
      sha = /["']?\bsha["']?\s*[=:]\s*["']?([0-9a-fA-F]+)/.exec(c)?.[1] ?? null;
    } else if (/\bgh\b/.test(c) && /\bpr\s+merge\b/.test(c)) {
      const after = c.slice(c.search(/\bpr\s+merge\b/)).split(/[\n;&|]/)[0];
      const words = after.split(/\s+/).slice(2).map((w) => w.replace(/^['"]|['"]$/g, ''));
      const flag = (names) => { for (let i = 0; i < words.length; i++) { for (const n of names) { if (words[i] === n) return words[i + 1] ?? ''; if (words[i].startsWith(`${n}=`)) return words[i].slice(n.length + 1); } } return null; };
      sha = flag(['--match-head-commit']);
      const repo = flag(['--repo', '-R']);
      const valued = new Set(['--match-head-commit', '--repo', '-R', '--subject', '-t', '--body', '-b', '--body-file', '-F', '--author-email', '-A']);
      const sel = words.find((w, i) => w && !w.startsWith('-') && !valued.has(words[i - 1]));
      const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(sel ?? '');
      if (url) pr = `${url[1]}#${url[2]}`;
      else if (/^#?\d+$/.test(sel ?? '')) pr = `${repo ?? originOf(input.cwd) ?? ''}#${sel.replace('#', '')}`;
      else pr = '';
    } else return null;
  } else return null;
  return {
    kind: 'merge',
    judge(how) {
      const r = runHarness(['merge-gate', '--pr', pr || 'none', '--sha', sha || 'none'], how);
      const ok = r.status === 0 && r.out?.allow === true;
      return { rule: fromCli(r, ok), record: { pr, sha }, why: r.out?.why ?? r.err };
    }
  };
}

// owner/repo of the checkout's origin, for a `gh pr merge <n>` without --repo.
function originOf(cwd) {
  try {
    const url = execFileSync('git', ['-C', cwd || '.', 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)?.[1] ?? null;
  } catch { return null; }
}
