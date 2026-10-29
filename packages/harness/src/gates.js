// The verifier's verdict on GitHub and in the store, the merge gate's question, and doctor's audit of merges (#36).
// The rules are the workItem machine's (VERDICT_GIVEN, MERGED's unverifiedHead) and the host invariants it names
// (harness meta.invariants: mergeBound, pinnedHead, reviewOnHead); this file asks the machine through a dry run
// and reads or writes GitHub's REST API, and decides nothing the spec does not say.
import { execFileSync } from 'node:child_process';
import { apply } from './runtime.js';
import { prKey, prMap, itemOf } from './pr-binding.js';
import { restFetcher, ghPath, SHA, mapLimit, READS_AT_ONCE } from './github-read.js';
import { specs } from './machines.js';

/** PASS or FAIL, from a verdict's first non-empty line ("PASS", "Verdict: FAIL", "**PASS** ..."), else null. */
export const verdictOf = (text) => /^[#>*\s]*(?:verdict\s*:\s*)?\**\s*(PASS|FAIL)\b/i.exec(String(text ?? '').trim().split('\n')[0] ?? '')?.[1]?.toUpperCase() ?? null;

const contextOf = (store, item) => store.read()?.snapshot.children?.[item]?.snapshot.context ?? null;
const pullPath = (key) => { const [repo, n] = key.split('#'); return `repos/${repo}/pulls/${n}`; };
/** The sha whose verifier PASS head `sha` holds: the one a carried PASS was given on (workItem carryVerdict), else sha. */
const givenOn = (store, item, sha) => (contextOf(store, item)?.verdicts?.[sha]?.givenOn ?? sha);
/** The item's latest VERDICT_GIVEN row for head `sha`, or null. */
const verdictRow = (events, item, sha) => events.findLast((e) => itemOf(e.to) === item && e.event?.type === 'VERDICT_GIVEN' && e.event.sha === sha) ?? null;

/**
 * Review `r` carries the store's verdict `row` on `sha` (reviewOnHead): the review id the store holds, on that sha,
 * COMMENTED, its body the stored text verbatim or followed by exactly the host's footer (harness meta.reviewFooter).
 */
const carries = (r, row, sha) => {
  const body = String(r?.body ?? '').trim();
  const text = String(row?.event.text ?? '').trim();
  return r?.id === row?.event.review && r.commit_id === sha && r.state === 'COMMENTED' && (body === text || body === text + specs.harness.meta.reviewFooter.text);
};

/** POST JSON to a REST path with gh (by absolute path), or with fetch and GH_TOKEN when there is no gh. */
export async function restPost(path, body, { gh = ghPath(), token = process.env.GH_TOKEN, fetchImpl = globalThis.fetch } = {}) {
  if (gh) {
    try {
      return JSON.parse(execFileSync(gh, ['api', '-X', 'POST', path, '--input', '-'], { input: JSON.stringify(body), encoding: 'utf8', maxBuffer: 1 << 24 }));
    } catch (e) {
      throw new Error(String(e.stderr || e.message).trim().split('\n').at(-1));
    }
  }
  if (!token) throw new Error('no gh and no GH_TOKEN');
  const r = await fetchImpl(`https://api.github.com/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`POST ${path}: HTTP ${r.status}`);
  return r.json();
}

/**
 * harness verdict: the verifier's verdict file, verbatim, as a COMMENT review on the PR at head `sha` ending with the
 * item's verifier brief sha256, and the same verdict as VERDICT_GIVEN from the verifier's agent actor (`by`). The
 * machine is asked first (dry run), so a verdict it would refuse is never posted. Returns apply's result plus the review.
 */
export async function giveVerdict(store, { text, to, pr, sha, by }, { post = restPost, now } = {}) {
  const item = itemOf(to);
  const key = prKey(pr);
  if (!item || !key) throw new Error('verdict needs --to item:<id> and --pr <the PR>');
  const brief = contextOf(store, item)?.verifierBrief;
  if (!brief) throw new Error(`item ${item} has no verifier brief fixed (VERIFIER_BRIEF_FIXED); nothing posted`);
  const verdict = verdictOf(text);
  if (!verdict) throw new Error("the verdict file's first line names no PASS or FAIL; nothing posted");
  const body = String(text).trimEnd().endsWith(brief) ? String(text).trimEnd() : `${String(text).trimEnd()}\n\nBrief-Sha256: ${brief}`;
  const event = { type: 'VERDICT_GIVEN', verdict, sha, pr: `https://github.com/${key.replace('#', '/pull/')}`, text: body, ...by };
  const dry = apply(store, { ...event, review: 1 }, { to, dryRun: true });
  if (dry.refused) return dry;
  const review = await post(`${pullPath(key)}/reviews`, { commit_id: sha, event: 'COMMENT', body });
  if (!Number.isInteger(review?.id)) throw new Error(`GitHub returned no review id for ${key}`);
  const r = apply(store, { ...event, review: review.id }, { to, id: `verdict-${item}-${review.id}`, ...(now && { now }) });
  return { ...r, review: { id: review.id, url: review.html_url ?? null } };
}

/**
 * The merge gate's question: may PR `pr` be merged at head `sha` now? {allow, rule, why, item}. It is denied unless the
 * PR is bound to an item (mergeBound), the call pins a full head sha (pinnedHead), the item's machine would take MERGED
 * of that head (machine: unverifiedHead and the state), and the PR carries the item's PASS verdict verbatim as a review
 * on that sha (reviewOnHead, read from GitHub's REST API).
 */
export async function mergeGate(store, { pr, sha }, { fetcher = restFetcher } = {}) {
  const key = prKey(pr);
  if (!key) return { allow: false, rule: 'mergeBound', why: `the merge names no PR the gate can read (${pr ?? 'none'})` };
  const events = store.events();
  const item = prMap(events)[key];
  if (!item) return { allow: false, rule: 'mergeBound', why: `${key} is bound to no item in the store` };
  if (!SHA.test(String(sha ?? ''))) return { allow: false, rule: 'pinnedHead', item, why: `the merge of ${key} pins no full head sha (${sha || 'none'}): pass expectedHeadSha, --match-head-commit or sha` };
  const github = { actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref: `merge-gate ${key}@${sha}` } };
  const dry = apply(store, { type: 'MERGED', pr: `https://github.com/${key.replace('#', '/pull/')}`, sha, ...github }, { to: `item:${item}`, dryRun: true });
  if (dry.refused) return { allow: false, rule: 'machine', item, why: `item ${item}'s machine would not take the merge of ${sha.slice(0, 7)}: ${dry.why}` };
  // A PASS carried to a merge of main (#137) is checked as a review on the sha the verifier gave it on.
  const on = givenOn(store, item, sha);
  const row = verdictRow(events, item, on);
  let reviews;
  try {
    reviews = [].concat(await fetcher(`${pullPath(key)}/reviews?per_page=100`));
  } catch (e) {
    return { allow: false, rule: 'reviewOnHead', item, why: `cannot read ${key}'s reviews from GitHub: ${e.message}` };
  }
  const review = reviews.find((r) => carries(r, row, on));
  if (!review) return { allow: false, rule: 'reviewOnHead', item, why: `${key} carries no review ${row?.event.review ?? ''} on ${on.slice(0, 7)} with the PASS verdict the store holds` };
  const carried = on !== sha ? `, carried to ${sha.slice(0, 7)} by a merge of main` : '';
  return { allow: true, item, why: `item ${item}'s verifier passed ${on.slice(0, 7)}${carried}, and review ${review.id} carries it on that sha` };
}

/** The repositories the store names (owner/repo, lowercased): its bound PRs' and its requests' issues'. */
const reposOf = (events, bound) => [
  ...new Set([
    ...Object.keys(bound).map((k) => k.split('#')[0]),
    ...events.map((e) => /github\.com\/([\w.-]+\/[\w.-]+)\/issues\/\d/.exec(e.event?.request?.url ?? '')?.[1]?.toLowerCase()).filter(Boolean)
  ])
];

/** Every PR GitHub says landed on main in `repo` at or after `since`, as {key: {head, at}}, read from REST pages of 100. */
async function landedOnMain(repo, fetcher, since) {
  const heads = {};
  for (let page = 1; ; page++) {
    const prs = [].concat(await fetcher(`repos/${repo}/pulls?state=closed&base=main&per_page=100&page=${page}`));
    for (const p of prs) if (p?.merged_at && Date.parse(p.merged_at) >= since) heads[`${repo}#${p.number}`] = { head: String(p.head?.sha ?? ''), at: p.merged_at };
    if (prs.length < 100) return heads;
  }
}

/**
 * Doctor's audit: every PR GitHub says landed on main, in each repository the store names, at or after the store's
 * first event (an older landing is outside what the store can judge), and every landed PR bound to an item, needs its item's latest verdict on its landed head to be PASS in the store, and GitHub to carry it as a
 * review on that sha, compared as the merge gate does, unless an OUT_OF_BAND row records that landing. A PR bound to no
 * item has no verdict, so its landing is a problem. On a history, a landing before the last ERA_ENDED row is judged by
 * the rules of its era, the first ERA_ENDED row at or after it: not a problem, its result era (harness meta.invariants
 * reviewOnHead). [{result: ok|problem|outOfBand|era|unreachable, pr, item, why?, row?, era?, ended?}]
 */
export async function verifyMerges(store, { fetcher = restFetcher } = {}) {
  const events = store.events();
  const bound = prMap(events);
  const marks = events.filter((e) => e.event?.type === specs.harness.meta.store.eras.event);
  const out = [];
  const landed = {};
  for (const repo of reposOf(events, bound)) {
    try {
      Object.assign(landed, await landedOnMain(repo, fetcher, Date.parse(events[0].at)));
    } catch (e) {
      out.push({ result: 'unreachable', pr: repo, why: `cannot list the PRs landed on main: ${e.message}` });
    }
  }
  // Each PR is read on its own, READS_AT_ONCE at a time, and listed in this order.
  const audited = await mapLimit([...new Set([...Object.keys(landed), ...Object.keys(bound)])], READS_AT_ONCE, async (key) => {
    const item = bound[key] ?? null;
    try {
      let { head, at } = landed[key] ?? {};
      if (head === undefined) {
        const p = await fetcher(pullPath(key));
        if (p?.merged !== true) return null;
        [head, at] = [String(p.head?.sha ?? ''), p.merged_at];
      }
      const why = [];
      const on = item && givenOn(store, item, head);
      const row = item && verdictRow(events, item, on);
      if (!item) why.push(`bound to no item: the store holds no verifier PASS for its landed head ${head.slice(0, 7)}`);
      else {
        if (row?.event.verdict !== 'PASS') why.push(`the store holds no verifier PASS for its merge head ${head.slice(0, 7)}`);
        const reviews = [].concat(await fetcher(`${pullPath(key)}/reviews?per_page=100`));
        if (!reviews.some((r) => carries(r, row, on))) why.push(`GitHub has no PASS review on ${on.slice(0, 7)} carrying the verdict the store holds`);
      }
      // A landing an OUT_OF_BAND row of the history records is listed by doctor, not a problem (meta.invariants reviewOnHead).
      const oob = why.length && events.find((e) => e.event?.type === 'OUT_OF_BAND' && prKey(e.event.pr ?? '') === key && (!e.event.sha || e.event.sha === head));
      if (oob) return { result: 'outOfBand', pr: key, item, row: oob.id };
      // A landing before an era's end is a fact of that era, judged by its rules, not today's (meta.invariants reviewOnHead).
      const era = why.length && at && marks.find((m) => Date.parse(m.at) >= Date.parse(at));
      if (era) return { result: 'era', pr: key, item, era: era.event.era, ended: era.at, why: why.join('; ') };
      return { result: why.length ? 'problem' : 'ok', pr: key, item, ...(why.length && { why: why.join('; ') }) };
    } catch (e) {
      return { result: 'unreachable', pr: key, item, why: e.message };
    }
  });
  return [...out, ...audited.filter(Boolean)];
}

export const verifyMergesText = (rows) => rows.map((r) => `${r.result} ${r.pr}${!('item' in r) ? '' : r.item ? ` item:${r.item}` : ' no item'}${r.why ? `: ${r.why}` : ''}`).join('\n');
