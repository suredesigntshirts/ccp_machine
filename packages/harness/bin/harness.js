#!/usr/bin/env node
// harness: drive a stored harness one event at a time. Every command reads and writes the store
// folder (--dir, default .harness), so each session wake runs a command and exits.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { eventsWhere, openStore, init, apply as applyEvent, ack, status, renderPage, renderItemPage, itemHref, budgetEvents, logPrecedents, readDecisionLog, renderDecisionLog, ladder, writeDigest, doctor, cardFor, stalled, parseAfter, replay, runScenarios, attention, attentionText, repair , writeRetro, retroDue, calibration, canaryRequest, canaryReport, intakeRows, readRows, pickAudit, auditCardFor, openAudits, verifyTaps, verifyTapsText, fromGithubText, verifyFacts, verifyFactsText, verifyActors, verifyActorsText, ledgerDir, writeHandoff, giveVerdict, mergeGate, acceptance, acceptanceText, standinAnswer, requestFromIssue, issueBody, renderLivePage, checklistFor } from '../src/index.js';
const HELP = `harness <command> [options]

  help, --help, -h               show this help

  init [--wip N]                 create a harness in --dir, with this session as its orchestrator
                                 (ORCHESTRATOR_STARTED; a session taking over an existing store sends it)
  send <event-json> [--to ADDR] [--id ID] [--actor KIND:ID] [--source KIND:REF]
                                 apply one event; ADDR is harness (default), a system id such as
                                 item:a or budget, or a child path such as item:a/decision:a:plan:1.
                                 --id makes the send idempotent. Prints the effects it queued. An event
                                 the machine would not take is refused: nothing is written, exit 1.
                                 An event whose guard checks who sent it needs --actor and --source:
                                 a worker's run (RUN_SUCCEEDED, RUN_FAILED), from the worker's own
                                 session, --actor session:$CLAUDE_CODE_SESSION_ID --source cli:<ref> (a
                                 subagent's, which the plugin's call record names, needs neither),
                                 a tap (PERSON_DECIDED, AUDIT_ANSWERED, PERSON_GRANTED, nothing else) --actor person:<id>
                                 --source tap:<the message id the card's ack recorded>, a grant in the
                                 person's words --actor person:<id> --source message:<their message id>,
                                 CI and merges come only from from-github (send refuses --actor github
                                 and --source github-wake). Any other event is sent as this
                                 session ($CLAUDE_CODE_SESSION_ID) from the cli; an --actor session:<id>
                                 that is not this session is refused. In a subagent's Bash call the plugin's
                                 hook sets HARNESS_AGENT and the actor is agent:<session_id>/<agent_id>; any
                                 --actor session or other agent is refused there, and --actor agent elsewhere.
                                 The hook also sets HARNESS_CALL=<tool_use_id>:<key>, its record of the
                                 call; an agent that record does not name, or a call without its key, is
                                 refused. A call the hook recorded under HARNESS_ENFORCE=1 marks the store
                                 enforced (enforced.json), and an enforced store takes writes only from
                                 recorded calls. Triage answers with
                                 {"type":"TRIAGED","tier":N,"criteria":[...]} --to item:<id>, from a session
                                 that is not the requester, the orchestrator or a worker; a reviewer who is
                                 neither sends {"type":"CRITERION_CHECKED","criterion":"...","verdict":
                                 "met|unmet|unclear","evidence":"..."} per criterion
  usage [--samples FILE]         feed saved usage samples (ledger usage, default .ledger/usage.json)
                                 to the budget actor, then tick
  stalled [--after 60m]          list in-flight items with no event for longer than --after, oldest first
  tick [--now ISO]               send the budget a TICK: the time and the cost filed since its last reading
  status                         print the summary as JSON
  effects                        print effects the host has not acknowledged
  ack <effect-id>... [--outcome done|failed] [--note TEXT] [--card CMSG]
                                 a posted card effect is acked alone and once with --card <its message id>,
                                 which records the card (CARD_POSTED; send refuses it)
  decisions                      ack the pending logPrecedent effects (they are the decision log already)
  standin <class>                the stand-in's autonomy for a decision class (shadow, recommend or act),
                                 worked out from the store's decided decisions; a decision takes it when it opens
  intake PATH                    file each new request-box row in PATH (an ArtifactData read of the mission
                                 control \`requests\` collection: its out_dir folder of <doc_id>.json files,
                                 its inline list text, or JSON) as REQUEST_RECEIVED req-<row id>,
                                 and print the row updates to write back (status taken, item, href)
  canary [--day D] [--check]     file the day's tier-0 canary item once (canary-<day>); with --check, report
                                 each stage's time and exit 1 with one attention line if it failed or is
                                 not merged 2 hours after the request
  acceptance [--ledger F] [--text]  the PRD's v1 acceptance criteria against this store: met, not met or
                                 unknown, each with its evidence (peak in flight, the person's touches by
                                 tier, scenarios, duplicate ids; --ledger checks turn costs)
  handoff                        write handoff.md in the store: items in flight with stage, PR and plan,
                                 cards waiting on the person, pending effects, budget, doctor, the host's
                                 own handoff-notes.md, and the next actions; run at the end of each wake
  audit                          today's (UTC) stand-in audit: up to 3 decisions the stand-in made alone, picked
                                 once a day (AUDIT_PICKED queues postAuditCard), decisions made under the
                                 person's grant first; prints its effect, its card and every grant decision
                                 since the last audit (granted), which the card lists too.
                                 The answer is a tap: AUDIT_ANSWERED {option: 0 all right, N reverse pick N}
  send '{"type":"GRANT_ASKED"}'  when the person asks to set what the stand-in may decide: opens a checklist
                                 card (postGrantCard; harness card prints it). The person's ticks are one tap,
                                 PERSON_GRANTED {picks} to grant:<n>; it replaces any earlier grant, and nothing
                                 else creates, widens or extends one (spec grant). The stand-in then decides
                                 alone the two-way doors the grant names, and one-way doors only with its box
  send '{"type":"PERSON_GRANTED","picks":[...]}' --actor person:<id> --source message:<cmsg id>
                                 the person's grant in their own words, from their chat message, sent to the
                                 harness by the session relaying it: picks as on the checklist, read from the
                                 words (kind:<class>..., one-way, at most one until:<ISO time>; none is no end
                                 time). "Stop asking" is every kind:<class> and one-way. It replaces any earlier
                                 grant; verify-taps lists it with its message id
  answer <item> --approve|--reject --reason TEXT --confidence N
                                 answer the item's pending stand-in question: send STAND_IN_ANSWERED to its
                                 decision (id standin-<subject>), ack the ask and log the precedent. Autonomy
                                 and threshold are the decision's; only the stand-in may answer, never the
                                 orchestrator or the item's worker; it decides an accept alone only when
                                 every criterion was checked met (expectationsMet), else the person does
  issue-request FILE             file one backlog issue (gh api repos/O/R/issues/N JSON) as REQUEST_RECEIVED,
                                 id req-issue<N>: item id from its "Item id: \`x\`" line, expect from the
                                 bullets under its "## Expect" heading (src/issue-request.js, the one
                                 format); no tier: triage sets it. Refuses an issue without the item line
  from-github FILE               turn each PR activity event in FILE, in order (wakes' <event source="github"> text, or
                                 {kind, data} JSON) into its item event: a finished check suite is
                                 CHECKS_PASSED, a failed check CHECKS_FAILED, a merged PR MERGED (acking
                                 the merge effect), a PR closed unmerged CANCEL; ids
                                 ci-<owner/repo#N>-<sha7>-passed|failed, merge-pr<N> and closed-pr<N> dedupe
                                 replays. Each CI result, merge or close is applied only if GitHub agrees, read with
                                 \`gh api\` (REST; gh by absolute path, /usr/local/bin/gh else \`command -v gh\`;
                                 GH_TOKEN and fetch without gh); the ref is the fact read. The PR must be
                                 the item's own: the item that named it first (an item's PR is bound once,
                                 one PR to one item), created at or after the item's request, on a branch
                                 <type>/[<issue>-]<item id>[--<agent>]; a CI result must name the full 40-character
                                 head sha. Otherwise it is refused with the reason, nothing written, exit 1
  verdict FILE --to item:<id> --pr PR --sha SHA
                                 the verifier's verdict (first line PASS or FAIL) posted verbatim as a COMMENT
                                 review on the PR at head SHA, ending with the item's verifier brief sha256, and
                                 the same verdict sent as VERDICT_GIVEN from this subagent; nothing is posted when
                                 the machine would refuse it (spec workItem, Workers)
  merge-gate --pr PR --sha SHA   may PR be merged at head SHA now: exits 0 when the PR is bound to an item whose
                                 machine would take MERGED of SHA and the PR carries the item's PASS verdict as a
                                 review on SHA, else 1 naming the rule; never writes (the plugin's merge gate asks it)
  verify-facts [--store DIR]     re-read GitHub for every github-wake event in the log, one line per fact:
                                 ok, mismatch (GitHub does not back it, or it is not the item's PR) or
                                 unreachable. Never writes to the store. Exits 1 on any mismatch, else 3
                                 when any could not be read; 2, writing nothing, when DIR has no events.jsonl. The check against a session that forged a
                                 fact: run it from outside that session
  verify-actors [--store DIR]    check every session actor in the log against the session ledgers the Stop
                                 hook files ($HARNESS_LIBRARY_DIR/ledger/sessions/<id>.json): one line per
                                 actor, ok, no ledger, or outside window (an event outside the ledger's
                                 start..end, give or take 5 minutes); every agent actor against the
                                 SubagentStart record (<session>/agents/<agent>.json): ok, no record, or
                                 outside window. Never writes. Exits 1 on any failure;
                                 2, writing nothing, when DIR has no events.jsonl. Run it after the sessions'
                                 turns have ended, so their ledgers are filed
  verify-taps [--store DIR]      one line per tap or message grant: event id, time, card or message id,
                                 where it went, the choice claimed, the person, the session that relayed it.
                                 Never writes; 2 without events.jsonl. Another session checks each line
                                 against its card or message (read_messages_by_id)
  calibration [class]            per decision class: agreement, reversals, confidence vs outcome (with the
                                 Brier score), time on each rung, and whether to trust the stand-in there
  retro [--day D] [--out DIR] [--due]
                                 review the last 7 days against the 7 before: better, worse, the top 3
                                 bottlenecks as issue drafts, and the last retro's expectations; writes
                                 <DIR>/<day>.md and .json (default the store's ../../reviews); --due exits 0
                                 when a retro is due (7 days or 20 merges since the last)
  digest [--day YYYY-MM-DD]      send DIGEST_DUE once per UTC day, write digests/<day>.md in the store
                                 and ack publishDigest; the host posts the text
  replay                         rebuild the harness from events.jsonl on a scratch copy and compare state
                                 and effects with the store; exits 1 on a difference. It re-applies github
                                 refs as logged without reading GitHub: verify-facts re-checks them
  doctor [--refreshes PATH]      check the store (version gaps, unknown acks, effects pending over a day,
                                 a stale lock, a snapshot that will not restore), verify-actors,
                                 verify-facts, and every merged PR of an item: the store's verifier PASS on
                                 its merge head and a PASS review on GitHub on that sha; exits 1 on a problem.
                                 GitHub unreachable or a ledger not filed for a session's event under 10
                                 minutes old is listed as unverifiable, exit 0.
                                 --refreshes: a page's refresh rows (ArtifactData out_dir or list text);
                                 each one slower than the spec's refreshSlowMs is a warning
  repair [--rebuild]             drop a torn last line of a log and clear a stale lock; --rebuild also
                                 rebuilds a state.json that is ahead of events.jsonl; exits 1 if any is left.
                                 It re-applies github refs as logged: verify-facts re-checks them
  scenarios [FILE...]            play golden event stories (default packages/harness/scenarios/*.json) on
                                 scratch stores and check each step; exits 1 on a failure
  card <effect-id> [--url U]     print request_decision arguments for a postDecisionCard or postAuditCard
                                 effect, or the checklist of a postGrantCard effect; post it, ack it with
                                 --card <cmsg id>; a tap on option i is PERSON_DECIDED {choice: choices[i]}
                                 (AUDIT_ANSWERED {option: i}) to address, the checklist's ticks one
                                 PERSON_GRANTED {picks: [ids]}
  page [--html FILE] [--title T] [--standalone] [--request-box]
                                 render mission control (default .harness/mission-control.html) and
                                 one page per item beside it (items/<id>.html), linked from its row,
                                 and the decision log (decisions.html);
                                 publish those as the Artifact's supporting files
  page --live [--project chan_...] [--files-path P] [--html FILE]
                                 render live mission control (default .harness/mission-control-live.html):
                                 only the fields pages/mission-control/needs.json declares from state.json,
                                 its age, and a Refresh button that rereads <P>/state.json through the
                                 Artifact files capability and times each refresh into db; publish with
                                 capabilities {files: {project}, db: {}}. A store outside the needs
                                 schemaVersion range shows a red banner and no data

  --actor KIND:ID, --source KIND:REF
                                 who sent the event (person, session, agent, github, timer) and where it came
                                 from (tap, message, cli, timer; github and github-wake only via from-github);
                                 the event log keeps both
  --dir DIR, --store DIR         store folder (default $HARNESS_DIR, else .harness); an orchestrator
                                 thread keeps it in the Library so the next thread can pick it up`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}
// A bad option or command is a usage error: one line and the usage, exit 2, no stack trace.
const usageError = (message) => {
  console.error(`harness: ${message}\n\n${HELP}`);
  process.exit(2);
};
let parsed;
try {
  parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: 'string', default: process.env.HARNESS_DIR ?? '.harness' },
      store: { type: 'string' },
      wip: { type: 'string' },
      ledger: { type: 'string' },
      text: { type: 'boolean' },
      to: { type: 'string' },
      id: { type: 'string' },
      outcome: { type: 'string', default: 'done' },
      note: { type: 'string' },
      card: { type: 'string' },
      samples: { type: 'string', default: '.ledger/usage.json' },
      html: { type: 'string' },
      title: { type: 'string', default: 'Mission control' },
      standalone: { type: 'boolean', default: false },
      day: { type: 'string' },
      url: { type: 'string' },
      after: { type: 'string', default: '60m' },
      sessions: { type: 'string' },
      rebuild: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      due: { type: 'boolean', default: false },
      'request-box': { type: 'boolean', default: false },
      live: { type: 'boolean', default: false },
      project: { type: 'string' },
      'files-path': { type: 'string' },
      refreshes: { type: 'string' },
      out: { type: 'string' },
      now: { type: 'string' },
      approve: { type: 'boolean', default: false },
      reject: { type: 'boolean', default: false },
      reason: { type: 'string' },
      confidence: { type: 'string' },
      actor: { type: 'string' },
      source: { type: 'string' },
      pr: { type: 'string' },
      sha: { type: 'string' }
    }
  });
} catch (e) {
  usageError(e.message);
}
const { values: o, positionals: [cmd, ...args] } = parsed;
if (o.store) o.dir = o.store;
// verify-facts, verify-actors and verify-taps only read: a folder without a log is a wrong --store to report, never a folder to make.
if (['verify-facts', 'verify-actors', 'verify-taps'].includes(cmd) && !existsSync(join(o.dir, 'events.jsonl'))) {
  console.error(`harness: ${cmd}: no events.jsonl in ${o.dir}, so nothing to verify (is --store the harness folder?)`);
  process.exit(2);
}
const store = openStore(o.dir);
// Every event goes through here: one the machine refuses is reported, and a batch goes on.
function apply(...args) { const r = applyEvent(...args); if (r.refused) console.error(`harness: ${r.why}`); return r; }
// The TICK carries the cost of the filed turns since the newest reading (spec/SPEC.md, budget).
const tick = (now) => {
  const since = status(store).budget?.sampledAt;
  const costSince = since
    ? Object.values(readSessions()).flatMap((s) => s.turns ?? []).filter((t) => t.start > since && t.start <= now).reduce((a, t) => a + (t.all?.cost ?? 0), 0)
    : undefined;
  return apply(store, { type: 'TICK', now, ...(costSince != null && { costSince }), ...timer(now) }, { to: 'budget', id: `tick-${now.slice(0, 16)}` });
};
// Filed session ledgers, by id, for the item pages' turns (missing folder: none).
const readSessions = (dir = ledgerDir()) => {
  try {
    return Object.fromEntries(
      readdirSync(dir)
        .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
        .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).session)
        .filter(Boolean)
        .map((sess) => [sess.sessionId, sess])
    );
  } catch {
    return {};
  }
};
const print = (x) => console.log(JSON.stringify(x, null, 2));
// Who sends from here: --actor and --source, else this session from the cli. Nothing here defaults to a
// person or a tap; an event whose guard checks the source (a tap, a GitHub wake) or the worker must name
// its sender with the flags. A session is the one the platform says this is: --actor session:<id> must be
// $CLAUDE_CODE_SESSION_ID when it is set (outside Claude Code there is none; verify-actors checks later).
const pair = (flag, a, b) => {
  const v = o[flag];
  if (v == null) return null;
  const i = v.indexOf(':');
  if (i < 1) usageError(`--${flag} is KIND:${b.toUpperCase()}, such as ${flag === 'actor' ? 'person:sd' : 'tap:cmsg_123'}`);
  return { [a]: v.slice(0, i), [b]: v.slice(i + 1) };
};
const flagged = { actor: pair('actor', 'kind', 'id'), source: pair('source', 'kind', 'ref') };
const platform = process.env.CLAUDE_CODE_SESSION_ID || null;
// A subagent's call: the plugin's PreToolUse hook sets HARNESS_AGENT=<agent_id>:<agent_type>, and the actor is
// agent <session_id>/<agent_id> (spec harness meta.actors). Without it, this is the session itself.
const handed = process.env.HARNESS_AGENT || null;
const [, agentId, agentType] = /^([A-Za-z0-9_-]+):(.+)$/.exec(handed ?? '') ?? [];
const self = handed ? { kind: 'agent', id: `${platform}/${agentId}`, type: agentType } : platform ? { kind: 'session', id: platform } : null;
// The call this runs in, as the plugin's PreToolUse hook recorded it and stamped it (HARNESS_CALL=<tool_use_id>:<key>,
// the record holding the key's sha256): the actor is believed only when that record names it, and only with the key
// the hook stamped, so an id the caller writes itself is refused (harness meta.invariants hookSawCall). A call the
// hook recorded under HARNESS_ENFORCE=1 marks its store enforced (enforced.json, naming the Library that holds the
// records); an enforced store takes a write only from a recorded call, whatever this process's environment says.
// HARNESS_ENFORCE itself is never read here: only the hook's own environment decides.
const [, callId, callKey] = /^([^:]*)(?::(.*))?$/.exec(process.env.HARNESS_CALL || '') ?? [];
const call = process.env.HARNESS_CALL ? callId : null;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const enforcedFile = join(o.dir, 'enforced.json');
const enforcedStore = (() => { try { return JSON.parse(readFileSync(enforcedFile, 'utf8')); } catch { return null; } })();
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const hookSawCall = () => {
  const locked = enforcedStore ? `store ${o.dir} is enforced (${enforcedFile}): it takes a write only from a call the plugin's PreToolUse hook recorded` : null;
  if (handed && !call) return `HARNESS_AGENT (${handed}) comes with no HARNESS_CALL: only the plugin's PreToolUse hook sets it, with its record of the call`;
  if (!call) return locked ? `${locked}, and this one carries no HARNESS_CALL` : null;
  if (!callKey) return `HARNESS_CALL ${call} carries no key: the plugin's PreToolUse hook stamps <tool_use_id>:<key> on the call it recorded${locked ? `; ${locked}` : ''}`;
  const sessions = enforcedStore?.libraryDir ? join(enforcedStore.libraryDir, 'ledger', 'sessions') : ledgerDir();
  const file = SAFE_ID.test(String(platform)) && SAFE_ID.test(call) ? join(sessions, platform, 'calls', `${call}.json`) : null;
  let record = null;
  try { record = file && JSON.parse(readFileSync(file, 'utf8')); } catch {}
  if (!record) return `HARNESS_CALL ${call} names no record of the plugin's PreToolUse hook for session ${platform}${file ? ` (${file})` : ''}${locked ? `; ${locked}` : ''}`;
  if (!record.keySha256 || sha256(callKey) !== record.keySha256) return `the key of HARNESS_CALL ${call} is not the one the plugin's hook stamped on that call`;
  if (record.sessionId !== platform || (record.agentId ?? null) !== (agentId ?? null))
    return `the plugin's record of call ${call} names ${record.agentId ? `agent ${record.sessionId}/${record.agentId}` : `session ${record.sessionId}`}, not ${agentId ? `agent ${platform}/${agentId}` : `session ${platform}`}`;
  if (record.enforced === true && !enforcedStore) // one way: only removing the file by hand undoes it
    writeFileSync(enforcedFile, JSON.stringify({ at: new Date().toISOString(), libraryDir: dirname(dirname(sessions)), session: platform, call }) + '\n');
  return null;
};
const by = (what) => {
  const unseen = hookSawCall();
  if (unseen) throw new Error(`${unseen}; nothing was written`);
  const actor = flagged.actor ? { ...flagged.actor, ...(flagged.actor.kind === 'agent' && self?.kind === 'agent' && { type: self.type }) } : self;
  if (!actor) throw new Error(`${what} needs --actor session:<id> outside a Claude Code session`);
  const source = flagged.source ?? { kind: 'cli', ref: `harness ${cmd}` };
  return { actor, source, relayedBy: ['tap', 'message'].includes(source.kind) ? platform : undefined }; // a tap or a message names the session relaying it
};
const timer = (ref) => ({ actor: { kind: 'timer', id: `harness ${cmd}` }, source: { kind: 'timer', ref } });
// Events a guard takes only from a named party: the worker, a tap or a GitHub wake.
const attested = eventsWhere((t) => t.guard?.type === 'reportedByOrchestrator' || t.guard?.params?.source);

try {
  // GitHub's word comes only through from-github, which reads it from GitHub; no flag can claim it.
  if (flagged.actor?.kind === 'github' || flagged.source?.kind === 'github-wake')
    throw new Error(`${cmd} refuses --actor github and --source github-wake: only harness from-github sends as GitHub, after reading the result from GitHub`);
  if (handed && !(platform && agentId))
    throw new Error(`HARNESS_AGENT=${handed} is not <agent_id>:<agent_type> under a CLAUDE_CODE_SESSION_ID: only the plugin's PreToolUse hook sets it, for a subagent; nothing was written`);
  if (flagged.actor?.kind === 'session' && handed)
    throw new Error(`--actor session:${flagged.actor.id} is refused for a subagent (agent ${self.id}): a subagent records only as itself, never as its parent or another session; nothing was written`);
  if (flagged.actor?.kind === 'person' && handed) // harness meta.invariants personNotFromAgent
    throw new Error(`--actor person:${flagged.actor.id} is refused for a subagent (agent ${self.id}): a subagent records only as itself, so it cannot relay the person's tap or message; nothing was written`);
  if (flagged.actor?.kind === 'agent' && handed && flagged.actor.id !== self.id)
    throw new Error(`--actor agent:${flagged.actor.id} is not this subagent (agent ${self.id}): a subagent cannot act as another; nothing was written`);
  if (flagged.actor?.kind === 'agent' && !handed && platform)
    throw new Error(`--actor agent:${flagged.actor.id} is refused: this is session ${platform}, not a subagent (the plugin's PreToolUse hook names a subagent); nothing was written`);
  if (flagged.actor?.kind === 'session' && platform && flagged.actor.id !== platform)
    throw new Error(`--actor session:${flagged.actor.id} is not this session (CLAUDE_CODE_SESSION_ID is ${platform}): a session's id comes from the platform, so one session cannot act as another; nothing was written`);
  switch (cmd) {
    case 'init': {
      const sender = by('init');
      const r = init(store, o.wip ? { wipLimit: Number(o.wip) } : {});
      const started = apply(store, { type: 'ORCHESTRATOR_STARTED', ...sender }, { id: `orchestrator-${sender.actor.id}` });
      print({ ...r, orchestrator: started.refused ? null : sender.actor.id });
      if (started.refused) process.exitCode = 1;
      break;
    }
    case 'send':
      if (!args[0]) throw new Error('send needs an event, such as \'{"type":"REQUEST_RECEIVED","request":{"id":"a"}}\'');
      {
        const event = JSON.parse(args[0]);
        if (event.type === 'CARD_POSTED')
          throw new Error('send refuses CARD_POSTED: a card is recorded only by harness ack <card effect> --card <cmsg id>, the ack of the card the machine asked for');
        // A subagent the plugin's call record names is already named: its run needs no flags (by() checks the record).
        if (attested.has(event.type) && !(flagged.actor && flagged.source) && !(handed && call))
          throw new Error(`${event.type} needs --actor KIND:ID --source KIND:REF naming who sent it (see harness help send)`);
        Object.assign(event, by('send'));
        const r = apply(store, event, { to: o.to, id: o.id });
        print(r);
        if (r.refused) process.exitCode = 1;
      }
      break;
    case 'usage': {
      const samples = JSON.parse(readFileSync(o.samples, 'utf8'));
      for (const e of budgetEvents(samples)) apply(store, { ...e.event, ...by('usage') }, { to: e.to, id: e.id });
      tick(new Date().toISOString());
      const st = status(store);
      print({ budget: st.budget, scheduler: st.state.scheduler });
      break;
    }
    case 'stalled':
      print(stalled(status(store), store.events(), { afterMs: parseAfter(o.after) }));
      break;
    case 'tick':
      tick(o.now ?? new Date().toISOString());
      print(status(store).budget);
      break;
    case 'status':
      print(status(store));
      break;
    case 'effects':
      print(store.pending());
      break;
    case 'ack':
      print(ack(store, args, { outcome: o.outcome, note: o.note, card: o.card, ...((flagged.actor || platform) && { by: by('ack') }) }));
      break;
    case 'answer':
      if (!args[0] || o.approve === o.reject) throw new Error('answer needs an item and one of --approve or --reject');
      print(
        standinAnswer(store, args[0], {
          choice: o.approve ? 'approve' : 'reject',
          reason: o.reason,
          confidence: o.confidence && Number(o.confidence),
          by: by('answer')
        })
      );
      break;
    case 'decisions':
      print(logPrecedents(store));
      break;
    case 'calibration':
      print(calibration(readDecisionLog(store), { decisionClass: args[0] }));
      break;
    case 'standin':
      if (!args[0]) throw new Error('standin needs a decision class, such as plan or accept');
      print(ladder(readDecisionLog(store), args[0]));
      break;
    case 'acceptance': {
      const rows = acceptance(store, { ledgerFile: o.ledger });
      if (o.text) console.log(acceptanceText(rows));
      else print(rows);
      break;
    }
    case 'handoff':
      print({ file: await writeHandoff(store) });
      break;
    case 'audit': {
      const a = pickAudit(store, { by: by('audit') });
      const open = openAudits(store).find((x) => x.address === a.address);
      print({ ...a, card: open ? { address: a.address, ...open.ask } : null });
      break;
    }
    case 'from-github': {
      if (!args[0]) throw new Error('from-github needs a file holding one PR activity event');
      const results = [await fromGithubText(store, readFileSync(args[0], 'utf8'))].flat();
      print(results.length === 1 ? results[0] : results);
      if (results.some((r) => r.result === 'refused')) process.exitCode = 1;
      break;
    }
    case 'verdict': {
      if (!args[0] || !o.to || !o.pr || !o.sha) throw new Error('verdict needs a file, --to item:<id>, --pr <the PR> and --sha <the head sha checked>');
      const r = await giveVerdict(store, { text: readFileSync(args[0], 'utf8'), to: o.to, pr: o.pr, sha: o.sha, by: by('verdict') });
      print(r);
      if (r.refused) process.exitCode = 1;
      break;
    }
    case 'merge-gate': {
      const r = await mergeGate(store, { pr: o.pr, sha: o.sha });
      print(r);
      if (!r.allow) process.exitCode = 1;
      break;
    }
    case 'verify-facts': {
      const results = await verifyFacts(store);
      if (results.length) console.log(verifyFactsText(results));
      const n = (k) => results.filter((r) => r.result === k).length;
      console.error(`harness: ${results.length} GitHub facts: ${n('ok')} ok, ${n('mismatch')} mismatch, ${n('unreachable')} unreachable`);
      process.exitCode = n('mismatch') ? 1 : n('unreachable') ? 3 : 0;
      break;
    }
    case 'verify-taps': {
      const rows = verifyTaps(store);
      if (rows.length) console.log(verifyTapsText(rows));
      console.error(`harness: ${rows.length} taps and message grants; a session other than the one that sent them checks each against its card or message (read_messages_by_id)`);
      break;
    }
    case 'verify-actors': {
      const results = verifyActors(store);
      if (results.length) console.log(verifyActorsText(results));
      const n = (k, kind) => results.filter((r) => r.result === k && r.kind === kind).length;
      const agents = results.filter((r) => r.kind === 'agent').length;
      console.error(`harness: ${results.length - agents} session actors: ${n('ok', 'session')} ok, ${n('no ledger', 'session')} no ledger, ${n('outside window', 'session')} outside window${agents ? `; ${agents} agent actors: ${n('ok', 'agent')} ok, ${n('no record', 'agent')} no record, ${n('outside window', 'agent')} outside window` : ''}`);
      process.exitCode = results.every((r) => r.result === 'ok') ? 0 : 1;
      break;
    }
    case 'issue-request': {
      if (!args[0]) throw new Error('issue-request needs a file holding one issue as GitHub JSON');
      const issue = JSON.parse(readFileSync(args[0], 'utf8'));
      const request = requestFromIssue(issue);
      const r = apply(store, { type: 'REQUEST_RECEIVED', request, ...by('issue-request') }, { id: `req-issue${issue.number}` });
      print({ request, duplicate: r.duplicate, refused: r.why, effects: r.effects.map((e) => e.name) });
      break;
    }
    case 'intake': {
      if (!args[0]) throw new Error('intake needs a file or folder holding the requests rows');
      print(intakeRows(store, readRows(args[0]), { by: by('intake') }));
      break;
    }
    case 'canary': {
      const day = o.day ?? new Date().toISOString().slice(0, 10);
      if (!o.check) {
        const r = apply(store, { ...canaryRequest(day), ...by('canary') }, { id: `req-canary-${day}` });
        print({ item: `canary-${day}`, filed: !r.duplicate && !r.refused, effects: r.effects.map((e) => e.name) });
        break;
      }
      const report = canaryReport(store.events(), day);
      print(report);
      if (['failed', 'late'].includes(report.status)) {
        console.error(`attention: ${report.line}`);
        process.exitCode = 1;
      }
      break;
    }
    case 'retro': {
      const dir = o.out ?? join(o.dir, '..', '..', 'reviews');
      if (o.due) {
        const d = retroDue(store, dir, o.day);
        print(d);
        if (!d.due) process.exitCode = 1;
        break;
      }
      const { file, record, text } = writeRetro(store, dir, o.day ? { day: o.day } : {});
      console.log(text);
      console.error(`wrote ${file}; file each bottleneck as a harness-backlog issue`);
      print(record.bottlenecks.map(({ title, expected, wait }) => ({ title, expected, body: issueBody({ id: `cut-${String(wait).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-wait`, why: `${title}: from the retro.`, expect: [expected] }) })));
      break;
    }
    case 'digest': {
      const { file, acked, text } = writeDigest(store, o.day ? { day: o.day } : {});
      console.log(text);
      console.error(`wrote ${file}, acked ${acked}`);
      break;
    }
    case 'replay': {
      const { rebuilt, ...r } = replay(store);
      print(r);
      if (!r.ok) process.exitCode = 1;
      break;
    }
    case 'repair': {
      const r = repair(store, { rebuild: o.rebuild });
      print(r);
      if (r.left.length) process.exitCode = 1;
      break;
    }
    case 'doctor': {
      const report = await doctor(store, o.refreshes ? { refreshes: readRows(o.refreshes) } : {});
      print(report);
      if (!report.ok) process.exitCode = 1;
      break;
    }
    case 'scenarios': {
      const results = runScenarios(...(args.length ? [args] : []));
      for (const r of results) {
        console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name} (${r.steps} steps)`);
        for (const f of r.failures) console.log(`     step ${f.step}: ${f.key} expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`);
      }
      if (results.some((r) => !r.ok)) process.exitCode = 1;
      break;
    }
    case 'card': {
      const effect = store.outbox().find((e) => e.id === args[0]);
      if (!effect) throw new Error(`no effect ${args[0]}`);
      print(effect.name === 'postAuditCard' ? auditCardFor(store, effect) : effect.name === 'postGrantCard' ? checklistFor(effect) : cardFor(effect, { itemUrl: o.url }));
      break;
    }
    case 'page': {
      if (o.live) {
        // The live page: the store's state.json, only the fields pages/<page>/needs.json declares, and a refresh button.
        const state = store.read();
        if (!state) throw new Error(`no harness in ${o.dir}`);
        const file = o.html ?? `${o.dir}/mission-control-live.html`;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, renderLivePage(state, { project: o.project, path: o['files-path'] ?? '', standalone: o.standalone, ...(o.title !== 'Mission control' && { title: o.title }) }));
        print({ page: file, capabilities: { files: { project: o.project ?? '<project id>' }, db: {} }, reads: `${o['files-path'] ? `${o['files-path'].replace(/\/+$/, '')}/` : ''}state.json` });
        break;
      }
      const st = status(store);
      if (!st) throw new Error(`no harness in ${o.dir}`);
      const file = o.html ?? `${o.dir}/mission-control.html`;
      mkdirSync(dirname(file), { recursive: true });
      const events = store.events();
      const decisions = readDecisionLog(store);
      const records = { events, outbox: store.outbox(), acks: store.acks(), back: '../', sessions: readSessions(o.sessions), decisions };
      const metrics = Object.fromEntries(st.items.map((i) => [i.id, attentionText(attention(i, records))]));
      writeFileSync(file, renderPage(st, { events, pending: store.pending(), title: o.title, standalone: o.standalone, itemLinks: true, metrics, requestBox: o['request-box'], audits: openAudits(store) }));
      const items = st.items.map((item) => {
        const path = join(dirname(file), itemHref(item.id));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, renderItemPage(item, records));
        return itemHref(item.id);
      });
      writeFileSync(join(dirname(file), 'decisions.html'), renderDecisionLog(decisions, { back: './' }));
      print({ page: file, files: [...items, 'decisions.html'] });
      break;
    }
    case undefined:
    case 'help':
      console.log(HELP);
      break;
    default:
      usageError(`unknown command "${cmd}"`);
  }
} catch (e) {
  console.error(`harness: ${e.message}`);
  process.exitCode = 1;
}
