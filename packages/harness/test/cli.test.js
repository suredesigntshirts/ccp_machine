// The CLI is the host's whole interface, and a new orchestrator reaches for --help first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const bin = new URL('../bin/harness.js', import.meta.url).pathname;
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

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
