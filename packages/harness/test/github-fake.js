// GitHub, offline: REST responses recorded from suredesigntshirts/ccp_machine#21 on 2026-10-27 (trimmed to
// the fields shown), served by a fetcher like the one from-github uses. Options make the same PR say
// something else: another head or branch, created at another time, failing or running checks, more runs
// than one page holds, not merged, a malformed answer, or GitHub out of reach.
import { readFileSync } from 'node:fs';

const load = (f) => JSON.parse(readFileSync(new URL(`./fixtures/github/${f}`, import.meta.url), 'utf8'));
export const recorded = { pull: load('pulls-21.json'), runs: load('check-runs-ceeba95.json'), commit: load('commit-354ac30.json'), commits: load('pull-commits-21.json') };
export const HEAD = recorded.pull.head.sha;
export const MERGE = recorded.pull.merge_commit_sha;
export const CREATED = recorded.pull.created_at;
export const BRANCH = recorded.pull.head.ref;

/**
 * A fetcher(path) answering for any PR; `calls` lists the paths it was asked for. `checks` is the conclusion
 * of every run (or 'in_progress'); `totalCount` claims more runs than the page holds; `mangle(pull)` returns
 * the PR answer to serve instead; `earlier` lists commits the PR had before its head.
 */
export function fakeGithub({ head = HEAD, ref = BRANCH, createdAt = CREATED, checks = 'success', totalCount, merged = true, mergeSha = MERGE, earlier = [], mangle = (p) => p, down } = {}) {
  const calls = [];
  const fetcher = async (path) => {
    calls.push(path);
    if (down) throw new Error(down);
    const number = Number(/\/pulls\/(\d+)/.exec(path)?.[1]);
    if (/^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(path))
      // An open PR has a merge_commit_sha too (GitHub's test merge), so only `merged` says it merged.
      return mangle({ ...recorded.pull, number, created_at: createdAt, head: { ...recorded.pull.head, ref, sha: head }, merged, state: merged ? 'closed' : 'open', merge_commit_sha: mergeSha });
    if (/^repos\/[^/]+\/[^/]+\/pulls\/\d+\/commits/.test(path)) return [...earlier, head].map((sha) => ({ sha }));
    for (const sha of [head, ...earlier])
      if (path.startsWith(`repos/`) && path.includes(`/commits/${sha}/check-runs`)) {
        const runs = recorded.runs.check_runs.map((r) => ({ ...r, head_sha: sha, ...(checks === 'in_progress' ? { status: 'in_progress', conclusion: null } : { conclusion: checks }) }));
        return { ...recorded.runs, total_count: totalCount ?? runs.length, check_runs: runs };
      }
    if (path.endsWith(`/commits/${MERGE}`)) return recorded.commit;
    throw new Error(`gh: Not Found (HTTP 404) ${path}`);
  };
  fetcher.calls = calls;
  return fetcher;
}
