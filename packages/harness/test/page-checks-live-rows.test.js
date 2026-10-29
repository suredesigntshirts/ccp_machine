// #158: the page needs checks (checkPage, checkLogNeeds) read a history's rows by the rule doctor and the pages read
// them by (harness meta.store.history, history.schema.json live, src/live.js liveRows): a row harness send appends
// after the join's rows is live, so its missing provenance is no problem; a row with no provenance before a joined
// row still is. And a needs file can declare a field only some rows of a type carry (needs `optional`, history.schema.json
// events): the ledger and introspection declare RUN_SUCCEEDED event.pr so, since a triage run opens no PR; a field
// declared without it is still reported where a row lacks it, and a field the schema requires cannot be declared so.
// No network: the history is built with the current code in a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.js';
import { contractHistory } from '../src/sim.js';
import { parseLog } from '../src/live.js';
import { checkLogNeeds } from '../src/history.js';
import { checkPage, loadNeeds } from '../src/pages.js';

const BIN = fileURLToPath(new URL('../bin/harness.js', import.meta.url));
const USAGE = fileURLToPath(new URL('../scripts/history/usage.mjs', import.meta.url));
const LEAD = '2ce18a8f-fd3a-507a-82d3-2dea2ed3db49';
const PAGES = ['ledger', 'flow-replay', 'design-log', 'introspection'];
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const cli = (dir, ...args) => spawnSync(process.execPath, [BIN, '--dir', dir, ...args], { encoding: 'utf8', env });

// A joined history (the sim's contract store through extract-store.mjs and join.mjs), two rows harness send appends
// to it, and the files the pages read beside it, built again: steps.jsonl (harness replay --steps) and usage.jsonl
// (scripts/history/usage.mjs, here from no session ledgers).
let built;
async function history() {
  if (built) return built;
  const { dir } = await contractHistory(tempDir('harness-page-checks-live-rows-'));
  const joined = parseLog(readFileSync(join(dir, 'events.jsonl'), 'utf8')).length;
  for (const [id, n] of [['page-checks-d', 4], ['page-checks-e', 5]]) {
    const event = { type: 'REQUEST_RECEIVED', request: { id, title: id, project: 'ccp_machine', url: `https://github.com/suredesigntshirts/ccp_machine/issues/${n}` } };
    const r = cli(dir, 'send', JSON.stringify(event), '--id', `req-${id}`, '--actor', `session:${LEAD}`, '--source', 'cli:harness send');
    assert.equal(r.status, 0, r.stderr);
  }
  // The sim's MERGED rows name no PR, so the join gives them a placeholder, which introspection's MERGED event.pr does
  // not take: here each names one, so the history meets every other need the pages declare.
  const named = (r) => ({ ...r, event: { ...r.event, pr: `https://example.test/pr/${r.to}` }, provenance: { ...r.provenance, placeholders: r.provenance.placeholders.filter((p) => p !== 'event.pr') } });
  const rows = parseLog(readFileSync(join(dir, 'events.jsonl'), 'utf8')).map((r) => (r.event.type === 'MERGED' && r.event.pr?.legacy ? named(r) : r));
  assert.ok(rows.slice(joined).length === 2 && rows.slice(joined).every((r) => !('provenance' in r)), 'the live rows are as the runtime wrote them');
  cli(dir, 'replay', '--steps');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const usage = spawnSync(process.execPath, [USAGE, join(dir, 'sessions'), join(dir, 'events.jsonl')], { encoding: 'utf8', env });
  assert.equal(usage.status, 0, usage.stderr);
  const also = { 'steps.jsonl': parseLog(readFileSync(join(dir, 'steps.jsonl'), 'utf8')), 'usage.jsonl': parseLog(usage.stdout) };
  return (built = { rows, joined, also });
}
const bare = ({ provenance, ...r }) => r;

test('#158: a joined history followed by live rows meets each history page\'s needs (checkPage and checkLogNeeds)', async () => {
  const { rows, also } = await history();
  for (const page of PAGES) {
    assert.deepEqual(checkPage(page, { history: rows, also }), [], `${page}: checkPage reads the live rows by the history rule`);
    assert.deepEqual(checkLogNeeds(loadNeeds(page), rows, undefined, also), [], `${page}: checkLogNeeds reads the live rows by the history rule`);
  }
});

test('#158: a row with no provenance before a joined row still fails the checks, naming the row', async () => {
  const { rows, joined, also } = await history();
  const k = Math.floor(joined / 2);
  const hole = rows.map((r, i) => (i === k ? bare(r) : r));
  for (const page of ['ledger', 'flow-replay']) {
    const lack = `${page}: reads * field provenance.origin, which row ${rows[k].id} lacks`;
    assert.ok(checkPage(page, { history: hole, also }).includes(lack), `${page}: checkPage reports ${rows[k].id}`);
    assert.ok(checkLogNeeds(loadNeeds(page), hole, undefined, also).includes(lack), `${page}: checkLogNeeds reports ${rows[k].id}`);
  }
});

test('#158: a RUN_SUCCEEDED with no pr passes only where the needs file declares pr optional', async () => {
  const { rows, also } = await history();
  const runs = rows.filter((r) => r.event.type === 'RUN_SUCCEEDED');
  assert.ok(runs.length > 1 && runs.every((r) => r.event.pr !== undefined), 'the contract history has RUN_SUCCEEDED rows, each with a pr');
  const triage = runs[0].id;
  const nopr = rows.map((r) => (r.id === triage ? { ...r, event: { ...r.event, pr: undefined } } : r));
  for (const page of ['ledger', 'introspection']) {
    const needs = loadNeeds(page);
    assert.deepEqual(needs.optional?.RUN_SUCCEEDED, ['event.pr'], `${page} declares RUN_SUCCEEDED event.pr optional`);
    assert.deepEqual(checkPage(page, { history: nopr, also }), [], `${page}: a run with no pr is no problem where pr is optional`);
    // Without the declaration, the field is always present, and the row that lacks it is reported.
    const always = structuredClone(needs);
    delete always.optional;
    assert.ok(checkPage(page, { history: nopr, also, needs: always }).includes(`${page}: reads RUN_SUCCEEDED field event.pr, which row ${triage} lacks`), page);
    // Optional still needs a value somewhere: a field no row of the type carries is reported.
    const none = rows.map((r) => (r.event.type === 'RUN_SUCCEEDED' ? { ...r, event: { ...r.event, pr: undefined } } : r));
    assert.ok(checkPage(page, { history: none, also }).includes(`${page}: reads RUN_SUCCEEDED field event.pr, which no RUN_SUCCEEDED event in this history has`), page);
  }
  // MERGED needs its pr (history.schema.json requires it): introspection reads it, and does not declare it optional.
  const merged = rows.find((r) => r.event.type === 'MERGED');
  const unmerged = rows.map((r) => (r === merged ? { ...r, event: { ...r.event, pr: undefined } } : r));
  assert.ok(checkLogNeeds(loadNeeds('introspection'), unmerged, undefined, also).includes(`introspection: reads MERGED field event.pr, which row ${merged.id} lacks`));
});

test('#158: optional cannot silence a field the schema requires, a field the page does not read, or a type it does not read', () => {
  const needs = structuredClone(loadNeeds('ledger'));
  needs.optional = { ...needs.optional, '*': ['provenance.origin', 'at'], WORKER_SPAWNED: ['event.agentType', 'event.nope'], MERGED: ['event.pr'] };
  const problems = checkLogNeeds(needs);
  assert.ok(problems.includes('ledger: declares * field provenance.origin optional, which history.schema.json requires'), problems.join('\n'));
  assert.ok(problems.includes('ledger: declares * field at optional, which history.schema.json requires'), problems.join('\n'));
  assert.ok(problems.includes('ledger: declares WORKER_SPAWNED field event.nope optional, which its events.WORKER_SPAWNED does not read'), problems.join('\n'));
  assert.ok(problems.includes('ledger: declares MERGED field event.pr optional, which its events.MERGED does not read'), problems.join('\n'));
  assert.ok(!problems.some((p) => p.includes('event.agentType')), 'a field the schema does not require may be optional');
});
