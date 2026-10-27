// What every hook in this plugin shares: the per-project install gate and the version of the code
// that runs. The gate's marker path and its override live here and nowhere else.
//
// Plugins installed from a claude.ai marketplace load into every project of the account, so each hook
// first asks installed() and does nothing (exit 0, no output, no writes) when it says no.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** The harness's own Library folder; tests point it elsewhere. */
export const libraryDir = () => process.env.HARNESS_LIBRARY_DIR ?? '/mnt/project-files/harness';
/** The marker the install phase writes into a project that installs the harness. */
export const markerPath = () => join(libraryDir(), 'install.json');
/** Set to 1 to turn every hook off, even where the marker exists. */
export const DISABLE_ENV = 'HARNESS_DISABLED';

/**
 * A session's update state: when notice-behind.js last checked, which newer versions it has told the
 * session about, and its `updates` log, which file-turns.js copies into the ledger record. Local to the
 * machine (not the slow Library mount); the session id is reduced to a safe file name.
 */
export const updatesPath = (session) => join(tmpdir(), 'harness-updates', `${String(session).replace(/[^A-Za-z0-9_-]/g, '')}.json`);

/** The plugin folder this code runs from (never cached: an update lands in a new sibling folder). */
export const pluginRoot = () => dirname(dirname(fileURLToPath(import.meta.url)));

const later = (ms, value) => new Promise((ok) => setTimeout(ok, ms, value).unref());

/**
 * 'disabled' when HARNESS_DISABLED=1, 'installed' when the marker can be read, else 'absent'.
 * One read and no directory walk, capped at `ms` because the Library mount is slow when cold.
 */
export async function gate(ms = 1000) {
  if (process.env[DISABLE_ENV] === '1') return 'disabled';
  const read = readFile(markerPath()).then(() => 'installed', () => 'absent');
  return Promise.race([read, later(ms, 'absent')]);
}

/** { name, version, commit, root }: commit is the git HEAD when the plugin sits in a checkout, else null. */
export function version(root = pluginRoot()) {
  let name = 'harness', ver = 'unknown', commit = null;
  try {
    ({ name = name, version: ver = ver } = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')));
  } catch {}
  try {
    commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv() }).trim() || null;
  } catch {}
  return { name, version: ver, commit, root };
}

/** 'no', 'yes (origin/main <sha>)' or 'unknown': compares HEAD with origin/main by `git ls-remote`, capped at `ms`. */
export async function behind({ root, commit }, ms = 2500) {
  if (!commit) return 'unknown';
  const env = gitEnv();
  const remote = await Promise.race([
    new Promise((ok) => execFile('git', ['-C', root, 'ls-remote', 'origin', 'refs/heads/main'], { timeout: ms, encoding: 'utf8', env },
      (err, out) => ok(err ? null : (out.split(/\s/)[0] || null)))),
    later(ms + 100, null) // a helper process may keep the pipe open after git is killed
  ]);
  if (!remote) return 'unknown';
  if (remote === commit) return 'no';
  try { // origin/main already in this checkout's history: ahead, not behind.
    execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', remote, commit], { timeout: 1000, stdio: 'ignore', env });
    return 'no';
  } catch {
    return `yes (origin/main ${remote.slice(0, 7)})`;
  }
}

/** How often refresh() may fetch, per clone. */
export const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
/** The most one refresh() may take, all its git calls together (the Stop hook must stay quick). */
export const REFRESH_BUDGET_MS = 12 * 1000;
/** A merge is not started with less than this left of the budget: a killed checkout would leave the tree half-updated. */
const MERGE_MIN_MS = 3000;

/**
 * Variables that point git at another repository, index, object store or config than the one `-C root`
 * names (a hook can run inside a git hook or under an outer tool that sets them). Every git call here
 * drops them, so it only ever acts on the clone it was asked about.
 */
const REDIRECTS = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_IMPLICIT_WORK_TREE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE',
  'GIT_NO_REPLACE_OBJECTS', 'GIT_INTERNAL_SUPER_PREFIX', 'GIT_QUARANTINE_PATH', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT']);
const gitEnv = () => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const k of Object.keys(env)) if (REDIRECTS.has(k) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete env[k];
  return env;
};
/** git's trimmed output, or null on any failure. */
const git = (root, args, ms = 2000) => {
  if (!(ms > 0)) return null;
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: ms, stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv() }).trim();
  } catch { return null; }
};

/** Commits HEAD is behind origin/main as of the last fetch (no network), or null when unknown. */
export function behindCount(root = pluginRoot()) {
  const n = git(root, ['rev-list', '--count', 'HEAD..refs/remotes/origin/main']);
  return n === null ? null : Number(n);
}

/** Files and folders in a git dir that mean a rebase, merge, cherry-pick, revert or bisect is under way. */
const OPERATIONS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'sequencer'];

/**
 * Brings the clone that `root` sits in up to date with origin/main, only when that is safe: not a linked
 * worktree, no rebase, merge, cherry-pick, revert or bisect in progress, HEAD detached or on main, no
 * uncommitted changes to tracked files, the fetch succeeds within `ms`, and the update is a fast-forward
 * (`git merge --ff-only`). Anything else is skipped. Every git call runs without the GIT_* variables that
 * would redirect it to another repository, and all of them together fit in `budget`; the fetch runs in
 * its own process group, killed whole when it times out, so no ssh child outlives it. Fetches at most
 * once per `interval` per clone (the time is saved before the fetch); in between it returns the last
 * result. Returns { at, from, to } (from === to when already up to date) or { at, skipped: reason }.
 * Never resets, never discards, never throws.
 */
export function refresh(root = pluginRoot(), { stateDir = join(tmpdir(), 'harness-refresh'), interval = REFRESH_INTERVAL_MS, ms = 5000, budget = REFRESH_BUDGET_MS, now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  const skip = (skipped) => ({ at, skipped });
  const deadline = Date.now() + budget;
  const left = () => deadline - Date.now();
  const run = (args, cap = 2000) => git(root, args, Math.min(cap, left()));
  try {
    const common = run(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!common) return skip('not a git checkout');
    const gitDir = run(['rev-parse', '--absolute-git-dir']);
    if (gitDir !== common) return skip(gitDir ? 'a linked worktree' : 'git rev-parse failed');
    const file = join(stateDir, `${common.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
    let state = {};
    try { state = JSON.parse(readFileSync(file, 'utf8')); } catch {}
    if (state.last && now - (Date.parse(state.checkedAt) || 0) < interval) return state.last;
    const save = (last) => {
      mkdirSync(stateDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ checkedAt: at, last }));
      renameSync(tmp, file);
      return last;
    };
    save(skip('started; did not finish')); // before the fetch, so a killed run is not retried at once
    const busy = () => OPERATIONS.find((name) => existsSync(join(gitDir, name)));
    let op = busy();
    if (op) return save(skip(`a git operation is in progress (${op})`));
    const branch = run(['symbolic-ref', '-q', '--short', 'HEAD']); // null when detached
    if (branch && branch !== 'main') return save(skip(`on branch ${branch}, not main or detached`));
    if (run(['status', '--porcelain', '--untracked-files=no']) !== '') return save(skip('the working tree has uncommitted changes'));
    const fetchMs = Math.min(ms, left());
    if (fetchMs <= 0) return save(skip('out of time before the fetch'));
    // Its own process group (detached), so the whole group, ssh included, can be killed if it hangs.
    const fetched = spawnSync('git', ['-C', root, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { stdio: 'ignore', timeout: fetchMs, detached: true, env: gitEnv() });
    if (fetched.status !== 0) {
      if (fetched.pid) try { process.kill(-fetched.pid, 'SIGKILL'); } catch {} // ESRCH: nothing left
      return save(skip('git fetch failed or timed out'));
    }
    const from = run(['rev-parse', 'HEAD']), to = run(['rev-parse', 'refs/remotes/origin/main']);
    if (!from || !to) return save(skip('git rev-parse failed'));
    if (from === to) return save({ at, from, to });
    if (run(['merge-base', '--is-ancestor', from, to]) === null) return save(skip('not a fast-forward of origin/main'));
    if ((op = busy())) return save(skip(`a git operation is in progress (${op})`)); // started during the fetch
    if (left() < MERGE_MIN_MS) return save(skip('out of time before the merge'));
    if (run(['merge', '-q', '--ff-only', to], 5000) === null) return save(skip('git merge --ff-only failed'));
    return save({ at, from, to });
  } catch {
    return skip('error');
  }
}
