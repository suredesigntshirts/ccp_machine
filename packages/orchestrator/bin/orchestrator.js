#!/usr/bin/env node
// orchestrator demo [dir]        run one item end to end in a local git sandbox, with claude -p (Haiku) doing
//                                the build, the verification and the stand-in's decision; rerun to resume
// orchestrator step <dir>        one step for a host that runs the sessions itself (src/step.js); input on stdin
// orchestrator check <dir>       whether a session's claim ({ run, claim } on stdin) would be taken
// orchestrator wait <dir> <seq>  where the item is, once its journal grows past seq or after 50 s
// orchestrator agents            the session kinds the actors need: { name, tools, claim }
// orchestrator status <dir>      where the item is, its context and what is pending
// orchestrator page [dir]        an HTML page of the machine's states and data, and the item's run if dir is given
// orchestrator inspect [dir]     an HTML page that draws the machine as a graph and plays the item's run over it
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSessions } from '../src/claude.js';
import { drive } from '../src/driver.js';
import { openSandboxItem, sandboxActors } from '../src/sandbox.js';
import { refusal, step, wait, where } from '../src/step.js';
import { itemSpec, openItem } from '../src/item.js';
import { itemPage } from '../src/page.js';
import { itemInspector } from '../src/inspector.js';

const ISSUE = {
  url: 'sandbox:issues/1',
  title: 'Add multiply to math.js',
  expect: ['math.js exports multiply(a, b), which returns a times b', 'math.test.js tests multiply, and node --test passes']
};

const print = (value) => console.log(JSON.stringify(value, null, 2));
const stdin = () => JSON.parse(readFileSync(0, 'utf8').trim() || 'null');
const line = ({ entry, refused, ...input }) =>
  entry ? `${entry.at} #${entry.seq} ${entry.event.type}${entry.run ? ` (run ${entry.run})` : ''} from ${entry.source} -> ${entry.hash}` : `refused ${input.event?.type ?? input.run}: ${refused}`;

const demo = async (dir = mkdtempSync(join(tmpdir(), 'orchestrator-demo-'))) => {
  const item = openSandboxItem(dir);
  console.log(`item in ${dir}${item.host.journal.length ? `, resuming at #${item.host.journal.length}` : ''}`);
  const { send, settled } = drive({ ...item, sessions: claudeSessions({ model: process.env.MODEL ?? 'haiku' }), log: (x) => console.log(line(x)) });
  if (!item.host.snapshot) send({ event: { type: 'xstate.init', input: { issue: ISSUE } }, source: 'person' });
  await settled;
  print(where(item.host));
};

const [command, dir, seq] = process.argv.slice(2);
if (command === 'demo') await demo(dir);
else if (command === 'step' && dir) print(await step(openSandboxItem(dir), stdin()));
else if (command === 'check' && dir) print(refusal(openSandboxItem(dir), stdin()) ?? { ok: true });
else if (command === 'wait' && dir) print(await wait(dir, Number(seq ?? 0)));
else if (command === 'agents') print(Object.entries(sandboxActors({ dir: '', repo: '' })).filter(([, a]) => a.claim).map(([name, { tools, claim }]) => ({ name, tools, claim })));
else if (command === 'page') console.log(itemPage(itemSpec, dir ? openItem(dir).journal.read() : []));
else if (command === 'inspect') console.log(itemInspector(itemSpec, dir ? openItem(dir).journal.read() : []));
else if (command === 'status' && dir) {
  const { host } = openSandboxItem(dir);
  print({ ...where(host), context: host.snapshot?.context, pending: host.pending });
} else {
  console.error('usage: orchestrator demo [dir] | step <dir> | check <dir> | wait <dir> <seq> | agents | status <dir> | page [dir] | inspect [dir]');
  process.exit(2);
}
process.exit(0);
