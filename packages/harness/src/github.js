// PR activity events into harness events. The orchestrator is woken with GitHub events (a check suite
// finished, a check failed, a PR merged); this maps each one to the item event it means, so the host stops
// translating them by hand. Items are found through the PR links on their own events.
import { apply, ack } from './runtime.js';
import { readFact, FAILED } from './github-read.js';
import { prKey, prMap, requestedAt } from './pr-binding.js';

export { prKey, prMap };

/**
 * {kind, data, at?} from a wake's `<event source="github" kind="...">{json}</event>` text, or from JSON.
 * `at` is the wake's current-time: when GitHub reported, which can be well before the host feeds it.
 */
export function parseGithubEvent(text) {
  const s = String(text).trim();
  const tag = /<event\b([^>]*)>([\s\S]*?)<\/event>/.exec(s);
  const attr = (name, where = tag?.[1] ?? '') => new RegExp(`(?:^|\\s)${name}="([^"]+)"`).exec(where)?.[1];
  if (tag && attr('kind')) {
    const data = JSON.parse(tag[2].replace(/<!--[\s\S]*?-->/g, '').trim());
    const at = attr('current-time', /<wake\b[^>]*>/.exec(s)?.[0]);
    return { kind: attr('kind'), data, ...(at && { at }) };
  }
  const o = JSON.parse(s);
  return { kind: o.kind, data: o.data ?? o, ...(o.at && { at: o.at }) };
}

/** The harness event a GitHub event means, or {ignore: why}. */
export function mapGithubEvent({ kind, data }) {
  const pr = prKey(data?.pr);
  const head = String(data?.head_sha ?? '');
  const sha = head.slice(0, 7);
  if (!pr) return { ignore: `no PR in ${kind}` };
  const url = `https://github.com/${pr.replace('#', '/pull/')}`;
  if (kind === 'check_suite.completed') return { pr, head, id: `ci-${sha}-passed`, event: { type: 'CHECKS_PASSED', pr: url, sha } };
  if (kind === 'check_run.completed') {
    if (!FAILED.includes(data.conclusion)) return { ignore: `check ${data.check ?? ''} ${data.conclusion}: the suite reports the result` };
    return { pr, head, id: `ci-${sha}-failed`, event: { type: 'CHECKS_FAILED', pr: url, sha, check: data.check, conclusion: data.conclusion } };
  }
  if (kind === 'pull_request.closed')
    return data.outcome === 'merged'
      ? { pr, id: `merge-pr${pr.split('#')[1]}`, event: { type: 'MERGED', pr: url } }
      : { pr, id: `closed-pr${pr.split('#')[1]}`, event: { type: 'CANCEL', reason: `PR closed without merging`, pr: url } };
  return { ignore: `${kind} needs nothing from the harness` };
}

/**
 * Apply one GitHub event to the store, sent by github from a github-wake, once GitHub agrees: before a CI
 * result or a merge, the PR is read from GitHub's REST API (fetcher, see github-read.js). It must be the
 * item's own PR (the item that named it first; created at or after the item's request; its branch name
 * contains the item id), a CI result must name the PR's full 40-character head sha, and the ref is the
 * fact read, such as o/r#7@<head sha>:checks=success or o/r#7:merged@<merge sha>. Returns what happened: sent
 * (with the effects), duplicate, refused (GitHub disagrees or cannot be read, or the item's machine would
 * not take it; nothing written), unknown PR, or ignored.
 */
export async function fromGithub(store, raw, { fetcher } = {}) {
  const ev = typeof raw === 'string' ? parseGithubEvent(raw) : raw;
  const m = mapGithubEvent(ev);
  if (m.ignore) return { result: 'ignored', why: m.ignore };
  const events = store.events();
  const item = prMap(events)[m.pr];
  if (!item) return { result: 'unknown', why: `no item names ${m.pr}`, pr: m.pr };
  const fact = m.event.type === 'CANCEL' ? { ref: m.pr } : await readFact({ type: m.event.type, pr: m.pr, sha: m.head, item, requestedAt: requestedAt(events, item) }, fetcher);
  if (fact.why) return { result: 'refused', item, id: m.id, why: fact.why };
  if (fact.sha) m.event.sha = fact.sha.slice(0, 7);
  const id = fact.sha ? m.id.replace(/^ci-[^-]*-/, `ci-${m.event.sha}-`) : m.id;
  // observedAt lets the retro tell CI's time from the host's delay in feeding the result.
  const at = Date.parse(ev.at);
  const event = { ...m.event, ...(!Number.isNaN(at) && { observedAt: new Date(at).toISOString() }), actor: { kind: 'github', id: 'github' }, source: { kind: 'github-wake', ref: fact.ref } };
  const r = apply(store, event, { to: `item:${item}`, id });
  if (r.refused) return { result: 'refused', item, id, why: r.why };
  if (m.event.type === 'MERGED') {
    const merge = store.pending().filter((e) => e.name === 'mergePullRequest' && (e.subject === item || e.actor === item)).map((e) => e.id);
    if (merge.length) ack(store, merge, { note: `merged: ${m.event.pr}` });
  }
  return { result: r.duplicate ? 'duplicate' : 'sent', item, id, event: m.event.type, effects: r.effects.map((e) => e.name) };
}

/** Every `<wake>...</wake>` in the text, in order (a notification read can hold several). */
export const splitWakes = (text) => String(text).match(/<wake\b[\s\S]*?<\/wake>/g) ?? [String(text)];

/** Apply each wake in the text: one result for one wake, else one per wake in order. */
export async function fromGithubText(store, text, opts) {
  const results = [];
  for (const w of splitWakes(text)) results.push(await fromGithub(store, w, opts));
  return results.length === 1 ? results[0] : results;
}
