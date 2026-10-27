// GitHub, offline: REST responses recorded from suredesigntshirts/ccp_machine#21 on 2026-10-27 (trimmed to
// the fields shown), served by a fetcher like the one from-github uses. Options make the same PR say
// something else: another head, failing or running checks, not merged, or GitHub out of reach.
import { readFileSync } from 'node:fs';

const load = (f) => JSON.parse(readFileSync(new URL(`./fixtures/github/${f}`, import.meta.url), 'utf8'));
export const recorded = { pull: load('pulls-21.json'), runs: load('check-runs-ceeba95.json'), commit: load('commit-354ac30.json') };
export const HEAD = recorded.pull.head.sha;
export const MERGE = recorded.pull.merge_commit_sha;

/** A fetcher(path) answering for any PR; `calls` lists the paths it was asked for. */
export function fakeGithub({ head = HEAD, checks = 'success', merged = true, mergeSha = MERGE, down } = {}) {
  const calls = [];
  const fetcher = async (path) => {
    calls.push(path);
    if (down) throw new Error(down);
    if (/^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(path))
      // An open PR has a merge_commit_sha too (GitHub's test merge), so only `merged` says it merged.
      return { ...recorded.pull, head: { ...recorded.pull.head, sha: head }, merged, state: merged ? 'closed' : 'open', merge_commit_sha: mergeSha };
    if (path.startsWith(`repos/`) && path.includes(`/commits/${head}/check-runs`))
      return { ...recorded.runs, check_runs: recorded.runs.check_runs.map((r) => ({ ...r, head_sha: head, ...(checks === 'in_progress' ? { status: 'in_progress', conclusion: null } : { conclusion: checks }) })) };
    if (path.endsWith(`/commits/${MERGE}`)) return recorded.commit;
    throw new Error(`gh: Not Found (HTTP 404) ${path}`);
  };
  fetcher.calls = calls;
  return fetcher;
}
