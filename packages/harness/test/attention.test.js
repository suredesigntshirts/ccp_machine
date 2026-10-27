import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, init, apply, status, logPrecedents, readDecisionLog, attention, attentionText, touchesTrend, renderPage, renderDigest } from '../src/index.js';

const sure = { choice: 'approve', confidence: 0.95, threshold: 0.9, autonomy: 'act' };

test('attention counts the person\'s touches, the stand-in\'s decisions, turns and wall time per item', () => {
  const store = openStore(mkdtempSync(join(tmpdir(), 'harness-')));
  init(store, {}, '2026-10-26T09:00:00Z');
  const send = (event, to, now) => apply(store, event, { to, now });
  send({ type: 'REQUEST_RECEIVED', request: { id: 'p', tier: 2 } }, undefined, '2026-10-26T10:00:00Z');
  send({ type: 'RUN_SUCCEEDED', session: 's1' }, 'item:p', '2026-10-26T10:05:00Z');
  send({ type: 'STAND_IN_ANSWERED', answer: sure }, 'item:p/decision:p:plan:1', '2026-10-26T10:06:00Z');
  send({ type: 'PERSON_DECIDED', choice: 'revise', person: true }, 'item:p/decision:p:plan:1', '2026-10-26T10:30:00Z');
  send({ type: 'RUN_SUCCEEDED' }, 'item:p', '2026-10-26T10:40:00Z');
  send({ type: 'STAND_IN_ANSWERED', answer: sure }, 'item:p/decision:p:plan:2', '2026-10-26T10:41:00Z');
  send({ type: 'PERSON_DECIDED', choice: 'approve' }, 'item:p/decision:p:plan:2', '2026-10-26T10:42:00Z');
  send({ type: 'RUN_SUCCEEDED' }, 'item:p', '2026-10-26T10:50:00Z');
  send({ type: 'RUN_SUCCEEDED' }, 'item:p', '2026-10-26T10:55:00Z');
  send({ type: 'CHECKS_PASSED' }, 'item:p', '2026-10-26T11:00:00Z');
  logPrecedents(store);
  const records = { events: store.events(), outbox: store.outbox(), acks: store.acks(), decisions: readDecisionLog(store) };
  const item = status(store).items[0];
  const none = attention(item, records, '2026-10-26T11:00:00Z');
  assert.deepEqual([none.cards, none.personMessages, none.touches, none.reversed, none.turns], [2, 1, 3, 1, null]);
  assert.match(attentionText(none), /^3 touches · \d+ stand-in, 1 reversed · turns n\/a · 1\.0h$/);

  const turn = { index: 4, start: '2026-10-26T10:10:00Z', end: '2026-10-26T10:20:00Z', all: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 0.5 } };
  const withLedger = attention(item, { ...records, sessions: { s1: { turns: [turn] } } }, '2026-10-26T11:00:00Z');
  assert.deepEqual([withLedger.turns, withLedger.tokens, withLedger.cost], [1, 100, 0.5]);
});

test('mission control shows attention for finished items and the digest shows the touches trend', () => {
  const st = { version: 1, updatedAt: '2026-10-26T12:00:00Z', state: { scheduler: 'accepting' }, context: { inFlight: [], queued: [], wipLimit: 3 }, budget: null,
    items: [{ id: 'a', state: 'done', done: true, tier: 0, decisions: [] }, { id: 'b', state: 'done', done: true, tier: 0, decisions: [] }] };
  assert.match(renderPage(st, { metrics: { a: '0 touches · 0 stand-in' } }), /<th>Attention<\/th>.*0 touches · 0 stand-in/s);
  const events = [
    { at: '2026-10-25T10:00:00Z', to: 'harness', event: { type: 'REQUEST_RECEIVED', request: { id: 'a' } } },
    { at: '2026-10-25T10:10:00Z', to: 'item:a', event: { type: 'PERSON_DECIDED', person: true } },
    { at: '2026-10-25T11:00:00Z', to: 'item:a', event: { type: 'MERGED' } },
    { at: '2026-10-26T10:00:00Z', to: 'harness', event: { type: 'REQUEST_RECEIVED', request: { id: 'b' } } },
    { at: '2026-10-26T11:00:00Z', to: 'item:b', event: { type: 'MERGED' } }
  ];
  const trend = touchesTrend(st.items, { events }, '2026-10-26');
  assert.deepEqual([trend.today.perItem, trend.before.perItem], [0, 1]);
  assert.match(renderDigest(st, { events, day: '2026-10-26' }), /Your touches:\*\* 0\.0 per item \(1\) today, 1\.0 per item \(1\) the day before/);
});
