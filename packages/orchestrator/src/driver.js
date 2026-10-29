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
  const inFlight = new Map(); // run -> AbortController, for each actor started
  const inSession = new Set(); // runs whose actor is waiting on a session
  const timers = new Map(); // timer id -> clock handle
  const whenIdle = []; // resolvers waiting for the item to go idle
  let settle;
  const settled = new Promise((resolve, reject) => (settle = { resolve, reject }));

  // Idle: nothing left for this process to do but wait on sessions, timers or events from outside. Checked
  // once pending callbacks have run, so a session that has already answered is not taken for one waited on.
  const checkIdle = () =>
    setImmediate(() => {
      const onlySessionsLeft = [...inFlight.keys()].every((run) => inSession.has(run));
      if (onlySessionsLeft) whenIdle.splice(0).forEach((resolve) => resolve(host.snapshot));
    });

  // One input in: journal it if the host takes it, then carry out its effects.
  const send = (input) => {
    try {
      const result = host.accept({ at: clock.now(), ...input });
      if (result.ok) {
        journal.append(result.entry);
        log({ entry: result.entry });
        result.effects.forEach(carryOut);
        if (host.done) close();
      } else {
        log({ refused: result.reason, ...input });
      }
      checkIdle();
      return result;
    } catch (err) {
      settle.reject(err);
      return { ok: false, reason: String(err) };
    }
  };

  // Do an actor's work: { output, source }, or a thrown error.
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

  // Start a run; when its work ends, send its completion or error back in under its run id.
  const startRun = ({ run, id, actor, input }) => {
    const controller = new AbortController();
    inFlight.set(run, controller);
    perform({ actor, input, run }, { run, signal: controller.signal })
      .then(
        ({ output, source }) => ({ source, event: { type: `xstate.done.actor.${id}`, output } }),
        (err) => ({ source: err?.source ?? actor, event: { type: `xstate.error.actor.${id}`, error: String(err?.message ?? err) } })
      )
      .then((finished) => inFlight.delete(run) && send({ ...finished, run })); // a stopped run's result is dropped
  };

  const stopRun = ({ run }) => {
    inFlight.get(run)?.abort();
    inFlight.delete(run);
  };

  const setTimer = ({ id, event, due }) => {
    const fire = () => timers.delete(id) && send({ event, source: 'timer' });
    const wait = Math.max(0, Date.parse(due) - Date.parse(clock.now()));
    timers.set(id, clock.setTimeout(fire, wait));
  };

  const cancelTimer = ({ id }) => {
    clock.clearTimeout(timers.get(id));
    timers.delete(id);
  };

  const carryOut = (effect) => ({ run: startRun, stop: stopRun, timer: setTimer, cancel: cancelTimer })[effect.type](effect);

  // The item is done: drop whatever is still open.
  const close = () => {
    inFlight.forEach((controller) => controller.abort());
    timers.forEach((handle) => clock.clearTimeout(handle));
    settle.resolve(host.snapshot);
  };

  // Resume: start again what the journal left open.
  host.pending.forEach(carryOut);
  if (host.done) close();

  return {
    send,
    settled,
    /** Resolves with the snapshot once this process has nothing left to do but wait. */
    idle: () =>
      new Promise((resolve) => {
        whenIdle.push(resolve);
        checkIdle();
      })
  };
};
