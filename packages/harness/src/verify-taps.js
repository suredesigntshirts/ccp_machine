// harness verify-taps: every tap in the event log, for a session with platform tools to check. A tap is taken
// only on the card the machine asked for (its message id came with the ack of the card effect), but whether the
// person really tapped that choice on that card is a fact only the platform holds. Each line names the card's
// message id (read it with read_messages_by_id), where the tap went, the choice it claims and the session that
// relayed it, so the checker can show it is another session. It reads the log only, and never writes.

/** [{id, at, card, to, type, choice, by, relayedBy}], in log order: choice as sent (an audit's option number). */
export const verifyTaps = (store) =>
  store.events().filter((e) => e.source?.kind === 'tap')
    .map((e) => ({ id: e.id, at: e.at, card: e.source.ref, to: e.to, type: e.event.type, choice: e.event.choice ?? e.event.option ?? null, by: `${e.actor?.kind}:${e.actor?.id}`, relayedBy: e.relayedBy ?? null }));

/** One line per tap: `<event id> <at> card <message id> <address> <TYPE> choice <choice> by <actor> relayed by <session>`. */
export const verifyTapsText = (rows) => rows.map((r) => `${r.id} ${r.at} card ${r.card} ${r.to} ${r.type} choice ${JSON.stringify(r.choice)} by ${r.by} relayed by ${r.relayedBy ?? 'no session'}`).join('\n');
