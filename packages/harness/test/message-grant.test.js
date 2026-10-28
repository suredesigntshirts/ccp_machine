// The person's grant in their own words (#54): the same PERSON_GRANTED {picks} as the checklist tap, from a chat
// message named by its id (source message:<cmsg id>), sent to the harness itself. Each test drives a real store
// through runtime.apply() or the CLI, the way the host does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tempDir } from './tmp.js';
import { apply, start, post } from './send.js';
import { openStore, init, ack, status, apply as applyEvent, readDecisionLog, logPrecedents, renderPage, renderLivePage, verifyTaps, verifyTapsText } from '../src/index.js';

const T0 = '2026-10-28T10:00:00.000Z';
const at = (minutes) => new Date(Date.parse(T0) + minutes * 6e4).toISOString();
const MSG = 'cmsg_01CRqZ2YoFXkbgk5p24fe6KkAzi1XSmfFULC3PS9A7Wqtt';
// "Stop asking": every kind, one-way included, no end time.
const STOP_ASKING = ['kind:plan', 'kind:accept', 'kind:merge', 'one-way'];
const person = { actor: { kind: 'person', id: 'sd' } };
const fromMessage = (ref = MSG) => ({ ...person, source: { kind: 'message', ref }, relayedBy: 'sim-orchestrator' });
const session = (id) => ({ actor: { kind: 'session', id }, source: { kind: 'cli', ref: 'harness send' } });
const bin = new URL('../bin/harness.js', import.meta.url).pathname;
const harness = (dir, env, ...args) => spawnSync(process.execPath, [bin, ...args, '--dir', dir], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });

function fresh() {
  const store = openStore(tempDir('harness-message-grant-'));
  init(store, {}, T0);
  start(store, T0);
  return store;
}
const said = (store, picks = STOP_ASKING, { now = T0, by = fromMessage() } = {}) => applyEvent(store, { type: 'PERSON_GRANTED', picks, ...by }, { now });
const liveGrant = (store) => store.read().snapshot.context.grant;
const counts = (store) => [store.read().version, store.events().length, store.outbox().length];

/** An item at tier `tier` whose plan decision is open and waiting on the stand-in. */
function itemAtPlan(store, id = 'x', tier = 2, now = T0) {
  apply(store, { type: 'REQUEST_RECEIVED', request: { id } }, { now });
  ack(store, store.pending().filter((e) => e.name === 'dispatchRun').map((e) => e.id));
  apply(store, { type: 'RUN_FAILED' }, { to: `item:${id}`, now });
  apply(store, { type: 'TRIAGED', tier, criteria: ['a works'] }, { to: `item:${id}`, now });
  return `item:${id}/decision:${id}:plan:1`;
}
const answer = (store, to, now, reason = 'covered by the standing grant') =>
  apply(store, { type: 'STAND_IN_ANSWERED', answer: { choice: 'approve', confidence: 0.95, reason } }, { to, now });

test('the person grants in their own words: a message names the grant, with kinds, the one-way box and no end time', () => {
  const store = fresh();
  const r = said(store);
  assert.equal(r.refused, undefined, r.why);
  assert.deepEqual(liveGrant(store), { message: MSG, kinds: ['plan', 'accept', 'merge'], oneWay: true, until: null, at: T0 });
  const row = store.events().at(-1);
  assert.deepEqual([row.to, row.source, row.relayedBy], ['harness', { kind: 'message', ref: MSG }, 'sim-orchestrator']);
  // An end time read from the words is kept; a later message replaces the grant whole, and one with no kind ends it.
  said(store, ['kind:plan', `until:${at(120)}`], { now: at(1), by: fromMessage('cmsg_later') });
  assert.deepEqual(liveGrant(store), { message: 'cmsg_later', kinds: ['plan'], oneWay: false, until: at(120), at: at(1) });
  said(store, [], { now: at(2), by: fromMessage('cmsg_off') });
  assert.deepEqual(liveGrant(store).kinds, []);
});

test('a message grant forged from a session, an agent, the lead or with no source is refused, and writes nothing', () => {
  const store = fresh();
  const forgeries = [
    session('worker'),
    { ...session('sim-orchestrator'), source: { kind: 'message', ref: MSG } }, // the lead, naming the message
    { actor: { kind: 'session', id: 'sim-orchestrator' }, source: { kind: 'message', ref: MSG }, relayedBy: 'sim-orchestrator' },
    { actor: { kind: 'agent', id: 'sim-orchestrator/a1' }, source: { kind: 'message', ref: MSG }, relayedBy: 'sim-orchestrator' },
    { actor: { kind: 'timer', id: 'tick' }, source: { kind: 'message', ref: MSG } },
    { ...person }, // no source
    { ...person, source: { kind: 'cli', ref: MSG } },
    { ...person, source: { kind: 'tap', ref: MSG }, relayedBy: 'host' }, // a tap grants only on its checklist
    { ...person, source: { kind: 'message', ref: '' }, relayedBy: 'host' },
    { ...person, source: { kind: 'message', ref: 'not a message id' }, relayedBy: 'host' },
    {}
  ];
  for (const by of forgeries) {
    const before = counts(store);
    assert.equal(said(store, STOP_ASKING, { by }).refused, true, JSON.stringify(by));
    assert.deepEqual(counts(store), before, `${JSON.stringify(by)}: a refusal writes nothing`);
  }
  // Picks must be the grant's own vocabulary, each once, with at most one end time and that one in the future.
  for (const bad of [['kind:deploy'], ['kind:plan', 'kind:plan'], ['kind:plan', `until:${at(60)}`, `until:${at(120)}`], ['kind:plan', `until:${at(-1)}`], ['kind:plan', 'until:soon'], ['oneWay'], 'kind:plan', [['kind:plan']], null])
    assert.equal(said(store, bad).refused, true, JSON.stringify(bad));
  // Under a session the CLI's envelope wants the session relaying a message, as for a tap.
  const { relayedBy, ...bare } = fromMessage();
  const before = counts(store);
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'lead';
  try { assert.match(said(store, STOP_ASKING, { by: bare }).why, /relayedBy/); } finally { if (prev == null) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prev; }
  assert.deepEqual(counts(store), before);
  assert.equal(liveGrant(store), null, 'nothing refused made a grant');
});

test('the CLI refuses a message grant from a session, the lead, a subagent or with no source; the person\'s message is relayed by its session', () => {
  const store = fresh();
  const event = JSON.stringify({ type: 'PERSON_GRANTED', picks: STOP_ASKING });
  const lead = { CLAUDE_CODE_SESSION_ID: 'sim-orchestrator' };
  for (const [env, flags, why] of [
    [lead, [], /needs --actor/],
    [lead, ['--source', `message:${MSG}`], /needs --actor/],
    [lead, ['--actor', 'session:sim-orchestrator', '--source', `message:${MSG}`], /refused: PERSON_GRANTED .*unattested/],
    [{ CLAUDE_CODE_SESSION_ID: 'other' }, ['--actor', 'session:other', '--source', `message:${MSG}`], /refused: PERSON_GRANTED .*unattested/],
    [lead, ['--actor', 'person:sd'], /needs --actor/],
    [{ ...lead, HARNESS_AGENT: 'a1:general-purpose' }, ['--actor', 'person:sd', '--source', `message:${MSG}`], /subagent/],
    [{ ...lead, HARNESS_AGENT: 'a1:general-purpose' }, ['--actor', 'agent:sim-orchestrator/a1', '--source', `message:${MSG}`], /HARNESS_CALL|refused/]
  ]) {
    const before = counts(store);
    const r = harness(store.dir, env, 'send', event, ...flags);
    assert.notEqual(r.status, 0, `${JSON.stringify(flags)}: ${r.stdout}`);
    assert.match(r.stderr + r.stdout, why, JSON.stringify(flags));
    assert.deepEqual(counts(store), before, `${JSON.stringify(flags)}: nothing written`);
  }
  const ok = harness(store.dir, lead, 'send', event, '--actor', 'person:sd', '--source', `message:${MSG}`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(liveGrant(store).kinds, ['plan', 'accept', 'merge']);
  assert.equal(store.events().at(-1).relayedBy, 'sim-orchestrator', 'the log names the session that relayed the message');
});

test('nothing else creates, widens or extends a grant: the checklist takes no message, GRANT_GIVEN and DECIDED_UNDER_GRANT none from outside', () => {
  const store = fresh();
  apply(store, { type: 'GRANT_ASKED' }, { now: T0 });
  const card = post(store, 'grant:1', 'cmsg_checklist');
  assert.equal(applyEvent(store, { type: 'PERSON_GRANTED', picks: ['kind:plan', `until:${new Date(Date.parse(T0) + 8 * 36e5).toISOString()}`], ...fromMessage(card) }, { to: 'grant:1', now: T0 }).refused, true, 'a checklist is answered only by a tap on it');
  for (const by of [session('sim-orchestrator'), fromMessage()]) {
    assert.equal(applyEvent(store, { type: 'GRANT_GIVEN', grant: { message: MSG, kinds: ['merge'], oneWay: true, until: null }, ...by }, { now: T0 }).refused, true);
    assert.equal(applyEvent(store, { type: 'DECIDED_UNDER_GRANT', row: { item: 'forged' }, ...by }, { now: T0 }).refused, true);
  }
  // A message decides nothing but a grant: the person's decision is a tap on its card.
  const plan = itemAtPlan(store, 'p', 2, at(1));
  apply(store, { type: 'STAND_IN_FAILED' }, { to: plan, now: at(1) });
  post(store, plan, 'cmsg_plan_card', at(1));
  assert.equal(applyEvent(store, { type: 'PERSON_DECIDED', choice: 'approve', ...fromMessage('cmsg_plan_card') }, { to: plan, now: at(2) }).refused, true);
  assert.equal(liveGrant(store), null);
});

test('under the standing grant a tier-2 item reaches merge with no tap: plan, accept and merge decided by the stand-in, authority grant, no card queued', () => {
  const store = fresh();
  said(store);
  const plan = itemAtPlan(store, 'x', 2, at(1));
  answer(store, plan, at(2));
  apply(store, { type: 'RUN_SUCCEEDED' }, { to: 'item:x', now: at(3) });
  apply(store, { type: 'CRITERION_CHECKED', criterion: 'a works', verdict: 'met', evidence: 'test a' }, { to: 'item:x', now: at(3) });
  apply(store, { type: 'CHECKS_PASSED' }, { to: 'item:x', now: at(3) });
  answer(store, 'item:x/decision:x:accept:2', at(4));
  answer(store, 'item:x/decision:x:merge:3', at(5));
  assert.equal(status(store).items[0].state, 'active.merging');
  assert.ok(!apply(store, { type: 'MERGED' }, { to: 'item:x', now: at(6) }).refused);
  assert.equal(status(store).items[0].done, true);
  assert.deepEqual(store.outbox().filter((e) => e.name === 'postDecisionCard'), [], 'no card was queued for the person');
  assert.deepEqual(status(store).waitingOnPerson, []);
  logPrecedents(store);
  const rows = readDecisionLog(store).filter((r) => r.item === 'x' || String(r.decision ?? '').includes(':x:'));
  assert.deepEqual(rows.map((r) => [r.decisionClass, r.decidedBy, r.authority, r.grant?.message]), [['plan', 'stand-in', 'grant', MSG], ['accept', 'stand-in', 'grant', MSG], ['merge', 'stand-in', 'grant', MSG]]);
  assert.deepEqual(store.read().snapshot.context.granted.map((g) => [g.decisionClass, g.door, g.message]), [['plan', 'two-way', MSG], ['accept', 'two-way', MSG], ['merge', 'one-way', MSG]]);
});

test('mission control shows the standing grant, its message and every decision made under it', () => {
  const store = fresh();
  said(store);
  answer(store, itemAtPlan(store, 'a', 2, at(1)), at(1), 'reason for a');
  const live = renderLivePage(store.read(), { now: at(10) });
  assert.match(live, new RegExp(`message ${MSG}`));
  assert.match(live, /plan, accept, merge, one-way doors included, no end time/);
  assert.match(live, /reason for a/);
  const page = renderPage(status(store));
  assert.match(page, new RegExp(`Your grant: plan, accept, merge, one-way doors included, no end time \\(message ${MSG}\\)`));
  assert.match(page, /reason for a/);
});

test('verify-taps lists every message grant with its message id, for another session to read', () => {
  const store = fresh();
  said(store);
  said(store, ['kind:plan', `until:${at(120)}`], { now: at(1), by: fromMessage('cmsg_later') });
  const rows = verifyTaps(store).filter((r) => r.type === 'PERSON_GRANTED');
  assert.deepEqual(rows.map((r) => [r.message, r.card, r.to, r.choice, r.by, r.relayedBy]), [
    [MSG, null, 'harness', STOP_ASKING, 'person:sd', 'sim-orchestrator'],
    ['cmsg_later', null, 'harness', ['kind:plan', `until:${at(120)}`], 'person:sd', 'sim-orchestrator']
  ]);
  assert.match(verifyTapsText(rows), new RegExp(`message ${MSG} harness PERSON_GRANTED`));
  const cli = harness(store.dir, {}, 'verify-taps');
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, new RegExp(`message ${MSG} harness PERSON_GRANTED choice`));
  assert.match(cli.stdout, /message cmsg_later/);
});
