#!/usr/bin/env node
// harness: drive a stored harness one event at a time. Every command reads and writes the store
// folder (--dir, default .harness), so each session wake runs a command and exits.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { openStore, init, apply, ack, status, renderPage, renderItemPage, itemHref, budgetEvents, logPrecedents, readDecisionLog, renderDecisionLog, ladder, writeDigest, doctor, cardFor, stalled, parseAfter, replay, runScenarios, attention, attentionText, repair , writeRetro, retroDue, calibration, canaryRequest, canaryReport, intakeRows, readRows, dayAudit, answerAudit, auditCard, fromGithub, readCheck, initCheck, checkVerdict, acceptBlocked, requestOf, writeHandoff, acceptance, acceptanceText, standinAnswer } from '../src/index.js';
const HELP = `harness <command> [options]

  help, --help, -h               show this help

  init [--wip N]                 create a harness in --dir
  send <event-json> [--to ADDR] [--id ID]
                                 apply one event; ADDR is harness (default), a system id such as
                                 item:a or budget, or a child path such as item:a/decision:a:plan:1.
                                 --id makes the send idempotent. Prints the effects it queued.
  usage [--samples FILE]         feed saved usage samples (ledger usage, default .ledger/usage.json)
                                 to the budget actor; a stop or soft limit reaches the scheduler
  stalled [--after 60m]          list in-flight items with no event for longer than --after, oldest first
  tick [--now ISO]               tell the budget the time, so a reading older than 2 hours drains it
  status                         print the summary as JSON
  effects                        print effects the host has not acknowledged
  ack <effect-id>... [--outcome done|failed] [--note TEXT]
  decisions                      append logPrecedent effects to decisions.jsonl in the store and ack them
  standin <class>                the stand-in's autonomy for a decision class (shadow, recommend or act),
                                 worked out from decisions.jsonl; use it as STAND_IN_ANSWERED's autonomy
  intake PATH                    file each new request-box row in PATH (an ArtifactData read of the mission
                                 control \`requests\` collection: its out_dir folder of <doc_id>.json files,
                                 its inline list text, or JSON) as REQUEST_RECEIVED req-<row id>,
                                 and print the row updates to write back (status taken, item, href)
  canary [--day D] [--check]     file the day's tier-0 canary item once (canary-<day>); with --check, report
                                 each stage's time and exit 1 with one attention line if it failed or is
                                 not merged 2 hours after the request
  check <item> [--init]          the expectation check: --init writes checks/<item>.md from the request's
                                 expect, one line each; mark each [met], [unmet] or [unclear] with
                                 evidence. Prints the verdict; exits 1 unless every line is met. send
                                 refuses a stand-in approve on an accept gate until it is
  acceptance [--ledger F] [--text]  the PRD's v1 acceptance criteria against this store: met, not met or
                                 unknown, each with its evidence (peak in flight, the person's touches by
                                 tier, scenarios, duplicate ids; --ledger checks turn costs)
  handoff                        write handoff.md in the store: items in flight with stage, PR and plan,
                                 cards waiting on the person, pending effects, budget, doctor, the host's
                                 own handoff-notes.md, and the next actions; run at the end of each wake
  audit [--day D] [--answer N]   the day's stand-in audit: up to 3 decisions the stand-in made alone, picked
                                 once a day (audits/<day>.json); prints request_decision arguments for one
                                 card. --answer records the tap: 0 confirms all, N reverses pick N
  answer <item> --approve|--reject --reason TEXT [--confidence N] [--autonomy A]
                                 answer the item's pending stand-in question: send STAND_IN_ANSWERED to its
                                 decision (id standin-<subject>), ack the ask and log the precedent. The
                                 autonomy comes from the ladder unless --autonomy (only for standing
                                 authority quoted in --reason); an accept approve still needs a met check
  from-github FILE               turn one PR activity event (a wake's <event source="github"> text, or
                                 {kind, data} JSON) into its item event: a finished check suite is
                                 CHECKS_PASSED, a failed check CHECKS_FAILED, a merged PR MERGED (acking
                                 the merge effect); ids ci-<sha7> and merge-pr<N> dedupe replays
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
                                 and effects with the store; exits 1 on a difference
  doctor                         check the store (version gaps, unknown acks, effects pending over a day,
                                 a stale lock, a snapshot that will not restore); exits 1 on a problem
  repair [--rebuild]             drop a torn last line of a log and clear a stale lock; --rebuild also
                                 rebuilds a state.json that is ahead of events.jsonl; exits 1 if any is left
  scenarios [FILE...]            play golden event stories (default packages/harness/scenarios/*.json) on
                                 scratch stores and check each step; exits 1 on a failure
  card <effect-id> [--url U]     print request_decision arguments for a postDecisionCard effect; a tap on
                                 option i is PERSON_DECIDED {choice: choices[i]} to address, --id <card id>
  page [--html FILE] [--title T] [--standalone] [--request-box]
                                 render mission control (default .harness/mission-control.html) and
                                 one page per item beside it (items/<id>.html), linked from its row,
                                 and the decision log (decisions.html);
                                 publish those as the Artifact's supporting files

  --dir DIR                      store folder (default $HARNESS_DIR, else .harness); an orchestrator
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
      init: { type: 'boolean', default: false },
      answer: { type: 'string' },
      due: { type: 'boolean', default: false },
      'request-box': { type: 'boolean', default: false },
      out: { type: 'string' },
      now: { type: 'string' },
      approve: { type: 'boolean', default: false },
      reject: { type: 'boolean', default: false },
      reason: { type: 'string' },
      confidence: { type: 'string' },
      autonomy: { type: 'string' }
    }
  });
} catch (e) {
  usageError(e.message);
}
const { values: o, positionals: [cmd, ...args] } = parsed;
const store = openStore(o.dir);
const tick = (now) => apply(store, { type: 'TICK', now }, { to: 'budget', id: `tick-${now.slice(0, 16)}` });
// Filed session ledgers, by id, for the item pages' turns (missing folder: none).
const readSessions = (dir = '/mnt/project-files/harness/ledger/sessions') => {
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

try {
  switch (cmd) {
    case 'init':
      print(init(store, o.wip ? { wipLimit: Number(o.wip) } : {}));
      break;
    case 'send':
      if (!args[0]) throw new Error('send needs an event, such as \'{"type":"REQUEST_RECEIVED","request":{"id":"a"}}\'');
      {
        const event = JSON.parse(args[0]);
        const blocked = acceptBlocked(store, event, o.to);
        if (blocked) throw new Error(blocked);
        print(apply(store, event, { to: o.to, id: o.id }));
      }
      break;
    case 'usage': {
      const samples = JSON.parse(readFileSync(o.samples, 'utf8'));
      for (const e of budgetEvents(samples)) apply(store, e.event, { to: e.to, id: e.id });
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
          ...(o.confidence && { confidence: Number(o.confidence) }),
          ...(o.autonomy && { autonomy: o.autonomy })
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
    case 'check': {
      const id = args[0];
      if (!id) throw new Error('check needs an item id');
      if (o.init) {
        const expect = requestOf(store, id)?.expect;
        if (!expect) throw new Error(`${id} has no expect line in its request`);
        print(initCheck(store, id, expect));
        break;
      }
      const lines = readCheck(store, id);
      if (!lines) throw new Error(`no check for ${id}; run harness check ${id} --init`);
      const v = checkVerdict(lines);
      print({ ...v, lines });
      if (!v.allMet) process.exitCode = 1;
      break;
    }
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
      print(fromGithub(store, readFileSync(args[0], 'utf8')));
      break;
    }
    case 'intake': {
      if (!args[0]) throw new Error('intake needs a file or folder holding the requests rows');
      print(intakeRows(store, readRows(args[0])));
      break;
    }
    case 'canary': {
      const day = o.day ?? new Date().toISOString().slice(0, 10);
      if (!o.check) {
        const r = apply(store, canaryRequest(day), { id: `req-canary-${day}` });
        print({ item: `canary-${day}`, filed: !r.duplicate, effects: r.effects.map((e) => e.name) });
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
      print(record.bottlenecks.map(({ title, expected }) => ({ title, expected })));
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
      const records = { events, outbox: store.outbox(), acks: store.acks(), back: '../', sessions: readSessions(o.sessions), decisions: readDecisionLog(store), checks: Object.fromEntries(status(store).items.map((i) => [i.id, readCheck(store, i.id)]).filter(([, c]) => c)) };
      const metrics = Object.fromEntries(st.items.map((i) => [i.id, attentionText(attention(i, records))]));
      writeFileSync(file, renderPage(st, { events, pending: store.pending(), title: o.title, standalone: o.standalone, itemLinks: true, metrics, requestBox: o['request-box'] }));
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
