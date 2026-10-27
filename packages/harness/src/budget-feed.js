// Turns saved usage samples (from @ccp/ledger) into the budget actor's events. Ids come from the
// day and the sample time, so feeding the same samples twice changes nothing.
import { budgetStatus } from '@ccp/ledger';

/** @returns {{id: string, to: 'budget', event: object}[]} events to apply in order */
export function budgetEvents(samples, config = {}) {
  const st = budgetStatus(samples, config);
  if (st.mode === 'unknown') return [];
  const { latest } = st;
  return [
    { id: `day-${st.dayStart}`, to: 'budget', event: { type: 'DAY_STARTED', sevenDay: st.dayStartSevenDay, fiveHour: latest.fiveHour, at: latest.at } },
    { id: `usage-${latest.at}`, to: 'budget', event: { type: 'USAGE_SAMPLED', sevenDay: latest.sevenDay, fiveHour: latest.fiveHour, sevenDayResetsAt: latest.sevenDayResetsAt, at: latest.at, ...(latest.estimated ? { estimated: true } : {}) } }
  ];
}
