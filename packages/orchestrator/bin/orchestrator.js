#!/usr/bin/env node
// orchestrator demo [dir]    run one item end to end in a local git sandbox, with Claude (Haiku) as builder,
//                            verifier and stand-in; rerun on the same dir to resume after a crash
// orchestrator status <dir>  replay an item's journal and show where it is
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drive } from '../src/driver.js';
import { openItem } from '../src/item.js';
import { makeSandbox, sandboxActors } from '../src/sandbox.js';

const ISSUE = {
  url: 'sandbox:issues/1',
  title: 'Add multiply to math.js',
  expect: ['math.js exports multiply(a, b), which returns a times b', 'math.test.js tests multiply, and node --test passes']
};

const line = ({ entry, refused, ...input }) =>
  entry
    ? `${entry.at} #${entry.seq} ${entry.event.type}${entry.run ? ` (run ${entry.run})` : ''} from ${entry.source} -> ${entry.hash}`
    : `refused ${input.event?.type}: ${refused}`;

const status = ({ host }) => ({ state: host.snapshot?.value, status: host.snapshot?.status, context: host.snapshot?.context, pending: host.pending, output: host.snapshot?.output });

const [command, arg] = process.argv.slice(2);
if (command === 'demo') {
  const dir = arg ?? mkdtempSync(join(tmpdir(), 'orchestrator-demo-'));
  const repo = join(dir, 'repo');
  if (!existsSync(repo)) makeSandbox(repo);
  const item = openItem(dir);
  console.log(`item in ${dir}${item.host.journal.length ? `, resuming at #${item.host.journal.length}` : ''}`);
  const { send, settled } = drive({ ...item, actors: sandboxActors({ dir, repo, model: process.env.MODEL ?? 'haiku' }), log: (x) => console.log(line(x)) });
  if (!item.host.snapshot) send({ event: { type: 'xstate.init', input: { issue: ISSUE } }, source: 'person' });
  const snapshot = await settled;
  console.log(JSON.stringify({ state: snapshot.value, output: snapshot.output }, null, 2));
} else if (command === 'status' && arg) {
  console.log(JSON.stringify(status(openItem(arg)), null, 2));
} else {
  console.error('usage: orchestrator demo [dir] | orchestrator status <dir>');
  process.exit(2);
}
