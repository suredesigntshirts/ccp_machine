#!/usr/bin/env node
// orchestrator demo [dir]    run one item end to end in a local git sandbox, Claude (claude -p, Haiku) doing
//                            the build, the verification and the stand-in's decision; rerun on dir to resume
// orchestrator step <dir>    for a host that runs sessions itself (the Claude Code mod): read one input on
//                            stdin, carry the item as far as it goes alone, print what it now waits on
// orchestrator check <dir>   whether a session's claim ({ run, claim } on stdin) would be taken
// orchestrator wait <dir> <seq>  return once the journal grows past seq, or after 50 s
// orchestrator agents        the session kinds the actors need: { name, tools, claim }
// orchestrator status <dir>  replay an item's journal and show where it is
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSessions } from '../src/claude.js';
import { drive } from '../src/driver.js';
import { openItem } from '../src/item.js';
import { makeSandbox, sandboxActors } from '../src/sandbox.js';
import { check } from '../src/schema.js';

const ISSUE = {
  url: 'sandbox:issues/1',
  title: 'Add multiply to math.js',
  expect: ['math.js exports multiply(a, b), which returns a times b', 'math.test.js tests multiply, and node --test passes']
};
const INIT = { event: { type: 'xstate.init', input: { issue: ISSUE } }, source: 'person' };

const line = ({ entry, refused, ...input }) =>
  entry ? `${entry.at} #${entry.seq} ${entry.event.type}${entry.run ? ` (run ${entry.run})` : ''} from ${entry.source} -> ${entry.hash}` : `refused ${input.event?.type ?? input.run}: ${refused}`;
const print = (value) => console.log(JSON.stringify(value, null, 2));

/** An item in dir with its sandbox repo, made on first use. */
const sandboxItem = (dir) => {
  const repo = join(dir, 'repo');
  if (!existsSync(repo)) makeSandbox(repo);
  return { ...openItem(dir), actors: sandboxActors({ dir, repo }) };
};

const demo = async (dir = mkdtempSync(join(tmpdir(), 'orchestrator-demo-'))) => {
  const item = sandboxItem(dir);
  console.log(`item in ${dir}${item.host.journal.length ? `, resuming at #${item.host.journal.length}` : ''}`);
  const { send, settled } = drive({ ...item, sessions: claudeSessions({ model: process.env.MODEL ?? 'haiku' }), log: (x) => console.log(line(x)) });
  if (!item.host.snapshot) send(INIT);
  const snapshot = await settled;
  print({ state: snapshot.value, output: snapshot.output });
};

// Why an outside host's input about a run cannot be taken: the run is not in flight, or the claim is bad.
const refusal = (item, { run, claim }) => {
  const open = item.host.pending.find((p) => p.run === run);
  if (!open) return { refused: `run ${run} is not in flight` };
  const problems = claim === undefined ? [] : check(item.actors[open.actor].claim, claim);
  return problems.length ? { rejected: problems } : null;
};

const where = (host) => ({ state: host.snapshot?.value ?? null, done: host.done, seq: host.journal.length, ...(host.done ? { output: host.snapshot.output } : {}) });

// One step for an outside host. The input is { event, source } (the start, a timer, a GitHub event),
// { run, claim, source } (a session's claim) or { run, failed, source } (a session that ended without one).
// The output says where the item is and what it waits on: sessions to start, timers to set.
const step = async (dir, input) => {
  const item = sandboxItem(dir);
  const no = input?.run && refusal(item, input);
  if (no) return no;
  const waiting = [];
  const refused = [];
  const sessions = (job, { run }) => {
    if (run !== input?.run) return waiting.push({ run, ...job }), new Promise(() => {});
    return 'failed' in input ? Promise.reject(new Error(input.failed)) : Promise.resolve({ claim: input.claim, source: input.source });
  };
  const noTimers = { now: () => new Date().toISOString(), setTimeout: () => null, clearTimeout: () => {} };
  const driver = drive({ ...item, sessions, clock: noTimers, log: (x) => x.refused && refused.push(x.refused) });
  if (input?.event) driver.send(input);
  await Promise.race([driver.settled, driver.idle()]);
  const actorOf = (run) => item.host.pending.find((p) => p.run === run)?.actor;
  return {
    ...where(item.host),
    ...(refused.length ? { refused: refused.join('; ') } : {}),
    sessions: waiting.filter(({ run }) => actorOf(run)).map(({ run, prompt, cwd, tools, schema }) => ({ run, actor: actorOf(run), prompt, cwd, tools, schema })),
    timers: item.host.pending.filter((p) => p.type === 'timer')
  };
};

// Wait up to seconds for the journal to grow past seq: how a session watches an item without polling hard.
const wait = async (dir, seq, seconds = 50) => {
  for (const until = Date.now() + seconds * 1000; Date.now() < until; await new Promise((r) => setTimeout(r, 1000))) {
    const { host } = openItem(dir);
    if (host.journal.length > seq || host.done) return where(host);
  }
  return where(openItem(dir).host);
};

const stdin = () => JSON.parse(readFileSync(0, 'utf8').trim() || 'null');
const [command, dir, arg] = process.argv.slice(2);
if (command === 'demo') await demo(dir);
else if (command === 'step' && dir) print(await step(dir, stdin()));
else if (command === 'check' && dir) print(refusal(sandboxItem(dir), stdin()) ?? { ok: true });
else if (command === 'wait' && dir) print(await wait(dir, Number(arg ?? 0)));
else if (command === 'agents') print(Object.entries(sandboxActors({ dir: '', repo: '' })).filter(([, a]) => a.claim).map(([name, { tools, claim }]) => ({ name, tools, claim })));
else if (command === 'status' && dir) {
  const { host } = openItem(dir);
  print({ ...where(host), context: host.snapshot?.context, pending: host.pending });
} else {
  console.error('usage: orchestrator demo [dir] | step <dir> | check <dir> | wait <dir> <seq> | agents | status <dir>');
  process.exit(2);
}
process.exit(0);
