// What every hook in this plugin shares: the per-project install gate and the version of the code
// that runs. The gate's marker path and its override live here and nowhere else.
//
// Plugins installed from a claude.ai marketplace load into every project of the account, so each hook
// first asks installed() and does nothing (exit 0, no output, no writes) when it says no.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The harness's own Library folder; tests point it elsewhere. */
export const libraryDir = () => process.env.HARNESS_LIBRARY_DIR ?? '/mnt/project-files/harness';
/** The marker the install phase writes into a project that installs the harness. */
export const markerPath = () => join(libraryDir(), 'install.json');
/** Set to 1 to turn every hook off, even where the marker exists. */
export const DISABLE_ENV = 'HARNESS_DISABLED';

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
    commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {}
  return { name, version: ver, commit, root };
}

/** 'no', 'yes (origin/main <sha>)' or 'unknown': compares HEAD with origin/main by `git ls-remote`, capped at `ms`. */
export async function behind({ root, commit }, ms = 2500) {
  if (!commit) return 'unknown';
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const remote = await Promise.race([
    new Promise((ok) => execFile('git', ['-C', root, 'ls-remote', 'origin', 'refs/heads/main'], { timeout: ms, encoding: 'utf8', env },
      (err, out) => ok(err ? null : (out.split(/\s/)[0] || null)))),
    later(ms + 100, null) // a helper process may keep the pipe open after git is killed
  ]);
  if (!remote) return 'unknown';
  if (remote === commit) return 'no';
  try { // origin/main already in this checkout's history: ahead, not behind.
    execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', remote, commit], { timeout: 1000, stdio: 'ignore' });
    return 'no';
  } catch {
    return `yes (origin/main ${remote.slice(0, 7)})`;
  }
}
