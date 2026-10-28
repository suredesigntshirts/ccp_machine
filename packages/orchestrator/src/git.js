// A local git repository standing in for GitHub: the forge the host reads facts from and merges into.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export const gitForge = (repo) => ({
  repo,
  head: (ref) => git(repo, 'rev-parse', ref),
  diff: (sha) => git(repo, 'diff', `main...${sha}`),
  url: (branch) => `file://${repo}#${branch}`,
  /** A worktree at path: on branch (made from main when new), or detached at a commit. */
  worktree(path, { branch, at }) {
    if (existsSync(path)) return path;
    if (at) git(repo, 'worktree', 'add', '--detach', path, at);
    else git(repo, 'worktree', 'add', ...(git(repo, 'branch', '--list', branch) ? [path, branch] : ['-b', branch, path, 'main']));
    return path;
  },
  removeWorktree: (path) => git(repo, 'worktree', 'remove', '--force', path),
  /** Commit everything in a worktree; the new head, or null when nothing changed. */
  commitAll(cwd, message) {
    git(cwd, 'add', '-A');
    if (!git(cwd, 'status', '--porcelain')) return null;
    git(cwd, 'commit', '-q', '-m', message);
    return git(cwd, 'rev-parse', 'HEAD');
  },
  /** Merge exactly commit sha into main; the merge commit. */
  merge(sha, message) {
    git(repo, 'merge', '-q', '--no-ff', '-m', message, sha);
    return git(repo, 'rev-parse', 'HEAD');
  }
});
