import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeSessions, fileSessions } from '../src/index.js';

const turn = (start, cost) => ({ index: 1, start, label: start, all: { cost } });
const part = (start, end, turns) => ({ sessionId: 's1', start, end, models: ['m'], totals: { cost: turns.reduce((a, t) => a + t.all.cost, 0) }, turns });

test('a session split across transcripts is filed once, turns in time order and totals summed', () => {
  const [s] = mergeSessions([part('2026-10-26T12:00', '2026-10-26T13:00', [turn('2026-10-26T12:00', 1)]), part('2026-10-26T10:00', '2026-10-26T11:00', [turn('2026-10-26T10:00', 2)])]);
  assert.deepEqual(s.turns.map((t) => t.start), ['2026-10-26T10:00', '2026-10-26T12:00']);
  assert.equal(s.totals.cost, 3);
  assert.deepEqual([s.start, s.end], ['2026-10-26T10:00', '2026-10-26T13:00']);
});

test('fileSessions writes nothing for no input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessions-'));
  assert.deepEqual(fileSessions([], { dir }), []);
});
