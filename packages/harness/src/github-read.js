// What GitHub itself says about a PR, read from its REST API before from-github applies a CI or merge
// result, and again by verify-facts afterwards. A wake is text any session could write; the PR read is an
// input an honest session cannot get wrong. The fetcher is injectable: fetcher(path) resolves to the JSON at
// https://api.github.com/<path>. These checks stop mistakes, not a hostile session: code running inside a
// session can be replaced by that session, so `harness verify-facts`, run from outside, is the check.
import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

export const FAILED = ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'];
export const GH = '/usr/local/bin/gh';
export const SHA = /^[0-9a-f]{40}$/;

const executable = (p) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const commandV = () => {
  try {
    return execFileSync('/bin/sh', ['-c', 'command -v gh'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
};

/** The gh to run, by absolute path: /usr/local/bin/gh if there, else what `command -v gh` finds; else null. */
export function resolveGh({ isFile = executable, commandV: which = commandV } = {}) {
  if (isFile(GH)) return GH;
  const found = which();
  return found && isAbsolute(found) ? found : null;
}
let gh;
/** resolveGh(), once per process: later PATH changes do not move it. */
export const ghPath = () => (gh === undefined ? (gh = resolveGh()) : gh);

/** GET a REST path with gh (`gh api`, by absolute path; GraphQL is never used), or with fetch and GH_TOKEN when there is no gh. */
export async function restFetcher(path, { gh = ghPath(), run = promisify(execFile), fetchImpl = globalThis.fetch, token = process.env.GH_TOKEN } = {}) {
  if (gh) {
    let out;
    try {
      out = (await run(gh, ['api', path], { maxBuffer: 1 << 24 })).stdout;
    } catch (e) {
      throw new Error(String(e.stderr || e.message).trim().split('\n').at(-1));
    }
    return JSON.parse(out);
  }
  if (!token) throw new Error(`no gh (${GH} or \`command -v gh\`) and no GH_TOKEN`);
  const r = await fetchImpl(`https://api.github.com/${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status}`);
  return r.json();
}

/** A commit's check runs as one conclusion: failure if any failed, pending while any runs, else success (none without runs). */
export const combined = (runs) =>
  runs.some((r) => r.status === 'completed' && FAILED.includes(r.conclusion)) ? 'failure' : runs.some((r) => r.status !== 'completed') ? 'pending' : runs.length ? 'success' : 'none';

/** A check-runs answer as one conclusion; more runs than the page holds (total_count > runs) is pending. */
export const runsState = (runs) => (runs?.total_count > (runs?.check_runs?.length ?? 0) ? 'pending' : combined(runs?.check_runs ?? []));

/** What is wrong with a PR answer for number n (number, head.sha of 40 hex, merged boolean, created_at), or null. */
export function malformed(p, n) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return `not a PR object`;
  const bad = [];
  if (p.number !== Number(n)) bad.push(`number ${JSON.stringify(p.number)}, not ${n}`);
  if (!SHA.test(String(p.head?.sha ?? ''))) bad.push(`head.sha ${JSON.stringify(p.head?.sha)}`);
  if (typeof p.merged !== 'boolean') bad.push(`merged ${JSON.stringify(p.merged)}`);
  if (typeof p.created_at !== 'string' || Number.isNaN(Date.parse(p.created_at))) bad.push(`created_at ${JSON.stringify(p.created_at)}`);
  return bad.length ? bad.join(', ') : null;
}

/** Why PR answer p is not item's own PR: opened before the item's request, or a branch without its id. */
export function notItsPr(p, pr, { item, requestedAt }) {
  const why = [];
  if (!requestedAt) why.push(`item ${item} has no REQUEST_RECEIVED to date its PR against`);
  else if (Date.parse(p.created_at) < Date.parse(requestedAt)) why.push(`${pr} was created ${p.created_at}, before item ${item}'s request at ${requestedAt}`);
  const ref = String(p.head?.ref ?? '');
  if (!ref.includes(item)) why.push(`${pr}'s branch ${ref || '(none)'} does not contain the item id ${item}`);
  return why;
}

/**
 * The GitHub fact behind a CHECKS_PASSED, CHECKS_FAILED or MERGED for pr ("owner/repo#N"; sha: the full head
 * sha the wake named, needed for CI). With item, the PR must also be that item's: created at or after
 * requestedAt and on a branch whose name contains the item id. Returns {ref} naming what GitHub said (and the
 * head sha for CI), or {why} when the wake or GitHub's answer falls short, GitHub disagrees, or it cannot be read.
 */
export async function readFact({ type, pr, sha = '', item, requestedAt }, fetcher = restFetcher) {
  const [repo, n] = pr.split('#');
  if (type !== 'MERGED' && !SHA.test(sha)) return { why: `the wake names no full 40-character head sha for ${pr} (${sha || 'none'})` };
  let step = `repos/${repo}/pulls/${n}`;
  try {
    const p = await fetcher(step);
    const bad = malformed(p, n);
    if (bad) return { why: `GitHub's answer for ${pr} is malformed: ${bad}` };
    if (item != null) {
      const not = notItsPr(p, pr, { item, requestedAt });
      if (not.length) return { why: `GitHub: ${not.join('; ')}` };
    }
    if (type === 'MERGED') {
      if (p.merged !== true || !p.merge_commit_sha) return { why: `GitHub says ${pr} is not merged` };
      const c = await fetcher((step = `repos/${repo}/commits/${p.merge_commit_sha}`)).catch((e) => ({ error: e.message }));
      if (c.sha !== p.merge_commit_sha) return { why: `GitHub: merge commit ${p.merge_commit_sha.slice(0, 7)} of ${pr} not found (${c.error ?? c.sha})` };
      return { ref: `${pr}:merged@${c.sha}` };
    }
    const head = p.head.sha;
    if (head !== sha) return { why: `GitHub says ${pr}'s head is ${head.slice(0, 7)}, not ${sha.slice(0, 7)}` };
    const got = runsState(await fetcher((step = `repos/${repo}/commits/${head}/check-runs?per_page=100`)));
    const want = type === 'CHECKS_PASSED' ? 'success' : 'failure';
    if (got !== want) return { why: `GitHub says ${pr}@${head.slice(0, 7)} checks=${got}, not ${want}` };
    return { ref: `${pr}@${head}:checks=${got}`, sha: head };
  } catch (e) {
    return { why: `cannot reach GitHub: ${e.message} (${step})` };
  }
}
