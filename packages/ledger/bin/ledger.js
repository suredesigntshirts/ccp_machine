#!/usr/bin/env node
// ledger: turn-level audit of Claude Code sessions. Run `ledger help`.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { buildLedger, findTranscripts, samplesFromText, mergeSamples, budgetStatus, renderReport, sessionsFromEvents } from '../src/index.js';

const HELP = `ledger <command> [options]

  build [transcript.jsonl ...]   Build a ledger from session transcripts (default: every session under
                                 ~/.claude/projects). Writes --out (default .ledger/ledger.json).
  events <file ...>              Add sessions from saved list_events output (result events) to --out's
                                 ledger: for sessions whose transcripts are not in this container.
  collect [dir ...]              Merge the session files the harness plugin files in the Library
                                 (default /mnt/project-files/harness/ledger/sessions) into --out
  usage <file ...>               Add usage-window samples from saved rate_limit_event JSON (list_events
                                 output, JSON or JSONL) to --samples (default .ledger/usage.json), then
                                 print today's budget status.
  budget                         Print today's budget status from --samples.
  report                         Render --out's ledger and --samples' budget as HTML to --html
                                 (default .ledger/report.html). --standalone writes a full document.
  turns [transcript.jsonl ...]   Print one line per turn: index, start, duration, cost, label.

Options: --out <path> --samples <path> --html <path> --title <text> --standalone
         --daily-share 0.1 --soft-at 0.8 --five-hour-stop 0.95 --utc-offset <minutes>`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: '.ledger/ledger.json' },
    samples: { type: 'string', default: '.ledger/usage.json' },
    html: { type: 'string', default: '.ledger/report.html' },
    title: { type: 'string' },
    standalone: { type: 'boolean', default: false },
    'daily-share': { type: 'string' },
    'soft-at': { type: 'string' },
    'five-hour-stop': { type: 'string' },
    'utc-offset': { type: 'string' }
  }
});
const [cmd = 'help', ...args] = positionals;
const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
};
const readJson = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);
const budgetConfig = () =>
  Object.fromEntries(
    [
      ['dailyShare', o['daily-share']],
      ['softAt', o['soft-at']],
      ['fiveHourStopAt', o['five-hour-stop']],
      ['utcOffsetMinutes', o['utc-offset']]
    ]
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, Number(v)])
  );
const transcripts = () => (args.length ? args : findTranscripts(join(homedir(), '.claude', 'projects')));

switch (cmd) {
  case 'build': {
    const ledger = buildLedger(transcripts());
    write(o.out, JSON.stringify(ledger, null, 1));
    const turns = ledger.sessions.reduce((a, s) => a + s.turns.length, 0);
    const cost = ledger.sessions.reduce((a, s) => a + s.totals.cost, 0);
    console.log(`${ledger.sessions.length} sessions, ${turns} turns, $${cost.toFixed(2)} at list price -> ${o.out}`);
    break;
  }
  case 'events': {
    const ledger = readJson(o.out, { generatedAt: new Date().toISOString(), version: 1, sessions: [], usage: [] });
    const added = sessionsFromEvents(args.map((f) => readFileSync(f, 'utf8')));
    const ids = new Set(added.map((s) => s.sessionId));
    ledger.sessions = [...ledger.sessions.filter((s) => !ids.has(s.sessionId)), ...added];
    write(o.out, JSON.stringify(ledger, null, 1));
    console.log(`${added.length} sessions from events (${added.reduce((a, s) => a + s.turns.length, 0)} turns) -> ${o.out}`);
    break;
  }
  case 'collect': {
    // Session files the harness plugin's Stop hook files in the Library, one per session.
    const ledger = readJson(o.out, { generatedAt: new Date().toISOString(), version: 1, sessions: [], usage: [] });
    const dirs = args.length ? args : ['/mnt/project-files/harness/ledger/sessions'];
    const added = dirs.flatMap((d) =>
      readdirSync(d)
        .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
        .map((f) => readJson(join(d, f), null)?.session)
        .filter(Boolean)
    );
    const ids = new Set(added.map((s) => s.sessionId));
    ledger.sessions = [...ledger.sessions.filter((s) => !ids.has(s.sessionId)), ...added];
    write(o.out, JSON.stringify(ledger, null, 1));
    console.log(`${added.length} filed sessions merged -> ${o.out}`);
    break;
  }
  case 'usage': {
    const added = args.flatMap((f) => samplesFromText(readFileSync(f, 'utf8')));
    const samples = mergeSamples(readJson(o.samples, []), added);
    write(o.samples, JSON.stringify(samples, null, 1));
    console.log(`${added.length} samples read, ${samples.length} kept in ${o.samples}`);
    console.log(JSON.stringify(budgetStatus(samples, budgetConfig()), null, 2));
    break;
  }
  case 'budget':
    console.log(JSON.stringify(budgetStatus(readJson(o.samples, []), budgetConfig()), null, 2));
    break;
  case 'report': {
    const ledger = readJson(o.out, null);
    if (!ledger) {
      console.error(`No ledger at ${o.out}; run \`ledger build\` first.`);
      process.exit(1);
    }
    const samples = readJson(o.samples, []);
    const html = renderReport(ledger, {
      title: o.title,
      standalone: o.standalone,
      budget: samples.length ? budgetStatus(samples, budgetConfig()) : undefined
    });
    write(o.html, html);
    console.log(`report -> ${o.html}`);
    break;
  }
  case 'turns': {
    for (const s of buildLedger(transcripts()).sessions)
      for (const t of s.turns)
        console.log(
          [s.sessionId.slice(0, 8), `#${t.index}`, t.start, `${Math.round(t.durationMs / 1000)}s`, `$${t.all.cost.toFixed(2)}`, t.label].join('\t')
        );
    break;
  }
  default:
    console.log(HELP);
}
