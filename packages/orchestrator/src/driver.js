// Runs an item: carries out the host's effects and feeds what comes back in as the host's next input.
// Every accepted input is appended to the journal before its effects start, so a crash at any point
// resumes from the journal: the open runs start again and the timers are set for what is left of them.
//
// An actor is one of two kinds:
// - local: an async function (input, { run, signal }) => { output, source }, done by the host itself;
// - agent: { claim, tools, prepare, finish }, done by a Claude session. prepare(input, ctx) gives the
//   session's job ({ prompt, cwd }); the session (the sessions port) returns a claim matching the claim
//   schema; finish(claim, input, job, ctx) turns it into the actor's output, reading facts for itself.
// Either kind's thrown error becomes the actor's error event.
import { check } from './schema.js';

export const systemClock = { now: () => new Date().toISOString(), setTimeout, clearTimeout };

export const drive = ({ host, journal, actors, sessions, clock = systemClock, log = () => {} }) => {
  const inFlight = new Map(); // run -> AbortController
  const inSession = new Set(); // runs waiting on a session
  const timers = new Map(); // timer id -> clock handle
  const whenIdle = [];
  let settle;
  const settled = new Promise((resolve, reject) => (settle = { resolve, reject }));

  // Idle: nothing left for this process to do but wait on sessions, timers or events from outside. Checked
  // once pending callbacks have run, so a session that has already answered is not taken for one waited on.
  const checkIdle = () =>
    setImmediate(() => {
      if ([...inFlight.keys()].every((run) => inSession.has(run))) whenIdle.splice(0).forEach((resolve) => resolve(host.snapshot));
    });

  const send = (input) => {
    try {
      const result = host.accept({ at: clock.now(), ...input });
      if (!result.ok) log({ refused: result.reason, ...input });
      else {
        journal.append(result.entry);
        log({ entry: result.entry });
        result.effects.forEach(carryOut);
        if (host.done) finish();
      }
      checkIdle();
      return result;
    } catch (err) {
      settle.reject(err);
      return { ok: false, reason: String(err) };
    }
  };

  const perform = async ({ actor: name, input, run }, ctx) => {
    const actor = actors[name];
    if (typeof actor === 'function') return actor(input, ctx);
    const job = { ...(await actor.prepare(input, ctx)), tools: actor.tools, schema: actor.claim };
    inSession.add(run);
    checkIdle();
    const { claim, source } = await sessions(job, ctx).finally(() => inSession.delete(run));
    try {
      const problems = check(actor.claim, claim);
      if (problems.length) throw new Error(`the session's claim: ${problems.join('; ')}`);
      return { output: await actor.finish(claim, input, job, ctx), source };
    } catch (err) {
      throw Object.assign(err, { source }); // the session's doing, or what the host found in it
    }
  };

  const carryOut = (effect) => {
    if (effect.type === 'run') {
      const controller = new AbortController();
      inFlight.set(effect.run, controller);
      perform(effect, { run: effect.run, signal: controller.signal })
        .then(
          ({ output, source }) => ({ source, event: { type: `xstate.done.actor.${effect.id}`, output } }),
          (err) => ({ source: err?.source ?? effect.actor, event: { type: `xstate.error.actor.${effect.id}`, error: String(err?.message ?? err) } })
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
  return {
    send,
    settled,
    /** Resolves with the snapshot once this process has nothing left to do but wait. */
    idle: () => new Promise((resolve) => (whenIdle.push(resolve), checkIdle()))
  };
};
