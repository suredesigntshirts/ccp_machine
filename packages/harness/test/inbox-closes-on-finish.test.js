// #157: an inbox entry lives no longer than its item. When an item finishes, by any route, every inbox entry whose
// item has finished leaves the person's inbox (harness attention, route inboxDropsFinished; an entry's item is read by
// harness meta.store.eras byItem.inbox), and an empty inbox takes attention back to quiet. An entry leaked before the
// rule (an item cancelled while its decision waited on the person) leaves on the next item's ITEM_FINISHED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { tempDir } from './tmp.js';
import { openStore, init, status, replay } from '../src/index.js';
import { specs } from '../src/machines.js';
import { apply, start } from './send.js';

const sure = { choice: 'approve', confidence: 0.95, reason: 'small' };
const inbox = (store) => store.read().snapshot.context.inbox;
const attention = (store) => status(store).state.attention;
const stateOf = (store, id) => status(store).items.find((i) => i.id === id);

function fresh() {
  const store = openStore(tempDir('harness-inbox-closes-on-finish-'));
  init(store, { wipLimit: 4 });
  start(store);
  return store;
}

// An item at tier 2 whose plan decision waits on the person (awaitingPerson): the stand-in answered, tier 2 asks the person.
function planWaitsOnPerson(store, id) {
  apply(store, { type: 'REQUEST_RECEIVED', request: { id } });
  apply(store, { type: 'TRIAGED', tier: 2, criteria: ['it works'] }, { to: `item:${id}` });
  apply(store, { type: 'STAND_IN_ANSWERED', answer: sure }, { to: `item:${id}/decision:${id}:plan:1` });
  assert.equal(stateOf(store, id).decisions[0].state, 'awaitingPerson');
  return `decision:${id}:plan:1`;
}

// The cancel as the release before #157 logged it: its route without inboxDropsFinished (or the quiet it would bring).
function cancelBeforeTheRule(store, id) {
  const copy = openStore(tempDir('harness-inbox-closes-on-finish-copy-'));
  cpSync(store.dir, copy.dir, { recursive: true });
  const today = apply(copy, { type: 'CANCEL' }, { to: `item:${id}` });
  const route = today.route.filter((r) => !['inboxDropsFinished', 'attentionQuiet'].includes(r));
  apply(store, { type: 'CANCEL' }, { to: `item:${id}`, id: `cancel-${id}-before`, fact: { route } });
}

test('cancelling an item whose decision waits on the person (awaitingPerson) takes it out of the inbox; an in-flight item\'s decision stays', () => {
  const store = fresh();
  const p = planWaitsOnPerson(store, 'p');
  const q = planWaitsOnPerson(store, 'q');
  assert.deepEqual(inbox(store), [p, q]);
  assert.equal(attention(store), 'needsPerson');

  apply(store, { type: 'CANCEL' }, { to: 'item:p' });
  assert.equal(stateOf(store, 'p').state, 'cancelled');
  assert.deepEqual(inbox(store), [q], 'the open decision of q, still in flight, stays');
  assert.equal(attention(store), 'needsPerson');

  apply(store, { type: 'CANCEL' }, { to: 'item:q' });
  assert.deepEqual(inbox(store), [], 'the inbox is empty');
  assert.equal(attention(store), 'quiet', 'and attention is quiet again (inboxEmpty)');
  assert.equal(replay(store).ok, true);
});

test('cancelling an item whose decision waits on the stand-in (askingStandIn) leaves the inbox empty', () => {
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'x' } });
  apply(store, { type: 'TRIAGED', tier: 2, criteria: ['a works'] }, { to: 'item:x' });
  apply(store, { type: 'STAND_IN_ANSWERED', answer: sure }, { to: 'item:x/decision:x:plan:1' });
  apply(store, { type: 'PERSON_DECIDED', choice: 'approve' }, { to: 'item:x/decision:x:plan:1' });
  apply(store, { type: 'RUN_SUCCEEDED', pr: 'https://github.com/o/r/pull/1' }, { to: 'item:x' });
  apply(store, { type: 'CHECKS_PASSED' }, { to: 'item:x' });
  // The accept decision goes to the person, then a check that changes expectationsMet withdraws it and opens the next,
  // which waits on the stand-in.
  apply(store, { type: 'STAND_IN_ANSWERED', answer: sure }, { to: 'item:x/decision:x:accept:2' });
  assert.equal(attention(store), 'needsPerson');
  apply(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'a test' }, { to: 'item:x' });
  const [open] = stateOf(store, 'x').decisions;
  assert.deepEqual([open.id, open.state], ['decision:x:accept:3', 'askingStandIn']);

  apply(store, { type: 'CANCEL' }, { to: 'item:x' });
  assert.equal(stateOf(store, 'x').state, 'cancelled');
  assert.deepEqual(inbox(store), []);
  assert.equal(attention(store), 'quiet');
  assert.equal(replay(store).ok, true);
});

test('an entry leaked before the rule leaves on the next item\'s ITEM_FINISHED, with no new event', () => {
  const store = fresh();
  const old = planWaitsOnPerson(store, 'old');
  const open = planWaitsOnPerson(store, 'open');
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'next' } });
  cancelBeforeTheRule(store, 'old');
  assert.equal(stateOf(store, 'old').state, 'cancelled');
  assert.deepEqual(inbox(store), [old, open], 'the state today\'s stores hold: a cancelled item\'s decision left in the inbox');
  assert.equal(replay(store).ok, true, 'and it replays as it was logged');

  apply(store, { type: 'CANCEL' }, { to: 'item:next' });
  assert.deepEqual(inbox(store), [open], 'the leaked entry left; the in-flight item\'s open decision stays');
  assert.equal(attention(store), 'needsPerson');

  apply(store, { type: 'CANCEL' }, { to: 'item:open' });
  assert.deepEqual(inbox(store), []);
  assert.equal(attention(store), 'quiet');
  const r = replay(store);
  assert.equal(r.ok, true, JSON.stringify(r.differences ?? r.firstDivergence));
});

test('an item that finishes done through its accept decision leaves the inbox once, and others\' entries stay', () => {
  const store = fresh();
  const open = planWaitsOnPerson(store, 'open');
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'd' } });
  apply(store, { type: 'TRIAGED', tier: 2, criteria: ['a works'] }, { to: 'item:d' });
  apply(store, { type: 'STAND_IN_ANSWERED', answer: sure }, { to: 'item:d/decision:d:plan:1' });
  apply(store, { type: 'PERSON_DECIDED', choice: 'approve' }, { to: 'item:d/decision:d:plan:1' });
  apply(store, { type: 'RUN_SUCCEEDED', pr: 'https://github.com/o/r/pull/2' }, { to: 'item:d' });
  apply(store, { type: 'CHECKS_PASSED' }, { to: 'item:d' });
  apply(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'a test' }, { to: 'item:d' });
  const accept = stateOf(store, 'd').decisions[0].id;
  apply(store, { type: 'STAND_IN_ANSWERED', answer: sure }, { to: `item:d/${accept}` });
  assert.deepEqual(inbox(store), [open, accept]);
  apply(store, { type: 'PERSON_DECIDED', choice: 'approve' }, { to: `item:d/${accept}` });
  assert.deepEqual(inbox(store), [open], 'the accept decision left when decided');
  const merge = stateOf(store, 'd').decisions[0].id;
  apply(store, { type: 'STAND_IN_ANSWERED', answer: sure }, { to: `item:d/${merge}` });
  apply(store, { type: 'PERSON_DECIDED', choice: 'approve' }, { to: `item:d/${merge}` });
  apply(store, { type: 'MERGED' }, { to: 'item:d' });
  assert.equal(stateOf(store, 'd').state, 'done');
  assert.deepEqual(inbox(store), [open]);
  assert.equal(attention(store), 'needsPerson');
  assert.equal(replay(store).ok, true);
});

test('a needsCriteria item that is cancelled leaves the inbox, and byItem.inbox names its item', () => {
  const item = (entry) => new RegExp(specs.harness.meta.store.eras.byItem.inbox).exec(entry)?.[1];
  assert.deepEqual(['decision:a:plan:1', 'needsCriteria:b'].map(item), ['a', 'b']);
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'n' } });
  apply(store, { type: 'TRIAGED', tier: 1, criteria: [] }, { to: 'item:n' });
  assert.deepEqual(inbox(store), ['needsCriteria:n']);
  apply(store, { type: 'CANCEL' }, { to: 'item:n' });
  assert.deepEqual(inbox(store), []);
  assert.equal(attention(store), 'quiet');
});
