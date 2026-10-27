// The harness plugin's hooks, run as the host runs them, on copies of the committed plugin: the
// per-project gate, the SessionStart version line, the status mod's data, the stamp on filed ledger
// records, and the CI check that a plugin change raises its version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const plugin = join(repo, 'plugins/harness');
const { version } = JSON.parse(readFileSync(join(plugin, '.claude-plugin/plugin.json'), 'utf8'));
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** A scratch dir holding a Library area (no marker yet) and a copy of the plugin in a folder named like a synced update. */
function scratch() {
  const tmp = tempDir('hook-');
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
  const { refreshed, ...stamped } = record.harness;
  assert.deepEqual(stamped, { name: 'harness', version, commit: null, root, hook: 'plugin', hooks: ['plugin'], behind: null });
  assert.equal(refreshed.skipped, 'not a git checkout');

  run(root, 'file-turns.js', { HARNESS_LIBRARY_DIR: lib }, ['settings'], input);
  record = JSON.parse(readFileSync(filed, 'utf8'));
  assert.equal(record.harness.hook, 'settings');
  assert.deepEqual(record.harness.hooks, ['plugin', 'settings']);

  run(root, 'file-turns.js', { HARNESS_LIBRARY_DIR: lib }, ['plugin'], 'not json'); // exits 0 or execFileSync throws
});

test('status mod data: the gate and the status text, the load record only when installed, no network', () => {
  const { tmp, lib, root, install } = scratch();
  const env = { HARNESS_LIBRARY_DIR: lib };
  const status = (extra = {}, args = []) => JSON.parse(run(root, 'status.js', { ...env, ...extra }, args));
  const record = join(lib, 'status-mod/s1.json');

  assert.deepEqual(status({ HARNESS_DISABLED: '1' }, ['--record', 's1']), { state: 'disabled', text: null });
  let s = status({}, ['--record', 's1']);
  assert.equal(s.state, 'absent');
  assert.equal(s.text, `harness ${version}: available, not installed`);
  assert.equal(s.marker, join(lib, 'install.json'));
  assert.ok(!existsSync(join(lib, 'status-mod')), 'no writes without the marker');

  install();
  assert.deepEqual(status({ HARNESS_DISABLED: '1' }, ['--record', 's1']), { state: 'disabled', text: null }, 'the override wins over the marker');
  assert.ok(!existsSync(record), 'no writes when disabled');
  s = status({}, ['--record', 's1']);
  assert.equal(s.text, `harness ${version} commit unknown (no git) · installed`);
  assert.deepEqual({ ...s, text: undefined }, { state: 'installed', text: undefined, name: 'harness', version, commit: null, root, marker: join(lib, 'install.json'), record });
  const loaded = JSON.parse(readFileSync(record, 'utf8'));
  assert.deepEqual({ ...loaded, at: undefined }, { session: 's1', event: 'loaded', plugin: 'harness', version, commit: null, root, at: undefined });
  assert.ok(!Number.isNaN(Date.parse(loaded.at)));
  assert.equal(status().record, undefined, 'a refresh without --record writes nothing');
  status({}, ['--record', '../x']);
  assert.ok(existsSync(join(lib, 'status-mod/___x.json')), 'a session id cannot leave the folder');

  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'one');
  git(root, 'remote', 'add', 'origin', 'ssh://example.invalid/repo.git');
  const head = git(root, 'rev-parse', 'HEAD');
  const t0 = Date.now();
  s = status({ GIT_SSH_COMMAND: 'sleep 20; :' }); // would hang if it touched the remote
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.equal(s.commit, head);
  assert.equal(s.text, `harness ${version} commit ${head.slice(0, 7)} · installed`);
});

test('the status mod ships in the plugin: hooks.json names its module and plugin.json its state contract', () => {
  const hooks = JSON.parse(readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8'));
  assert.deepEqual(hooks.modules, ['./status.tsx']);
  assert.ok(existsSync(join(plugin, 'hooks/status.tsx')));
  const manifest = JSON.parse(readFileSync(join(plugin, '.claude-plugin/plugin.json'), 'utf8'));
  assert.ok(existsSync(join(plugin, manifest.types)));
  const mod = readFileSync(join(plugin, 'hooks/status.tsx'), 'utf8');
  assert.doesNotMatch(mod, /state\/main|\$\.fs\.|\$\.net/, 'no reads of the retired store, no direct Library reads, no network');
  assert.match(mod, /scripts\/status\.js/);
});

test('only the plugin registers the Stop hook: hooks.json says plugin, .claude/settings.json has none', () => {
  const stop = (hooks) => (hooks?.Stop ?? []).flatMap((h) => h.hooks).find((h) => h.args?.[0]?.endsWith('scripts/file-turns.js'));
  assert.equal(stop(JSON.parse(readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8')).hooks).args[1], 'plugin');
  assert.equal(stop(JSON.parse(readFileSync(join(repo, '.claude/settings.json'), 'utf8')).hooks), undefined);
});

test('CI version check: a plugin change without a higher version fails, with one passes', () => {
  const tmp = tempDir('bump-');
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

// notice-behind.js (UserPromptSubmit): each test gets its own TMPDIR, so its own update state.
const notice = (root, lib, tmp, extra = {}) => {
  const out = run(root, 'notice-behind.js', { HARNESS_LIBRARY_DIR: lib, TMPDIR: tmp, ...extra }, [], JSON.stringify({ session_id: 's1', hook_event_name: 'UserPromptSubmit' }));
  return out ? JSON.parse(out).hookSpecificOutput : null;
};
const updatesFile = (tmp) => join(tmp, 'harness-updates/s1.json');
const age = (tmp, minutes) => { // pretend the last check was `minutes` ago
  const state = JSON.parse(readFileSync(updatesFile(tmp), 'utf8'));
  writeFileSync(updatesFile(tmp), JSON.stringify({ ...state, checkedAt: new Date(Date.now() - minutes * 60000).toISOString() }));
};

/** The scratch plugin as a checkout of a local bare origin whose main is one commit ahead of HEAD (detached). */
function behindCheckout() {
  const s = scratch();
  s.install();
  const origin = join(s.tmp, 'origin.git');
  git(s.tmp, 'init', '-q', '--bare', origin);
  git(s.root, 'init', '-q');
  git(s.root, 'add', '.');
  git(s.root, 'commit', '-qm', 'one');
  git(s.root, 'remote', 'add', 'origin', origin);
  s.old = git(s.root, 'rev-parse', 'HEAD');
  writeFileSync(join(s.root, 'NEW'), 'two');
  git(s.root, 'add', 'NEW');
  git(s.root, 'commit', '-qm', 'two');
  git(s.root, 'push', '-q', 'origin', 'HEAD:main');
  s.main = git(s.root, 'rev-parse', 'HEAD');
  git(s.root, 'fetch', '-q', 'origin');
  git(s.root, 'checkout', '-q', '--detach', s.old);
  return s;
}

test('UserPromptSubmit: nothing without the marker or when disabled, and no state written', () => {
  const { tmp, lib, root, install } = scratch();
  assert.equal(notice(root, lib, tmp), null);
  install();
  assert.equal(notice(root, lib, tmp, { HARNESS_DISABLED: '1' }), null);
  assert.ok(!existsSync(updatesFile(tmp)));
  assert.equal(notice(root, lib, tmp), null, 'a synced copy with no newer sibling says nothing');
  assert.ok(existsSync(updatesFile(tmp)), 'but records the check time');
});

test('UserPromptSubmit in a clean detached checkout behind origin/main: fast-forwards and says so once', () => {
  const { tmp, lib, root, old, main } = behindCheckout();
  const out = notice(root, lib, tmp);
  assert.equal(out.hookEventName, 'UserPromptSubmit');
  assert.match(out.additionalContext, new RegExp(`started on harness ${version} commit ${old.slice(0, 7)}; origin/main is at ${main.slice(0, 7)}.*fast-forwarded the plugin checkout`));
  assert.equal(git(root, 'rev-parse', 'HEAD'), main);
  const { updates } = JSON.parse(readFileSync(updatesFile(tmp), 'utf8'));
  assert.deepEqual(updates.map(({ at, ...u }) => u), [{ from: old, to: main, action: 'fast-forward' }]);

  age(tmp, 31);
  assert.equal(notice(root, lib, tmp), null, 'up to date now: nothing to say');

  const input = transcript(tmp); // the Stop hook files the updates in the ledger record
  run(root, 'file-turns.js', { HARNESS_LIBRARY_DIR: lib, TMPDIR: tmp }, ['plugin'], input);
  const record = JSON.parse(readFileSync(join(lib, 'ledger/sessions/s1.json'), 'utf8'));
  assert.deepEqual(record.harness.updates, updates);
});

test('UserPromptSubmit cache: one check per 30 minutes, and a hanging remote costs at most about 3 s', () => {
  const { tmp, lib, root } = behindCheckout();
  git(root, 'remote', 'set-url', 'origin', 'ssh://example.invalid/repo.git');
  let t0 = Date.now();
  assert.equal(notice(root, lib, tmp, { GIT_SSH_COMMAND: 'sleep 20; :' }), null);
  assert.ok(Date.now() - t0 < 3600, `took ${Date.now() - t0} ms`);

  git(root, 'remote', 'set-url', 'origin', join(tmp, 'origin.git'));
  t0 = Date.now();
  assert.equal(notice(root, lib, tmp), null, 'checked under 30 minutes ago: no network, no message');
  age(tmp, 29);
  assert.equal(notice(root, lib, tmp), null);
  age(tmp, 31);
  assert.match(notice(root, lib, tmp).additionalContext, /fast-forwarded/);
});

test('UserPromptSubmit never touches a dirty tree or another branch, and reports each newer version once', () => {
  const dirty = behindCheckout();
  writeFileSync(join(dirty.root, 'README.md'), 'local edit');
  let out = notice(dirty.root, dirty.lib, dirty.tmp);
  assert.match(out.additionalContext, new RegExp(`runs harness ${version} commit ${dirty.old.slice(0, 7)} .* older than origin/main ${dirty.main.slice(0, 7)}\\. Not updated \\(the checkout has uncommitted changes\\)`));
  assert.equal(git(dirty.root, 'rev-parse', 'HEAD'), dirty.old);
  assert.equal(readFileSync(join(dirty.root, 'README.md'), 'utf8'), 'local edit');
  age(dirty.tmp, 31);
  assert.equal(notice(dirty.root, dirty.lib, dirty.tmp), null, 'same version: not told again');
  git(dirty.root, 'stash', '-q');
  git(dirty.root, 'checkout', '-q', '--detach', dirty.main);
  git(dirty.root, 'commit', '-q', '--allow-empty', '-m', 'three');
  git(dirty.root, 'push', '-q', 'origin', 'HEAD:main'); // origin/main moves on again
  git(dirty.root, 'checkout', '-q', '--detach', dirty.old);
  git(dirty.root, 'stash', 'pop', '-q');
  age(dirty.tmp, 31);
  assert.match(notice(dirty.root, dirty.lib, dirty.tmp).additionalContext, /Not updated \(the checkout has uncommitted changes\)/, 'a newer version is told');
  assert.equal(JSON.parse(readFileSync(updatesFile(dirty.tmp), 'utf8')).updates.length, 2);

  const other = behindCheckout();
  git(other.root, 'checkout', '-q', '-b', 'feat');
  out = notice(other.root, other.lib, other.tmp);
  assert.match(out.additionalContext, /Not updated \(the checkout is on branch feat, which does not track origin\/main\)/);
  assert.equal(git(other.root, 'rev-parse', 'HEAD'), other.old);

  const detached = behindCheckout(); // detached, clean, but not an ancestor of origin/main
  git(detached.root, 'commit', '-q', '--allow-empty', '-m', 'local');
  out = notice(detached.root, detached.lib, detached.tmp);
  assert.match(out.additionalContext, /Not updated \(detached HEAD is not an ancestor of origin\/main\)/);

  const tracking = behindCheckout(); // a branch tracking origin/main fast-forwards
  git(tracking.root, 'checkout', '-q', '-b', 'trunk');
  git(tracking.root, 'branch', '-q', '-u', 'origin/main');
  assert.match(notice(tracking.root, tracking.lib, tracking.tmp).additionalContext, /fast-forwarded/);
  assert.equal(git(tracking.root, 'rev-parse', 'trunk'), tracking.main);
});

test('UserPromptSubmit in a synced copy: reports a newer sibling <folder>~gN once, and never switches', () => {
  const { tmp, lib, install } = scratch();
  install();
  const dir = join(tmp, 'synced');
  const own = join(dir, 'harness~g1');
  mkdirSync(dir);
  cpSync(plugin, own, { recursive: true });
  const sibling = (name, v) => {
    mkdirSync(join(dir, name, '.claude-plugin'), { recursive: true });
    writeFileSync(join(dir, name, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'harness', version: v }));
  };
  sibling('harness', '0.0.1'); // older
  sibling('other~g3', '99.0.0'); // another plugin
  assert.equal(notice(own, lib, tmp), null);
  sibling('harness~g2', '99.1.0');
  sibling('harness~g3', '99.0.5');
  age(tmp, 31);
  const out = notice(own, lib, tmp);
  assert.match(out.additionalContext, new RegExp(`runs harness ${version} from the synced copy .*harness~g1; a newer synced copy, harness 99\\.1\\.0, is at .*harness~g2\\. .*start a new session`));
  assert.deepEqual(JSON.parse(readFileSync(updatesFile(tmp), 'utf8')).updates.map(({ at, ...u }) => u), [{ from: version, to: '99.1.0', action: 'reported: synced copy, not switched' }]);
  age(tmp, 31);
  assert.equal(notice(own, lib, tmp), null, 'told once per version');
});

test('the UserPromptSubmit registration runs notice-behind.js within its timeout', () => {
  const [h] = JSON.parse(readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8')).hooks.UserPromptSubmit[0].hooks;
  assert.deepEqual(h.args, ['${CLAUDE_PLUGIN_ROOT}/scripts/notice-behind.js']);
  assert.ok(h.timeout >= 4);
});
