// The harness plugin's hooks, run as the host runs them, on copies of the committed plugin: the
// per-project gate, the SessionStart version line, the stamp on filed ledger records, and the CI check
// that a plugin change raises its version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const plugin = join(repo, 'plugins/harness');
const { version } = JSON.parse(readFileSync(join(plugin, '.claude-plugin/plugin.json'), 'utf8'));
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** A scratch dir holding a Library area (no marker yet) and a copy of the plugin in a folder named like a synced update. */
function scratch() {
  const tmp = mkdtempSync(join(tmpdir(), 'hook-'));
  const lib = join(tmp, 'harness');
  mkdirSync(lib);
  const root = join(tmp, 'harness~g2 x'); // `~` and a space: paths must come from fileURLToPath
  cpSync(plugin, root, { recursive: true });
  return { tmp, lib, root, install: () => writeFileSync(join(lib, 'install.json'), '{"installedAt":"2026-10-27"}') };
}
const run = (root, script, env, args = [], input = '') =>
  execFileSync('node', [join(root, 'scripts', script), ...args], { input, encoding: 'utf8', env: { ...process.env, HARNESS_DISABLED: '', ...env } });

function transcript(dir) {
  const path = join(dir, 's1.jsonl');
  writeFileSync(path, [
    { type: 'user', timestamp: '2026-10-26T10:00:01.000Z', turnPosition: { turnIndex: 1 }, message: { content: 'go' } },
    { type: 'assistant', requestId: 'r1', timestamp: '2026-10-26T10:00:05.000Z', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 50 }, content: [] } }
  ].map((l) => JSON.stringify(l)).join('\n'));
  return JSON.stringify({ session_id: 's1', transcript_path: path });
}

test('the committed plugin ledger is a fresh build, and no plugin script builds a path from URL.pathname', () => {
  execFileSync('node', ['scripts/build-plugin.mjs', '--check'], { cwd: repo });
  for (const f of readdirSync(plugin, { recursive: true }).filter((f) => f.endsWith('.js'))) {
    assert.doesNotMatch(readFileSync(join(plugin, f), 'utf8'), /URL\(import\.meta\.url\)\.pathname/, f);
  }
});

test('SessionStart: one "not installed" line without the marker, the version line with it, nothing when disabled', () => {
  const { lib, root, install } = scratch();
  const env = { HARNESS_LIBRARY_DIR: lib };
  assert.equal(run(root, 'session-start.js', env), `harness ${version}: available but not installed in this project (no ${join(lib, 'install.json')})\n`);
  assert.equal(run(root, 'session-start.js', { ...env, HARNESS_DISABLED: '1' }), '');
  install();
  assert.equal(run(root, 'session-start.js', env), `harness ${version} commit unknown (no git) from ${root}, behind: unknown\n`);
  assert.equal(run(root, 'session-start.js', { ...env, HARNESS_DISABLED: '1' }), '', 'the override wins over the marker');
});

test('SessionStart in a git checkout: names the commit and compares it with origin/main', () => {
  const { tmp, lib, root, install } = scratch();
  install();
  const origin = join(tmp, 'origin.git');
  git(tmp, 'init', '-q', '--bare', origin);
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'one');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  const head = git(root, 'rev-parse', 'HEAD');
  const env = { HARNESS_LIBRARY_DIR: lib };
  assert.equal(run(root, 'session-start.js', env), `harness ${version} commit ${head} from ${root}, behind: no\n`);

  git(root, 'commit', '-q', '--allow-empty', '-m', 'two'); // origin/main moves on, this copy stays at one
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  const main = git(root, 'rev-parse', 'HEAD');
  git(root, 'reset', '-q', '--hard', head);
  assert.equal(run(root, 'session-start.js', env), `harness ${version} commit ${head} from ${root}, behind: yes (origin/main ${main.slice(0, 7)})\n`);

  git(root, 'remote', 'set-url', 'origin', join(tmp, 'gone.git'));
  assert.match(run(root, 'session-start.js', env), /, behind: unknown\n$/);

  git(root, 'remote', 'set-url', 'origin', 'ssh://example.invalid/repo.git'); // a remote that hangs
  const t0 = Date.now();
  assert.match(run(root, 'session-start.js', { ...env, GIT_SSH_COMMAND: 'sleep 20; :' }), /, behind: unknown\n$/);
  assert.ok(Date.now() - t0 < 4500, `took ${Date.now() - t0} ms`);
});

test('Stop: files nothing until installed, then stamps each record with the version and the registration that ran it', () => {
  const { tmp, lib, root, install } = scratch();
  const input = transcript(tmp);
  const filed = join(lib, 'ledger/sessions/s1.json');
  assert.equal(run(root, 'file-turns.js', { HARNESS_LIBRARY_DIR: lib }, ['plugin'], input), '');
  assert.ok(!existsSync(join(lib, 'ledger')), 'no writes without the marker');
  install();
  assert.equal(run(root, 'file-turns.js', { HARNESS_LIBRARY_DIR: lib, HARNESS_DISABLED: '1' }, ['plugin'], input), '');
  assert.ok(!existsSync(join(lib, 'ledger')), 'no writes when disabled');

  run(root, 'file-turns.js', { HARNESS_LIBRARY_DIR: lib }, ['plugin'], input);
  let record = JSON.parse(readFileSync(filed, 'utf8'));
  assert.equal(record.session.turns.length, 1);
  assert.ok(record.session.totals.cost > 0);
  assert.deepEqual(record.harness, { name: 'harness', version, commit: null, root, hook: 'plugin', hooks: ['plugin'] });

  run(root, 'file-turns.js', { HARNESS_LIBRARY_DIR: lib }, ['settings'], input);
  record = JSON.parse(readFileSync(filed, 'utf8'));
  assert.equal(record.harness.hook, 'settings');
  assert.deepEqual(record.harness.hooks, ['plugin', 'settings']);

  run(root, 'file-turns.js', { HARNESS_LIBRARY_DIR: lib }, ['plugin'], 'not json'); // exits 0 or execFileSync throws
});

test('both registrations pass their tag: hooks.json says plugin, .claude/settings.json says settings', () => {
  const stop = (hooks) => hooks.Stop.flatMap((h) => h.hooks).find((h) => h.args?.[0]?.endsWith('scripts/file-turns.js'));
  assert.equal(stop(JSON.parse(readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8')).hooks).args[1], 'plugin');
  assert.equal(stop(JSON.parse(readFileSync(join(repo, '.claude/settings.json'), 'utf8')).hooks).args[1], 'settings');
});

test('CI version check: a plugin change without a higher version fails, with one passes', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bump-'));
  const manifest = join(tmp, 'plugins/harness/.claude-plugin/plugin.json');
  mkdirSync(join(tmp, 'plugins/harness/.claude-plugin'), { recursive: true });
  const write = (v, body) => {
    writeFileSync(manifest, JSON.stringify({ name: 'harness', version: v }));
    writeFileSync(join(tmp, 'plugins/harness/a.js'), body);
    git(tmp, 'add', '.');
    git(tmp, 'commit', '-qm', v);
  };
  git(tmp, 'init', '-q');
  write('0.2.0', 'one');
  git(tmp, 'branch', 'base');
  const check = () => execFileSync('node', [join(repo, 'scripts/check-plugin-version.mjs'), 'base'], { cwd: tmp, stdio: 'pipe' });
  check(); // unchanged
  write('0.2.0', 'two');
  assert.throws(check, /bump "version"/);
  write('0.10.0', 'two');
  check();
});
