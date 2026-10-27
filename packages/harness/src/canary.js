// The daily canary: one synthetic tier-0 item a day (bump canary/last.txt, PR, CI, merge) proves the
// whole pipeline still works and times each stage. When it is slow, fails or does not finish, the digest
// leads with it, and the host raises one attention line for the person instead of one per stuck item.
const LIMITS_MS = { triage: 15 * 60e3, build: 30 * 60e3, verify: 30 * 60e3, merge: 15 * 60e3 };
export const CANARY_LATE_MS = 2 * 3600e3;

export const canaryId = (day) => `canary-${day}`;

/** The day's canary request, to send with id req-canary-<day> so it is filed once. */
export function canaryRequest(day) {
  return {
    type: 'REQUEST_RECEIVED',
    request: {
      id: canaryId(day),
      title: `Daily canary ${day}`,
      project: 'canary',
      tier: 0,
      expect: `canary/last.txt reads ${day}, merged through a PR with green CI`
    }
  };
}

const span = (ms) => (ms == null ? '—' : ms < 3600e3 ? `${Math.max(0, Math.round(ms / 60e3))}m` : `${(ms / 3600e3).toFixed(1)}h`);

/**
 * How the day's canary went, from the store's events.
 * @returns {{id: string, status: 'missing'|'running'|'late'|'failed'|'ok', stages: {stage: string, ms: number|null, slow: boolean}[], totalMs: number|null, line: string}}
 */
export function canaryReport(events, day, now = new Date().toISOString()) {
  const id = canaryId(day);
  const mine = events.filter((e) => e.to === `item:${id}` || e.to?.startsWith(`item:${id}/`) || e.event.request?.id === id);
  const at = (pred) => mine.find(pred)?.at ?? null;
  const requested = at((e) => e.event.type === 'REQUEST_RECEIVED');
  if (!requested) return { id, status: 'missing', stages: [], totalMs: null, line: `Canary ${day}: not filed.` };
  const runs = mine.filter((e) => e.event.type === 'RUN_SUCCEEDED');
  const triaged = runs[0]?.at ?? null;
  const built = runs.at(-1) && runs.length > 1 ? runs.at(-1).at : null;
  const checked = at((e) => e.event.type === 'CHECKS_PASSED');
  const merged = at((e) => e.event.type === 'MERGED');
  const failure = mine.find((e) => ['RUN_FAILED', 'CHECKS_FAILED', 'MERGE_FAILED'].includes(e.event.type));
  const ms = (a, b) => (a && b ? Date.parse(b) - Date.parse(a) : null);
  const stages = [
    ['triage', requested, triaged],
    ['build', triaged, built],
    ['verify', built, checked],
    ['merge', checked, merged]
  ].map(([stage, from, to]) => {
    const d = ms(from, to ?? (from ? now : null));
    return { stage, ms: d, done: Boolean(to), slow: d != null && d > LIMITS_MS[stage] };
  });
  const totalMs = ms(requested, merged ?? now);
  const status = merged ? 'ok' : failure ? 'failed' : totalMs > CANARY_LATE_MS ? 'late' : 'running';
  const times = stages.map((s) => `${s.stage} ${span(s.ms)}${s.slow ? ' (slow)' : ''}`).join(', ');
  const stuck = stages.find((s) => !s.done && s.ms != null);
  const line = {
    ok: `Canary ${day} merged in ${span(totalMs)}: ${times}.`,
    running: `Canary ${day} running for ${span(totalMs)}, at ${stuck?.stage}: ${times}.`,
    late: `Canary ${day} has not finished after ${span(totalMs)}; stuck at ${stuck?.stage}. The pipeline needs a look.`,
    failed: `Canary ${day} failed at ${failure?.event.type} (${failure?.at?.slice(11, 16)} UTC): ${times}.`
  }[status];
  return { id, status, stages, totalMs, line };
}
