// What GitHub itself says about a PR, read from its REST API before from-github applies a CI or merge
// result. A wake is text any session could write; the PR read is an input the session cannot produce.
// The fetcher is injectable: fetcher(path) resolves to the JSON at https://api.github.com/<path>.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const FAILED = ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'];

/** GET a REST path with `gh api` (GraphQL is never used), or with fetch and GH_TOKEN when gh is absent. */
export async function restFetcher(path) {
  try {
    return JSON.parse((await promisify(execFile)('gh', ['api', path], { maxBuffer: 1 << 24 })).stdout);
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(String(e.stderr || e.message).trim().split('\n').at(-1));
  }
  if (!process.env.GH_TOKEN) throw new Error('no gh on PATH and no GH_TOKEN');
  const r = await fetch(`https://api.github.com/${path}`, { headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status}`);
  return r.json();
}

/** A commit's check runs as one conclusion: failure if any failed, pending while any runs, else success (none without runs). */
export const combined = (runs) =>
  runs.some((r) => r.status === 'completed' && FAILED.includes(r.conclusion)) ? 'failure' : runs.some((r) => r.status !== 'completed') ? 'pending' : runs.length ? 'success' : 'none';

/**
 * The GitHub fact behind a CHECKS_PASSED, CHECKS_FAILED or MERGED for pr ("owner/repo#N"; sha: the head the
 * wake named, if any). Returns {ref} naming what GitHub said (and the head sha for CI), or {why} when GitHub
 * disagrees or cannot be read.
 */
export async function readFact({ type, pr, sha = '' }, fetcher = restFetcher) {
  const [repo, n] = pr.split('#');
  let step = `repos/${repo}/pulls/${n}`;
  try {
    const p = await fetcher(step);
    if (type === 'MERGED') {
      if (p.merged !== true || !p.merge_commit_sha) return { why: `GitHub says ${pr} is not merged` };
      const c = await fetcher((step = `repos/${repo}/commits/${p.merge_commit_sha}`)).catch((e) => ({ error: e.message }));
      if (c.sha !== p.merge_commit_sha) return { why: `GitHub: merge commit ${p.merge_commit_sha.slice(0, 7)} of ${pr} not found (${c.error ?? c.sha})` };
      return { ref: `${pr}:merged@${c.sha}` };
    }
    const head = String(p.head?.sha ?? '');
    if (!head || !head.startsWith(sha)) return { why: `GitHub says ${pr}'s head is ${head.slice(0, 7)}, not ${sha}` };
    const runs = await fetcher((step = `repos/${repo}/commits/${head}/check-runs?per_page=100`));
    const got = runs.total_count > runs.check_runs?.length ? 'pending' : combined(runs.check_runs ?? []);
    const want = type === 'CHECKS_PASSED' ? 'success' : 'failure';
    if (got !== want) return { why: `GitHub says ${pr}@${head.slice(0, 7)} checks=${got}, not ${want}` };
    return { ref: `${pr}@${head}:checks=${got}`, sha: head };
  } catch (e) {
    return { why: `cannot reach GitHub: ${e.message} (${step})` };
  }
}
