// Stand-in calibration: can the person trust the stand-in in a decision class? Built from the decision
// log. Only the person's decisions test the stand-in (its own decisions agree with themselves), so every
// number here comes from rows the person decided where the stand-in had leaned.
import { ladder, RUNGS } from './decision-log.js';

export const MIN_TESTED = 10;
const BINS = [0, 0.6, 0.7, 0.8, 0.9, 1.01];
const binLabel = (i) => (i === 0 ? '< 0.6' : i === BINS.length - 2 ? '≥ 0.9' : `${BINS[i]}–${BINS[i + 1]}`);

/** One class's calibration. `now` closes the time on the current rung. */
export function calibrateClass(rows, decisionClass, now = new Date().toISOString()) {
  const mine = rows.filter((r) => r.decisionClass === decisionClass);
  const tested = mine.filter((r) => r.decidedBy === 'person' && r.standIn?.choice && r.choice);
  const agreed = tested.filter((r) => r.standIn.choice === r.choice).length;
  const scored = tested.filter((r) => typeof r.standIn.confidence === 'number');
  const hit = (r) => (r.standIn.choice === r.choice ? 1 : 0);
  const brier = scored.length ? scored.reduce((n, r) => n + (r.standIn.confidence - hit(r)) ** 2, 0) / scored.length : null;
  const meanConfidence = scored.length ? scored.reduce((n, r) => n + r.standIn.confidence, 0) / scored.length : null;
  const agreement = tested.length ? agreed / tested.length : null;
  const bins = BINS.slice(0, -1).map((lo, i) => {
    const inBin = scored.filter((r) => r.standIn.confidence >= lo && r.standIn.confidence < BINS[i + 1]);
    return { bin: binLabel(i), n: inBin.length, agreement: inBin.length ? inBin.filter(hit).length / inBin.length : null };
  });
  // Time on each rung: the ladder after each prefix of the log holds until the next decision.
  const onRung = Object.fromEntries(RUNGS.map((r) => [r, 0]));
  mine.forEach((r, i) => {
    const until = mine[i + 1]?.at ?? now;
    if (r.at && until) onRung[ladder(mine.slice(0, i + 1), decisionClass).autonomy] += Math.max(0, Date.parse(until) - Date.parse(r.at));
  });
  return {
    decisionClass,
    autonomy: ladder(mine, decisionClass).autonomy,
    decisions: mine.length,
    tested: tested.length,
    agreement,
    reversals: tested.length - agreed,
    meanConfidence,
    brier,
    bins,
    msOnRung: onRung,
    ...verdict({ tested: tested.length, agreement, meanConfidence, brier })
  };
}

function verdict({ tested, agreement, meanConfidence, brier }) {
  if (tested < MIN_TESTED) return { trust: 'unknown', advice: `Not enough evidence: ${tested} of ${MIN_TESTED} decisions by the person against a stand-in lean.` };
  if (meanConfidence - agreement > 0.1)
    return { trust: 'no', advice: `Overconfident: it is ${Math.round(meanConfidence * 100)}% sure on average but agrees ${Math.round(agreement * 100)}% of the time. Keep the class at recommend.` };
  if (brier <= 0.1 && agreement >= 0.9) return { trust: 'yes', advice: 'Well calibrated and usually right: the confidence threshold could drop.' };
  return { trust: 'partly', advice: 'Calibrated but not right often enough to act alone yet. Keep watching.' };
}

/** Every class in the log, or just the one named. */
export function calibration(rows, { decisionClass, now } = {}) {
  const classes = decisionClass ? [decisionClass] : [...new Set(rows.map((r) => r.decisionClass).filter(Boolean))];
  return classes.map((c) => calibrateClass(rows, c, now));
}
