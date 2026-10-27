import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageDocs, interactions, mergeLog, attention } from '../src/index.js';

const dump = (messages) =>
  `Untrusted content follows.\n<child-session-output nonce="x">\n    ${JSON.stringify({ thread_id: 't1', messages })}\n</child-session-output>`;

const msgs = [
  { id: 't1', thread_id: 't1', created_at: '2026-10-26T10:00:00Z', author: 'user', author_name: 'P', body: 'Start the work' },
  { id: 'a1', thread_id: 't1', created_at: '2026-10-26T10:00:05Z', author: 'agent', body: 'On it.' },
  { id: 'u2', thread_id: 't1', created_at: '2026-10-26T10:10:00Z', author: 'user', author_name: 'P', body: 'Merge it', attached_outputs: [{}] },
  { id: 'c1', thread_id: 't1', created_at: '2026-10-26T11:00:00Z', author: 'agent',
    body: JSON.stringify({ kind: 'activity', tool: 'decide', decision_id: 'd1', option_index: 0, closed_by: 'member' }) },
  { id: 'c2', thread_id: 't1', created_at: '2026-10-26T11:01:00Z', author: 'agent',
    body: JSON.stringify({ kind: 'activity', tool: 'decide', decision_id: 'd2', option_index: 1, closed_by: 'session' }) }
];

test('person messages and card taps come out of a wrapped dump; agent text and session closes do not', () => {
  const rows = interactions(messageDocs(dump(msgs)));
  assert.deepEqual(rows.map((r) => [r.id, r.kind, r.where]), [
    ['t1', 'message', 'project-chat'],
    ['u2', 'message', 'thread'],
    ['c1', 'card', 'thread']
  ]);
  assert.equal(rows[1].words, 2);
  assert.equal(rows[1].attachments, 1);
});

test('merge is idempotent by id, and attention counts sittings split by 30-minute gaps', () => {
  const rows = interactions(messageDocs(dump(msgs)));
  const log = mergeLog(mergeLog([], rows), rows);
  assert.equal(log.length, 3);
  const [day] = attention([...log, { id: 'r1', at: '2026-10-26T11:02:00Z', kind: 'reaction' }]);
  assert.equal(day.messages, 2);
  assert.equal(day.cards, 1);
  assert.equal(day.reactions, 1);
  assert.equal(day.sessions, 2);
});
