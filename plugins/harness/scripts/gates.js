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
//   (roleLine). SubagentStart (agent-actor.js) binds the started agent to the spawn; its input does not name the Agent
//   call, so a second spawn of an agent type while one waits for its agent is refused and denied (oneUnboundSpawn).
// - Merge: the PR must be bound to an item (mergeBound), the call must pin the head sha (pinnedHead), the item's
//   machine must take MERGED of that head (its verifier's PASS), and the PR must carry the PASS as a review on that
//   sha (reviewOnHead): `harness merge-gate` answers. A Bash call is read into the simple commands it runs (commands):
//   gh pr merge, or a gh api path naming a merge endpoint, merges (merges), and a word the shell rewrites where it
//   decides that (or a curl or wget call) is unreadable (rewritten); the words of gh's commands that never run an
//   argument (GH_DATA) and of data-only programs are data (isData), so 'merge' in their arguments, strings or heredoc text is none. A call that runs anything else is text
//   the gate cannot read, and its text naming the word merge with gh, curl, wget, api or graphql counts as a merge
//   (namesMerge). A merge is denied unless it is exactly one of the gated forms (GATED_FORMS), which alone are
//   judged. Any other Bash call is read for GitHub writes the gate cannot read (a gh command,
//   method or path built from a variable, a gh alias or extension, a GraphQL mutation or unreadable document, a curl
//   or wget write built from a variable or to GraphQL), which are denied (readableGitHubWrite).
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
// gh's own commands; anything else is an alias or an extension, whose meaning the gate cannot read.
const GH = new Set(['agent-task', 'alias', 'api', 'attestation', 'auth', 'browse', 'cache', 'codespace', 'completion', 'config', 'copilot', 'extension', 'gist', 'gpg-key', 'help', 'issue', 'label', 'org', 'pr', 'preview', 'project', 'release', 'repo', 'ruleset', 'run', 'search', 'secret', 'ssh-key', 'status', 'variable', 'workflow', '--version', '--help', '-h', 'version']);
// Words that make a command run by a name the gate cannot read look like a GitHub write.
const WRITE_WORDS = new Set(['api', 'pr', 'graphql', 'merge', '-X', '--method', '--request', 'PUT', 'POST', 'PATCH', 'DELETE']);

// The only Bash merges the gate judges (spec harness meta.invariants readableGitHubWrite): one simple command each.
const GATED_FORMS = 'one simple command, exactly `gh pr merge <number> --repo <owner>/<repo> --match-head-commit <sha>` (with only --squash, --merge, --rebase, --delete-branch, --subject or --body beside it) or `gh api -X PUT repos/<owner>/<repo>/pulls/<number>/merge -f sha=<sha>` (with only -f merge_method, commit_title or commit_message beside it); or the GitHub MCP merge tool with expectedHeadSha';
const COMPOUND = /[;&|<>(){}$`\\\n\r]/;
// A GitHub merge endpoint in a word, lower-cased: REST (pulls/<n>/merge, merges, merge-upstream) or GraphQL.
const MERGE_ENDPOINT = /\/merges?(?:[/?#]|$)|\/merge-upstream/;
// The word merge in text: also merges and compounds (merge_method, merge-upstream, mergePullRequest), not merged,
// mergeable or merger.
const MERGE_WORD = /[mM][eE][rR][gG][eE](?![a-rt-z])/;
// Programs whose words are data to the gate (see isData).
const GH_API_VALUED = new Set(['-X', '--method', '-H', '--header', '-f', '--raw-field', '-F', '--field', '--input', '-q', '--jq', '-t', '--template', '--cache', '--hostname', '-p', '--preview']);
// A word the shell rewrites into words the gate cannot know: several words or none (an unquoted expansion, brace, glob,
// tilde or extglob), or one word that may start with a dash, a flag (an expansion with no literal start).
const rewritten = (a) => a.dyn && (a.split || !a.lead);
const DATA = new Set(['gh', 'echo', 'printf', 'cat', 'jq', 'harness']);
// The gh commands whose words are data: none runs an argument as a command, now or later (codespace ssh does; config
// sets an editor, pager or browser gh runs; repo clone passes options to git; alias and extension run their own).
// Any other gh command, one gh adds later included, is text the gate cannot read.
const GH_DATA = new Set(['api', 'issue', 'label', 'pr', 'release', 'run', 'search', 'status', 'help', 'version', '--version', '--help', '-h']);
// Percent-escapes decoded until none is left, so an escaped word reads as itself.
const decodePct = (t) => { let prev; do { prev = t; t = t.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))); } while (t !== prev); return t; };
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
  if (rule === 'oneUnboundSpawn') return deny('oneUnboundSpawn', why);
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
  else if (input.tool_name === 'Bash' && typeof t.command === 'string') {
    const cmds = commands(t.command);
    const judged = cmds.map(merges);
    const merge = judged.includes('merge');
    const hidden = judged.find((j) => j?.unread);
    const tool = !merge && !hidden && cmds.some((c) => !isData(c)) && namesMerge(t.command);
    found = merge || tool ? [gatedMerge(t.command) ?? { unread: merge ? 'this command merges, and the only Bash merges the gate takes are the gated forms' : `this command runs ${cmds.find((c) => !isData(c)).prog ?? 'a program built from a variable'} (text the gate cannot read, or a file write) and names a merge with ${tool}` }]
      : hidden ? [hidden] : cmds.map(githubWrite).filter(Boolean);
  } else return null;
  if (!found.length) return null;
  return {
    kind: 'merge',
    judge(how) {
      const unread = found.find((f) => f.unread);
      if (unread) return { rule: 'readableGitHubWrite', record: { unread: found.filter((f) => f.unread).map((f) => f.unread) }, why: `${unread.unread}. Merge with ${GATED_FORMS}` };
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

// Whether a simple command merges: 'merge' for gh pr merge, or gh api naming a merge endpoint in its path, by any
// method; { unread } when a word that decides it is one the shell rewrites (as a variable is); else false.
function merges({ prog, args }) {
  const [first] = args;
  if (prog !== 'gh' || !first || first.dyn) return false;
  if (first.text === 'pr') { // its subcommand: the first word after pr and its only flag before one, -R/--repo
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a.dyn) return { unread: 'a gh pr word up to its subcommand is one the shell rewrites' };
      if (a.text === '-R' || a.text === '--repo') { if (args[++i]?.dyn) return { unread: 'a gh pr repo the shell rewrites' }; continue; }
      if (/^(?:-R.|--repo=)/.test(a.text)) continue;
      if (a.text.startsWith('-')) return { unread: `gh pr ${a.text} before its subcommand` };
      return a.text.toLowerCase() === 'merge' ? 'merge' : false;
    }
    return false;
  }
  if (first.text !== 'api') return false;
  if (args.some(rewritten)) return { unread: 'a gh api word the shell rewrites into words or a flag the gate cannot read' };
  return flags(args.slice(1), GH_API_VALUED).pos.some((p) => MERGE_ENDPOINT.test(decodePct(p.text).toLowerCase())) ? 'merge' : false;
}

// A simple command whose words are data: gh (read by merges and githubWrite) or a data-only program, named without a
// path, writing no file. Anything else may run text the gate cannot read.
function isData({ prog, word, args }) {
  const harness = prog === 'node' && /(^|\/)bin\/harness\.js$/.test(args[0]?.text ?? '') && !args[0].dyn;
  if (!harness && (!DATA.has(prog) || word !== prog)) return false;
  if (prog === 'gh' && (args[0]?.dyn || !GH_DATA.has(args[0]?.text))) return false; // a gh command that may run its words
  return !args.some((a, i) => {
    const r = /^(?:\d*|&)>>?(.*)$/.exec(a.text);
    return r && !/^(?:&\d+|&-|\/dev\/(?:null|stdout|stderr))$/.test(r[1] || args[i + 1]?.text || '');
  });
}

// The GitHub tool a command's text names together with the word merge (quotes and backslashes removed, escapes
// decoded; merged, mergeable and merger are not the word), or null. Read only when the call runs what the gate cannot read.
function namesMerge(text) {
  const plain = decodePct(text.replace(/['"\\]/g, ''));
  return MERGE_WORD.test(plain) ? /gh|curl|wget|api|graphql/.exec(plain.toLowerCase())?.[0] ?? null : null;
}

// { pr, sha } when the whole command is exactly one gated form (GATED_FORMS), else null. Words may be quoted, but
// nothing else of the shell is read: any compound or expanding character makes it not a gated form.
function gatedMerge(text) {
  const t = text.trim();
  if (COMPOUND.test(t)) return null;
  const words = [];
  const word = /\s*(?:'([^']*)'|"([^"]*)"|([^\s'"]+))(?=\s|$)/y;
  while (word.lastIndex < t.length) {
    const m = word.exec(t);
    if (!m) return null;
    words.push(m[1] ?? m[2] ?? m[3]);
  }
  const opts = (rest, valued, flags) => {
    const got = {};
    for (let i = 0; i < rest.length; i++) {
      let [name, value] = rest[i].split(/=(.*)/s);
      if (!valued[name] && !flags[name]) return null;
      const key = valued[name] ?? flags[name];
      if (key in got) return null;
      if (valued[name] && value === undefined) value = rest[++i];
      if (valued[name] ? value === undefined : value !== undefined) return null;
      got[key] = value ?? true;
    }
    return got;
  };
  if (words[0] === 'gh' && words[1] === 'pr' && words[2] === 'merge' && /^\d+$/.test(words[3] ?? '')) {
    const o = opts(words.slice(4), { '--repo': 'repo', '-R': 'repo', '--match-head-commit': 'sha', '--subject': 'subject', '-t': 'subject', '--body': 'body', '-b': 'body' },
      { '--squash': 'squash', '-s': 'squash', '--merge': 'merge', '-m': 'merge', '--rebase': 'rebase', '-r': 'rebase', '--delete-branch': 'delete', '-d': 'delete' });
    if (!o || !/^[\w.-]+\/[\w.-]+$/.test(o.repo ?? '')) return null;
    return { pr: `${o.repo}#${words[3]}`, sha: o.sha ?? null };
  }
  const path = /^repos\/([\w.-]+)\/([\w.-]+)\/pulls\/(\d+)\/merge$/.exec(words[4] ?? '');
  if (words[0] === 'gh' && words[1] === 'api' && words[2] === '-X' && words[3] === 'PUT' && path) {
    const fields = {};
    for (let i = 5; i < words.length; i += 2) {
      const [k, v] = (words[i] === '-f' ? words[i + 1] ?? '' : '').split(/=(.*)/s);
      if (!['sha', 'merge_method', 'commit_title', 'commit_message'].includes(k) || v === undefined || k in fields) return null;
      fields[k] = v;
    }
    return { pr: `${path[1]}/${path[2]}#${path[3]}`, sha: fields.sha ?? null };
  }
  return null;
}

// The simple commands a Bash command runs, each a list of words { text (quotes removed), dyn (the shell rewrites it:
// a $ or backtick outside single quotes, or an unquoted brace, glob, tilde or extglob), split (it may become several
// words or none), lead (its first character is literal and not a dash, so it cannot become a flag) }. Lists, pipelines and subshells are split; the bodies of
// $(...) and backticks, and sh -c and eval strings, are read as commands of their own; env, command, exec, nohup,
// time, nice, timeout, sudo and xargs are looked through to the program they run (and listed as programs too); a
// heredoc's body is input, not commands.
function commands(text, depth = 0) {
  const out = [], nested = [];
  let words = [], w = null, q = null;
  const push = () => { if (w) words.push(w); w = null; };
  const end = () => { push(); if (words.length) out.push(words); words = []; };
  // kind: undefined for a literal character, 'one' for an expansion that stays one word (in double quotes), 'split'
  // for one the shell may turn into several words or none (unquoted: an expansion, brace, glob, tilde or extglob).
  const add = (c, kind) => {
    w ??= { text: '', dyn: false };
    w.lead ??= !kind && c !== '-';
    w.text += c;
    if (kind) w.dyn = true;
    if (kind === 'split') w.split = true;
  };
  // A heredoc (<<word, <<-word): its delimiter is read here, and its body, from the next line, is input, not commands;
  // a body the shell expands (a $ or backtick under an unquoted delimiter) is text the gate cannot read.
  const docs = [];
  const heredoc = (j) => {
    push();
    const doc = { delim: '', quoted: false, strip: text[j] === '-' };
    if (doc.strip) j++;
    while (text[j] === ' ' || text[j] === '\t') j++;
    for (; j < text.length && !/[\s;&|<>()]/.test(text[j]); j++) {
      if (text[j] === "'" || text[j] === '"') { const k = text.indexOf(text[j], j + 1); doc.quoted = true; doc.delim += text.slice(j + 1, k < 0 ? text.length : k); j = k < 0 ? text.length : k; }
      else if (text[j] === '\\') { doc.quoted = true; doc.delim += text[++j] ?? ''; }
      else doc.delim += text[j];
    }
    docs.push(doc);
    return j;
  };
  const bodies = (p) => {
    for (const doc of docs.splice(0)) {
      const body = [];
      while (p < text.length) {
        const nl = text.indexOf('\n', p);
        const line = text.slice(p, nl < 0 ? text.length : nl);
        p = nl < 0 ? text.length : nl + 1;
        if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) break;
        body.push(line);
      }
      if (!doc.quoted && /[$`]/.test(body.join('\n'))) nested.push({ prog: null, word: null, dyn: true, args: [] });
    }
    return p;
  };
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
      add('$', q ? 'one' : 'split');
      i = j;
      continue;
    }
    if (c === '$') { add(c, q && !/^(?:@|\{[^}]*@)/.test(text.slice(i + 1)) ? 'one' : 'split'); continue; } // "$@" and "${a[@]}" split in quotes too
    if (!q && /[{*?[~]/.test(c)) { add(c, 'split'); continue; } // brace, glob, tilde: bash rewrites the word
    if (!q && c === '(' && w) { add(c, 'split'); end(); continue; } // a word glued to ( is an extglob or a function
    if (!q && c === '<' && text[i + 1] === '<' && text[i + 2] !== '<') { i = heredoc(i + 2) - 1; continue; }
    if (!q && c === '\n' && docs.length) { end(); i = bodies(i + 1) - 1; continue; }
    if (!q && c === '&' && /[<>]/.test(text[i - 1] + text[i + 1])) { add(c); continue; } // 2>&1, &>file: a redirect, not a list
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
  const seen = []; // each wrapper, shell or eval looked through is a program too, whose words are not data (isData)
  const out = (r) => [...seen.map((prog) => ({ prog, word: null, dyn: false, args: [] })), ...r];
  const skipFlags = (valued = new Set()) => { while (i < ws.length && /^-/.test(ws[i].text)) { if (valued.has(ws[i].text)) i++; i++; } };
  for (;;) {
    while (i < ws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i].text)) i++;
    const p = ws[i]?.text.split('/').pop();
    if (p === undefined) return out([]);
    if (ws[i].dyn) return out([{ prog: null, dyn: true, args: ws.slice(i + 1) }]);
    seen.push(p);
    if (p === 'env') {
      i++;
      skipFlags(new Set(['-u', '--unset', '-C', '--chdir']));
      if (!/^(-S|--split-string)/.test(ws[i - 1]?.text ?? '')) continue;
      const rest = ws.slice(i); // env -S: the rest is one command line, split by env
      return out(rest.some((x) => x.dyn) ? [{ prog: null, dyn: true, args: rest }] : depth < 8 ? commands(rest.map((x) => x.text).join(' '), depth + 1) : []);
    }
    if (['command', 'exec', 'nohup', 'time', 'sudo', 'builtin'].includes(p)) { i++; skipFlags(new Set(['-u', '-g'])); continue; }
    if (p === 'nice') { i++; skipFlags(new Set(['-n'])); continue; }
    if (p === 'timeout') { i++; skipFlags(new Set(['-s', '-k'])); i++; continue; }
    if (p === 'xargs') { i++; skipFlags(new Set(['-n', '-I', '-P', '-L', '-d', '-a', '-s', '-E'])); continue; }
    if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(p)) {
      const c = ws.findIndex((x, k) => k > i && /^-[a-z]*c[a-z]*$/.test(x.text));
      if (c < 0 || !ws[c + 1]) return out([]);
      return out(ws[c + 1].dyn ? [{ prog: null, dyn: true, args: ws.slice(c + 1) }] : depth < 8 ? commands(ws[c + 1].text, depth + 1) : []);
    }
    if (p === 'eval') {
      const rest = ws.slice(i + 1);
      return out(rest.some((x) => x.dyn) ? [{ prog: null, dyn: true, args: rest }] : depth < 8 ? commands(rest.map((x) => x.text).join(' '), depth + 1) : []);
    }
    seen.pop();
    return out([{ prog: p, word: ws[i].text, dyn: false, args: ws.slice(i + 1) }]);
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

// A GitHub write one simple command makes that the gate cannot read ({ unread: why }), or null. Merges never get here:
// a command naming one is judged by namesMerge and gatedMerge.
function githubWrite({ prog, dyn, args }) {
  if (dyn) {
    const hit = args.find((a) => WRITE_WORDS.has(a.text) || /api\.github\.com|\/pulls\/[^/\s]*\/merge/.test(a.text));
    return hit ? { unread: `a command run by a name the gate cannot read (a variable or substitution) with "${hit.text}" in it` } : null;
  }
  if (prog === 'gh') return ghWrite(args);
  if (prog === 'curl' || prog === 'wget') return httpWrite(prog, args);
  return null;
}

function ghWrite(args) {
  const [first, sub] = args;
  if (!first) return null;
  if (first.dyn) return { unread: 'a gh command built from a variable' };
  if (!GH.has(first.text)) return { unread: `gh ${first.text} is not one of gh's own commands (an alias or an extension)` };
  if (first.text === 'pr') {
    return sub?.dyn ? { unread: 'a gh pr subcommand built from a variable' } : null;
  }
  if (first.text !== 'api') return null;
  const f = flags(args.slice(1), GH_API_VALUED);
  const [method] = f.has('-X', '--method');
  if (method?.value.dyn) return { unread: 'a gh api method built from a variable' };
  const fields = f.has('-f', '--raw-field', '-F', '--field').map((x) => x.value);
  const input = f.has('--input').length > 0;
  const verb = (method?.value.text || (fields.length || input ? 'POST' : 'GET')).toUpperCase();
  const [path] = f.pos;
  if (!path || verb === 'GET' || verb === 'HEAD') return null;
  if (path.dyn) return { unread: `a gh api ${verb} to a path built from a variable` };
  if (/^\/*graphql\/*(?:[?#]|$)/i.test(decodePct(path.text))) {
    const query = fields.find((x) => x.text.startsWith('query='));
    if (input || !query || query.dyn || query.text.startsWith('query=@')) return { unread: 'a GraphQL document the gate cannot read (from a file, --input or a variable)' };
    return /\bmutation\b/i.test(query.text) ? { unread: 'a GraphQL mutation' } : null;
  }
  return null;
}

function httpWrite(prog, args) {
  const curl = prog === 'curl';
  const data = curl ? ['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '-F', '--form', '--form-string', '-T', '--upload-file'] : ['--post-data', '--post-file', '--body-data', '--body-file'];
  const valued = new Set([...data, ...(curl ? ['-X', '--request', '-H', '--header', '-o', '--output', '-u', '--user', '-K', '--config', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '-c', '--cookie-jar', '-w', '--write-out', '--url', '-x', '--proxy', '-m', '--max-time', '--connect-timeout', '--retry', '-r', '--range', '-E', '--cert', '--cacert', '--resolve'] : ['--method', '--header', '-O', '--output-document', '-o', '--output-file', '-U', '--user-agent', '--user', '--password', '-e', '--execute', '-i', '--input-file'])]);
  if (args.some(rewritten)) return { unread: `a ${prog} word the shell rewrites into words or a flag the gate cannot read` };
  const f = flags(args, valued);
  if (f.has(...(curl ? ['-K', '--config'] : ['-e', '--execute', '-i', '--input-file'])).length) return { unread: `${prog} reading its requests or options from a file` };
  const [method] = f.has(...(curl ? ['-X', '--request'] : ['--method']));
  if (method?.value.dyn) return { unread: `a ${prog} method built from a variable` };
  const verb = (method?.value.text || (f.has(...data).length ? 'POST' : 'GET')).toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') return null;
  const urls = [...f.pos, ...f.has('--url').map((x) => x.value)];
  if (urls.some((u) => u.dyn)) return { unread: `a ${prog} ${verb} to a URL built from a variable` };
  const gql = urls.find((u) => /\/graphql\/*(?:[?#]|$)/i.test(decodePct(u.text))); // on any host: an address can name GitHub without saying github.com
  return gql ? { unread: `a ${prog} ${verb} to ${gql.text}: a GraphQL write by ${prog}` } : null;
}
