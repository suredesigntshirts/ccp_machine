// Usage windows. Claude Code sessions report the person's 5-hour and 7-day usage only in
// `rate_limit_event`s (seen through the claude-code-remote `list_events` tool), as
// rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization 0..1, resetsAt epoch seconds}.
// This file turns any saved JSON that contains them into samples and a budget status.

/** Finds every rate_limit_info object in parsed JSON, with the nearest timestamp seen on the way. */
export function extractSamples(value, at = null, out = []) {
  if (Array.isArray(value)) {
    for (const v of value) extractSamples(v, at, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  const here = value.created_at ?? value.timestamp ?? at;
  const w = value.rate_limit_info?.unifiedWindows ?? value.unifiedWindows;
  if (w?.five_hour || w?.seven_day) {
    out.push({
      at: here,
      fiveHour: w.five_hour?.utilization ?? null,
      fiveHourResetsAt: w.five_hour?.resetsAt ?? null,
      sevenDay: w.seven_day?.utilization ?? null,
      sevenDayResetsAt: w.seven_day?.resetsAt ?? null
    });
    return out;
  }
  for (const v of Object.values(value)) extractSamples(v, here, out);
  return out;
}

/** Parses text that is JSON, JSONL, or tool output with JSON inside, into samples. */
export function samplesFromText(textValue) {
  const out = [];
  const tryParse = (s) => {
    try {
      extractSamples(JSON.parse(s), null, out);
      return true;
    } catch {
      return false;
    }
  };
  if (!tryParse(textValue)) for (const line of textValue.split('\n')) if (line.trim()) tryParse(line);
  return out;
}

/** Sorts and de-duplicates samples by time. */
export function mergeSamples(...lists) {
  const byKey = new Map();
  for (const s of lists.flat()) if (s.at) byKey.set(`${s.at}|${s.sevenDay}|${s.fiveHour}`, s);
  return [...byKey.values()].sort((a, b) => a.at.localeCompare(b.at));
}

export const DEFAULT_BUDGET = { dailyShare: 0.1, softAt: 0.8, fiveHourStopAt: 0.95, utcOffsetMinutes: 0 };

const dayStartOf = (iso, offsetMin) => {
  const local = new Date(Date.parse(iso) + offsetMin * 60_000);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - offsetMin * 60_000).toISOString();
};

/**
 * Budget status for the day of the latest sample, following budget.machine.json in the spec
 * (ccp_machine harness/spec): today's spend is the 7-day utilization gained since the day began,
 * compared with dailyShare; wrap up at softAt of it; pause at all of it or at a nearly full 5-hour window.
 */
export function budgetStatus(samples, config = {}) {
  const c = { ...DEFAULT_BUDGET, ...config };
  samples = liveSamples(samples);
  if (!samples.length) return { mode: 'unknown', reason: 'no usage samples yet', config: c };
  const last = samples.at(-1);
  const dayStart = dayStartOf(last.at, c.utcOffsetMinutes);
  const today = samples.filter((s) => s.at >= dayStart && s.sevenDay != null);
  const before = samples.filter((s) => s.at < dayStart && s.sevenDay != null).at(-1);
  const base = config.dayStartSevenDay ?? before?.sevenDay ?? today[0]?.sevenDay ?? last.sevenDay;
  // A 7-day window that resets mid-day restarts at 0; count what was spent before the reset too.
  let spent = 0;
  let from = base;
  let windowEnd = (before ?? today[0])?.sevenDayResetsAt;
  for (const s of today) {
    if (s.sevenDayResetsAt !== windowEnd) {
      from = 0;
      windowEnd = s.sevenDayResetsAt;
    }
    spent += Math.max(0, s.sevenDay - from);
    from = s.sevenDay;
  }
  const share = spent / c.dailyShare;
  const fiveHourFull = (last.fiveHour ?? 0) >= c.fiveHourStopAt;
  const mode = fiveHourFull || share >= 1 ? 'paused' : share >= c.softAt ? 'wrappingUp' : 'normal';
  return {
    mode,
    reason: fiveHourFull
      ? '5-hour window nearly full'
      : share >= 1
        ? "today's slice is spent"
        : share >= c.softAt
          ? "past the soft limit of today's slice"
          : 'within budget',
    dayStart,
    dayStartSevenDay: base,
    spentToday: Number(spent.toFixed(4)),
    shareOfSlice: Number(share.toFixed(3)),
    latest: last,
    config: c
  };
}

/** Drops each estimate that a real reading newer than its base has superseded. */
export function liveSamples(samples) {
  const newestReal = samples.filter((s) => !s.estimated && s.at).reduce((m, s) => (s.at > m ? s.at : m), '');
  return samples.filter((s) => !s.estimated || s.estimatedFrom >= newestReal);
}

/**
 * A usage sample estimated from the ledger, for when no real reading has arrived (they are rare).
 * From the newest real sample, it adds the cost of the turns that started since, at the utilization
 * per dollar seen between the oldest and newest real samples, window by window. Null when there is
 * no real sample, nothing was spent since, or no rate can be measured (no spend or no rise between
 * readings). Estimates are marked `estimated: true` and never feed the next estimate.
 */
export function estimateSample(samples, ledger, now = new Date().toISOString()) {
  const real = samples.filter((s) => !s.estimated && s.at).sort((a, b) => a.at.localeCompare(b.at));
  const last = real.at(-1);
  if (!last) return null;
  const turns = (ledger?.sessions ?? []).flatMap((s) => s.turns ?? []);
  const spent = (from, to) => turns.filter((t) => t.start > from && t.start <= to).reduce((a, t) => a + (t.all?.cost ?? 0), 0);
  const since = spent(last.at, now);
  if (!(since > 0)) return null;
  const first = real.find((s) => s.at < last.at);
  const between = first ? spent(first.at, last.at) : 0;
  const rate = (k) => (between > 0 && last[k] != null && first[k] != null && last[k] >= first[k] && last.sevenDayResetsAt === first.sevenDayResetsAt ? (last[k] - first[k]) / between : null);
  const r7 = rate('sevenDay');
  if (!r7) return null;
  const r5 = rate('fiveHour') ?? r7;
  const round = (x) => Math.round(x * 1e4) / 1e4;
  return {
    ...last,
    at: now,
    sevenDay: round(Math.min(1, last.sevenDay + since * r7)),
    fiveHour: last.fiveHour == null ? null : round(Math.min(1, last.fiveHour + since * r5)),
    estimated: true,
    estimatedFrom: last.at,
    costSince: round(since)
  };
}
