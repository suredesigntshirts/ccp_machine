// M3: who did a step is something the session cannot pick. The CLI takes the session actor from the
// platform (CLAUDE_CODE_SESSION_ID) and refuses another; verify-actors checks every session in the log
// against the Stop hook's ledger. Each run sets or clears the variable itself, so the result is the same
// inside a Claude Code session and outside one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir } from './tmp.js';

const bin = new URL('../bin/harness.js', import.meta.url).pathname;
const run = (env, ...args) => {
  const e = { ...process.env, HARNESS_LIBRARY_DIR: tempDir('harness-lib-'), ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: e });
};
const as = (id) => ({ CLAUDE_CODE_SESSION_ID: id });
const outside = { CLAUDE_CODE_SESSION_ID: undefined };
const rows = (dir) => readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
// Every file in the store, with its size and modification time: a command that never writes leaves it as it was.
const snapshot = (dir) => readdirSync(dir, { recursive: true }).sort().map((f) => [f, statSync(join(dir, f)).size, statSync(join(dir, f)).mtimeMs]);

function item(dir) {
  assert.equal(run(as('orch'), 'init', '--dir', dir).status, 0);
  assert.equal(run(as('orch'), 'send', '{"type":"REQUEST_RECEIVED","request":{"id":"a"}}', '--dir', dir).status, 0);
}

test('send takes the session actor from CLAUDE_CODE_SESSION_ID', () => {
  const dir = tempDir('harness-id-');
  item(dir);
  const r = run(as('triager-1'), 'send', '{"type":"TRIAGED","tier":1,"criteria":["a works"]}', '--to', 'item:a', '--dir', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(rows(dir).at(-1).actor, { kind: 'session', id: 'triager-1' });
});

test('an explicit --actor session:X that is not this session is refused, says why, and writes nothing', () => {
  const dir = tempDir('harness-id-');
  item(dir);
  const before = snapshot(dir);
  for (const args of [
    ['send', '{"type":"TRIAGED","tier":1,"criteria":["a works"]}', '--to', 'item:a', '--actor', 'session:fresh-id'],
    ['send', '{"type":"RUN_FAILED"}', '--to', 'item:a', '--actor', 'session:worker-1', '--source', 'cli:handback'],
    ['send', '{"type":"BLOCK"}', '--to', 'item:a', '--actor', 'session:orch2']
  ]) {
    const r = run(as('orch'), ...args, '--dir', dir);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /--actor session:\S+ is not this session \(CLAUDE_CODE_SESSION_ID is orch\): a session's id comes from the platform/, args.join(' '));
    assert.equal(r.stdout, '');
  }
  assert.deepEqual(snapshot(dir), before, 'the store is unchanged');
  // The same id as the platform's is taken.
  const same = run(as('worker-1'), 'send', '{"type":"RUN_FAILED"}', '--to', 'item:a', '--actor', 'session:worker-1', '--source', 'cli:handback', '--dir', dir);
  assert.equal(same.status, 0, same.stderr);
});

test('the other actor kinds are unchanged: a person needs a tap, GitHub only from-github, timers as before', () => {
  const dir = tempDir('harness-id-');
  item(dir);
  const person = run(as('orch'), 'send', '{"type":"BLOCK"}', '--to', 'item:a', '--actor', 'person:sd', '--dir', dir);
  assert.equal(person.status, 0, person.stderr);
  assert.deepEqual(rows(dir).at(-1).actor, { kind: 'person', id: 'sd' });
  const gh = run(as('orch'), 'send', '{"type":"UNBLOCKED"}', '--to', 'item:a', '--actor', 'github:github', '--dir', dir);
  assert.match(gh.stderr, /only harness from-github sends as GitHub/);
  assert.equal(run(as('orch'), 'tick', '--now', '2026-10-26T10:00:00Z', '--dir', dir).status, 0);
  assert.equal(rows(dir).at(-1).actor.kind, 'timer');
});

test('outside a Claude Code session there is no platform id: --actor session:<id> is taken as given, for verify-actors to check', () => {
  const dir = tempDir('harness-id-');
  const r = run(outside, 'init', '--actor', 'session:host', '--dir', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).orchestrator, 'host');
});

// The Stop hook's record: $HARNESS_LIBRARY_DIR/ledger/sessions/<id>.json with session.start and session.end.
const ledger = (lib, id, start, end) => {
  const dir = join(lib, 'ledger', 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ filedAt: end, session: { sessionId: id, start, end, turns: [] } }));
};
const event = (id, at, type = 'BLOCK') => ({ id: `e-${id}-${at}`, version: 1, at, to: 'item:a', actor: { kind: 'session', id }, source: { kind: 'cli', ref: 'harness send' }, event: { type } });

test('verify-actors: one line per session actor, ok, no ledger or outside window; exit 1 on any failure; never writes', () => {
  const lib = tempDir('harness-lib-');
  const dir = tempDir('harness-id-');
  ledger(lib, 'orch', '2026-10-27T10:00:00.000Z', '2026-10-27T12:00:00.000Z');
  ledger(lib, 'late', '2026-10-27T10:00:00.000Z', '2026-10-27T11:00:00.000Z');
  const log = [
    event('orch', '2026-10-27T10:30:00.000Z'),
    event('orch', '2026-10-27T12:01:00.000Z'), // inside the tolerance after the last filed turn
    event('late', '2026-10-27T13:00:00.000Z'),
    event('fresh-id', '2026-10-27T10:30:00.000Z'),
    { ...event('person', '2026-10-27T10:30:00.000Z'), actor: { kind: 'person', id: 'sd' } },
    { ...event('github', '2026-10-27T10:30:00.000Z'), actor: { kind: 'github', id: 'github' } }
  ];
  writeFileSync(join(dir, 'events.jsonl'), log.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const before = snapshot(dir);
  const libBefore = snapshot(lib);
  const r = run({ HARNESS_LIBRARY_DIR: lib, ...as('orch') }, 'verify-actors', '--store', dir);
  assert.equal(r.status, 1, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 3, r.stdout);
  assert.match(lines[0], /^ok session:orch \(2 events\)/);
  assert.match(lines[1], /^outside window session:late: e-late-2026-10-27T13:00:00.000Z at 2026-10-27T13:00:00.000Z is not in 2026-10-27T10:00:00.000Z\.\.2026-10-27T11:00:00.000Z/);
  assert.match(lines[2], /^no ledger session:fresh-id \(1 event\)/);
  assert.match(r.stderr, /3 session actors: 1 ok, 1 no ledger, 1 outside window/);
  assert.deepEqual(snapshot(dir), before, 'the store is unchanged');
  assert.deepEqual(snapshot(lib), libBefore, 'the ledger is unchanged');

  // All covered: exit 0.
  writeFileSync(join(dir, 'events.jsonl'), JSON.stringify(log[0]) + '\n');
  const ok = run({ HARNESS_LIBRARY_DIR: lib, ...outside }, 'verify-actors', '--store', dir);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^ok session:orch \(1 event\)/);
});

test('verify-actors on a folder with no log writes nothing and exits 2; an id that cannot be a ledger file has none', () => {
  const empty = tempDir('harness-id-');
  const r = run({}, 'verify-actors', '--store', empty);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /verify-actors: no events.jsonl/);
  assert.deepEqual(readdirSync(empty), []);
  const lib = tempDir('harness-lib-');
  const dir = tempDir('harness-id-');
  ledger(lib, 'orch', '2026-10-27T10:00:00.000Z', '2026-10-27T12:00:00.000Z');
  writeFileSync(join(dir, 'events.jsonl'), JSON.stringify(event('../ledger/sessions/orch', '2026-10-27T10:30:00.000Z')) + '\n');
  const bad = run({ HARNESS_LIBRARY_DIR: lib }, 'verify-actors', '--store', dir);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^no ledger session:\.\.\/ledger\/sessions\/orch/);
});
