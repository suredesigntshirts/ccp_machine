// PR activity events into harness events. The orchestrator is woken with GitHub events (a check suite
// finished, a check failed, a PR merged); this maps each one to the item event it means, so the host stops
// translating them by hand. Items are found through the PR links on their own events.
import { apply, ack, status } from './runtime.js';

/**
 * {kind, data, at?} from a wake's `<event source="github" kind="...">{json}</event>` text, or from JSON.
 * `at` is the wake's current-time: when GitHub reported, which can be well before the host feeds it.
 */
export function parseGithubEvent(text) {
  const s = String(text).trim();
  const tag = /<event\b[^>]*\bkind="([^"]+)"[^>]*>([\s\S]*?)<\/event>/.exec(s);
  if (tag) {
    const json = tag[2].replace(/<!--[\s\S]*?-->/g, '').trim();
    const at = /<wake\b[^>]*\bcurrent-time="([^"]+)"/.exec(s)?.[1];
    return { kind: tag[1], data: JSON.parse(json), ...(at && { at }) };
  }
  const o = JSON.parse(s);
  return { kind: o.kind, data: o.data ?? o, ...(o.at && { at: o.at }) };
}

/** "owner/repo#12" or ".../owner/repo/pull/12" as "owner/repo#12". */
export const prKey = (ref) => {
  const m = /([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)/.exec(String(ref ?? ''));
  return m ? `${m[1]}#${m[2]}` : null;
};

/** PR to item, from the `pr` each item's events carry (the build's RUN_SUCCEEDED, CI and merge events). */
export function prMap(events) {
  const map = {};
  for (const e of events) {
    const key = prKey(e.event.pr);
    const item = /^item:([^/]+)/.exec(e.to ?? '')?.[1];
    if (key && item) map[key] = item;
  }
  return map;
}

const FAILED = ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'];

/** The harness event a GitHub event means, or {ignore: why}. */
export function mapGithubEvent({ kind, data }) {
  const pr = prKey(data?.pr);
  const sha = String(data?.head_sha ?? '').slice(0, 7);
  if (!pr) return { ignore: `no PR in ${kind}` };
  const url = `https://github.com/${pr.replace('#', '/pull/')}`;
  if (kind === 'check_suite.completed') return { pr, id: `ci-${sha}`, event: { type: 'CHECKS_PASSED', pr: url, sha }, state: 'verifying' };
  if (kind === 'check_run.completed') {
    if (!FAILED.includes(data.conclusion)) return { ignore: `check ${data.check ?? ''} ${data.conclusion}: the suite reports the result` };
    return { pr, id: `ci-${sha}`, event: { type: 'CHECKS_FAILED', pr: url, sha, check: data.check, conclusion: data.conclusion }, state: 'verifying' };
  }
  if (kind === 'pull_request.closed')
    return data.outcome === 'merged'
      ? { pr, id: `merge-pr${pr.split('#')[1]}`, event: { type: 'MERGED', pr: url }, state: 'merging' }
      : { pr, id: `closed-pr${pr.split('#')[1]}`, event: { type: 'CANCEL', reason: `PR closed without merging`, pr: url }, state: null };
  return { ignore: `${kind} needs nothing from the harness` };
}

/**
 * Apply one GitHub event to the store. Returns what happened: sent (with the effects), duplicate,
 * stale (the item is not waiting for it), unknown PR, or ignored.
 */
export function fromGithub(store, raw) {
  const ev = typeof raw === 'string' ? parseGithubEvent(raw) : raw;
  const m = mapGithubEvent(ev);
  if (m.ignore) return { result: 'ignored', why: m.ignore };
  const item = prMap(store.events())[m.pr];
  if (!item) return { result: 'unknown', why: `no item names ${m.pr}`, pr: m.pr };
  const it = status(store).items.find((i) => i.id === item);
  if (it?.done) return { result: 'stale', item, why: `${item} is already ${it.state}` };
  if (m.state && !String(it?.state ?? '').endsWith(m.state)) return { result: 'stale', item, why: `${item} is ${it?.state}, not ${m.state}` };
  if (m.event.type === 'MERGED') {
    const merge = store.pending().filter((e) => e.name === 'mergePullRequest' && (e.subject === item || e.actor === item)).map((e) => e.id);
    if (merge.length) ack(store, merge, { note: `merged: ${m.event.pr}` });
  }
  // observedAt lets the retro tell CI's time from the host's delay in feeding the result.
  const at = Date.parse(ev.at);
  const event = Number.isNaN(at) ? m.event : { ...m.event, observedAt: new Date(at).toISOString() };
  const r = apply(store, event, { to: `item:${item}`, id: m.id });
  return { result: r.duplicate ? 'duplicate' : 'sent', item, id: m.id, event: m.event.type, effects: r.effects.map((e) => e.name) };
}
