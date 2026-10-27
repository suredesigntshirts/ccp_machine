// The Stop hook keeps the clone that hooks run from on origin/main (host.js refresh()), but only when it
// is safe, at most once per REFRESH_INTERVAL_MS, and never in a linked worktree; and its ledger stamp
// says how far behind the clone is, what the last refresh did, and which registrations ran it.
// Every repo here is a temp checkout of a local bare origin: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as host from '../../../plugins/harness/scripts/host.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const plugin = join(repo, 'plugins/harness');
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** A clone (a copy of the plugin, committed) of a local bare origin whose main is one commit ahead; HEAD detached at the older one. */
function clone() {
  const tmp = tempDir('refresh-');
  const root = join(tmp, 'clone');
  const origin = join(tmp, 'origin.git');
  cpSync(plugin, root, { recursive: true });
  git(tmp, 'init', '-q', '--bare', origin);
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'one');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  const old = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'NEW'), 'two');
  git(root, 'add', 'NEW');
  git(root, 'commit', '-qm', 'two');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  const main = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '--detach', old);
  git(root, 'branch', '-q', '-D', 'main');
  git(root, 'update-ref', 'refs/remotes/origin/main', old); // the clone has not fetched since it started
  const state = join(tmp, 'state');
  const lib = join(tmp, 'lib');
  mkdirSync(lib);
  return { tmp, root, origin, old, main, state, lib, install: () => writeFileSync(join(lib, 'install.json'), '{}') };
}
const head = (root) => git(root, 'rev-parse', 'HEAD');
const plain = ({ at, ...rest }) => (assert.ok(!Number.isNaN(Date.parse(at)), `at: ${at}`), rest);
/** Push one more commit to origin/main from a scratch clone. */
const advance = (c) => {
  const w = join(c.tmp, `w${Date.now()}${Math.random()}`);
  git(c.tmp, 'clone', '-q', c.origin, w);
  git(w, 'commit', '-q', '--allow-empty', '-m', 'more');
  git(w, 'push', '-q', 'origin', 'HEAD:main');
  return head(w);
};

test('refresh: a clean detached clone fast-forwards to origin/main, and says from and to', () => {
  const c = clone();
  assert.equal(host.behindCount(c.root), 0, 'as of the last fetch (none yet): not behind');
  assert.deepEqual(plain(host.refresh(c.root, { stateDir: c.state })), { from: c.old, to: c.main });
  assert.equal(head(c.root), c.main);
  assert.throws(() => git(c.root, 'symbolic-ref', '-q', 'HEAD'), 'still detached');
  assert.equal(host.behindCount(c.root), 0);
  assert.deepEqual(plain(host.refresh(c.root, { stateDir: c.state, interval: 0 })), { from: c.main, to: c.main }, 'up to date');
});

test('refresh: a clone on main fast-forwards main', () => {
  const c = clone();
  git(c.root, 'checkout', '-q', '-b', 'main');
  assert.deepEqual(plain(host.refresh(c.root, { stateDir: c.state })), { from: c.old, to: c.main });
  assert.equal(git(c.root, 'rev-parse', 'main'), c.main);
});

test('refresh: at most once per interval; in between it returns the last result and does not fetch', () => {
  const c = clone();
  assert.ok(host.REFRESH_INTERVAL_MS >= 60_000 && host.REFRESH_INTERVAL_MS <= 30 * 60_000);
  const first = host.refresh(c.root, { stateDir: c.state });
  const tip = advance(c);
  assert.deepEqual(host.refresh(c.root, { stateDir: c.state }), first, 'throttled: the last result');
  assert.equal(head(c.root), c.main, 'and no fetch');
  assert.equal(host.behindCount(c.root), 0, 'behind counts from the last fetch');
  const later = Date.now() + host.REFRESH_INTERVAL_MS + 1000;
  assert.deepEqual(plain(host.refresh(c.root, { stateDir: c.state, now: later })), { from: c.main, to: tip });
  assert.equal(head(c.root), tip);
});

test('refresh: skips, untouched, with the reason: dirty tree, another branch, not a fast-forward, failed fetch', () => {
  const dirty = clone();
  writeFileSync(join(dirty.root, 'README.md'), 'local edit');
  assert.deepEqual(plain(host.refresh(dirty.root, { stateDir: dirty.state })), { skipped: 'the working tree has uncommitted changes' });
  assert.equal(head(dirty.root), dirty.old);
  assert.equal(readFileSync(join(dirty.root, 'README.md'), 'utf8'), 'local edit');

  const branch = clone();
  git(branch.root, 'checkout', '-q', '-b', 'feat');
  assert.deepEqual(plain(host.refresh(branch.root, { stateDir: branch.state })), { skipped: 'on branch feat, not main or detached' });
  assert.equal(head(branch.root), branch.old);

  const diverged = clone();
  git(diverged.root, 'commit', '-q', '--allow-empty', '-m', 'local');
  const local = head(diverged.root);
  assert.deepEqual(plain(host.refresh(diverged.root, { stateDir: diverged.state })), { skipped: 'not a fast-forward of origin/main' });
  assert.equal(head(diverged.root), local);
  assert.equal(host.behindCount(diverged.root), 1, 'the fetch still counts how far behind');

  const gone = clone();
  git(gone.root, 'remote', 'set-url', 'origin', join(gone.tmp, 'gone.git'));
  assert.deepEqual(plain(host.refresh(gone.root, { stateDir: gone.state })), { skipped: 'git fetch failed or timed out' });
  assert.equal(head(gone.root), gone.old);

  const loose = tempDir('refresh-nogit-');
  assert.deepEqual(plain(host.refresh(loose, { stateDir: join(loose, 's') })), { skipped: 'not a git checkout' });
  assert.equal(host.behindCount(loose), null);
});

test('refresh: never touches a linked worktree, nor its clone through it', () => {
  const c = clone();
  const wt = join(c.tmp, 'wt');
  git(c.root, 'worktree', 'add', '-q', '--detach', wt, c.old);
  assert.deepEqual(plain(host.refresh(wt, { stateDir: c.state })), { skipped: 'a linked worktree' });
  assert.equal(head(wt), c.old);
  assert.equal(head(c.root), c.old);
  assert.equal(git(c.root, 'rev-parse', 'refs/remotes/origin/main'), c.old, 'not even a fetch');
});

// file-turns.js (the Stop hook) runs refresh on the clone it runs from and stamps the result.
const input = (dir) => {
  const path = join(dir, 's1.jsonl');
  writeFileSync(path, [
    { type: 'user', timestamp: '2026-10-26T10:00:01.000Z', turnPosition: { turnIndex: 1 }, message: { content: 'go' } },
    { type: 'assistant', requestId: 'r1', timestamp: '2026-10-26T10:00:05.000Z', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 50 }, content: [] } }
  ].map((l) => JSON.stringify(l)).join('\n'));
  return JSON.stringify({ session_id: 's1', transcript_path: path });
};
const stop = (c, args = [], env = {}) => {
  const home = join(c.tmp, 'home');
  mkdirSync(home, { recursive: true });
  return execFileSync('node', [join(c.root, 'scripts/file-turns.js'), ...args], {
    input: input(c.tmp), encoding: 'utf8',
    env: { ...process.env, HARNESS_DISABLED: '', HARNESS_LIBRARY_DIR: c.lib, TMPDIR: c.tmp, HOME: home, ...env }
  });
};
const stamp = (c) => JSON.parse(readFileSync(join(c.lib, 'ledger/sessions/s1.json'), 'utf8')).harness;

test('Stop: refreshes the clone only when installed and not disabled, and stamps behind and refreshed', () => {
  const c = clone();
  assert.equal(stop(c, ['plugin']), '');
  assert.equal(head(c.root), c.old, 'not installed: no refresh');
  c.install();
  assert.equal(stop(c, ['plugin'], { HARNESS_DISABLED: '1' }), '');
  assert.equal(head(c.root), c.old, 'disabled: no refresh');
  assert.ok(!existsSync(join(c.lib, 'ledger')));

  assert.equal(stop(c, ['plugin']), '');
  assert.equal(head(c.root), c.main);
  const h = stamp(c);
  assert.equal(h.commit, c.old, 'the code that ran this hook');
  assert.equal(h.behind, 0);
  assert.deepEqual(plain(h.refreshed), { from: c.old, to: c.main });
  assert.deepEqual(h.hooks, ['plugin']);
});

test('Stop: a skipped refresh is stamped with its reason and behind as of the last fetch', () => {
  const c = clone();
  c.install();
  writeFileSync(join(c.root, 'README.md'), 'local edit');
  stop(c, ['plugin']);
  const h = stamp(c);
  assert.equal(head(c.root), c.old);
  assert.deepEqual(plain(h.refreshed), { skipped: 'the working tree has uncommitted changes' });
  assert.equal(h.behind, 0, 'never fetched: origin/main as last seen');
  git(c.root, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  stop(c, ['plugin']);
  assert.equal(stamp(c).behind, 1);
});

test('Stop: a synced copy (no git) stamps behind null and the skip', () => {
  const c = clone();
  c.install();
  const copy = join(c.tmp, 'copy');
  cpSync(plugin, copy, { recursive: true });
  stop({ ...c, root: copy }, ['plugin']);
  const h = stamp(c);
  assert.equal(h.behind, null);
  assert.deepEqual(plain(h.refreshed), { skipped: 'not a git checkout' });
});

test('Stop: a hanging fetch is cut off and the hook still exits 0 with the record filed', () => {
  const c = clone();
  c.install();
  git(c.root, 'remote', 'set-url', 'origin', 'ssh://example.invalid/repo.git');
  const t0 = Date.now();
  assert.equal(stop(c, ['plugin'], { GIT_SSH_COMMAND: 'sleep 30; :' }), '');
  assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0} ms`);
  assert.deepEqual(plain(stamp(c).refreshed), { skipped: 'git fetch failed or timed out' });
  assert.equal(head(c.root), c.old);
});

test('Stop label: no argument from a ~/.claude/settings.json registration is "settings", else "unknown"', () => {
  const c = clone();
  c.install();
  stop(c);
  assert.equal(stamp(c).hook, 'unknown', 'no registration found');
  const home = join(c.tmp, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  // As the old pasted setup.sh wrote it: a plain command, no argument.
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `node ${join(c.root, 'scripts/file-turns.js')}` }] }] } }));
  const fresh = { ...c, lib: join(c.tmp, 'lib2') };
  mkdirSync(fresh.lib);
  writeFileSync(join(fresh.lib, 'install.json'), '{}');
  stop(fresh);
  const h = stamp(fresh);
  assert.equal(h.hook, 'settings');
  assert.deepEqual(h.hooks, ['settings'], 'a session that started before the plugin hooks shipped: settings only');
  stop(fresh, ['plugin']);
  assert.deepEqual(stamp(fresh).hooks, ['plugin', 'settings']);
});

// S1b: the cases where a refresh must not act, or must not act elsewhere, or must not run long.

test('refresh: skips, HEAD unmoved, while a rebase is stopped at `break`', () => {
  const c = clone();
  git(c.root, '-c', 'sequence.editor=echo break >', 'rebase', '-q', '-i', c.old);
  assert.ok(existsSync(join(c.root, '.git/rebase-merge')), 'the rebase is in progress');
  assert.deepEqual(plain(host.refresh(c.root, { stateDir: c.state })), { skipped: 'a git operation is in progress (rebase-merge)' });
  assert.equal(head(c.root), c.old);
});

test('refresh: skips, HEAD unmoved, while a bisect is in progress', () => {
  const c = clone();
  git(c.root, 'bisect', 'start');
  assert.deepEqual(plain(host.refresh(c.root, { stateDir: c.state })), { skipped: 'a git operation is in progress (BISECT_LOG)' });
  assert.equal(head(c.root), c.old);
});

test('refresh: skips while any other operation marker is in the git dir', () => {
  for (const name of ['rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer']) {
    const c = clone();
    const path = join(c.root, '.git', name);
    if (/^[A-Z_]+$/.test(name)) writeFileSync(path, `${c.main}\n`); else mkdirSync(path);
    assert.deepEqual(plain(host.refresh(c.root, { stateDir: c.state })), { skipped: `a git operation is in progress (${name})` }, name);
    assert.equal(head(c.root), c.old, name);
  }
});

/** Runs fn with process.env changed by `vars` (undefined deletes), then puts it back. */
const withEnv = (vars, fn) => {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (v) => { for (const [k, x] of Object.entries(v)) if (x === undefined) delete process.env[k]; else process.env[k] = x; };
  set(vars);
  try { return fn(); } finally { set(was); }
};

test('refresh: GIT_DIR and friends pointing at another repo are ignored; that repo is untouched', () => {
  const c = clone();
  const other = clone();
  const before = { head: head(other.root), remote: git(other.root, 'rev-parse', 'refs/remotes/origin/main') };
  const dotgit = join(other.root, '.git');
  const r = withEnv({ GIT_DIR: dotgit, GIT_WORK_TREE: other.root, GIT_INDEX_FILE: join(dotgit, 'index'), GIT_COMMON_DIR: dotgit, GIT_OBJECT_DIRECTORY: join(dotgit, 'objects') },
    () => host.refresh(c.root, { stateDir: c.state }));
  assert.deepEqual(plain(r), { from: c.old, to: c.main }, 'the clone it was asked about');
  assert.equal(head(c.root), c.main);
  assert.equal(head(other.root), before.head, 'the other repo: HEAD unmoved');
  assert.equal(git(other.root, 'rev-parse', 'refs/remotes/origin/main'), before.remote, 'and not fetched into');
  assert.equal(withEnv({ GIT_DIR: dotgit }, () => host.behindCount(c.root)), 0);
});

test('refresh: the update is --ff-only, never a merge commit, even with merge.ff=false', () => {
  const c = clone();
  git(c.root, 'config', 'merge.ff', 'false');
  git(c.root, 'config', 'user.name', 't');
  git(c.root, 'config', 'user.email', 't@t');
  assert.deepEqual(plain(host.refresh(c.root, { stateDir: c.state })), { from: c.old, to: c.main });
  assert.equal(head(c.root), c.main, 'HEAD is origin/main itself, not a merge of it');
});

/** True once pid has exited (gone, or a zombie waiting to be reaped). */
const dead = (pid) => {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] === 'Z'; } catch {}
  try { process.kill(pid, 0); return false; } catch { return true; }
};

test('refresh: an ssh child of a timed-out fetch does not outlive the refresh', async () => {
  const c = clone();
  git(c.root, 'remote', 'set-url', 'origin', 'ssh://example.invalid/repo.git');
  const pidFile = join(c.tmp, 'ssh.pid');
  const t0 = Date.now();
  const r = withEnv({ GIT_SSH_COMMAND: `echo $$ > '${pidFile}'; exec sleep 30; :` }, () => host.refresh(c.root, { stateDir: c.state, ms: 1000 }));
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  assert.deepEqual(plain(r), { skipped: 'git fetch failed or timed out' });
  const pid = Number(readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 40 && !dead(pid); i++) await new Promise((ok) => setTimeout(ok, 50));
  const alive = !dead(pid);
  if (alive) process.kill(pid, 'SIGKILL');
  assert.ok(!alive, `ssh child ${pid} still running`);
});

test('refresh: the whole run fits its time budget, under 15 s by default, however slow git is', () => {
  assert.ok(host.REFRESH_BUDGET_MS > 0 && host.REFRESH_BUDGET_MS < 15_000, `budget ${host.REFRESH_BUDGET_MS}`);
  const c = clone();
  const bin = join(c.tmp, 'bin');
  mkdirSync(bin);
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nsleep 0.3\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const t0 = Date.now();
  const r = withEnv({ PATH: `${bin}:${process.env.PATH}` }, () => host.refresh(c.root, { stateDir: c.state, budget: 1000 }));
  const took = Date.now() - t0;
  assert.ok(took < 1600, `took ${took} ms for a 1000 ms budget`);
  assert.ok(r.skipped, `skipped: ${JSON.stringify(r)}`);
  assert.equal(head(c.root), c.old);
});
