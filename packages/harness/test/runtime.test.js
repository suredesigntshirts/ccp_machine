import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { itemTurns } from '../src/item-page.js';
import { openStore, init, apply, ack, status, renderPage, renderItemPage, itemRecords, budgetEvents, logPrecedents, readDecisionLog, classStats, renderDecisionLog, ladder, writeDigest, doctor, cardFor } from '../src/index.js';
const fresh = (input) => {
  const store = openStore(mkdtempSync(join(tmpdir(), 'harness-')));
  init(store, input, '2026-10-26T18:00:00Z');
  return store;
};
const names = (r) => r.effects.map((e) => e.name);
const sure = { choice: 'approve', confidence: 0.95, threshold: 0.9, autonomy: 'act' };

test('each wake restores, applies one event, persists, and queues its effects', () => {
  const store = fresh({ wipLimit: 2 });
  assert.deepEqual(names(apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'a', tier: 0 } })), ['dispatchRun']);
  assert.equal(store.read().version, 2);
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:a' });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:a' });
  assert.deepEqual(names(apply(store, { type: 'CHECKS_PASSED' }, { to: 'item:a' })), ['mergePullRequest']);
  apply(store, { type: 'MERGED' }, { to: 'item:a' });
  const st = status(store);
  assert.deepEqual(st.items.map((i) => [i.id, i.state, i.done]), [['a', 'done', true]]);
  assert.deepEqual(st.context.inFlight, []);
  assert.equal(store.events().length, 5);
});

test('an event id is applied once, however often it is delivered', () => {
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'a', tier: 0 } }, { id: 'req-a' });
  const again = apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'a', tier: 0 } }, { id: 'req-a' });
  assert.equal(again.duplicate, true);
  assert.equal(status(store).items.length, 1);
});

test('a stale writer is refused by compare-and-set, and a held lock stops a second writer', () => {
  const store = fresh();
  const state = store.read();
  store.write({ ...state, version: 2 }, 1);
  assert.throws(() => store.write({ ...state, version: 2 }, 1), /expected version 1, found 2/);
  assert.throws(() => store.withLock(() => store.withLock(() => {})), /another writer/);
});

test('an escalated decision is addressable by path, shows on the page, and leaves when decided', () => {
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'p', tier: 2, title: 'Ship the ledger' } });
  assert.deepEqual(names(apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:p' })), ['askStandIn']);
  const [d] = status(store).items[0].decisions;
  assert.equal(d.address, 'item:p/decision:p:plan:1');
  assert.deepEqual(names(apply(store, { type: 'STAND_IN_ANSWERED', answer: sure }, { to: d.address })), ['postDecisionCard']);
  let st = status(store);
  assert.ok(st.needsPerson);
  const card = store.pending().find((e) => e.name === 'postDecisionCard');
  assert.equal(card.detail.standIn.choice, 'approve', 'the host gets what it needs to post the card');
  const html = renderPage(st, { events: store.events(), pending: store.pending() });
  assert.match(html, /Ship the ledger/);
  assert.match(html, /Stand-in leans <b>approve<\/b>/);

  apply(store, { type: 'PERSON_DECIDED', choice: 'approve' }, { to: d.address });
  st = status(store);
  assert.ok(!st.needsPerson);
  assert.equal(st.items[0].state, 'active.building');
});

test('effects stay pending until acknowledged; unknown ids are refused', () => {
  const store = fresh();
  const { effects } = apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'a', tier: 0 } });
  assert.equal(store.pending().length, 1);
  ack(store, effects.map((e) => e.id));
  assert.equal(store.pending().length, 0);
  assert.throws(() => ack(store, ['nope']), /unknown effects: nope/);
});

test('the page escapes what it shows', () => {
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: '<x>', tier: 0, title: '<script>alert(1)</script>' } });
  const html = renderPage(status(store), { events: store.events(), pending: store.pending() });
  assert.ok(!html.includes('<script>alert'));
});

test('usage samples reach the scheduler: a spent slice halts starts, and feeding twice is a no-op', () => {
  const store = fresh();
  const samples = [
    { at: '2026-10-26T01:00:00Z', sevenDay: 0.3, fiveHour: 0.1, sevenDayResetsAt: 1 },
    { at: '2026-10-26T12:00:00Z', sevenDay: 0.41, fiveHour: 0.2, sevenDayResetsAt: 1 }
  ];
  for (const round of [1, 2]) for (const e of budgetEvents(samples)) apply(store, e.event, { to: e.to, id: e.id });
  const st = status(store);
  assert.equal(st.budget.mode, 'paused');
  assert.equal(st.state.scheduler, 'halted');
  assert.equal(store.events().length, 2);
});

test('an item page shows what was asked, how it ended, who decided and what the host did', () => {
  const store = fresh();
  const { effects } = apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'p', tier: 1, title: 'Ship it', expect: 'A <b> page' } }, { id: 'req-p' });
  ack(store, effects.map((e) => e.id), { note: 'plan written' });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:p' });
  apply(store, { type: 'STAND_IN_ANSWERED', answer: { ...sure, reason: 'small' } }, { to: 'item:p/decision:p:plan:1' });
  apply(store, { type: 'RUN_SUCCEEDED', pr: 'https://github.com/o/r/pull/9' }, { to: 'item:p' });
  apply(store, { type: 'CHECKS_PASSED' }, { to: 'item:p' });
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'other', tier: 0 } });
  const item = status(store).items.find((i) => i.id === 'p');
  const records = itemRecords('p', { events: store.events(), outbox: store.outbox(), acks: store.acks() });
  assert.ok(records.events.every((e) => e.to.startsWith('item:p') || e.event.request?.id === 'p'));
  const html = renderItemPage(item, { events: store.events(), outbox: store.outbox(), acks: store.acks() });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /A &lt;b&gt; page/);
  assert.match(html, /CI passed/);
  assert.match(html, /pull\/9/);
  assert.match(html, /plan written/);
  assert.match(html, /stand-in/);
  assert.ok(!html.includes('other'));
  assert.match(renderPage(status(store), { itemLinks: true }), /href="items\/p\.html"/);
});

test('logPrecedent effects become the decision log once, and the page shows agreement per class', () => {
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'p', tier: 1 } });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:p' });
  apply(store, { type: 'STAND_IN_ANSWERED', answer: { ...sure, reason: '<why>' } }, { to: 'item:p/decision:p:plan:1' });
  assert.deepEqual(logPrecedents(store), { added: 1, acked: 1 });
  assert.deepEqual(logPrecedents(store), { added: 0, acked: 0 });
  const rows = readDecisionLog(store);
  assert.equal(rows[0].item, 'p');
  assert.equal(rows[0].decidedBy, 'stand-in');
  assert.ok(!store.pending().some((e) => e.name === 'logPrecedent'));
  const [plan] = classStats(rows);
  assert.deepEqual([plan.decisions, plan.agreement, plan.earnedAct], [1, null, false]);
  const many = Array.from({ length: 20 }, () => ({ ...rows[0], decidedBy: 'person' }));
  assert.equal(classStats(many)[0].earnedAct, true);
  const html = renderDecisionLog(rows);
  assert.match(html, /recommend/);
  assert.match(html, /&lt;why&gt;/);
});

test('the stand-in ladder climbs after 20 agreeing decisions and drops a rung on each reversal', () => {
  const row = (choice, lean = 'approve') => ({ decisionClass: 'plan', choice, decidedBy: 'person', standIn: { choice: lean } });
  const agree = (n) => Array.from({ length: n }, () => row('approve'));
  assert.equal(ladder([], 'plan').autonomy, 'recommend');
  assert.equal(ladder(agree(19), 'plan').autonomy, 'recommend');
  assert.equal(ladder(agree(20), 'plan').autonomy, 'act');
  const reversed = ladder([...agree(20), row('reject')], 'plan');
  assert.deepEqual([reversed.autonomy, reversed.reversals], ['recommend', 1]);
  assert.equal(ladder([row('reject'), row('reject')], 'plan').autonomy, 'shadow');
  assert.equal(ladder([row('reject'), ...agree(20)], 'plan').autonomy, 'recommend', 'climbing back takes 20 more');
  assert.equal(ladder(agree(20), 'accept').autonomy, 'recommend', 'classes are separate');
  const self = Array.from({ length: 30 }, () => ({ ...row('approve'), decidedBy: 'stand-in' }));
  const own = ladder(self, 'plan');
  assert.deepEqual([own.autonomy, own.decisions, own.agreement], ['recommend', 30, null], 'the stand-in agreeing with itself proves nothing');
  assert.equal(ladder([...agree(10), ...self, ...agree(10)], 'plan').autonomy, 'act', 'only the person\'s 20 count');
  assert.equal(classStats(self)[0].agreement, null);
});

test('the digest goes out once per UTC day and says what finished, what runs and what waits', () => {
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'a', tier: 0, title: 'Quick fix' } }, { now: '2026-10-26T09:00:00Z' });
  for (const t of ['RUN_SUCCEEDED', 'RUN_SUCCEEDED', 'CHECKS_PASSED', 'MERGED']) apply(store, { type: t }, { to: 'item:a', now: '2026-10-26T10:00:00Z' });
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'p', tier: 2 } });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:p' });
  apply(store, { type: 'STAND_IN_ANSWERED', answer: sure }, { to: 'item:p/decision:p:plan:1' });
  const first = writeDigest(store, { day: '2026-10-26' });
  assert.equal(first.acked, 1);
  assert.match(first.text, /Finished today \(1\)\*\*\n- a: Quick fix/);
  assert.match(first.text, /Waiting on you \(1\)\*\*\n- p: plan gate/);
  const again = writeDigest(store, { day: '2026-10-26' });
  assert.equal(again.acked, 0, 'a second run the same day queues no second digest');
  assert.equal(store.events().filter((e) => e.event.type === 'DIGEST_DUE').length, 1);
});

test('doctor passes a sound store and names each problem in a broken one', () => {
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'a', tier: 0 } }, { now: '2026-10-20T00:00:00Z' });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:a' });
  const soon = Date.parse('2026-10-20T01:00:00Z');
  assert.deepEqual(doctor(store, { now: soon }).problems, []);
  store.appendAcks([{ effectId: 'ghost', outcome: 'done' }]);
  store.appendEvents([{ id: 'x', version: 9, at: '2026-10-20T00:00:00Z', to: 'harness', event: { type: 'X' } }]);
  const { ok, problems } = doctor(store, { now: Date.parse('2026-10-26T00:00:00Z') });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /unknown effect ghost/.test(p)));
  assert.ok(problems.some((p) => /version 9, expected 4/.test(p)));
  assert.ok(problems.some((p) => /pending since/.test(p)));
});

test('a postDecisionCard effect becomes a card whose tap maps back to PERSON_DECIDED', () => {
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'p', tier: 2, title: 'Ship it' } });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:p' });
  const { effects } = apply(store, { type: 'STAND_IN_ANSWERED', answer: { ...sure, choice: 'revise', reason: 'too big' } }, { to: 'item:p/decision:p:plan:1' });
  const card = cardFor(effects.find((e) => e.name === 'postDecisionCard'));
  assert.equal(card.address, 'item:p/decision:p:plan:1');
  assert.equal(card.choices[card.recommended], 'revise', 'the stand-in\'s lean is the recommendation');
  assert.match(card.context, /leans revise \(95% sure\): too big/);
  assert.ok(card.options.length >= 2 && card.options.every((o) => o.label.length <= 40 && o.consequence.length <= 200));
  apply(store, { type: 'PERSON_DECIDED', choice: card.choices[0] }, { to: card.address, id: 'cmsg_tap' });
  assert.equal(apply(store, { type: 'PERSON_DECIDED', choice: 'reject' }, { to: card.address, id: 'cmsg_tap' }).duplicate, true);
  assert.equal(status(store).items[0].state, 'active.building');
  assert.throws(() => cardFor(effects[0].name === 'postDecisionCard' ? { name: 'x' } : effects[0]), /not a postDecisionCard/);
});

test('an item page lists the turns of the sessions named on its events, inside its window', () => {
  const events = [
    { at: '2026-10-26T10:00:00Z', to: 'harness', event: { type: 'REQUEST_RECEIVED', request: { id: 'a' } } },
    { at: '2026-10-26T11:00:00Z', to: 'item:a', event: { type: 'RUN_SUCCEEDED', session: 's1' } },
    { at: '2026-10-26T12:00:00Z', to: 'item:a', event: { type: 'MERGED' } }
  ];
  const t = (index, start, end) => ({ index, start, end, label: `t${index}` });
  const sessions = { s1: { turns: [t(1, '2026-10-26T08:00:00Z', '2026-10-26T09:00:00Z'), t(2, '2026-10-26T09:30:00Z', '2026-10-26T10:30:00Z'), t(3, '2026-10-26T13:00:00Z', '2026-10-26T13:10:00Z')] } };
  assert.deepEqual(itemTurns({ done: true }, events, sessions).map((x) => x.index), [2]);
  assert.match(renderItemPage({ id: 'a', done: true, state: 'done', decisions: [] }, { events, sessions }), /s1 #2/);
});
