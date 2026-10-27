// The CLI is the host's whole interface, and a new orchestrator reaches for --help first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const bin = new URL('../bin/harness.js', import.meta.url).pathname;
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'orchestrator-session' } });

test('help, --help and -h print the usage and exit 0', () => {
  for (const flag of ['help', '--help', '-h']) {
    const r = run(flag);
    assert.equal(r.status, 0, flag);
    assert.match(r.stdout, /^harness <command> \[options\]/);
  }
  assert.equal(run('status', '--help').status, 0);
});

test('every command in the dispatch is in the help', () => {
  const src = readFileSync(bin, 'utf8');
  const commands = [...src.matchAll(/^ {4}case '([a-z-]+)':/gm)].map((m) => m[1]);
  assert.ok(commands.length >= 15);
  const help = run('--help').stdout;
  assert.deepEqual(commands.filter((c) => !new RegExp(`^  ${c}\\b`, 'm').test(help) && !help.includes(` ${c},`)), []);
});

test('a bad option or command is one error line plus the usage, exit 2, no stack trace', () => {
  for (const args of [['status', '--bogus'], ['nope']]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /^harness: .+\n\nharness <command>/);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  }
});

test('send reports a refused event and exits 1; tick and usage report it and go on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-cli-'));
  const at = (...args) => run(...args, '--dir', dir);
  at('init');
  at('send', '{"type":"REQUEST_RECEIVED","request":{"id":"a","tier":0}}');
  const r = at('send', '{"type":"CHECKS_PASSED"}', '--to', 'item:a', '--actor', 'session:worker-1', '--source', 'cli:handback-1');
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'harness: refused: CHECKS_PASSED in active.triaging\n');
  assert.equal(JSON.parse(r.stdout).refused, true);

  assert.equal(at('tick', '--now', '2026-10-26T10:00:00Z').status, 0, 'no reading: the budget drains');
  const again = at('tick', '--now', '2026-10-26T10:05:00Z');
  assert.equal(again.status, 0);
  assert.match(again.stderr, /^harness: refused: TICK in wrappingUp$/m);
  assert.equal(JSON.parse(again.stdout).mode, 'wrappingUp');

  const samples = join(dir, 'usage.json');
  writeFileSync(samples, JSON.stringify([{ at: '2026-10-26T10:10:00Z', sevenDay: 0.1, fiveHour: 0.1 }]));
  const usage = at('usage', '--samples', samples);
  assert.equal(usage.status, 0, usage.stderr);
  const events = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  assert.match(events, /"USAGE_SAMPLED"/, 'the sample after the refused tick still lands');
  assert.doesNotMatch(events, /"CHECKS_PASSED"/, 'the refused send left no row');
});

test('init names this session as the orchestrator, and outside a session needs --actor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-cli-'));
  assert.equal(JSON.parse(run('init', '--dir', dir).stdout).orchestrator, 'orchestrator-session');
  const [row] = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual([row.event.type, row.actor, row.source.kind], ['ORCHESTRATOR_STARTED', { kind: 'session', id: 'orchestrator-session' }, 'cli']);
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  const outside = spawnSync(process.execPath, [bin, 'init', '--dir', mkdtempSync(join(tmpdir(), 'harness-cli-'))], { encoding: 'utf8', env });
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /init needs --actor session:<id>/);
  const person = spawnSync(process.execPath, [bin, 'init', '--actor', 'person:sd', '--dir', mkdtempSync(join(tmpdir(), 'harness-cli-'))], { encoding: 'utf8', env });
  assert.deepEqual([person.status, JSON.parse(person.stdout).orchestrator], [1, null], 'only a session orchestrates');
  assert.match(person.stderr, /refused: ORCHESTRATOR_STARTED/);
});
