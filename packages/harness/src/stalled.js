// Stall detection: the orchestrator acts only when woken, so an item whose worker went quiet sits with
// no event. lastMoved finds an item's newest event; stalled lists in-flight items quiet for too long.
const mine = (id, e) => e.to === `item:${id}` || e.to?.startsWith(`item:${id}/`) || (e.event.type === 'REQUEST_RECEIVED' && e.event.request?.id === id);

/** The time of the item's newest event, or null. */
export const lastMoved = (events, id) => events.findLast((e) => mine(id, e))?.at ?? null;

/** Parse "60m", "2h" or "90s" into milliseconds (a bare number is minutes). */
export function parseAfter(text = '60m') {
  const m = String(text).match(/^(\d+(?:\.\d+)?)([smh]?)$/);
  if (!m) throw new Error(`--after takes a time such as 60m or 2h, not "${text}"`);
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, '': 6e4 }[m[2]];
}

/** @returns {{id: string, state: string, lastMoved: string|null, quietMs: number}[]} oldest first */
export function stalled(st, events, { afterMs = 36e5, now = Date.now() } = {}) {
  return st.items
    .filter((i) => !i.done)
    .map((i) => {
      const at = lastMoved(events, i.id);
      return { id: i.id, state: i.state, lastMoved: at, quietMs: at ? now - Date.parse(at) : Infinity };
    })
    .filter((i) => i.quietMs > afterMs)
    .sort((a, b) => b.quietMs - a.quietMs);
}
