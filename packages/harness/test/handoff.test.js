import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, init, apply, ack, handoffNote, writeHandoff, HANDOFF_NOTES } from '../src/index.js';

const PR = 'https://github.com/o/r/pull/7';

test('the hand-off names every in-flight item with its stage and PR, the waiting card, the queue and the to-do', () => {
  const store = openStore(mkdtempSync(join(tmpdir(), 'harness-')));
  init(store, { wipLimit: 2 });
  const req = (id, tier) => apply(store, { type: 'REQUEST_RECEIVED', request: { id, tier, title: `Item ${id}` } }, { id: `req-${id}` });
  const ackAll = (note) => ack(store, store.pending().map((e) => e.id), { note });
  // a: tier 0, built, its PR in CI.
  req('a', 0);
  ackAll('triage dispatched');
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:a' });
  ackAll('build dispatched');
  apply(store, { type: 'RUN_SUCCEEDED', pr: PR }, { to: 'item:a' });
  ackAll('CI started');
  // b: tier 1, its plan card posted to the person.
  req('b', 1);
  ackAll('triage dispatched');
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:b' });
  const ask = store.pending().find((e) => e.name === 'askStandIn');
  ack(store, [ask.id], { note: 'judged' });
  apply(store, { type: 'STAND_IN_ANSWERED', answer: { choice: 'approve', confidence: 0.6, threshold: 0.9, autonomy: 'recommend', reason: 'unsure' } }, { to: `item:b/${ask.subject}` });
  const card = store.pending().find((e) => e.name === 'postDecisionCard');
  ack(store, [card.id], { note: 'cmsg_123' });
  // c: queued behind the WIP limit, its triage not yet dispatched.
  req('c', 0);
  writeFileSync(join(store.dir, HANDOFF_NOTES), '- audit card cmsg_9 waits on a tap');

  const note = handoffNote(store, { now: '2026-10-26T20:00:00Z' });
  assert.match(note, new RegExp(`\\*\\*a\\*\\* \\(tier 0\\) active\\.verifying, PR ${PR}`));
  assert.match(note, /\*\*b\*\* \(tier 1\) active\.awaitingPlanDecision/);
  assert.match(note, /- item:b\/decision:b:plan:1: .*\(card: cmsg_123\)/);
  assert.match(note, /In flight \(2 of WIP 2\)/);
  assert.match(note, /## Queued \(1\)\n- \*\*c\*\*/);
  assert.match(note, /Check CI on https:\/\/github\.com\/o\/r\/pull\/7/);
  assert.match(note, /audit card cmsg_9/);
  for (const e of store.pending()) assert.ok(note.includes(e.id), `pending ${e.id} listed`);
  assert.equal(readFileSync(writeHandoff(store), 'utf8').startsWith('# Harness hand-off'), true);
});
