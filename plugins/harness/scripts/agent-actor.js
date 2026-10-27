#!/usr/bin/env node
// PreToolUse (Bash) and SubagentStart hook: tells a session's subagents apart in the harness store. A subagent
// shares its parent's CLAUDE_CODE_SESSION_ID; only hook input carries its agent_id and agent_type.
// - PreToolUse: a subagent's command that names harness gets HARNESS_AGENT=<agent_id>:<agent_type> exported
//   (read-only) ahead of it through updatedInput, so every harness call in it records as agent
//   <session_id>/<agent_id> (spec harness meta.actors). A command that sets HARNESS_AGENT itself, from a subagent
//   or the parent, is denied with the reason. Every other command, and the parent's, is left as it is.
// - SubagentStart: files { sessionId, agentId, agentType, at } at
//   $HARNESS_LIBRARY_DIR/ledger/sessions/<session>/agents/<agent>.json, which harness verify-actors checks.
// It does nothing unless the project has installed the harness (host.js), and on its own failure it prints
// nothing and exits 0.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { gate, libraryDir } from './host.js';

// Setting, exporting, clearing or passing HARNESS_AGENT, inline, by export/declare/unset or through env.
const SETS = /HARNESS_AGENT\s*\+?=|\b(export|unset|declare|typeset|local|readonly|env)\b[^\n;&|]*\bHARNESS_AGENT\b/;
const id = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '');

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const command = input.tool_input?.command;
  if (input.hook_event_name === 'SubagentStart') {
    const [session, agent] = [id(input.session_id), id(input.agent_id)];
    if (session && agent && (await gate(1000)) === 'installed') {
      const dir = join(libraryDir(), 'ledger', 'sessions', session, 'agents');
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.${agent}.${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify({ sessionId: session, agentId: agent, agentType: String(input.agent_type ?? ''), at: new Date().toISOString() }));
      renameSync(tmp, join(dir, `${agent}.json`));
    }
  } else if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'Bash' && typeof command === 'string') {
    const sets = SETS.test(command);
    if ((sets || (input.agent_id && command.includes('harness'))) && (await gate(1000)) === 'installed') {
      const out = sets
        ? { permissionDecision: 'deny', permissionDecisionReason: 'harness: this command sets HARNESS_AGENT itself. Only the harness plugin sets it, for a subagent, so a session or subagent cannot record as another; run the command without it.' }
        : { updatedInput: { ...input.tool_input, command: `export HARNESS_AGENT='${id(input.agent_id)}:${String(input.agent_type ?? '').replace(/[^A-Za-z0-9_.:-]/g, '')}'; readonly HARNESS_AGENT\n${command}` } };
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...out } }));
    }
  }
} catch {
  // Swallowed on purpose; see above.
}
process.exit(0);
