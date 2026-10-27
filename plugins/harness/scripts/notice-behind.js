#!/usr/bin/env node
// UserPromptSubmit hook: tells a long-running session, once per newer version, that the harness code it
// runs is behind, through `additionalContext` (a system reminder the model reads). At most one check
// per 30 minutes per session (the time is saved before any network call), capped at about 3 s.
//
// - A git checkout (the skills-dir link) is compared with origin/main by host.js behind(). When behind,
//   it fast-forwards that checkout, but only when the tracked files are clean and HEAD is a branch
//   tracking origin/main or detached at an ancestor of origin/main; otherwise it only reports.
// - A synced copy (no git) is compared with its sibling folders `<folder>~gN` by plugin.json version,
//   and only reports: a running session cannot switch copies.
// Every update or skip is appended to the session's `updates` (host.js updatesPath), which the Stop hook
// files as harness.updates. It does nothing unless installed (host.js) and always exits 0.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { gate, version, behind, updatesPath } from './host.js';

const INTERVAL_MS = 30 * 60 * 1000;
const started = Date.now();
const left = () => 2800 - (Date.now() - started);

/** git's trimmed output, or null on any failure. */
const git = (root, args, ms = 1000) => {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: Math.max(ms, 100), stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
  } catch { return null; }
};

/** Negative, 0 or positive as version a is older than, equal to or newer than b (numeric x.y.z). */
const compare = (a, b) => {
  const [x, y] = [a, b].map((s) => String(s).split('.').map((n) => parseInt(n, 10) || 0));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** The newest sibling synced copy (`<folder>` or `<folder>~gN` next to root) newer than v, or null. */
function newerSibling(v) {
  const base = basename(v.root).replace(/~g\d+$/, ''), parent = dirname(v.root);
  let best = null;
  for (const name of readdirSync(parent)) {
    if (name === basename(v.root) || name.replace(/~g\d+$/, '') !== base) continue;
    try {
      const { version: ver } = JSON.parse(readFileSync(join(parent, name, '.claude-plugin', 'plugin.json'), 'utf8'));
      if (compare(ver, v.version) > 0 && (!best || compare(ver, best.version) > 0)) best = { version: ver, root: join(parent, name) };
    } catch {}
  }
  return best;
}

/** A checkout behind origin/main: fast-forward it when allowed. Returns { key, update, text } or null. */
async function checkout(v, told) {
  const state = await behind(v, Math.min(1500, left() - 800));
  const tip = state.match(/^yes \(origin\/main (\w+)\)$/)?.[1];
  if (!tip || told.includes(tip)) return null;
  const { root } = v, short = v.commit.slice(0, 7);
  const branch = git(root, ['symbolic-ref', '-q', '--short', 'HEAD']); // null when detached
  const running = `harness ${v.version} commit ${short}`;
  let to = tip, action;
  if (git(root, ['status', '--porcelain', '--untracked-files=no']) !== '') action = 'skipped: the checkout has uncommitted changes';
  else if (branch && git(root, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]) !== 'origin/main') action = `skipped: the checkout is on branch ${branch}, which does not track origin/main`;
  else if (git(root, ['fetch', '-q', 'origin', 'main'], left() - 300) === null) action = 'skipped: git fetch failed';
  else {
    to = git(root, ['rev-parse', 'FETCH_HEAD']) ?? tip;
    if (!branch && git(root, ['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD']) === null) action = 'skipped: detached HEAD is not an ancestor of origin/main';
    else if (git(root, ['merge', '-q', '--ff-only', 'FETCH_HEAD'], 2000) === null) action = 'skipped: git merge --ff-only failed';
    else action = 'fast-forward';
  }
  const update = { from: v.commit, to, at: new Date().toISOString(), action };
  if (action === 'fast-forward') {
    return { key: tip, update, text: `Harness updated: this session started on ${running}; origin/main is at ${to.slice(0, 7)}, so the hook fast-forwarded the plugin checkout ${root} to it (now harness ${version(root).version}). Hook scripts run the new code from the next hook on; skills and hook registrations loaded at session start stay old until a new session starts, so start one before relying on changed skills.` };
  }
  return { key: tip, update, text: `Harness behind: this session runs ${running} from ${root}, older than origin/main ${tip}. Not updated (${action.slice(9)}). To pick it up, bring ${root} onto origin/main yourself (git pull --ff-only on a clean main) or ask the user to, then start a new session.` };
}

/** A synced copy with a newer sibling: report only. */
function synced(v, told) {
  const newer = newerSibling(v);
  if (!newer || told.includes(newer.version)) return null;
  return {
    key: newer.version,
    update: { from: v.version, to: newer.version, at: new Date().toISOString(), action: 'reported: synced copy, not switched' },
    text: `Harness behind: this session runs harness ${v.version} from the synced copy ${v.root}; a newer synced copy, harness ${newer.version}, is at ${newer.root}. A running session cannot switch copies: finish or hand off the current step, then start a new session to load the new version.`
  };
}

const save = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
};

const done = (text) => {
  if (text) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } })}\n`);
  process.exit(0);
};
setTimeout(() => done(null), 3000).unref();

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  if (!input.session_id || (await gate(500)) !== 'installed') done(null);
  const path = updatesPath(input.session_id);
  let cache = {};
  try { cache = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  if (Date.now() - (Date.parse(cache.checkedAt) || 0) < INTERVAL_MS) done(null);
  cache = { told: [], updates: [], ...cache, checkedAt: new Date().toISOString() };
  save(path, cache); // before the network, so a slow or killed check is not retried for 30 minutes
  const v = version();
  const found = v.commit ? await checkout(v, cache.told) : synced(v, cache.told);
  if (!found) done(null);
  cache.told.push(found.key);
  cache.updates.push(found.update);
  save(path, cache);
  done(found.text);
} catch {
  done(null); // swallowed on purpose; see above
}
