import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { join } from 'node:path';
import { itemTurns } from '../src/item-page.js';
import { openStore, init, ack, status, renderPage, renderItemPage, itemRecords, budgetEvents, logPrecedents, readDecisionLog, classStats, renderDecisionLog, ladder, writeDigest, doctor, cardFor, stalled, parseAfter, replay } from '../src/index.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { apply, start, earn } from './send.js';
const fresh = (input) => {
  const store = openStore(tempDir('harness-'));
  init(store, input, '2026-10-26T18:00:00Z');
  start(store, '2026-10-26T18:00:00Z');
  return store;
};
const names = (r) => r.effects.map((e) => e.name);
const sure = { choice: 'approve', confidence: 0.95 };

test('each wake restores, applies one event, persists, and queues its effects', () => {
  const store = fresh({ wipLimit: 2 });
  assert.deepEqual(names(apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'a', tier: 0 } })), ['dispatchRun']);
  assert.equal(store.read().version, 3, 'init is version 1, the orchestrator starting 2');
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:a' });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:a' });
  assert.deepEqual(names(apply(store, { type: 'CHECKS_PASSED' }, { to: 'item:a' })), ['mergePullRequest']);
  apply(store, { type: 'MERGED' }, { to: 'item:a' });
  const st = status(store);
  assert.deepEqual(st.items.map((i) => [i.id, i.state, i.done]), [['a', 'done', true]]);
  assert.deepEqual(st.context.inFlight, []);
  assert.equal(store.events().length, 6);
});

test('an event id is applied once, however often it is delivered', () => {
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'a', tier: 0 } }, { id: 'req-a' });
  const again = apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'a', tier: 0 } }, { id: 'req-a' });
  assert.equal(again.duplicate, true);
  assert.equal(status(store).items.length, 1);
});

test('an event the machine would not take is refused and changes nothing', () => {
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'a', tier: 0 } });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:a' });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:a' });
  const before = [store.read(), store.events(), store.outbox()];
  const r = apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:a', id: 'late-run' });
  assert.deepEqual(r, { version: 5, refused: true, why: 'refused: RUN_SUCCEEDED in active.verifying', effects: [] });
  assert.deepEqual([store.read(), store.events(), store.outbox()], before, 'no version, event row or effect');
  // The id is not spent: the same id is taken once the machine would take it.
  assert.equal(apply(store, { type: 'CHECKS_PASSED' }, { to: 'item:a', id: 'late-run' }).refused, undefined);
  apply(store, { type: 'MERGED' }, { to: 'item:a' });
  assert.equal(apply(store, { type: 'CANCEL' }, { to: 'item:a' }).why, 'refused: CANCEL in done', 'a finished item takes nothing');
  assert.equal(apply(store, { type: 'TICK', now: '2026-10-26T18:30:00Z' }, { to: 'budget' }).refused, undefined, 'no reading yet: the TICK drains');
  assert.equal(apply(store, { type: 'TICK', now: '2026-10-26T18:31:00Z' }, { to: 'budget' }).why, 'refused: TICK in wrappingUp');
});

test('a stale writer is refused by compare-and-set, and a held lock stops a second writer', () => {
  const store = fresh();
  const state = store.read();
  store.write({ ...state, version: 3 }, 2);
  assert.throws(() => store.write({ ...state, version: 3 }, 2), /expected version 2, found 3/);
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
  assert.equal(store.events().filter((e) => e.to === 'budget').length, 2);
});

test('an estimated reading keeps the budget accepting through a 3-hour gap, and the page says so', () => {
  const store = fresh();
  const at = (h) => `2026-10-26T${String(h).padStart(2, '0')}:00:00Z`;
  const feed = (samples) => { for (const e of budgetEvents(samples)) apply(store, e.event, { to: e.to, id: e.id }); };
  const real = [{ at: at(1), sevenDay: 0.3, fiveHour: 0.1, sevenDayResetsAt: 1 }, { at: at(10), sevenDay: 0.32, fiveHour: 0.2, sevenDayResetsAt: 1 }];
  feed(real);
  // No reading for 3 hours: without an estimate, the tick drains the budget.
  apply(store, { type: 'TICK', now: at(13) }, { to: 'budget', id: 'tick-13' });
  assert.equal(status(store).state.scheduler, 'draining');
  const est = { ...real[1], at: at(13), sevenDay: 0.33, fiveHour: 0.25, estimated: true, estimatedFrom: at(10) };
  feed([...real, est]);
  apply(store, { type: 'TICK', now: at(13) }, { to: 'budget', id: 'tick-13b' });
  const st = status(store);
  assert.deepEqual([st.state.scheduler, st.budget.mode, st.budget.estimated, st.budget.sevenDay], ['accepting', 'normal', true, 0.33]);
  assert.match(renderPage(st), /estimated 0m old|estimated [^<]* old/);
  // A real reading replaces the estimate.
  feed([...real, est, { at: at(14), sevenDay: 0.335, fiveHour: 0.2, sevenDayResetsAt: 1 }]);
  assert.equal(status(store).budget.estimated, false);
});

test('an item page shows what was asked, how it ended, who decided and what the host did', () => {
  const store = fresh();
  const { effects } = apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'p', tier: 1, title: 'Ship it', expect: 'A <b> page' } }, { id: 'req-p' });
  ack(store, effects.map((e) => e.id), { note: 'plan written' });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:p' });
  apply(store, { type: 'STAND_IN_ANSWERED', answer: { ...sure, reason: 'small' } }, { to: 'item:p/decision:p:plan:1' });
  apply(store, { type: 'PERSON_DECIDED', choice: 'approve' }, { to: 'item:p/decision:p:plan:1' });
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
  assert.match(html, /<td class="m">person<\/td>/);
  assert.match(html, /small/, 'the stand-in\'s reason shows beside the person\'s decision');
  assert.ok(!html.includes('other'));
  assert.match(renderPage(status(store), { itemLinks: true }), /href="items\/p\.html"/);
});

test('logPrecedent effects are the decision log as soon as they are queued; harness decisions only acks them', () => {
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'p', tier: 1 } });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:p' });
  apply(store, { type: 'STAND_IN_ANSWERED', answer: { ...sure, reason: '<why>' } }, { to: 'item:p/decision:p:plan:1' });
  apply(store, { type: 'PERSON_DECIDED', choice: 'approve' }, { to: 'item:p/decision:p:plan:1' });
  assert.equal(readDecisionLog(store).length, 1, 'logged before anyone runs harness decisions');
  assert.deepEqual(logPrecedents(store), { acked: 1 });
  assert.deepEqual(logPrecedents(store), { acked: 0 });
  const rows = readDecisionLog(store);
  assert.equal(rows[0].item, 'p');
  assert.deepEqual([rows[0].decidedBy, rows[0].autonomy], ['person', 'recommend'], 'the log keeps the rung the decision opened with');
  assert.ok(!store.pending().some((e) => e.name === 'logPrecedent'));
  const [plan] = classStats(rows);
  assert.deepEqual([plan.decisions, plan.agreement, plan.earnedAct], [1, 1, false]);
  const many = Array.from({ length: 20 }, () => ({ ...rows[0], decidedBy: 'person' }));
  assert.equal(classStats(many)[0].earnedAct, true);
  const html = renderDecisionLog(rows);
  assert.match(html, /recommend/);
  assert.match(html, /&lt;why&gt;/);
});

test('a decision takes its autonomy from the ladder when it opens; no log, an unreadable log or an unknown class leaves it at recommend', () => {
  const plan = (store, id) => `item:${id}/decision:${id}:plan:1`;
  const open = (store, id) => {
    apply(store, { type: 'REQUEST_RECEIVED', request: { id, tier: 1 } });
    apply(store, { type: 'RUN_SUCCEEDED' }, { to: `item:${id}` });
    return store.read().snapshot.children[id].snapshot.children[`decision:${id}:plan:1`].snapshot.context;
  };
  const answer = (store, to, answer) => names(apply(store, { type: 'STAND_IN_ANSWERED', answer }, { to }));

  // No log: recommend, so even a sure stand-in goes to the person.
  const none = fresh();
  assert.deepEqual([open(none, 'p').autonomy, open(none, 'p2').threshold], ['recommend', 0.9]);
  assert.deepEqual(answer(none, plan(none, 'p'), { choice: 'approve', confidence: 0.99 }), ['postDecisionCard']);

  // Earned for plan: alone at or above the machine's threshold, to the person below it.
  const earned = fresh();
  earn(earned, 'plan');
  assert.equal(open(earned, 'p').autonomy, 'act');
  open(earned, 'q');
  assert.ok(answer(earned, plan(earned, 'p'), { choice: 'approve', confidence: 0.9 }).includes('dispatchRun'), 'at the threshold');
  assert.deepEqual(answer(earned, plan(earned, 'q'), { choice: 'approve', confidence: 0.85 }), ['postDecisionCard'], 'below it');
  // A class with no log of its own (accept) is at recommend, however plan has done.
  apply(earned, { type: 'RUN_SUCCEEDED', pr: 'https://github.com/o/r/pull/1' }, { to: 'item:p' });
  apply(earned, { type: 'CHECKS_PASSED' }, { to: 'item:p' });
  const accept = status(earned).items.find((i) => i.id === 'p').decisions[0];
  assert.deepEqual([accept.decisionClass, accept.autonomy], ['accept', 'recommend']);
  assert.deepEqual(answer(earned, accept.address, { choice: 'approve', confidence: 0.99 }), ['postDecisionCard']);

  // A log that cannot be read counts as no log.
  const broken = fresh();
  mkdirSync(join(broken.dir, 'audits'));
  writeFileSync(join(broken.dir, 'audits', '2026-01-01.json'), 'not json');
  earn(broken, 'plan');
  assert.equal(open(broken, 'p').autonomy, 'recommend');

  // No confidence: refused, and nothing is written.
  const before = none.read().version;
  const r = apply(none, { type: 'STAND_IN_ANSWERED', answer: { choice: 'approve' } }, { to: plan(none, 'p2') });
  assert.deepEqual([r.refused, none.read().version], [true, before]);
});

const planRung = (store, id) => store.read().snapshot.children[id].snapshot.children[`decision:${id}:plan:1`].snapshot.context.autonomy;
// The person decides one plan decision on item id, agreeing with the stand-in's lean or reversing it; returns the rung it opened with.
const decidePlan = (store, id, choice, now) => {
  apply(store, { type: 'REQUEST_RECEIVED', request: { id, tier: 1 } }, { now });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: `item:${id}`, now });
  const to = `item:${id}/decision:${id}:plan:1`;
  const rung = planRung(store, id);
  apply(store, { type: 'STAND_IN_ANSWERED', answer: { choice: 'approve', confidence: 0.5 } }, { to, now });
  assert.ok(!apply(store, { type: 'PERSON_DECIDED', choice }, { to, now }).refused);
  return rung;
};

test('a reversal lowers the rung of the very next decision with no extra command, and replay agrees', () => {
  const store = fresh({ wipLimit: 100 });
  for (let i = 0; i < 20; i++) decidePlan(store, `a${i}`, 'approve', `2026-10-27T10:${String(i).padStart(2, '0')}:00Z`);
  // Nobody runs harness decisions: the store's own records are the log.
  assert.ok(store.pending().some((e) => e.name === 'logPrecedent'));
  assert.equal(decidePlan(store, 'r', 'revise', '2026-10-27T11:00:00Z'), 'act', 'earned before the reversal');
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'next', tier: 1 } }, { now: '2026-10-27T11:00:01Z' });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:next', now: '2026-10-27T11:00:01Z' });
  assert.equal(planRung(store, 'next'), 'recommend', 'the reversal dropped plan a rung at once');
  const r = replay(store);
  assert.deepEqual([r.ok, r.firstDivergence, r.differences], [true, null, []]);
});

test('a record dated after a decision opens does not count toward its rung', () => {
  const store = fresh({ wipLimit: 100 });
  earn(store, 'plan');
  // A reversal recorded at noon; a decision opening at eleven (a backdated event) still sees act.
  decidePlan(store, 'r', 'revise', '2026-10-27T12:00:00Z');
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'early', tier: 1 } }, { now: '2026-10-27T11:00:00Z' });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:early', now: '2026-10-27T11:00:00Z' });
  assert.equal(planRung(store, 'early'), 'act');
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'late', tier: 1 } }, { now: '2026-10-27T12:00:01Z' });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:late', now: '2026-10-27T12:00:01Z' });
  assert.equal(planRung(store, 'late'), 'recommend');
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
  assert.ok(problems.some((p) => /version 9, expected 5/.test(p)));
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

test('replay rebuilds a store from its log and names a tampered state', () => {
  const store = fresh({ wipLimit: 2 });
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'p', tier: 2 } }, { id: 'req-p', now: '2026-10-26T10:00:00Z' });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:p', id: 'run-1', now: '2026-10-26T10:05:00Z' });
  apply(store, { type: 'STAND_IN_ANSWERED', answer: sure }, { to: 'item:p/decision:p:plan:1', id: 's-1', now: '2026-10-26T10:06:00Z' });
  const good = replay(store);
  assert.deepEqual([good.ok, good.events, good.firstDivergence, good.differences], [true, 4, null, []]);
  const state = store.read();
  state.snapshot.context.queued = ['ghost'];
  store.write({ ...state, version: state.version + 1 }, state.version);
  const bad = replay(store);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.differences, ['harness: context.queued differs']);
});

test('stalled lists in-flight items quiet for longer than the limit, and the page shows when each moved', () => {
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'old', tier: 0 } }, { now: '2026-10-26T08:00:00Z' });
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'new', tier: 0 } }, { now: '2026-10-26T09:50:00Z' });
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:old', now: '2026-10-26T08:30:00Z' });
  const now = Date.parse('2026-10-26T10:00:00Z');
  assert.deepEqual(stalled(status(store), store.events(), { afterMs: parseAfter('60m'), now }).map((i) => i.id), ['old']);
  assert.equal(parseAfter('2h'), 72e5);
  assert.throws(() => parseAfter('soon'), /--after/);
  assert.match(renderPage(status(store), { events: store.events() }), /moved \d+m ago/);
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
