// harness verify-taps: every tap and every message grant in the event log, for a session with platform tools to check. A tap is taken
// only on the card the machine asked for (its message id came with the ack of the card effect), but whether the
// person really tapped that choice on that card is a fact only the platform holds. Each line names the card's
// message id (read it with read_messages_by_id), where the tap went, the choice it claims and the session that
// relayed it, so the checker can show it is another session. A grant in the person's words names its message id
// instead of a card: the checker reads the message and checks the picks match the words. It reads the log only, and never writes.

/** [{id, at, card, message, to, type, choice, by, relayedBy}], in log order: choice as sent (an audit's option number, a grant's picks). */
export const verifyTaps = (store) =>
  store.events().filter((e) => ['tap', 'message'].includes(e.source?.kind))
    .map((e) => ({ id: e.id, at: e.at, card: e.source.kind === 'tap' ? e.source.ref : null, message: e.source.kind === 'message' ? e.source.ref : null, to: e.to, type: e.event.type, choice: e.event.choice ?? e.event.option ?? e.event.picks ?? null, by: `${e.actor?.kind}:${e.actor?.id}`, relayedBy: e.relayedBy ?? null }));

/** One line per tap or message: `<event id> <at> card|message <message id> <address> <TYPE> choice <choice> by <actor> relayed by <session>`. */
export const verifyTapsText = (rows) => rows.map((r) => `${r.id} ${r.at} ${r.message ? `message ${r.message}` : `card ${r.card}`} ${r.to} ${r.type} choice ${JSON.stringify(r.choice)} by ${r.by} relayed by ${r.relayedBy ?? 'no session'}`).join('\n');
