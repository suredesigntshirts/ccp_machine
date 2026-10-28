// infra/cloud-environment: setup.sh runs once per container build, and the environment caches containers,
// so the per-session steps (settings copy, skill and plugin links) live in session-start.sh, which the
// repo's .claude/settings.json runs as a SessionStart hook. setup.sh's settings copy carries that hook
// entry into ~/.claude/settings.json, so a settings change made after the build reaches the user file at
// the next session start. Everything runs on a scratch copy of the repo, with HOME and the log folder in
// a temp folder: never the real HOME, /tmp log or clone. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, readlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const real = fileURLToPath(new URL('../../../', import.meta.url));
const CLONE = '/home/user/ccp_machine'; // where the cloud clone lives; the hook entry names it
const SCRIPT = 'infra/cloud-environment/session-start.sh';

/** A scratch repo (the files the scripts read, no lockfile so npm ci is skipped), HOME and log folder. */
function scratch() {
  const tmp = tempDir('cloud-setup-');
  const repo = join(tmp, 'repo');
  for (const p of ['infra/cloud-environment', '.claude/settings.json', '.claude/skills/library',
    'plugins/harness/.claude-plugin', 'packages/harness/package.json']) {
    cpSync(join(real, p), join(repo, p), { recursive: true });
  }
  const home = join(tmp, 'home');
  const out = join(tmp, 'out');
  mkdirSync(home);
  mkdirSync(out);
  const env = { PATH: process.env.PATH, HOME: home, CCP_SETUP_DIR: out };
  const settingsPath = join(repo, '.claude/settings.json');
  const userPath = join(home, '.claude/settings.json');
  return {
    repo, home, out, env, settingsPath, userPath,
    setup: () => execFileSync('bash', [join(repo, 'infra/cloud-environment/setup.sh')], { env, encoding: 'utf8' }),
    user: () => JSON.parse(readFileSync(userPath, 'utf8')),
    repoSettings: () => JSON.parse(readFileSync(settingsPath, 'utf8')),
    log: () => readFileSync(join(out, 'ccp-machine-setup.log'), 'utf8'),
  };
}

/** The SessionStart entries in a settings object that run session-start.sh. */
const hookEntries = (settings) =>
  (settings.hooks?.SessionStart ?? []).flatMap((e) => e.hooks ?? []).filter((h) => String(h.command).includes(SCRIPT));

/** Run the hook as Claude Code would: the command from the user settings file, pointed at the scratch clone. */
function runHook(s) {
  const [h] = hookEntries(s.user());
  assert.ok(h, 'the user settings file has the SessionStart hook entry');
  assert.ok(h.command.includes(CLONE), `the hook runs the script from the clone at ${CLONE}`);
  const cmd = h.command.split(CLONE).join(s.repo);
  return execFileSync('bash', ['-c', cmd], { env: s.env, encoding: 'utf8' });
}

test('a settings change made after setup.sh reaches the user file at the next session-start hook', () => {
  const s = scratch();
  s.setup();
  assert.equal(hookEntries(s.repoSettings()).length, 1, 'the repo settings file defines the hook once');
  assert.equal(hookEntries(s.user()).length, 1, 'setup.sh copies the hook entry into the user file');
  assert.ok(existsSync(join(s.repo, SCRIPT)), 'the hook script is in the repo');

  const rule = 'Bash(echo session-setup-refresh)';
  const changed = s.repoSettings();
  changed.permissions.allow.push(rule);
  writeFileSync(s.settingsPath, JSON.stringify(changed, null, 2));
  assert.ok(!s.user().permissions.allow.includes(rule), 'the cached container still has the old user file');

  const stdout = runHook(s);
  assert.equal(stdout, '', 'the hook prints nothing into the session');
  assert.ok(s.user().permissions.allow.includes(rule), 'the hook copied the change into the user file');
});

test('the hook entry appears once after setup.sh and the hook have both run twice', () => {
  const s = scratch();
  s.setup();
  runHook(s);
  s.setup();
  runHook(s);
  assert.equal(hookEntries(s.user()).length, 1);
  assert.equal(s.user().hooks.SessionStart.length, s.repoSettings().hooks.SessionStart.length);
});

test('the hook relinks skills and plugins, logs versions and key names only, never values', () => {
  const s = scratch();
  const withSecret = s.repoSettings();
  withSecret.env.SESSION_SETUP_REFRESH_PROBE = 'value-session-setup-refresh-never-logged';
  writeFileSync(s.settingsPath, JSON.stringify(withSecret, null, 2));
  s.setup();
  runHook(s);
  assert.equal(readlinkSync(join(s.home, '.claude/skills/library')), join(s.repo, '.claude/skills/library'));
  assert.equal(readlinkSync(join(s.home, '.claude/skills/harness')), join(s.repo, 'plugins/harness'));
  const log = s.log();
  const plugin = JSON.parse(readFileSync(join(s.repo, 'plugins/harness/.claude-plugin/plugin.json'), 'utf8'));
  const harness = JSON.parse(readFileSync(join(s.repo, 'packages/harness/package.json'), 'utf8'));
  assert.match(log, new RegExp(`plugin harness ${plugin.version.replace(/\./g, '\\.')}`));
  assert.match(log, new RegExp(`harness ${harness.version.replace(/\./g, '\\.')}`));
  assert.match(log, /SESSION_SETUP_REFRESH_PROBE/);
  assert.doesNotMatch(log, /value-session-setup-refresh-never-logged/);
  assert.match(log, /session-start (start|end)/);
});

test('the hook never fails a session: a broken repo settings file is logged and it exits 0', () => {
  const s = scratch();
  s.setup();
  const before = readFileSync(s.userPath, 'utf8');
  writeFileSync(s.settingsPath, '{ not json');
  assert.equal(runHook(s), '');
  assert.equal(readFileSync(s.userPath, 'utf8'), before, 'the user file is left as it was');
  assert.match(s.log(), /settings: jq failed/);
});
