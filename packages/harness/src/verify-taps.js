// harness verify-taps: every tap in the event log, for a session with platform tools to check. A tap is taken
// only on the card the machine asked for (its message id came with the ack of the card effect), but whether the
// person really tapped that option on that card is a fact only the platform holds. Each line names the card's
// message id (read it with read_messages_by_id), where the tap went and the option it claims. Checked by a
// session other than the one that sent the taps. It reads the log only, and never writes.
import { specs } from './machines.js';

const OPTIONS = specs.decision.context.options;

/** [{id, at, card, to, type, choice, option, by}], in log order: choice as sent, option the card's index for it. */
export const verifyTaps = (store) =>
  store
    .events()
    .filter((e) => e.source?.kind === 'tap')
    .map((e) => {
      const choice = e.event.choice ?? e.event.option ?? null;
      return { id: e.id, at: e.at, card: e.source.ref, to: e.to, type: e.event.type, choice, option: typeof choice === 'number' ? choice : OPTIONS.indexOf(choice), by: `${e.actor?.kind}:${e.actor?.id}` };
    });

/** One line per tap: `<event id> <at> card <message id> <address> <TYPE> option <i> (<choice>) by <actor>`. */
export const verifyTapsText = (rows) => rows.map((r) => `${r.id} ${r.at} card ${r.card} ${r.to} ${r.type} option ${r.option} (${JSON.stringify(r.choice)}) by ${r.by}`).join('\n');
