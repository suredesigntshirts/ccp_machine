// Runs an item: carries out the host's effects and feeds what comes back in as the host's next input.
// Every accepted input is appended to the journal before its effects start, so a crash at any point
// resumes from the journal: the open runs start again and the timers are set for what is left of them.
// Actors are async functions (input, { run, signal }) => { output, source }, source naming who produced the
// output (a session, the host); a thrown error becomes the actor's error event.

export const systemClock = { now: () => new Date().toISOString(), setTimeout, clearTimeout };

export const drive = ({ host, journal, actors, clock = systemClock, log = () => {} }) => {
  const inFlight = new Map(); // run -> AbortController
  const timers = new Map(); // timer id -> clock handle
  let settle;
  const settled = new Promise((resolve, reject) => (settle = { resolve, reject }));

  const send = (input) => {
    try {
      const result = host.accept({ at: clock.now(), ...input });
      if (!result.ok) return log({ refused: result.reason, ...input }), result;
      journal.append(result.entry);
      log({ entry: result.entry });
      result.effects.forEach(carryOut);
      if (host.done) finish();
      return result;
    } catch (err) {
      settle.reject(err);
      return { ok: false, reason: String(err) };
    }
  };

  const carryOut = (effect) => {
    if (effect.type === 'run') {
      const controller = new AbortController();
      inFlight.set(effect.run, controller);
      Promise.resolve()
        .then(() => actors[effect.actor](effect.input, { run: effect.run, signal: controller.signal }))
        .then(
          ({ output, source }) => ({ source, event: { type: `xstate.done.actor.${effect.id}`, output } }),
          (err) => ({ source: effect.actor, event: { type: `xstate.error.actor.${effect.id}`, error: String(err?.message ?? err) } })
        )
        .then((input) => inFlight.delete(effect.run) && send({ ...input, run: effect.run }));
    } else if (effect.type === 'stop') {
      inFlight.get(effect.run)?.abort();
      inFlight.delete(effect.run);
    } else if (effect.type === 'timer') {
      const fire = () => timers.delete(effect.id) && send({ event: effect.event, source: 'timer' });
      timers.set(effect.id, clock.setTimeout(fire, Math.max(0, Date.parse(effect.due) - Date.parse(clock.now()))));
    } else if (effect.type === 'cancel') {
      clock.clearTimeout(timers.get(effect.id));
      timers.delete(effect.id);
    }
  };

  const finish = () => {
    inFlight.forEach((c) => c.abort());
    timers.forEach((t) => clock.clearTimeout(t));
    settle.resolve(host.snapshot);
  };

  host.pending.forEach(carryOut);
  if (host.done) finish();
  return { send, settled };
};
