#!/usr/bin/env node
// PreToolUse hook: the spawn gate (Agent) and the merge gate (mcp__github__merge_pull_request). The rules are the
// spec's: the workItem machine judges, asked through the harness CLI, and the host invariants the spec names (harness
// meta.invariants) cover the rest. Every deny names its rule. Under HARNESS_ENFORCE=1 a gate denies; without it, it
// only records and never denies.
// - Spawn: a brief names its item role in one line `Harness-Role: <role> item:<id>`. A spawn naming one is sent to
//   the store as WORKER_SPAWNED (role, sha256 of the prompt, agent type, model, agent definition, harness version)
//   by this session; the machine takes it or refuses it (no verifier brief yet, an edited verifier brief, ...), and a
//   refused spawn is denied. A spawn with no role line is allowed and recorded nowhere: its agent can send no item
//   event. A malformed or repeated role line, or a harness:builder or harness:verifier spawn without one, is denied
//   (roleLine). SubagentStart (agent-actor.js) binds the started agent to the spawn; its input does not name the Agent
//   call, so a second spawn of an agent type while one waits for its agent is refused and denied (oneUnboundSpawn).
// - Merge: the PR must be bound to an item (mergeBound), the call must pin the head sha (pinnedHead), the item's
//   machine must take MERGED of that head (its verifier's PASS), and the PR must carry the PASS as a review on that
//   sha (reviewOnHead): `harness merge-gate` answers. No Bash command is read: a landing by another route is listed
//   afterwards by `harness doctor` (reviewOnHead).
// Each gated call is recorded at $HARNESS_LIBRARY_DIR/ledger/sessions/<session>/calls/<tool_use_id>.json with what
// the gate decided. A gate that cannot reach the store or the CLI denies under HARNESS_ENFORCE=1 (storeReachable).
// It does nothing unless the project has installed the harness (host.js); on its own failure it exits 0, and denies
// only under HARNESS_ENFORCE=1 when the call was one it gates.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
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
    const id = safeId(input.tool_use_id) || `${ask.kind}-${sha256(JSON.stringify(input.tool_input)).slice(0, 32)}`;
    const mine = { kind: ask.kind, agentId: safeId(input.agent_id) || null, agentType: input.agent_type ?? null };
    const call = writeCall(input.session_id, id, { ...mine, pending: true }); // the CLI believes this call's actor only from its record and key
    const { rule, why, record } = ask.judge({ session: input.session_id, id, call, cwd: input.cwd, agent: input.agent_id ? `${safeId(input.agent_id)}:${String(input.agent_type ?? '').replace(/[^A-Za-z0-9_.:-]/g, '')}` : null });
    writeCall(input.session_id, id, { ...mine, ...record, decision: rule ? (enforced() ? 'denied' : 'would deny') : 'allowed', rule: rule ?? null, why });
    if (rule && enforced()) answer(denyFor(rule, why));
  }
} catch (e) {
  if (gated && enforced()) answer(deny('storeReachable', `the gate could not judge this call: ${e.message}`));
}
process.exit(0);

// Every deny names its rule (a guard or a host invariant), through host.js deny().
function denyFor(rule, why) {
  if (rule === 'roleLine') return deny('roleLine', why);
  if (rule === 'oneUnboundSpawn') return deny('oneUnboundSpawn', why);
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
      const event = { type: 'WORKER_SPAWNED', role, ...base, toolUseId: how.id, definition, harness: { version: v, commit } };
      const r = runHarness(['send', JSON.stringify(event), '--to', `item:${item}`, '--id', `spawn-${how.id}`], how);
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

// The GitHub MCP merge tool's call, judged by `harness merge-gate`; null for any other tool.
function mergeCall(input) {
  if (input.tool_name !== 'mcp__github__merge_pull_request') return null;
  const t = input.tool_input ?? {};
  const pr = t.owner && t.repo && t.pullNumber != null ? `${t.owner}/${t.repo}#${t.pullNumber}` : '';
  const sha = t.expectedHeadSha ?? null;
  return {
    kind: 'merge',
    judge(how) {
      const r = runHarness(['merge-gate', '--pr', pr || 'none', '--sha', sha || 'none'], how);
      const ok = r.status === 0 && r.out?.allow === true;
      return { rule: fromCli(r, ok), record: { pr, sha }, why: r.out?.why ?? r.err };
    }
  };
}
