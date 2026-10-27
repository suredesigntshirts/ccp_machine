#!/usr/bin/env node
// harness: drive a stored harness one event at a time. Every command reads and writes the store
// folder (--dir, default .harness), so each session wake runs a command and exits.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { specs, openStore, init, apply as applyEvent, ack, status, renderPage, renderItemPage, itemHref, budgetEvents, logPrecedents, readDecisionLog, renderDecisionLog, ladder, writeDigest, doctor, cardFor, stalled, parseAfter, replay, runScenarios, attention, attentionText, repair , writeRetro, retroDue, calibration, canaryRequest, canaryReport, intakeRows, readRows, dayAudit, answerAudit, auditCard, openAudits, fromGithubText, verifyFacts, verifyFactsText, verifyActors, verifyActorsText, ledgerDir, writeHandoff, acceptance, acceptanceText, standinAnswer, requestFromIssue, issueBody } from '../src/index.js';
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
                                 session, --actor session:$CLAUDE_CODE_SESSION_ID --source cli:<ref>,
                                 a tap (PERSON_DECIDED) --actor person:<id> --source tap:<card message id>,
                                 CI and merges come only from from-github (send refuses --actor github
                                 and --source github-wake). Any other event is sent as this
                                 session ($CLAUDE_CODE_SESSION_ID) from the cli; an --actor session:<id>
                                 that is not this session is refused. Triage answers with
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
  ack <effect-id>... [--outcome done|failed] [--note TEXT]
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
  audit [--day D] [--answer N]   the day's stand-in audit: up to 3 decisions the stand-in made alone, picked
                                 once a day (audits/<day>.json); prints request_decision arguments for one
                                 card. --answer records the tap: 0 confirms all, N reverses pick N
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
  verify-facts [--store DIR]     re-read GitHub for every github-wake event in the log, one line per fact:
                                 ok, mismatch (GitHub does not back it, or it is not the item's PR) or
                                 unreachable. Never writes to the store. Exits 1 on any mismatch, else 3
                                 when any could not be read; 2, writing nothing, when DIR has no events.jsonl. The check against a session that forged a
                                 fact: run it from outside that session
  verify-actors [--store DIR]    check every session actor in the log against the session ledgers the Stop
                                 hook files ($HARNESS_LIBRARY_DIR/ledger/sessions/<id>.json): one line per
                                 actor, ok, no ledger, or outside window (an event outside the ledger's
                                 start..end, give or take 5 minutes). Never writes. Exits 1 on any failure;
                                 2, writing nothing, when DIR has no events.jsonl. Run it after the sessions'
                                 turns have ended, so their ledgers are filed
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
  doctor                         check the store (version gaps, unknown acks, effects pending over a day,
                                 a stale lock, a snapshot that will not restore); exits 1 on a problem
  repair [--rebuild]             drop a torn last line of a log and clear a stale lock; --rebuild also
                                 rebuilds a state.json that is ahead of events.jsonl; exits 1 if any is left.
                                 It re-applies github refs as logged: verify-facts re-checks them
  scenarios [FILE...]            play golden event stories (default packages/harness/scenarios/*.json) on
                                 scratch stores and check each step; exits 1 on a failure
  card <effect-id> [--url U]     print request_decision arguments for a postDecisionCard effect; a tap on
                                 option i is PERSON_DECIDED {choice: choices[i]} to address,
                                 --actor person:<id> --source tap:<card message id>
  page [--html FILE] [--title T] [--standalone] [--request-box]
                                 render mission control (default .harness/mission-control.html) and
                                 one page per item beside it (items/<id>.html), linked from its row,
                                 and the decision log (decisions.html);
                                 publish those as the Artifact's supporting files

  --actor KIND:ID, --source KIND:REF
                                 who sent the event (person, session, github, timer) and where it came
                                 from (tap, cli, timer; github and github-wake only via from-github);
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
      answer: { type: 'string' },
      due: { type: 'boolean', default: false },
      'request-box': { type: 'boolean', default: false },
      out: { type: 'string' },
      now: { type: 'string' },
      approve: { type: 'boolean', default: false },
      reject: { type: 'boolean', default: false },
      reason: { type: 'string' },
      confidence: { type: 'string' },
      actor: { type: 'string' },
      source: { type: 'string' }
    }
  });
} catch (e) {
  usageError(e.message);
}
const { values: o, positionals: [cmd, ...args] } = parsed;
if (o.store) o.dir = o.store;
// verify-facts and verify-actors only read: a folder without a log is a wrong --store to report, never a folder to make.
if (['verify-facts', 'verify-actors'].includes(cmd) && !existsSync(join(o.dir, 'events.jsonl'))) {
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
const by = (what) => {
  const actor = flagged.actor ?? (platform ? { kind: 'session', id: platform } : null);
  if (!actor) throw new Error(`${what} needs --actor session:<id> outside a Claude Code session`);
  return { actor, source: flagged.source ?? { kind: 'cli', ref: `harness ${cmd}` } };
};
const timer = (ref) => ({ actor: { kind: 'timer', id: `harness ${cmd}` }, source: { kind: 'timer', ref } });
// Events a guard takes only from a named party: the worker, a tap or a GitHub wake.
const attested = new Set();
const walk = (node) => {
  for (const [ev, on] of Object.entries(node.on ?? {}))
    if ([on].flat().some((t) => t.guard?.type === 'reportedByOrchestrator' || t.guard?.params?.source)) attested.add(ev);
  Object.values(node.states ?? {}).forEach(walk);
};
Object.values(specs).forEach(walk);

try {
  // GitHub's word comes only through from-github, which reads it from GitHub; no flag can claim it.
  if (flagged.actor?.kind === 'github' || flagged.source?.kind === 'github-wake')
    throw new Error(`${cmd} refuses --actor github and --source github-wake: only harness from-github sends as GitHub, after reading the result from GitHub`);
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
        if (attested.has(event.type) && !(flagged.actor && flagged.source))
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
      print(ack(store, args, { outcome: o.outcome, note: o.note }));
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
      print({ file: writeHandoff(store) });
      break;
    case 'audit': {
      const day = o.day ?? new Date().toISOString().slice(0, 10);
      if (o.answer != null) {
        print(answerAudit(store, day, Number(o.answer)));
        break;
      }
      const a = dayAudit(store, day);
      print({ day, picks: a.picks.map((r) => r.effectId), answered: a.answered, card: a.picks.length && !a.answered ? auditCard(a.picks) : null });
      break;
    }
    case 'from-github': {
      if (!args[0]) throw new Error('from-github needs a file holding one PR activity event');
      const results = [await fromGithubText(store, readFileSync(args[0], 'utf8'))].flat();
      print(results.length === 1 ? results[0] : results);
      if (results.some((r) => r.result === 'refused')) process.exitCode = 1;
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
    case 'verify-actors': {
      const results = verifyActors(store);
      if (results.length) console.log(verifyActorsText(results));
      const n = (k) => results.filter((r) => r.result === k).length;
      console.error(`harness: ${results.length} session actors: ${n('ok')} ok, ${n('no ledger')} no ledger, ${n('outside window')} outside window`);
      process.exitCode = results.length === n('ok') ? 0 : 1;
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
      const report = doctor(store);
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
      print(cardFor(effect, { itemUrl: o.url }));
      break;
    }
    case 'page': {
      const st = status(store);
      if (!st) throw new Error(`no harness in ${o.dir}`);
      const file = o.html ?? `${o.dir}/mission-control.html`;
      mkdirSync(dirname(file), { recursive: true });
      const events = store.events();
      const records = { events, outbox: store.outbox(), acks: store.acks(), back: '../', sessions: readSessions(o.sessions), decisions: readDecisionLog(store) };
      const metrics = Object.fromEntries(st.items.map((i) => [i.id, attentionText(attention(i, records))]));
      writeFileSync(file, renderPage(st, { events, pending: store.pending(), title: o.title, standalone: o.standalone, itemLinks: true, metrics, requestBox: o['request-box'], audits: openAudits(store) }));
      const items = st.items.map((item) => {
        const path = join(dirname(file), itemHref(item.id));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, renderItemPage(item, records));
        return itemHref(item.id);
      });
      writeFileSync(join(dirname(file), 'decisions.html'), renderDecisionLog(readDecisionLog(store), { back: './' }));
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
