#!/usr/bin/env node
// PreToolUse (Bash) and SubagentStart hook: tells a session's subagents apart in the harness store. A subagent
// shares its parent's CLAUDE_CODE_SESSION_ID; only hook input carries its agent_id and agent_type.
// - PreToolUse: a command that names harness, from a subagent or the parent, is recorded first: { sessionId, agentId
//   (null for the parent), agentType, toolUseId, commandSha256, at } at
//   $HARNESS_LIBRARY_DIR/ledger/sessions/<session>/calls/<tool_use_id>.json. Then HARNESS_CALL=<tool_use_id> (and for
//   a subagent HARNESS_AGENT=<agent_id>:<agent_type>) is exported read-only ahead of it through updatedInput. The
//   CLI believes an agent only when that record names it (spec harness meta.invariants hookSawCall), so an
//   obfuscated HARNESS_AGENT records nothing. A command that sets HARNESS_AGENT or HARNESS_CALL itself is denied
//   (setsHarnessAgent). Every other command is left as it is.
// - SubagentStart: files { sessionId, agentId, agentType, at } at
//   $HARNESS_LIBRARY_DIR/ledger/sessions/<session>/agents/<agent>.json, which harness verify-actors checks, and binds
//   the agent to the oldest spawn of its agent type that the spawn gate recorded for this session and the store took
//   (WORKER_STARTED; spec workItem, Workers).
// It does nothing unless the project has installed the harness (host.js), and on its own failure it prints
// nothing and exits 0.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { gate, libraryDir, deny, safeId, writeCall, callsDir, runHarness } from './host.js';

// Setting, exporting, clearing or passing HARNESS_AGENT or HARNESS_CALL, inline, by export/declare/unset or through env.
const SETS = /HARNESS_(AGENT|CALL)\s*\+?=|\b(export|unset|declare|typeset|local|readonly|env)\b[^\n;&|]*\bHARNESS_(AGENT|CALL)\b/;
const id = safeId;

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const command = input.tool_input?.command;
  if (input.hook_event_name === 'SubagentStart') {
    const [session, agent] = [id(input.session_id), id(input.agent_id)];
    if (session && agent && (await gate(1000)) === 'installed') {
      const dir = join(libraryDir(), 'ledger', 'sessions', session, 'agents');
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.${agent}.${process.pid}.tmp`);
      const agentType = String(input.agent_type ?? '');
      writeFileSync(tmp, JSON.stringify({ sessionId: session, agentId: agent, agentType, at: new Date().toISOString() }));
      renameSync(tmp, join(dir, `${agent}.json`));
      bind(session, agent, agentType, input.cwd);
    }
  } else if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'Bash' && typeof command === 'string') {
    const sets = SETS.test(command);
    if ((sets || command.includes('harness')) && (await gate(1000)) === 'installed') {
      let out;
      if (sets) out = deny('setsHarnessAgent', 'this command sets HARNESS_AGENT or HARNESS_CALL itself. Only the harness plugin sets them, from its record of the call, so a session or subagent cannot record as another; run the command without them.');
      else {
        const session = id(input.session_id);
        const call = id(input.tool_use_id) || `cmd-${createHash('sha256').update(command).digest('hex').slice(0, 32)}`;
        const agent = input.agent_id ? `${id(input.agent_id)}:${String(input.agent_type ?? '').replace(/[^A-Za-z0-9_.:-]/g, '')}` : null;
        writeCall(session, call, { kind: 'bash', agentId: id(input.agent_id) || null, agentType: input.agent_type ?? null, commandSha256: createHash('sha256').update(command).digest('hex') });
        const vars = [`HARNESS_CALL='${call}'`, ...(agent ? [`HARNESS_AGENT='${agent}'`] : [])];
        out = { updatedInput: { ...input.tool_input, command: `export ${vars.join(' ')}; readonly ${vars.map((v) => v.split('=')[0]).join(' ')}\n${command}` } };
      }
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...out } }));
    }
  }
} catch {
  // Swallowed on purpose; see above.
}
process.exit(0);

// The spawn gate's records of this session's spawns that the store took, oldest first, not yet bound.
function bind(session, agent, agentType, cwd) {
  const dir = callsDir(session);
  let spawns = [];
  try {
    spawns = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ f, r: JSON.parse(readFileSync(join(dir, f), 'utf8')) }))
      .filter(({ r }) => r.kind === 'spawn' && r.recorded === true && !r.boundAgent && r.agentType === agentType)
      .sort((a, b) => String(a.r.at).localeCompare(String(b.r.at)));
  } catch {}
  const [first] = spawns;
  if (!first) return;
  const call = `start-${agent}`;
  writeCall(session, call, { kind: 'start', agentId: null, agentType: null, item: first.r.item, agent: `${session}/${agent}` });
  const r = runHarness(['send', JSON.stringify({ type: 'WORKER_STARTED', agent: `${session}/${agent}`, agentType }), '--to', `item:${first.r.item}`, '--id', `start-${agent}`], { session, call, cwd });
  writeCall(session, first.r.toolUseId, { ...first.r, boundAgent: r.status === 0 ? `${session}/${agent}` : null, bindResult: r.out?.why ?? (r.status === 0 ? 'bound' : r.err) });
}
