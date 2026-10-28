#!/usr/bin/env node
// PreToolUse (Bash) and SubagentStart hook: tells a session's subagents apart in the harness store. A subagent
// shares its parent's CLAUDE_CODE_SESSION_ID; only hook input carries its agent_id and agent_type.
// - PreToolUse: under HARNESS_ENFORCE=1 in this hook's own environment every Bash call, else a command that names
//   harness, from a subagent or the parent, is recorded first: { sessionId, agentId (null for the parent), agentType,
//   toolUseId, commandSha256, keySha256, enforced, at } at $HARNESS_LIBRARY_DIR/ledger/sessions/<session>/calls/
//   <tool_use_id>.json. Then HARNESS_CALL=<tool_use_id>:<key> (and for a subagent HARNESS_AGENT=<agent_id>:<agent_type>)
//   is exported read-only ahead of it through updatedInput. The CLI believes an actor only with that key and only
//   when that record names it, and a call recorded under HARNESS_ENFORCE=1 marks its store enforced, after which a
//   call the hook did not record writes nothing (spec harness meta.invariants hookSawCall): what the command itself
//   sets, unsets or forges changes nothing. A command that sets HARNESS_AGENT or HARNESS_CALL itself is denied
//   (setsHarnessAgent). Every other command is left as it is.
// - SubagentStart: files { sessionId, agentId, agentType, at } at
//   $HARNESS_LIBRARY_DIR/ledger/sessions/<session>/agents/<agent>.json, which harness verify-actors checks, and binds
//   the agent to the newest spawn of its agent type that the spawn gate recorded for this session and the store took,
//   when that spawn is unbound (WORKER_STARTED; spec workItem, Workers; harness meta.invariants oneUnboundSpawn). The
//   bind's result is added to the agent's record as bind { item, spawn, result }. A resumed agent starts again: its
//   record keeps its first at and bind, the new start time is added to resumes, and nothing is bound.
// It does nothing unless the project has installed the harness (host.js), and on its own failure it prints
// nothing and exits 0.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { gate, libraryDir, deny, enforced, safeId, writeCall, callsDir, runHarness } from './host.js';

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
      const agentType = String(input.agent_type ?? '');
      const at = new Date().toISOString();
      const file = (r) => {
        const tmp = join(dir, `.${agent}.${process.pid}.tmp`);
        writeFileSync(tmp, JSON.stringify(r));
        renameSync(tmp, join(dir, `${agent}.json`));
      };
      let prior = null;
      try { prior = JSON.parse(readFileSync(join(dir, `${agent}.json`), 'utf8')); } catch {}
      // A resume (SendMessage to an agent that ran) starts it again: its first start and bind stand.
      if (prior?.sessionId === session && prior.agentId === agent && Date.parse(prior.at)) file({ ...prior, resumes: [...(prior.resumes ?? []), at] });
      else {
        const record = { sessionId: session, agentId: agent, agentType, at };
        file(record);
        const bound = bind(session, agent, agentType, input.cwd);
        if (bound) file({ ...record, bind: bound });
      }
    }
  } else if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'Bash' && typeof command === 'string') {
    const sets = SETS.test(command);
    if ((sets || enforced() || command.includes('harness')) && (await gate(1000)) === 'installed') {
      let out;
      if (sets) out = deny('setsHarnessAgent', 'this command sets HARNESS_AGENT or HARNESS_CALL itself. Only the harness plugin sets them, from its record of the call, so a session or subagent cannot record as another; run the command without them.');
      else {
        const session = id(input.session_id);
        const call = id(input.tool_use_id) || `cmd-${createHash('sha256').update(command).digest('hex').slice(0, 32)}`;
        const agent = input.agent_id ? `${id(input.agent_id)}:${String(input.agent_type ?? '').replace(/[^A-Za-z0-9_.:-]/g, '')}` : null;
        const stamp = writeCall(session, call, { kind: 'bash', agentId: id(input.agent_id) || null, agentType: input.agent_type ?? null, commandSha256: createHash('sha256').update(command).digest('hex') });
        const vars = [`HARNESS_CALL='${stamp}'`, ...(agent ? [`HARNESS_AGENT='${agent}'`] : [])];
        out = { updatedInput: { ...input.tool_input, command: `export ${vars.join(' ')}; readonly ${vars.map((v) => v.split('=')[0]).join(' ')}\n${command}` } };
      }
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...out } }));
    }
  }
} catch {
  // Swallowed on purpose; see above.
}
process.exit(0);

// The spawn this agent belongs to is the session's newest spawn of its agent type that the store took: a session has
// at most one waiting per type (spec harness meta.invariants oneUnboundSpawn), and one already bound means the agent
// has no item role. The store judges the bind. Only a bind it takes is written on the spawn's record, so a refused
// one never overwrites another agent's; the result goes on this agent's own record. Returns it, or null.
function bind(session, agent, agentType, cwd) {
  const dir = callsDir(session);
  let last;
  try {
    [last] = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
      .filter((r) => r.kind === 'spawn' && r.recorded === true && r.agentType === agentType)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  } catch {}
  if (!last || last.boundAgent) return null;
  const call = writeCall(session, `start-${agent}`, { kind: 'start', agentId: null, agentType: null, item: last.item, agent: `${session}/${agent}` });
  const r = runHarness(['send', JSON.stringify({ type: 'WORKER_STARTED', agent: `${session}/${agent}`, agentType }), '--to', `item:${last.item}`, '--id', `start-${agent}`], { session, call, cwd });
  const ok = r.status === 0 && !r.out?.refused;
  if (ok) writeCall(session, last.toolUseId, { ...last, boundAgent: `${session}/${agent}`, bindResult: 'bound' });
  return { item: last.item, spawn: last.toolUseId, result: ok ? 'bound' : r.out?.why ?? r.err };
}
