// harness verify-facts: re-read GitHub for every fact a github-wake event put in the log, from outside the
// session that wrote it. from-github's checks run inside a session, and a session can replace the code that
// runs them (or call apply() itself); a re-read later, by anyone holding the store, catches a fact GitHub
// does not back. It reads the log and GitHub only, and never writes to the store.
import { restFetcher, malformed, notItsPr, runsState } from './github-read.js';
import { prKey, prMap, itemOf, requestedAt } from './pr-binding.js';

const PR = '([\\w.-]+\\/[\\w.-]+#\\d+)';
const FACT = {
  CHECKS_PASSED: new RegExp(`^${PR}@([0-9a-f]{40}):checks=(success)$`),
  CHECKS_FAILED: new RegExp(`^${PR}@([0-9a-f]{40}):checks=(failure)$`),
  MERGED: new RegExp(`^${PR}:merged@([0-9a-f]{40})$`),
  CANCEL: new RegExp(`^${PR}$`)
};

/** Re-check one github-wake row against GitHub: {result: ok|mismatch|unreachable, why?}. */
async function verifyRow(row, events, fetcher) {
  const type = row.event?.type;
  const ref = String(row.source?.ref ?? '');
  const item = itemOf(row.to);
  const m = FACT[type]?.exec(ref);
  if (!m) return { result: 'mismatch', why: FACT[type] ? `the ref names no GitHub fact for ${type}` : `${type} is not a GitHub fact` };
  const [, ref0, sha] = m;
  const pr = prKey(ref0);
  const why = [];
  const bound = prMap(events)[pr];
  if (bound !== item) why.push(bound ? `${pr} is bound to item ${bound}, not ${item}` : `no event of item ${item} names ${pr}`);
  const [repo, n] = pr.split('#');
  let step = `repos/${repo}/pulls/${n}`;
  try {
    const p = await fetcher(step);
    const bad = malformed(p, n);
    if (bad) return { result: 'mismatch', why: [...why, `GitHub's answer for ${pr} is malformed: ${bad}`].join('; ') };
    why.push(...notItsPr(p, pr, { item, requestedAt: requestedAt(events, item) }));
    if (type === 'MERGED') {
      if (p.merged !== true) why.push(`GitHub says ${pr} is not merged`);
      else if (p.merge_commit_sha !== sha) why.push(`GitHub's merge commit of ${pr} is ${String(p.merge_commit_sha).slice(0, 7)}, not ${sha.slice(0, 7)}`);
      else if ((await fetcher((step = `repos/${repo}/commits/${sha}`)))?.sha !== sha) why.push(`GitHub: merge commit ${sha.slice(0, 7)} not found`);
    } else if (type === 'CANCEL') {
      if (p.state !== 'closed' || p.merged) why.push(`GitHub says ${pr} is ${p.merged ? 'merged' : p.state}, not closed without merging`);
    } else {
      // The head then may not be the head now: the commit has to be one of the PR's (its first 100).
      const onPr = p.head.sha === sha || [].concat(await fetcher((step = `repos/${repo}/pulls/${n}/commits?per_page=100`))).some((c) => c?.sha === sha);
      if (!onPr) why.push(`${sha.slice(0, 7)} is not a commit of ${pr}`);
      const got = runsState(await fetcher((step = `repos/${repo}/commits/${sha}/check-runs?per_page=100`)));
      if (got !== m[3]) why.push(`GitHub says ${pr}@${sha.slice(0, 7)} checks=${got}, not ${m[3]}`);
    }
  } catch (e) {
    return why.length ? { result: 'mismatch', why: why.join('; ') } : { result: 'unreachable', why: `${e.message} (${step})` };
  }
  return why.length ? { result: 'mismatch', why: why.join('; ') } : { result: 'ok' };
}

/**
 * Every github-wake event in the store's log, re-checked against GitHub in log order:
 * [{result: 'ok'|'mismatch'|'unreachable', id, item, type, ref, why?}]. fetcher as in github-read.js.
 */
export async function verifyFacts(store, { fetcher = restFetcher } = {}) {
  const events = store.events();
  const out = [];
  for (const row of events.filter((e) => e.source?.kind === 'github-wake')) {
    const r = await verifyRow(row, events, fetcher);
    out.push({ result: r.result, id: row.id, item: itemOf(row.to), type: row.event?.type, ref: String(row.source.ref ?? ''), ...(r.why && { why: r.why }) });
  }
  return out;
}

/** One line per fact: `<ok|mismatch|unreachable> <event id> item:<id> <TYPE> <ref>[: why]`. */
export const verifyFactsText = (results) => results.map((r) => `${r.result} ${r.id} item:${r.item} ${r.type} ${r.ref}${r.why ? `: ${r.why}` : ''}`).join('\n');
