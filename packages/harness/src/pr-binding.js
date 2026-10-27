// Which PR is whose. An item's PR is bound once, by the first event that names it (a build's RUN_SUCCEEDED
// with `pr`, usually), and one PR binds to at most one item; runtime.apply() refuses an event that would
// bind otherwise. So a GitHub fact read for a PR counts for the one item that named it first.

/** "owner/repo#12" or ".../owner/repo/pull/12" as "owner/repo#12". */
export const prKey = (ref) => {
  const m = /([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)/.exec(String(ref ?? ''));
  return m ? `${m[1]}#${m[2]}` : null;
};

/** The item an address belongs to: "item:a" and "item:a/decision:..." are item a's; others none. */
export const itemOf = (to) => /^item:([^/]+)/.exec(to ?? '')?.[1] ?? null;

/** PR to item, each PR bound by the first event naming it, and only for an item not bound already. */
export function prMap(events) {
  const map = {};
  const taken = new Set();
  for (const e of events) {
    const key = prKey(e.event?.pr);
    const item = itemOf(e.to);
    if (!key || !item || key in map || taken.has(item)) continue;
    map[key] = item;
    taken.add(item);
  }
  return map;
}

/** Why an event to `to` naming `pr` would break a binding in the log, or null when it may go. */
export function bindingError(events, to, pr) {
  const key = prKey(pr);
  const item = itemOf(to);
  if (!key || !item) return null;
  const map = prMap(events);
  const mine = Object.keys(map).find((k) => map[k] === item);
  if (mine && mine !== key) return `names ${key}, but item ${item} is bound to ${mine} (an item's PR is bound once, by the first event naming it)`;
  if (map[key] && map[key] !== item) return `names ${key}, but ${key} is bound to item ${map[key]} (one PR binds to one item)`;
  return null;
}

/** When the item's request was filed: the log time of its REQUEST_RECEIVED, or null. */
export function requestedAt(events, item) {
  return events.find((e) => e.event?.type === 'REQUEST_RECEIVED' && e.event.request?.id === item)?.at ?? null;
}
