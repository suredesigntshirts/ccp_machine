#!/usr/bin/env node
// PreToolUse hook: the spawn gate (Agent) and the merge gate (mcp__github__merge_pull_request, and every Bash command
// that merges or writes to GitHub). The rules are the spec's: the workItem machine judges, asked
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
//   sha (reviewOnHead): `harness merge-gate` answers. A Bash call is read whole (lists, pipelines, $(...) and
//   backticks, sh -c and eval strings, env/command/xargs wrappers): a literal merge however wrapped is judged so, and
//   a GitHub write the gate cannot read (a gh command, method or path built from variables, a gh alias or extension,
//   a GraphQL mutation or unreadable document, a merge by curl or wget) is denied (readableGitHubWrite).
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
// gh's own commands; anything else is an alias or an extension, whose meaning the gate cannot read.
const GH = new Set(['agent-task', 'alias', 'api', 'attestation', 'auth', 'browse', 'cache', 'codespace', 'completion', 'config', 'copilot', 'extension', 'gist', 'gpg-key', 'help', 'issue', 'label', 'org', 'pr', 'preview', 'project', 'release', 'repo', 'ruleset', 'run', 'search', 'secret', 'ssh-key', 'status', 'variable', 'workflow', '--version', '--help', '-h', 'version']);
// Words that make a command run by a name the gate cannot read look like a GitHub write.
const WRITE_WORDS = new Set(['api', 'pr', 'graphql', 'merge', '-X', '--method', '--request', 'PUT', 'POST', 'PATCH', 'DELETE']);

const answer = (out) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...out } }));

let gated = false; // set once the call is one a gate judges, so a failure after it denies under enforcement
try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const ask = input.hook_event_name === 'PreToolUse' && (['Agent', 'Task'].includes(input.tool_name) ? spawnCall(input) : mergeCall(input));
  if (ask && (await gate(1000)) === 'installed') {
    gated = true;
    // A Bash call's own record (tool_use_id) belongs to agent-actor.js, which stamps the command with it; the gate's is beside it.
    const id = `${input.tool_name === 'Bash' ? 'gate-' : ''}${safeId(input.tool_use_id) || `${ask.kind}-${sha256(JSON.stringify(input.tool_input)).slice(0, 32)}`}`;
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
  if (rule === 'mergeBound') return deny('mergeBound', why);
  if (rule === 'pinnedHead') return deny('pinnedHead', why);
  if (rule === 'reviewOnHead') return deny('reviewOnHead', why);
  if (rule === 'readableGitHubWrite') return deny('readableGitHubWrite', why);
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

// The merge call's routes: the MCP tool, or what a Bash command runs (see readBash). Null when it is neither a merge
// nor a GitHub write the gate cannot read.
function mergeCall(input) {
  const t = input.tool_input ?? {};
  let found;
  if (input.tool_name === 'mcp__github__merge_pull_request')
    found = [{ pr: t.owner && t.repo && t.pullNumber != null ? `${t.owner}/${t.repo}#${t.pullNumber}` : '', sha: t.expectedHeadSha ?? null }];
  else if (input.tool_name === 'Bash' && typeof t.command === 'string') found = commands(t.command).map((c) => githubWrite(c, input.cwd)).filter(Boolean);
  else return null;
  if (!found.length) return null;
  return {
    kind: 'merge',
    judge(how) {
      const unread = found.find((f) => f.unread);
      if (unread) return { rule: 'readableGitHubWrite', record: { unread: found.filter((f) => f.unread).map((f) => f.unread) }, why: `${unread.unread}. Merge through gh pr merge, gh api or the GitHub MCP merge tool with a literal PR and --match-head-commit / sha / expectedHeadSha, which the merge gate reads` };
      let last = null;
      for (const { pr, sha } of found) {
        const r = runHarness(['merge-gate', '--pr', pr || 'none', '--sha', sha || 'none'], how);
        const ok = r.status === 0 && r.out?.allow === true;
        last = { rule: fromCli(r, ok), record: { pr, sha }, why: r.out?.why ?? r.err };
        if (!ok) return last;
      }
      return last;
    }
  };
}

// The simple commands a Bash command runs, each a list of words { text (quotes removed), dyn (it holds a $ or a
// backtick outside single quotes, so the shell builds it) }. Lists, pipelines and subshells are split; the bodies of
// $(...) and backticks, and sh -c and eval strings, are read as commands of their own; env, command, exec, nohup,
// time, nice, timeout, sudo and xargs are looked through to the program they run.
function commands(text, depth = 0) {
  const out = [], nested = [];
  let words = [], w = null, q = null;
  const push = () => { if (w) words.push(w); w = null; };
  const end = () => { push(); if (words.length) out.push(words); words = []; };
  const add = (c, dyn = false) => { w ??= { text: '', dyn: false }; w.text += c; if (dyn) w.dyn = true; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q === "'") { if (c === "'") q = null; else add(c); continue; }
    if (c === '\\' && i + 1 < text.length) { if (text[i + 1] !== '\n') add(text[i + 1]); i++; continue; }
    if (q === '"' && c === '"') { q = null; continue; }
    if (!q && (c === "'" || c === '"')) { q = c; w ??= { text: '', dyn: false }; continue; }
    if (c === '`' || (c === '$' && text[i + 1] === '(')) {
      let j = i + 1;
      if (c === '`') { while (j < text.length && text[j] !== '`') j++; }
      else for (let d = 0; j < text.length; j++) { if (text[j] === '(') d++; else if (text[j] === ')' && --d === 0) break; }
      if (depth < 8) nested.push(...commands(text.slice(c === '`' ? i + 1 : i + 2, j), depth + 1));
      add('$', true);
      i = j;
      continue;
    }
    if (c === '$') { add(c, true); continue; }
    if (!q && /[;&|\n()]/.test(c)) { end(); continue; }
    if (!q && /\s/.test(c)) { push(); continue; }
    add(c);
  }
  end();
  return [...nested, ...out.flatMap((ws) => run(ws, depth))];
}

// The program a word list runs, through assignments and wrappers: [{ prog, dyn, args }], or the commands of an
// sh -c or eval string.
function run(ws, depth) {
  let i = 0;
  const skipFlags = (valued = new Set()) => { while (i < ws.length && /^-/.test(ws[i].text)) { if (valued.has(ws[i].text)) i++; i++; } };
  for (;;) {
    while (i < ws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i].text)) i++;
    const p = ws[i]?.text.split('/').pop();
    if (p === undefined) return [];
    if (ws[i].dyn) return [{ prog: null, dyn: true, args: ws.slice(i + 1) }];
    if (p === 'env') {
      i++;
      skipFlags(new Set(['-u', '--unset', '-C', '--chdir']));
      if (!/^(-S|--split-string)/.test(ws[i - 1]?.text ?? '')) continue;
      const rest = ws.slice(i); // env -S: the rest is one command line, split by env
      return rest.some((x) => x.dyn) ? [{ prog: null, dyn: true, args: rest }] : depth < 8 ? commands(rest.map((x) => x.text).join(' '), depth + 1) : [];
    }
    if (['command', 'exec', 'nohup', 'time', 'sudo', 'builtin'].includes(p)) { i++; skipFlags(new Set(['-u', '-g'])); continue; }
    if (p === 'nice') { i++; skipFlags(new Set(['-n'])); continue; }
    if (p === 'timeout') { i++; skipFlags(new Set(['-s', '-k'])); i++; continue; }
    if (p === 'xargs') { i++; skipFlags(new Set(['-n', '-I', '-P', '-L', '-d', '-a', '-s', '-E'])); continue; }
    if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(p)) {
      const c = ws.findIndex((x, k) => k > i && /^-[a-z]*c[a-z]*$/.test(x.text));
      if (c < 0 || !ws[c + 1]) return [];
      return ws[c + 1].dyn ? [{ prog: null, dyn: true, args: ws.slice(c + 1) }] : depth < 8 ? commands(ws[c + 1].text, depth + 1) : [];
    }
    if (p === 'eval') {
      const rest = ws.slice(i + 1);
      return rest.some((x) => x.dyn) ? [{ prog: null, dyn: true, args: rest }] : depth < 8 ? commands(rest.map((x) => x.text).join(' '), depth + 1) : [];
    }
    return [{ prog: p, dyn: false, args: ws.slice(i + 1) }];
  }
}

// Flags and positionals of an argument list: valued flags take the next word, or the rest of their word (-XPUT,
// --method=PUT); a cluster of short flags (-sSX PUT) ends at its first valued one.
function flags(args, valued) {
  const got = [], pos = [];
  for (let i = 0; i < args.length; i++) {
    const { text, dyn } = args[i];
    const take = (name, rest) => got.push({ name, value: rest !== '' ? { text: rest, dyn } : args[++i] ?? { text: '', dyn: false } });
    if (text.startsWith('--')) {
      const [name, ...v] = text.split('=');
      if (v.length) got.push({ name, value: { text: v.join('='), dyn } });
      else if (valued.has(name)) take(name, '');
      else got.push({ name, value: null });
    } else if (/^-[A-Za-z]/.test(text)) {
      let k = 1;
      for (; k < text.length; k++) { const name = `-${text[k]}`; if (valued.has(name)) { take(name, text.slice(k + 1)); break; } got.push({ name, value: null }); }
    } else pos.push(args[i]);
  }
  return { got, pos, has: (...n) => got.filter((f) => n.includes(f.name)) };
}

// What one simple command does to GitHub: { pr, sha } for a literal merge, { unread: why } for a write the gate
// cannot read, or null.
function githubWrite({ prog, dyn, args }, cwd) {
  if (dyn) {
    const hit = args.find((a) => WRITE_WORDS.has(a.text) || /api\.github\.com|\/pulls\/[^/\s]*\/merge/.test(a.text));
    return hit ? { unread: `a command run by a name the gate cannot read (a variable or substitution) with "${hit.text}" in it` } : null;
  }
  if (prog === 'gh') return ghWrite(args, cwd);
  if (prog === 'curl' || prog === 'wget') return httpWrite(prog, args);
  return null;
}

function ghWrite(args, cwd) {
  const [first, sub] = args;
  if (!first) return null;
  if (first.dyn) return { unread: 'a gh command built from a variable' };
  if (!GH.has(first.text)) return { unread: `gh ${first.text} is not one of gh's own commands (an alias or an extension)` };
  if (first.text === 'pr') {
    if (sub?.dyn) return { unread: 'a gh pr subcommand built from a variable' };
    return sub?.text === 'merge' ? prMerge(args.slice(2), cwd) : null;
  }
  if (first.text !== 'api') return null;
  const f = flags(args.slice(1), new Set(['-X', '--method', '-H', '--header', '-f', '--raw-field', '-F', '--field', '--input', '-q', '--jq', '-t', '--template', '--cache', '--hostname', '-p', '--preview']));
  const [method] = f.has('-X', '--method');
  if (method?.value.dyn) return { unread: 'a gh api method built from a variable' };
  const fields = f.has('-f', '--raw-field', '-F', '--field').map((x) => x.value);
  const input = f.has('--input').length > 0;
  const verb = (method?.value.text || (fields.length || input ? 'POST' : 'GET')).toUpperCase();
  const [path] = f.pos;
  if (!path || verb === 'GET' || verb === 'HEAD') return null;
  if (path.dyn) return { unread: `a gh api ${verb} to a path built from a variable` };
  const r = reducePath(path.text);
  if (r.unread) return r;
  if (r.low.join('/') === 'graphql') {
    const query = fields.find((x) => x.text.startsWith('query='));
    if (input || !query || query.dyn || query.text.startsWith('query=@')) return { unread: 'a GraphQL document the gate cannot read (from a file, --input or a variable)' };
    return /\bmutation\b/i.test(query.text) ? { unread: 'a GraphQL mutation' } : null;
  }
  const m = mergePath(r, path.text);
  if (!m || m.unread) return m;
  const sha = input ? null : fields.find((x) => x.text.startsWith('sha=') && !x.dyn)?.text.slice(4) ?? null;
  const repo = m.owner === '{owner}' || m.repo === '{repo}' ? originOf(cwd) : `${m.owner}/${m.repo}`;
  return { pr: repo ? `${repo}#${m.number}` : '', sha };
}

// A write's path in its one canonical form (spec harness meta.invariants readableGitHubWrite): the scheme and host,
// the query and the fragment dropped, each segment's percent-escapes decoded once, empty and '.' segments dropped and
// '..' resolved. { segs, low (case folded) }, or { unread: why } for a path the gate does not reduce: a bad escape, an
// escape that leaves '%', '?', '#', '/', '\\' or a control character, a '..' above the root, or repositories/<id>.
function reducePath(text) {
  const path = String(text).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').replace(/[?#][\s\S]*$/, '');
  const segs = [];
  for (const raw of path.split('/')) {
    let seg;
    try { seg = decodeURIComponent(raw); } catch { return { unread: `the path ${text} has a percent-escape the gate cannot decode` }; }
    if (/[%?#/\\\x00-\x20\x7f]/.test(seg)) return { unread: `the path ${text} escapes a separator or another escape, which the gate does not reduce` };
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!segs.length) return { unread: `the path ${text} climbs above its root` };
      segs.pop();
      continue;
    }
    segs.push(seg);
  }
  const low = segs.map((x) => x.toLowerCase());
  if (low[0] === 'repositories') return { unread: `the path ${text} names a repository by id (repositories/), which the gate cannot bind to a PR` };
  return { segs, low };
}

// A reduced path that touches pulls/<n>/merge: { owner, repo, number } when it is exactly
// repos/<owner>/<repo>/pulls/<number>/merge, else { unread }; null when it touches no merge endpoint.
function mergePath({ segs, low }, text) {
  if (!low.some((x, i) => x === 'pulls' && low[i + 2] === 'merge')) return null;
  if (low.length === 6 && low[0] === 'repos' && low[3] === 'pulls' && /^\d+$/.test(low[4]) && low[5] === 'merge') return { owner: segs[1], repo: segs[2], number: low[4] };
  return { unread: `the path ${text} reaches a pull's merge endpoint but is not repos/<owner>/<repo>/pulls/<number>/merge` };
}

function prMerge(rest, cwd) {
  const f = flags(rest, new Set(['--match-head-commit', '--repo', '-R', '--subject', '-t', '--body', '-b', '--body-file', '-F', '--author-email', '-A']));
  const value = (...n) => { const v = f.has(...n).at(-1)?.value; return v && !v.dyn ? v.text : null; };
  const sha = value('--match-head-commit');
  const repo = value('--repo', '-R');
  const sel = f.pos[0];
  if (!sel || sel.dyn) return { pr: '', sha };
  const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(sel.text);
  if (url) return { pr: `${url[1]}#${url[2]}`, sha };
  if (/^#?\d+$/.test(sel.text)) return { pr: `${repo ?? originOf(cwd) ?? ''}#${sel.text.replace('#', '')}`, sha };
  return { pr: '', sha };
}

function httpWrite(prog, args) {
  const curl = prog === 'curl';
  const data = curl ? ['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '-F', '--form', '--form-string', '-T', '--upload-file'] : ['--post-data', '--post-file', '--body-data', '--body-file'];
  const valued = new Set([...data, ...(curl ? ['-X', '--request', '-H', '--header', '-o', '--output', '-u', '--user', '-K', '--config', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '-c', '--cookie-jar', '-w', '--write-out', '--url', '-x', '--proxy', '-m', '--max-time', '--connect-timeout', '--retry', '-r', '--range', '-E', '--cert', '--cacert', '--resolve'] : ['--method', '--header', '-O', '--output-document', '-o', '--output-file', '-U', '--user-agent', '--user', '--password', '-e', '--execute', '-i', '--input-file'])]);
  const f = flags(args, valued);
  if (f.has(...(curl ? ['-K', '--config'] : ['-e', '--execute', '-i', '--input-file'])).length) return { unread: `${prog} reading its requests or options from a file` };
  const [method] = f.has(...(curl ? ['-X', '--request'] : ['--method']));
  if (method?.value.dyn) return { unread: `a ${prog} method built from a variable` };
  const verb = (method?.value.text || (f.has(...data).length ? 'POST' : 'GET')).toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') return null;
  const urls = [...f.pos, ...f.has('--url').map((x) => x.value)];
  if (urls.some((u) => u.dyn)) return { unread: `a ${prog} ${verb} to a URL built from a variable` };
  for (const u of urls) { // on any host: an address can name GitHub without saying github.com
    const r = reducePath(u.text);
    if (r.unread) return r;
    if (mergePath(r, u.text) || r.low.join('/') === 'graphql') return { unread: `a ${prog} ${verb} to ${u.text}: a merge or GraphQL write by ${prog}` };
  }
  return null;
}

// owner/repo of the checkout's origin, for a `gh pr merge <n>` without --repo.
function originOf(cwd) {
  try {
    const url = execFileSync('git', ['-C', cwd || '.', 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)?.[1] ?? null;
  } catch { return null; }
}
