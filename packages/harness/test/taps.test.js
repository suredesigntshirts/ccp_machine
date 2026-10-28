// M4: the person's decisions enter only through the machine, as taps on cards the machine asked for. A
// decision or the day's audit asks for a card (postDecisionCard, postAuditCard); the host's ack of that
// effect names the card's message id (CARD_POSTED); a tap is taken only with that id, from the person, with
// one of the card's options. The decision log reads AUDIT_ANSWERED events, never a file. No event carries
// `person`, and a person actor is only ever a bound tap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initialTransition, transition } from 'xstate';
import { machines } from '../src/machines.js';
import { openStore, init, status, ack, readDecisionLog, ladder, attention, pickAudit, openAudits, auditLine, verifyTaps, verifyTapsText, doctor, intakeRows } from '../src/index.js';
import { apply, start, logged, post, decide } from './send.js';
import { fakeGithub } from './github-fake.js';
import { tempDir } from './tmp.js';

const as = (id) => ({ actor: { kind: 'session', id }, source: { kind: 'cli', ref: 'harness send' } });
const tap = (card) => ({ actor: { kind: 'person', id: 'sd' }, source: { kind: 'tap', ref: card }, relayedBy: 'host' });
const sure = { choice: 'approve', confidence: 0.95, reason: 'small' };
const bin = new URL('../bin/harness.js', import.meta.url).pathname;
const run = (env, ...args) => {
  const e = { ...process.env, HARNESS_LIBRARY_DIR: tempDir('harness-lib-'), ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: e });
};
// Every file in the store with its size and time: a refused or read-only command leaves it as it was.
const files = (dir) => readdirSync(dir, { recursive: true }).sort().map((f) => [f, statSync(join(dir, f)).size, statSync(join(dir, f)).mtimeMs]);
const counts = (store) => [store.read().version, store.events().length, store.outbox().length, store.acks().length];
const refused = (store, event, to, label, now) => {
  const before = counts(store);
  const r = apply(store, event, { to, ...(now && { now }) });
  assert.equal(r.refused, true, label);
  assert.deepEqual(counts(store), before, `${label}: nothing written`);
  return r;
};

const fresh = () => {
  const store = openStore(tempDir('harness-taps-'));
  init(store);
  start(store);
  return store;
};
// Item `id` at tier 2 with its plan decision in front of the person; returns the decision's address.
const awaiting = (store, id) => {
  apply(store, { type: 'REQUEST_RECEIVED', request: { id }, ...as('orchestrator') });
  apply(store, { type: 'TRIAGED', tier: 2, criteria: [`${id} works`], ...as('triager') }, { to: `item:${id}` });
  apply(store, { type: 'STAND_IN_ANSWERED', answer: sure, ...as('stand-in') }, { to: `item:${id}/decision:${id}:plan:1` });
  return `item:${id}/decision:${id}:plan:1`;
};
const cardEffect = (store, to) => store.pending().find((e) => e.name === 'postDecisionCard' && e.detail.address === to);

// 1. A card exists only because the machine asked for it, and a tap is bound to it.

test('the decision machine holds its card: no tap decides before CARD_POSTED, and only a tap on that card after', () => {
  const [opened] = initialTransition(machines.decision, { id: 'decision:a:plan:1', decisionClass: 'plan', tier: 2 });
  const [waiting] = transition(machines.decision, opened, { type: 'STAND_IN_FAILED' });
  assert.equal(waiting.value, 'awaitingPerson');
  const decided = (s, choice, card) => s.can({ type: 'PERSON_DECIDED', choice, ...tap(card) });
  assert.equal(decided(waiting, 'approve', 'cmsg_a'), false, 'no card posted: no tap decides');
  assert.equal(waiting.can({ type: 'CARD_POSTED', card: 'cmsg_a', ...tap('cmsg_a') }), false, 'the person does not post cards');
  assert.equal(waiting.can({ type: 'CARD_POSTED', card: 'posted', ...as('orchestrator') }), false, 'a card is a message id');
  const [posted] = transition(machines.decision, waiting, { type: 'CARD_POSTED', card: 'cmsg_a', ...as('orchestrator') });
  assert.equal(posted.context.card, 'cmsg_a');
  assert.equal(posted.can({ type: 'CARD_POSTED', card: 'cmsg_b', ...as('orchestrator') }), false, 'one card per decision, recorded once');
  assert.equal(decided(posted, 'approve', 'cmsg_b'), false, 'another card');
  assert.equal(decided(posted, 'maybe', 'cmsg_a'), false, 'not one of the card\'s options');
  assert.equal(posted.can({ type: 'PERSON_DECIDED', choice: 'approve', actor: { kind: 'person', id: 'sd' }, source: { kind: 'cli', ref: 'cmsg_a' } }), false, 'not a tap');
  for (const choice of ['approve', 'revise', 'reject']) assert.equal(decided(posted, choice, 'cmsg_a'), true, choice);
});

test('through the store: the ack of the decision\'s own postDecisionCard names the card, and only a tap on it decides', () => {
  const store = fresh();
  const a = awaiting(store, 'a');
  const b = awaiting(store, 'b');
  refused(store, { type: 'PERSON_DECIDED', choice: 'approve', ...tap('cmsg_a1') }, a, 'a tap on a card never posted');
  const effect = cardEffect(store, a);
  assert.ok(effect, 'the decision asked for its card');
  // A card's ack must name its message id; anything else acks nothing and writes nothing.
  const before = counts(store);
  assert.throws(() => ack(store, [effect.id], { note: 'posted it', by: as('orchestrator') }), /cmsg_/);
  assert.throws(() => ack(store, [effect.id], { note: 'cmsg_a1', by: as('orchestrator') }), /--card/, '--note never carries the card');
  assert.deepEqual(counts(store), before, 'an ack without a message id changes nothing');
  ack(store, [effect.id], { card: 'cmsg_a1', by: as('orchestrator') });
  // The effect has its card: a second ack, with the same id or another, is refused and writes nothing.
  const posted = counts(store);
  assert.throws(() => ack(store, [effect.id], { card: 'cmsg_a1', by: as('orchestrator') }), /already has its card/);
  assert.throws(() => ack(store, [effect.id], { card: 'cmsg_a9', by: as('orchestrator') }), /already has its card/);
  assert.deepEqual(counts(store), posted, 'a re-ack writes nothing');
  assert.deepEqual(store.events().findLast((e) => e.event.type === 'CARD_POSTED').event, { type: 'CARD_POSTED', card: 'cmsg_a1', effect: effect.id });
  assert.equal(store.events().findLast((e) => e.event.type === 'CARD_POSTED').to, a);
  assert.equal(status(store).items.find((i) => i.id === 'a').decisions[0].card, 'cmsg_a1');
  // b's card cannot reuse a's message id, and a's tap cannot land on b.
  assert.throws(() => ack(store, [cardEffect(store, b).id], { card: 'cmsg_a1', by: as('orchestrator') }), /cmsg_a1/);
  ack(store, [cardEffect(store, b).id], { card: 'cmsg_b1', by: as('orchestrator') });
  refused(store, { type: 'PERSON_DECIDED', choice: 'approve', ...tap('cmsg_b1') }, a, 'another decision\'s card');
  refused(store, { type: 'PERSON_DECIDED', choice: 'approve', ...tap('cmsg_a1') }, b, 'another decision\'s card, the other way');
  refused(store, { type: 'PERSON_DECIDED', choice: 'merge', ...tap('cmsg_a1') }, a, 'a choice the card did not offer');
  refused(store, { type: 'CARD_POSTED', card: 'cmsg_a2', effect: effect.id, ...as('orchestrator') }, a, 'a second card');
  assert.ok(!apply(store, { type: 'PERSON_DECIDED', choice: 'approve', ...tap('cmsg_a1') }, { to: a }).refused);
  assert.match(status(store).items.find((i) => i.id === 'a').state, /building/);
});

test('send refuses CARD_POSTED: only harness ack --card sends it, once; a tap records the session that relayed it', () => {
  const dir = tempDir('harness-taps-cli-');
  const orch = { CLAUDE_CODE_SESSION_ID: 'orch' };
  assert.equal(run(orch, 'init', '--dir', dir).status, 0);
  run(orch, 'send', '{"type":"REQUEST_RECEIVED","request":{"id":"a"}}', '--dir', dir);
  run({ CLAUDE_CODE_SESSION_ID: 'tri' }, 'send', '{"type":"TRIAGED","tier":2,"criteria":["a works"]}', '--to', 'item:a', '--dir', dir);
  run({ CLAUDE_CODE_SESSION_ID: 'si' }, 'answer', 'a', '--approve', '--reason', 'small', '--confidence', '0.5', '--dir', dir);
  const to = 'item:a/decision:a:plan:1';
  const before = files(dir);
  const direct = run(orch, 'send', '{"type":"CARD_POSTED","card":"cmsg_x"}', '--to', to, '--dir', dir);
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /CARD_POSTED.*harness ack/);
  assert.deepEqual(files(dir), before);
  const effect = JSON.parse(run(orch, 'effects', '--dir', dir).stdout).find((e) => e.name === 'postDecisionCard');
  const byNote = run(orch, 'ack', effect.id, '--note', 'cmsg_x', '--dir', dir);
  assert.equal(byNote.status, 1, '--note does not name the card');
  assert.deepEqual(files(dir), before);
  const r = run(orch, 'ack', effect.id, '--card', 'cmsg_x', '--dir', dir);
  assert.equal(r.status, 0, r.stderr);
  const acked = files(dir);
  const again = run(orch, 'ack', effect.id, '--card', 'cmsg_x2', '--dir', dir);
  assert.equal(again.status, 1, 're-acking an effect that has its card');
  assert.match(again.stderr, /already has its card/);
  assert.deepEqual(files(dir), acked, 'the refused re-ack writes nothing');
  const tapIt = (ref) => run(orch, 'send', '{"type":"PERSON_DECIDED","choice":"approve"}', '--to', to, '--actor', 'person:sd', '--source', `tap:${ref}`, '--dir', dir);
  assert.equal(tapIt('cmsg_y').status, 1, 'a tap on another card');
  assert.equal(tapIt('cmsg_x').status, 0, 'the tap on the posted card');
  const row = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.equal(row.relayedBy, 'orch', 'the tap names the session that relayed it');
  assert.equal(run(orch, 'verify-taps', '--store', dir).stdout.trim().endsWith('relayed by orch'), true);
});

// 7. Every person-actor event is a bound tap; this closes the M3 bypass (RUN_SUCCEEDED --actor person:tri).

test('a person actor with any source but a bound tap is refused, on every event, and the store stays unchanged', () => {
  const store = fresh();
  const a = awaiting(store, 'a');
  post(store, a, 'cmsg_a1');
  decide(store, a, 'approve', 'cmsg_a1');
  const person = (source) => ({ actor: { kind: 'person', id: 'tri' }, source });
  for (const source of [{ kind: 'cli', ref: 'h' }, { kind: 'timer', ref: 't' }, { kind: 'tap', ref: 'cmsg_a1' }, { kind: 'tap', ref: 'cmsg_new' }]) {
    refused(store, { type: 'RUN_SUCCEEDED', ...person(source) }, 'item:a', `RUN_SUCCEEDED as person from ${source.kind}:${source.ref}`);
    refused(store, { type: 'BLOCK', reason: 'x', ...person(source) }, 'item:a', `BLOCK as person from ${source.kind}`);
    refused(store, { type: 'REQUEST_RECEIVED', request: { id: 'z' }, ...person(source) }, undefined, `REQUEST_RECEIVED as person from ${source.kind}`);
  }
  // A tap is the person's: a session cannot send one.
  refused(store, { type: 'RUN_SUCCEEDED', actor: { kind: 'session', id: 'worker' }, source: { kind: 'tap', ref: 'cmsg_a1' }, relayedBy: 'host' }, 'item:a', 'a session with a tap source');
  assert.ok(!apply(store, { type: 'RUN_SUCCEEDED', ...as('worker') }, { to: 'item:a' }).refused, 'the worker still builds');
});

test('the CLI refuses the M3 bypass: RUN_SUCCEEDED --actor person:tri, from cli or a tap, writes nothing', () => {
  const dir = tempDir('harness-taps-cli-');
  const orch = { CLAUDE_CODE_SESSION_ID: 'orch' };
  run(orch, 'init', '--dir', dir);
  run(orch, 'send', '{"type":"REQUEST_RECEIVED","request":{"id":"x"}}', '--dir', dir);
  run({ CLAUDE_CODE_SESSION_ID: 'tri' }, 'send', '{"type":"TRIAGED","tier":0,"criteria":["x works"]}', '--to', 'item:x', '--dir', dir);
  const before = files(dir);
  for (const source of ['cli:h', 'tap:cmsg_1', 'timer:t']) {
    const r = run({ CLAUDE_CODE_SESSION_ID: 'tri' }, 'send', '{"type":"RUN_SUCCEEDED"}', '--to', 'item:x', '--actor', 'person:tri', '--source', source, '--dir', dir);
    assert.equal(r.status, 1, source);
    assert.match(r.stderr, /refused: RUN_SUCCEEDED/, source);
  }
  assert.deepEqual(files(dir), before);
});

test('the requester role is pinned: the session that filed an item cannot answer, build or check it', () => {
  const store = fresh();
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'r' }, ...as('filer') });
  apply(store, { type: 'TRIAGED', tier: 1, criteria: ['r works'], ...as('triager') }, { to: 'item:r' });
  const d = 'item:r/decision:r:plan:1';
  refused(store, { type: 'STAND_IN_ANSWERED', answer: sure, ...as('filer') }, d, 'the requester answers its own plan');
  apply(store, { type: 'STAND_IN_FAILED', ...as('orchestrator') }, { to: d });
  decide(store, d, 'approve');
  refused(store, { type: 'RUN_SUCCEEDED', ...as('filer') }, 'item:r', 'the requester builds');
  apply(store, { type: 'RUN_SUCCEEDED', ...as('worker') }, { to: 'item:r' });
  refused(store, { type: 'CRITERION_CHECKED', criterion: 'r works', verdict: 'met', evidence: 'mine', ...as('filer') }, 'item:r', 'the requester checks');
});

// 3. No event carries `person`: it is refused. The person's touches are cards and taps.

test('an event carrying `person` is refused, and intake files the request box without it', () => {
  const store = fresh();
  const r = refused(store, { type: 'REQUEST_RECEIVED', request: { id: 'p' }, person: true, ...as('orchestrator') }, undefined, 'person: true');
  assert.match(r.why, /person/);
  refused(store, { type: 'REQUEST_RECEIVED', request: { id: 'p' }, person: false, ...as('orchestrator') }, undefined, 'person: false');
  const out = intakeRows(store, [{ id: 'row1', data: { title: 'Add a thing', status: 'new' } }], { by: as('orchestrator') });
  assert.equal(out.filed.length, 1);
  assert.equal('person' in store.events().at(-1).event, false);
});

test('attention counts posted cards, taps and audit answers, never a flag', () => {
  const store = fresh();
  const a = awaiting(store, 'a');
  const records = () => ({ events: store.events(), outbox: store.outbox(), acks: store.acks(), decisions: readDecisionLog(store) });
  const item = () => status(store).items.find((i) => i.id === 'a');
  assert.equal(attention(item(), records()).touches, 0, 'a card the machine asked for but nobody posted is no touch');
  post(store, a, 'cmsg_a1');
  assert.deepEqual([attention(item(), records()).cards, attention(item(), records()).touches], [1, 1]);
  decide(store, a, 'revise', 'cmsg_a1');
  const m = attention(item(), records());
  assert.deepEqual([m.cards, m.taps, m.touches], [1, 1, 2]);
});

// 2. The audit is a machine flow; audits/<day>.json is neither written nor read.

const standIn = (n, cls, confidence, at) => ({ effectId: `s${n}`, at, item: `i${n}`, decision: `decision:i${n}:${cls}:1`, decisionClass: cls, tier: 1, choice: 'approve', decidedBy: 'stand-in', standIn: { choice: 'approve', confidence, reason: 'looks fine' } });

test('the day\'s audit: AUDIT_PICKED opens it and asks for a card, AUDIT_ANSWERED is a tap on that card, and the log reads the event', () => {
  const store = fresh();
  logged(store, [standIn(1, 'plan', 0.9, '2026-10-26T10:00:00Z'), standIn(2, 'plan', 0.8, '2026-10-26T10:01:00Z'), standIn(3, 'accept', 0.9, '2026-10-26T10:02:00Z')]);
  const day = '2026-10-26';
  const at = '2026-10-26T11:00:00Z';
  // The day is the event's own UTC day: a past or a future day is refused.
  refused(store, { type: 'AUDIT_PICKED', day: '2026-10-25', picks: ['s1'], ...as('orchestrator') }, undefined, 'a past day', at);
  refused(store, { type: 'AUDIT_PICKED', day: '2026-10-27', picks: ['s1'], ...as('orchestrator') }, undefined, 'a future day', at);
  refused(store, { type: 'AUDIT_PICKED', day: '2026-10-25', picks: ['s1'], receivedAt: '2026-10-25T00:00:00Z', ...as('orchestrator') }, undefined, 'the sender names its own time', at);
  const picked = pickAudit(store, { by: as('orchestrator'), now: at });
  assert.equal(picked.day, day);
  assert.deepEqual(picked.picks, ['s2', 's3', 's1']);
  assert.equal(store.outbox().find((e) => e.id === picked.effect).name, 'postAuditCard');
  assert.equal(auditLine(store, day), '3 to check, about 1 minute');
  assert.equal(openAudits(store).length, 1);
  assert.equal(readdirSync(store.dir).includes('audits'), false, 'no audits folder is written');
  // Once a day: a second pick for the day is refused.
  refused(store, { type: 'AUDIT_PICKED', day, picks: ['s1'], ...as('orchestrator') }, undefined, 'a second audit the same day', '2026-10-26T23:00:00Z');
  refused(store, { type: 'AUDIT_PICKED', day: '2026-10-27', picks: ['a', 'b', 'c', 'd'], ...as('orchestrator') }, undefined, 'more than 3 picks', '2026-10-27T01:00:00Z');
  refused(store, { type: 'AUDIT_PICKED', day: '2026-10-27', picks: ['s1'], ...tap('cmsg_x') }, undefined, 'the person does not pick', '2026-10-27T01:00:00Z');
  const to = `audit:${day}`;
  refused(store, { type: 'AUDIT_ANSWERED', option: 1, ...tap('cmsg_audit') }, to, 'an answer before the card is posted');
  ack(store, [picked.effect], { card: 'cmsg_audit', by: as('orchestrator') });
  refused(store, { type: 'AUDIT_ANSWERED', option: 1, ...as('orchestrator') }, to, 'a session answers');
  refused(store, { type: 'AUDIT_ANSWERED', option: 1, ...tap('cmsg_other') }, to, 'another card');
  refused(store, { type: 'AUDIT_ANSWERED', option: 4, ...tap('cmsg_audit') }, to, 'an option the card did not offer');
  refused(store, { type: 'AUDIT_ANSWERED', option: -1, ...tap('cmsg_audit') }, to, 'a negative option');
  refused(store, { type: 'AUDIT_ANSWERED', option: '1', ...tap('cmsg_audit') }, to, 'an option that is not a number');
  refused(store, { type: 'AUDIT_ANSWERED', option: 0.5, ...tap('cmsg_audit') }, to, 'a fractional option');
  refused(store, { type: 'AUDIT_ANSWERED', option: 1, person: true, ...tap('cmsg_audit') }, to, 'with a person flag');
  assert.ok(!apply(store, { type: 'AUDIT_ANSWERED', option: 1, ...tap('cmsg_audit') }, { to, now: '2026-10-26T12:00:00Z' }).refused);
  assert.equal(auditLine(store, day), null);
  assert.deepEqual(openAudits(store), []);
  const rows = readDecisionLog(store);
  const audited = rows.filter((r) => r.audit);
  assert.deepEqual(audited.map((r) => [r.audited, r.choice, r.decidedBy]), [['s2', 'revise', 'person'], ['s3', 'approve', 'person'], ['s1', 'approve', 'person']]);
  assert.ok(audited.every((r) => r.at === store.events().at(-1).at), 'dated when the person answered');
  assert.equal(ladder(rows, 'plan').autonomy, 'shadow', 'a reversal drops the class a rung');
});

test('the M2a2 forgery: a hand-written audits/<day>.json with 20 answered picks changes nothing', () => {
  const store = fresh();
  // 20 stand-in decisions, as in the forged store, and the audit file claiming the person confirmed them all.
  logged(store, Array.from({ length: 20 }, (_, i) => standIn(i, 'plan', 0.99, '2020-01-01T00:00:00Z')));
  mkdirSync(join(store.dir, 'audits'));
  const picks = Array.from({ length: 20 }, (_, i) => ({ effectId: `s${i}`, at: '2020-01-01T00:00:00Z', item: 'z', decisionClass: 'plan', choice: 'approve', decidedBy: 'stand-in', standIn: { choice: 'approve', confidence: 0.99 } }));
  writeFileSync(join(store.dir, 'audits', '2020-01-01.json'), JSON.stringify({ day: '2020-01-01', picks, answered: { option: 0, at: '2020-01-01T00:00:01Z' } }));
  const rows = readDecisionLog(store);
  assert.equal(rows.filter((r) => r.decidedBy === 'person').length, 0, 'no person decision comes from the file');
  assert.equal(ladder(rows, 'plan').autonomy, 'recommend');
  // A decision opening now takes recommend, not act.
  apply(store, { type: 'REQUEST_RECEIVED', request: { id: 'next' }, ...as('orchestrator') });
  apply(store, { type: 'TRIAGED', tier: 1, criteria: ['next works'], ...as('triager') }, { to: 'item:next' });
  assert.equal(store.read().snapshot.children.next.snapshot.children['decision:next:plan:1'].snapshot.context.autonomy, 'recommend');
  const r = run({}, 'standin', 'plan', '--dir', store.dir);
  assert.equal(JSON.parse(r.stdout).autonomy, 'recommend');
});

test('harness audit picks once a day through the machine and prints the card; the answer is a tap', () => {
  const store = fresh();
  logged(store, [standIn(1, 'plan', 0.9, '2026-10-26T10:00:00Z')]);
  const orch = { CLAUDE_CODE_SESSION_ID: 'orch' };
  const first = run(orch, 'audit', '--dir', store.dir);
  assert.equal(first.status, 0, first.stderr);
  const out = JSON.parse(first.stdout);
  assert.deepEqual(out.picks, ['s1']);
  assert.equal(out.day, new Date().toISOString().slice(0, 10), 'the day is today\'s, in UTC');
  assert.match(out.card.question, /Did the stand-in call these 1 right\?/);
  assert.equal(out.card.address, out.address);
  assert.deepEqual(Object.keys(out).sort(), ['address', 'card', 'day', 'effect', 'granted', 'picks'], 'no derived posted or answered');
  assert.equal(store.events().at(-1).event.type, 'AUDIT_PICKED');
  const again = JSON.parse(run(orch, 'audit', '--dir', store.dir).stdout);
  assert.equal(again.effect, out.effect, 'the same audit, not a second one');
  assert.equal(store.events().filter((e) => e.event.type === 'AUDIT_PICKED').length, 1);
  const old = run(orch, 'audit', '--answer', '0', '--dir', store.dir);
  assert.equal(old.status, 2, '--answer is gone: the answer is a tap');
});

// 4. verify-taps lists every tap for another session to check; it never writes.

test('harness verify-taps: one line per tap with its card, decision and claimed choice; never writes', () => {
  const store = fresh();
  const a = awaiting(store, 'a');
  post(store, a, 'cmsg_a1');
  decide(store, a, 'revise', 'cmsg_a1');
  logged(store, [standIn(1, 'plan', 0.9, '2026-10-26T10:00:00Z')]);
  const { effect } = pickAudit(store, { by: as('orchestrator'), now: '2026-10-26T11:00:00Z' });
  ack(store, [effect], { card: 'cmsg_audit', by: as('orchestrator') });
  apply(store, { type: 'AUDIT_ANSWERED', option: 0, ...tap('cmsg_audit') }, { to: 'audit:2026-10-26' });
  const rows = verifyTaps(store);
  assert.deepEqual(rows.map((r) => [r.card, r.to, r.type, r.choice, r.relayedBy]), [
    ['cmsg_a1', a, 'PERSON_DECIDED', 'revise', 'host'],
    ['cmsg_audit', 'audit:2026-10-26', 'AUDIT_ANSWERED', 0, 'host']
  ]);
  assert.equal('option' in rows[0], false, 'the choice only, no option index');
  const text = verifyTapsText(rows).split('\n');
  assert.equal(text.length, 2);
  assert.match(text[0], /card cmsg_a1 item:a\/decision:a:plan:1 PERSON_DECIDED choice "revise" by person:person relayed by host$/);
  const before = files(store.dir);
  const r = run({}, 'verify-taps', '--store', store.dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), text);
  assert.deepEqual(files(store.dir), before, 'verify-taps never writes');
  assert.equal(run({}, 'verify-taps', '--store', tempDir('harness-empty-')).status, 2, 'no events.jsonl: nothing to verify');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /verify-taps[^]*checked by a session other than the one that sent the taps/);
});

// 4. doctor: a problem (exit 1) is a mismatch or a ledger missing for an older event; what cannot be checked yet is
// unverifiable (exit 0, listed): a fact GitHub could not be reached for, a ledger not filed for an event under 10 minutes old.

const ledger = (lib, id) => {
  const dir = join(lib, 'ledger', 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ session: { sessionId: id, start: '2000-01-01T00:00:00Z', end: '2100-01-01T00:00:00Z', turns: [] } }));
};
const merged = (store, at) => store.appendEvents([{ id: 'forged', version: store.read().version + 1, at, to: 'item:a', actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref: 'o/r#1:merged@' + 'a'.repeat(40) }, event: { type: 'MERGED' } }]);

test('doctor is one function: problems are mismatches and old unfiled ledgers, unverifiable is what cannot be checked yet', async () => {
  const store = fresh();
  awaiting(store, 'a');
  const lib = tempDir('harness-lib-');
  const ledgers = join(lib, 'ledger', 'sessions');
  const last = Math.max(...store.events().map((e) => Date.parse(e.at)));
  const at = (ms) => doctor(store, { now: last + ms, ledgers, fetcher: fakeGithub() });
  // Under 10 minutes since the session's last event: its ledger may not be filed yet.
  const fresh5 = await at(5 * 60_000);
  assert.equal(fresh5.ok, true, fresh5.problems.join('\n'));
  assert.match(fresh5.unverifiable.join('\n'), /verify-actors: no ledger session:orchestrator/);
  // Older: a missing ledger is a problem.
  const old = await at(11 * 60_000);
  assert.equal(old.ok, false);
  assert.match(old.problems.join('\n'), /verify-actors: no ledger session:orchestrator/);
  for (const id of new Set(store.events().filter((e) => e.actor?.kind === 'session').map((e) => e.actor.id))) ledger(lib, id);
  const filed = await at(11 * 60_000);
  assert.deepEqual([filed.ok, filed.unverifiable], [true, []], filed.problems.join('\n'));
  // A fact GitHub does not back is a problem (an unreachable one is unverifiable: test/github-facts.test.js).
  merged(store, new Date(last).toISOString());
  const forged = await doctor(store, { now: last, ledgers, fetcher: fakeGithub() });
  assert.equal(forged.ok, false);
  assert.match(forged.problems.join('\n'), /verify-facts: mismatch forged/);
  // The CLI: exit 1 on a problem, 0 when only unverifiable.
  const cli = run({ HARNESS_LIBRARY_DIR: tempDir('harness-lib-'), GH_TOKEN: '' }, 'doctor', '--dir', fresh().dir);
  assert.equal(cli.status, 0, 'a session that has just acted has no ledger yet: unverifiable, not a problem');
  assert.match(JSON.parse(cli.stdout).unverifiable.join('\n'), /verify-actors: no ledger/);
});

// 6. Pins for the M4 verifier's surviving mutations.

test('the audit machine takes one card: a second CARD_POSTED, or one that is not a message id, is refused', () => {
  const store = fresh();
  logged(store, [standIn(1, 'plan', 0.9, '2026-10-26T10:00:00Z')]);
  const { address, effect } = pickAudit(store, { by: as('orchestrator'), now: '2026-10-26T11:00:00Z' });
  refused(store, { type: 'CARD_POSTED', card: 'posted', effect, ...as('orchestrator') }, address, 'not a message id');
  assert.ok(!apply(store, { type: 'CARD_POSTED', card: 'cmsg_one', effect, ...as('orchestrator') }, { to: address }).refused);
  refused(store, { type: 'CARD_POSTED', card: 'cmsg_two', effect, ...as('orchestrator') }, address, 'a second card for the audit');
  assert.equal(openAudits(store)[0].card, 'cmsg_one');
});

test('an audit pick that names the person\'s own decision teaches nothing: only stand-in decisions become audit rows', () => {
  const store = fresh();
  logged(store, [standIn(1, 'plan', 0.9, '2026-10-26T10:00:00Z'), { ...standIn(2, 'plan', 0.9, '2026-10-26T10:01:00Z'), decidedBy: 'person' }]);
  const now = '2026-10-26T11:00:00Z';
  assert.ok(!apply(store, { type: 'AUDIT_PICKED', day: '2026-10-26', picks: ['s1', 's2'], ...as('orchestrator') }, { now }).refused);
  post(store, 'audit:2026-10-26', 'cmsg_audit');
  assert.ok(!apply(store, { type: 'AUDIT_ANSWERED', option: 2, ...tap('cmsg_audit') }, { to: 'audit:2026-10-26', now }).refused);
  assert.deepEqual(readDecisionLog(store).filter((r) => r.audit).map((r) => [r.audited, r.choice]), [['s1', 'approve']]);
});

test('a card effect is acked on its own: with another effect, or twice in one ack, it is refused and nothing is written', () => {
  const store = fresh();
  const a = awaiting(store, 'a');
  const card = cardEffect(store, a);
  const other = store.pending().find((e) => e.id !== card.id);
  const before = counts(store);
  assert.throws(() => ack(store, [card.id, other.id], { card: 'cmsg_a1', by: as('orchestrator') }), /acked on its own/);
  assert.throws(() => ack(store, [other.id, card.id], { card: 'cmsg_a1', by: as('orchestrator') }), /acked on its own/);
  assert.throws(() => ack(store, [card.id, card.id], { card: 'cmsg_a1', by: as('orchestrator') }), /acked on its own/);
  assert.deepEqual(counts(store), before);
  assert.equal(store.events().some((e) => e.event.type === 'CARD_POSTED'), false);
});

// 3. A tap names the session that relayed it; inside a Claude Code session one without it is refused.

test('a tap without the session that relayed it is refused when a session id is set, and kept on the log row when given', () => {
  const store = fresh();
  const a = awaiting(store, 'a');
  post(store, a, 'cmsg_a1');
  const saved = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'host';
  try {
    const { relayedBy, ...bare } = { type: 'PERSON_DECIDED', choice: 'approve', ...tap('cmsg_a1') };
    assert.match(refused(store, bare, a, 'no relaying session').why, /relayedBy/);
    assert.ok(!apply(store, { ...bare, relayedBy }, { to: a }).refused);
    assert.equal(store.events().at(-1).relayedBy, 'host');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = saved;
  }
});
