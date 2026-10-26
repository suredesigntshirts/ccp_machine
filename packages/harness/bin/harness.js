#!/usr/bin/env node
// harness: drive a stored harness one event at a time. Every command reads and writes the store
// folder (--dir, default .harness), so each session wake runs a command and exits.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { openStore, init, apply, ack, status, renderPage, renderItemPage, itemHref, budgetEvents, logPrecedents, readDecisionLog, renderDecisionLog, ladder, writeDigest, doctor, cardFor, stalled, parseAfter, replay } from '../src/index.js';
const HELP = `harness <command> [options]

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
  digest [--day YYYY-MM-DD]      send DIGEST_DUE once per UTC day, write digests/<day>.md in the store
                                 and ack publishDigest; the host posts the text
  replay                         rebuild the harness from events.jsonl on a scratch copy and compare state
                                 and effects with the store; exits 1 on a difference
  doctor                         check the store (version gaps, unknown acks, effects pending over a day,
                                 a stale lock, a snapshot that will not restore); exits 1 on a problem
  card <effect-id> [--url U]     print request_decision arguments for a postDecisionCard effect; a tap on
                                 option i is PERSON_DECIDED {choice: choices[i]} to address, --id <card id>
  page [--html FILE] [--title T] [--standalone]
                                 render mission control (default .harness/mission-control.html) and
                                 one page per item beside it (items/<id>.html), linked from its row,
                                 and the decision log (decisions.html);
                                 publish those as the Artifact's supporting files

  --dir DIR                      store folder (default $HARNESS_DIR, else .harness); an orchestrator
                                 thread keeps it in the Library so the next thread can pick it up`;

const { values: o, positionals: [cmd, ...args] } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string', default: process.env.HARNESS_DIR ?? '.harness' },
    wip: { type: 'string' },
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
    now: { type: 'string' }
  }
});
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
      print(apply(store, JSON.parse(args[0]), { to: o.to, id: o.id }));
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
    case 'decisions':
      print(logPrecedents(store));
      break;
    case 'standin':
      if (!args[0]) throw new Error('standin needs a decision class, such as plan or accept');
      print(ladder(readDecisionLog(store), args[0]));
      break;
    case 'digest': {
      const { file, acked, text } = writeDigest(store, o.day ? { day: o.day } : {});
      console.log(text);
      console.error(`wrote ${file}, acked ${acked}`);
      break;
    }
    case 'replay': {
      const r = replay(store);
      print(r);
      if (!r.ok) process.exitCode = 1;
      break;
    }
    case 'doctor': {
      const report = doctor(store);
      print(report);
      if (!report.ok) process.exitCode = 1;
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
      writeFileSync(file, renderPage(st, { events, pending: store.pending(), title: o.title, standalone: o.standalone, itemLinks: true }));
      const records = { events, outbox: store.outbox(), acks: store.acks(), back: '../', sessions: readSessions(o.sessions) };
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
    default:
      console.log(HELP);
      if (cmd && cmd !== 'help') process.exitCode = 1;
  }
} catch (e) {
  console.error(`harness: ${e.message}`);
  process.exitCode = 1;
}
