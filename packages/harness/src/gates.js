// The verifier's verdict on GitHub and in the store, the merge gate's question, and doctor's audit of merges (#36).
// The rules are the workItem machine's (VERDICT_GIVEN, MERGED's unverifiedHead) and the host invariants it names
// (harness meta.invariants: mergeBound, pinnedHead, reviewOnHead); this file asks the machine through a dry run
// and reads or writes GitHub's REST API, and decides nothing the spec does not say.
import { execFileSync } from 'node:child_process';
import { apply } from './runtime.js';
import { prKey, prMap, itemOf } from './pr-binding.js';
import { restFetcher, ghPath, SHA } from './github-read.js';

/** PASS or FAIL, from a verdict's first non-empty line ("PASS", "Verdict: FAIL", "**PASS** ..."), else null. */
export const verdictOf = (text) => /^[#>*\s]*(?:verdict\s*:\s*)?\**\s*(PASS|FAIL)\b/i.exec(String(text ?? '').trim().split('\n')[0] ?? '')?.[1]?.toUpperCase() ?? null;

const contextOf = (store, item) => store.read()?.snapshot.children?.[item]?.snapshot.context ?? null;
const pullPath = (key) => { const [repo, n] = key.split('#'); return `repos/${repo}/pulls/${n}`; };
/** The item's latest VERDICT_GIVEN row for head `sha`, or null. */
const verdictRow = (events, item, sha) => events.findLast((e) => itemOf(e.to) === item && e.event?.type === 'VERDICT_GIVEN' && e.event.sha === sha) ?? null;

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
  const row = verdictRow(events, item, sha);
  let reviews;
  try {
    reviews = [].concat(await fetcher(`${pullPath(key)}/reviews?per_page=100`));
  } catch (e) {
    return { allow: false, rule: 'reviewOnHead', item, why: `cannot read ${key}'s reviews from GitHub: ${e.message}` };
  }
  const on = reviews.find((r) => r?.id === row?.event.review && r.commit_id === sha && r.state === 'COMMENTED' && String(r.body ?? '').trim() === String(row?.event.text ?? '').trim());
  if (!on) return { allow: false, rule: 'reviewOnHead', item, why: `${key} carries no review ${row?.event.review ?? ''} on ${sha.slice(0, 7)} with the PASS verdict the store holds` };
  return { allow: true, item, why: `item ${item}'s verifier passed ${sha.slice(0, 7)}, and review ${on.id} carries it on that sha` };
}

/**
 * Doctor's audit: every PR bound to an item that GitHub says is merged needs the item's latest verdict on its merge
 * head to be PASS in the store, and a PASS review on GitHub on that sha. [{result: ok|problem|unreachable, pr, item, why?}]
 */
export async function verifyMerges(store, { fetcher = restFetcher } = {}) {
  const events = store.events();
  const out = [];
  for (const [key, item] of Object.entries(prMap(events))) {
    try {
      const p = await fetcher(pullPath(key));
      if (p?.merged !== true) continue;
      const head = String(p.head?.sha ?? '');
      const why = [];
      if (verdictRow(events, item, head)?.event.verdict !== 'PASS') why.push(`the store holds no verifier PASS for its merge head ${head.slice(0, 7)}`);
      const reviews = [].concat(await fetcher(`${pullPath(key)}/reviews?per_page=100`));
      if (!reviews.some((r) => r?.commit_id === head && verdictOf(r.body) === 'PASS')) why.push(`GitHub has no PASS review on ${head.slice(0, 7)}`);
      out.push({ result: why.length ? 'problem' : 'ok', pr: key, item, ...(why.length && { why: why.join('; ') }) });
    } catch (e) {
      out.push({ result: 'unreachable', pr: key, item, why: e.message });
    }
  }
  return out;
}

export const verifyMergesText = (rows) => rows.map((r) => `${r.result} ${r.pr} item:${r.item}${r.why ? `: ${r.why}` : ''}`).join('\n');
