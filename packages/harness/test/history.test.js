// The one history's contracts (epic #59, step 0): the row schema with provenance (C2), the log views' needs files
// (C3), fact identity (C4) and the golden history every extractor and view builds against (C5). Each test fails
// naming the row, the view or the field, so a worker who drifts from a contract sees which one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HISTORY, validate, placeholders, outOfBand, factKey, dedupe, checkLogNeeds } from '../src/history.js';
import { eventsWhere, specs } from '../src/machines.js';
import { PAGES, loadNeeds, checkPage } from '../src/pages.js';

const golden = () => readFileSync(new URL('./fixtures/history-golden/events.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const row = (id) => structuredClone(golden().find((r) => r.id === id));
const LOG_VIEWS = PAGES.filter((p) => loadNeeds(p).reads.file === 'events.jsonl');

test('C5: the golden history is about 30 valid rows, in time order, numbered from 1', () => {
  const rows = golden();
  assert.ok(rows.length >= 25 && rows.length <= 40, `${rows.length} rows`);
  assert.deepEqual(rows.flatMap(validate), []);
  assert.deepEqual(rows.map((r) => r.version), rows.map((_, i) => i + 1));
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].at <= rows[i].at, `${rows[i].id} is before ${rows[i - 1].id}`);
});

test('C5: it covers every era and origin, one placeholder of each kind, an out-of-band step and a fact from two sources', () => {
  const rows = golden();
  const refs = new Set(rows.map((r) => r.provenance.from.ref));
  for (const era of ['main', 'dogfood', 'dogfood2']) assert.ok(refs.has(`library/harness/state/${era}/events.jsonl`), `no ${era} row`);
  assert.deepEqual([...new Set(rows.map((r) => r.provenance.origin))].sort(), ['live', 'migrated', 'recovered']);
  assert.deepEqual([...new Set(rows.map((r) => r.provenance.from.source))].sort(), ['github', 'session', 'store']);
  const paths = new Set(rows.flatMap((r) => r.provenance.placeholders ?? []));
  for (const p of ['actor', 'source', 'harness']) assert.ok(paths.has(p), `no ${p} placeholder`);
  assert.ok([...paths].some((p) => p.startsWith('event.')), 'no payload placeholder');
  assert.equal(outOfBand(rows).length, 1);
  assert.ok(dedupe(rows).dropped.length >= 1, 'no fact from two sources');
});

test('C2: the schema declares every event the machines take, and nothing the machines do not', () => {
  const taken = eventsWhere(() => true);
  const declared = new Set(Object.keys(HISTORY.events.types));
  for (const t of taken) assert.ok(declared.has(t), `the machines take ${t}, which history.schema.json does not declare`);
  // ERA_ENDED, which ends an era, replay takes itself (harness meta.store.eras): no machine takes it when sent.
  for (const t of declared) assert.ok(taken.has(t) || t === specs.harness.meta.store.eras.event, `history.schema.json declares ${t}, which no machine takes`);
  assert.equal(taken.has(specs.harness.meta.store.eras.event), false, 'no machine takes ERA_ENDED');
  for (const [t, d] of Object.entries(HISTORY.events.types)) assert.equal(d.v, 1, `${t} is at v${d.v} with no declared conversion`);
});

test('C2: a row that breaks the schema is refused, naming the row and the field', () => {
  const refused = (r, re) => {
    const problems = validate(r);
    assert.ok(problems.some((p) => p.startsWith(`${r.id}: `) && re.test(p)), problems.join('\n') || 'taken');
  };
  const r = row('merged-ledger');
  refused({ ...r, provenance: { ...r.provenance, placeholders: ['actor', 'source', 'harness'] } }, /^merged-ledger: event\.sha: holds a legacy placeholder/);
  refused({ ...r, provenance: { ...r.provenance, placeholders: [...r.provenance.placeholders, 'event.pr'] } }, /event\.pr: listed in provenance.placeholders/);
  refused({ ...r, provenance: { ...r.provenance, origin: 'guessed' } }, /provenance\.origin/);
  refused({ ...r, at: '26 Oct' }, /^merged-ledger: at: /);
  const { provenance, ...bare } = r;
  refused(bare, /provenance: missing/);
  const tap = row('tap-issue36-plan');
  refused({ ...tap, actor: { kind: 'robot', id: 'x' } }, /actor\.kind: robot/);
  refused({ ...tap, source: { kind: 'email', ref: 'x' } }, /source\.kind: email/);
  refused({ ...tap, event: { type: 'PERSON_DECIDED' } }, /event\.choice: missing/);
  refused({ ...tap, event: { type: 'GUESSED', choice: 'x' } }, /GUESSED is not declared/);
  refused({ ...tap, event: { ...tap.event, v: 2 } }, /newer than PERSON_DECIDED v1/);
  const oob = golden().find((x) => x.event.type === 'OUT_OF_BAND');
  refused({ ...oob, event: { ...oob.event, skipped: [] } }, /event\.skipped: has 0 items/);
  refused({ ...oob, event: { ...oob.event, message: 'yesterday' } }, /event\.message/);
});

test('C2: placeholders are counted by source and field, for doctor', () => {
  const counts = placeholders(golden());
  const main = counts['library/harness/state/main/events.jsonl'];
  assert.deepEqual([main.actor, main.source, main.harness, main['event.sha']], [10, 10, 10, 1]);
});

test('C4: one fact from two sources is one row; the owner is kept and the other source is kept beside it', () => {
  const rows = golden();
  const { rows: kept, dropped, conflicts } = dedupe(rows);
  assert.equal(kept.length, rows.length - dropped.length);
  assert.deepEqual(conflicts, []);
  const merged = kept.filter((r) => r.event.type === 'MERGED');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].provenance.from.source, 'store', 'the store owns a merge it recorded: its row is what replay applies');
  assert.deepEqual(merged[0].provenance.also.map((f) => f.ref), ['github/suredesigntshirts--ccp_machine_test/pages/pulls-001.json.gz']);
  const spawns = kept.filter((r) => r.event.type === 'WORKER_SPAWNED');
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].provenance.from.source, 'store', 'the store owns a spawn');
  // dogfood and dogfood2 share an orchestrator id; they are two facts.
  assert.equal(kept.filter((r) => r.event.type === 'ORCHESTRATOR_STARTED').length, 2);
  for (const r of kept) assert.deepEqual(validate(r), []);
});

test('C4: two rows of one fact that disagree are reported, not merged silently', () => {
  const rows = golden();
  const gh = rows.find((r) => r.id === 'gh-ccp_machine_test-pr-3');
  const store = rows.find((r) => r.id === 'merged-ledger');
  assert.equal(factKey(gh), factKey(store));
  const other = { ...store, event: { ...store.event, sha: '0'.repeat(40) }, provenance: { ...store.provenance, placeholders: ['actor', 'source', 'harness'] } };
  const { conflicts } = dedupe([gh, other]);
  assert.deepEqual(conflicts.map((c) => [c.field, c.kept, c.other]), [['event.sha', store.id, gh.id]]);
  // A row missing a key path is its own fact.
  const keyless = { ...gh, event: { type: 'MERGED' } };
  assert.notEqual(factKey(keyless), factKey(gh));
});

test('C4: two rows of one key in one source are two facts; the n-th of a source meets the n-th of another', () => {
  // A stand-in's answer and its re-ask under a grant share a decision address (dogfood2, #65).
  const answer = row('sia-ledger-plan');
  const reask = { ...structuredClone(answer), id: 'sia-ledger-plan-reask-1', at: '2026-10-26T17:58:00.000Z', event: { ...answer.event, answer: { ...answer.event.answer, choice: 'reject' } } };
  reask.provenance.from.line = 9;
  const seen = (r, line) => ({ ...structuredClone(r), id: `session-${r.id}`, provenance: { origin: 'recovered', from: { source: 'session', ref: 'sessions/x/transcript.jsonl', line } } });
  const { rows, dropped, conflicts } = dedupe([answer, reask, seen(answer, 3), seen(reask, 7)]);
  assert.deepEqual(rows.map((r) => r.id), ['sia-ledger-plan', 'sia-ledger-plan-reask-1']);
  assert.deepEqual(dropped.map((d) => [d.id, d.kept]), [['session-sia-ledger-plan', 'sia-ledger-plan'], ['session-sia-ledger-plan-reask-1', 'sia-ledger-plan-reask-1']]);
  assert.deepEqual(conflicts, []);
});

test('C3: every log view declares what it reads, and the golden history has all of it', () => {
  assert.deepEqual(LOG_VIEWS.sort(), ['design-log', 'flow-replay', 'introspection', 'ledger']);
  // A view that also reads a file beside the history (flow replay's steps) is held to the golden rows here, and to
  // the golden history joined, with its steps, in history-pages.test.js.
  for (const page of LOG_VIEWS) assert.deepEqual(loadNeeds(page).reads.with ? checkLogNeeds(loadNeeds(page), golden()) : checkPage(page, { history: golden() }), [], `${page}'s needs are not met`);
});

test('C3: a field a view reads that the history lacks fails, naming the view and the field', () => {
  const rows = golden().map((r) => (r.event.type === 'WORKER_SPAWNED' ? { ...r, event: { ...r.event, model: undefined } } : r));
  assert.deepEqual(checkPage('ledger', { history: rows }), ['ledger: reads WORKER_SPAWNED field event.model, which no WORKER_SPAWNED event in this history has']);
  // One row without a field its view reads fails too, naming the row; a placeholder there would be counted, not missing.
  const one = golden().map((r) => (r.id === 'run-issue36' ? { ...r, event: { ...r.event, pr: undefined } } : r));
  assert.deepEqual(checkPage('ledger', { history: one }), ['ledger: reads RUN_SUCCEEDED field event.pr, which row run-issue36 lacks']);
  const needs = structuredClone(loadNeeds('design-log'));
  needs.events.DECISION_TAKEN = ['at'];
  assert.ok(checkLogNeeds(needs).includes('design-log: reads DECISION_TAKEN, which history.schema.json does not declare'));
  needs.reads.schemaVersion = { min: 2, max: 2 };
  assert.ok(checkLogNeeds(needs).some((p) => p.startsWith('design-log: reads history schema 2..2')));
  // A placeholder does not meet a need: the view would show it as a value.
  const legacy = golden().map((r) => (r.event.type === 'OUT_OF_BAND' ? { ...r, event: { ...r.event, what: { legacy: 'lost' } } } : r));
  assert.ok(checkPage('design-log', { history: legacy }).includes('design-log: reads OUT_OF_BAND field event.what, which no OUT_OF_BAND event in this history has'));
});
