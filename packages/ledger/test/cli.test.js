// The ledger CLI is run by hand and by the orchestrator, so --help must work and mistakes must be short.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const bin = new URL('../bin/ledger.js', import.meta.url).pathname;
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

test('help, --help and -h print the usage and exit 0', () => {
  for (const args of [['help'], ['--help'], ['-h'], ['budget', '--help']]) {
    const r = run(...args);
    assert.equal(r.status, 0, args.join(' '));
    assert.match(r.stdout, /^ledger <command> \[options\]/);
  }
});

test('every command in the dispatch is in the help', () => {
  const commands = [...readFileSync(bin, 'utf8').matchAll(/^ {2}case '([a-z-]+)':/gm)].map((m) => m[1]);
  assert.ok(commands.length >= 9);
  const help = run('--help').stdout;
  assert.deepEqual(commands.filter((c) => !new RegExp(`^  ${c}\\b`, 'm').test(help)), []);
});

test('a bad option or command is one error line plus the usage, exit 2, no stack trace', () => {
  for (const args of [['budget', '--bogus'], ['nope']]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /^ledger: .+\n\nledger <command>/);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  }
});
