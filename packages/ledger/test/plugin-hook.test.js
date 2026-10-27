// The harness plugin's Stop hook files this package's ledger; check it end to end on a built plugin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = new URL('../../../', import.meta.url).pathname;

test('the Stop hook files the session ledger only where the Library area exists, and never fails', () => {
  execFileSync('node', ['scripts/build-plugin.mjs'], { cwd: repo });
  const tmp = mkdtempSync(join(tmpdir(), 'hook-'));
  const transcript = join(tmp, 's1.jsonl');
  const lines = [
    { type: 'user', timestamp: '2026-10-26T10:00:01.000Z', turnPosition: { turnIndex: 1 }, message: { content: 'go' } },
    { type: 'assistant', requestId: 'r1', timestamp: '2026-10-26T10:00:05.000Z', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 50 }, content: [] } }
  ];
  writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n'));
  const run = (env, input) =>
    execFileSync('node', [join(repo, 'dist/harness/scripts/file-turns.js')], { input, env: { ...process.env, ...env } });

  const missing = join(tmp, 'no-area');
  run({ HARNESS_LIBRARY_DIR: missing }, JSON.stringify({ session_id: 's1', transcript_path: transcript }));
  assert.ok(!existsSync(missing), 'must not create the area');

  const area = join(tmp, 'harness');
  mkdirSync(area);
  run({ HARNESS_LIBRARY_DIR: area }, JSON.stringify({ session_id: 's1', transcript_path: transcript }));
  const filed = JSON.parse(readFileSync(join(area, 'ledger/sessions/s1.json'), 'utf8'));
  assert.equal(filed.session.turns.length, 1);
  assert.ok(filed.session.totals.cost > 0);

  run({ HARNESS_LIBRARY_DIR: area }, 'not json'); // exits 0 or execFileSync throws
});
