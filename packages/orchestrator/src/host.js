// One item's host, as a pure value. The journal of inputs from outside is the truth: replaying it rebuilds
// the snapshot, the runs in flight and the timers set. accept() takes one input, refuses what the machine
// would not take, and returns the journal entry to append and the effects to carry out. The host reads no
// clock and does no I/O; the driver does both.
//
// XState's pure transition() does not run anything: it returns the actions a step would run. The host turns
// four of them into effects for the outside world:
//   xstate.spawnChild -> { type: 'run', run, actor, input }   start an invoked actor's work
//   xstate.stopChild  -> { type: 'stop', run }                its state was left; drop its result
//   delayed raise     -> { type: 'timer', id, event, due }    send event at due (an `after` transition)
//   xstate.cancel     -> { type: 'cancel', id }               the timer's state was left
import { createHash } from 'node:crypto';
import { initialTransition, transition } from 'xstate';
import { machineOf, failing } from './spec.js';
import { check } from './schema.js';

const START = 'xstate.init';
const DONE = 'xstate.done.actor.'; // + the invoke's id: the actor finished, with event.output
const ERROR = 'xstate.error.actor.'; // + the invoke's id: the actor failed, with event.error
const TIMER = 'xstate.after.'; // the event a delayed transition's timer sends

/** A short hash of what the item is: its state and context. Each entry records the one it led to. */
export const hashOf = (snapshot) => {
  const json = JSON.stringify([snapshot.value, snapshot.context]);
  return createHash('sha256').update(json).digest('hex').slice(0, 12);
};

export class Host {
  #spec;
  #machine;
  #runs = new Map(); // run id -> { run, id, actor, input }: actors started and not yet finished
  #timers = new Map(); // timer id -> { id, event, due }: timers set and not yet fired or cancelled
  journal = [];
  snapshot = null;

  constructor(spec) {
    this.#spec = spec;
    this.#machine = machineOf(spec);
  }

  /** The host as the journal leaves it. Throws when a step replays to another state than it recorded (the spec changed under it). */
  static replay(spec, entries) {
    const host = new Host(spec);
    for (const entry of entries) {
      const { entry: replayed } = host.#apply(entry);
      if (replayed.hash !== entry.hash) {
        throw new Error(`journal entry ${entry.seq} replays to ${replayed.hash}, not ${entry.hash}: the spec changed`);
      }
    }
    return host;
  }

  get done() {
    return this.snapshot?.status === 'done';
  }

  /** What is still open: the runs in flight and the timers set, as the effects that started them. */
  get pending() {
    const runs = [...this.#runs.values()].map((run) => ({ type: 'run', ...run }));
    const timers = [...this.#timers.values()].map((timer) => ({ type: 'timer', ...timer }));
    return [...runs, ...timers];
  }

  /** Take one input from outside: { event, at, source, run? }. The first is { type: 'xstate.init', input }. Returns { ok, entry, effects } or { ok: false, reason }. */
  accept(input) {
    const reason = this.#refusal(input);
    if (reason) return { ok: false, reason };
    return { ok: true, ...this.#apply({ seq: this.journal.length, ...input }) };
  }

  // Why an input cannot be taken, or null. Each kind of input has its own check, and then the machine must
  // take the event in the state it is in.
  #refusal({ event, run }) {
    const type = event?.type;
    if (!this.snapshot) return type === START ? this.#refuseStart(event.input) : 'the item has not started';
    if (type === START) return 'the item has started';
    if (this.done) return 'the item is done';

    const reason =
      type.startsWith(DONE) || type.startsWith(ERROR) ? this.#refuseCompletion(event, run)
      : type.startsWith(TIMER) ? this.#refuseTimer(type)
      : this.#refuseOutsideEvent(event);
    if (reason) return reason;
    return this.snapshot.can(event) ? null : `${type} is not taken in ${JSON.stringify(this.snapshot.value)}`;
  }

  // The start: its input must match the spec's input schema, and the first state's needs must hold.
  #refuseStart(input) {
    const problems = this.#problems(this.#spec.meta.input, input);
    if (problems) return problems;
    const [first] = initialTransition(this.#machine, input);
    const needs = Object.values(first.getMeta()).flatMap((meta) => meta.needs ?? []);
    const unmet = failing(this.#spec, needs, { context: first.context });
    return unmet.length ? `the initial state needs ${unmet.join(', ')}` : null;
  }

  // A completion or error only from the run in flight for that invoke, and output its actor's schema allows.
  #refuseCompletion(event, run) {
    const open = this.#runs.get(run);
    if (!open || (event.type !== DONE + open.id && event.type !== ERROR + open.id)) {
      return `run ${run} is not in flight for ${event.type}`;
    }
    if (event.type.startsWith(ERROR)) return null;
    const problems = this.#problems(this.#spec.meta.actors[open.actor], event.output);
    return problems && `${open.actor} output: ${problems}`;
  }

  // A timer only while it is set.
  #refuseTimer(type) {
    return this.#timers.has(type) ? null : `no timer ${type} is set`;
  }

  // Any other event only if the spec takes it from outside, with a payload its schema allows.
  #refuseOutsideEvent({ type, ...payload }) {
    const schema = this.#spec.meta.events[type];
    if (!schema) return `${type} is not an event this machine takes from outside`;
    const problems = this.#problems(schema, payload);
    return problems && `${type}: ${problems}`;
  }

  #problems(schema, value) {
    return check(schema, value, this.#spec.meta.schemas).join('; ');
  }

  // Step the machine with an accepted input and record it. A finished run and a fired timer are closed first,
  // so leaving their state does not emit a stop or cancel for them.
  #apply(entry) {
    const { seq, event, run, at } = entry;
    if (run) this.#runs.delete(run);
    if (event.type.startsWith(TIMER)) this.#timers.delete(event.type);

    const [snapshot, actions] =
      event.type === START ? initialTransition(this.#machine, event.input) : transition(this.#machine, this.snapshot, event);
    this.snapshot = snapshot;

    const recorded = { ...entry, hash: hashOf(snapshot) };
    this.journal.push(recorded);
    const effects = actions.flatMap((action) => this.#effectOf(action, seq, at));
    return { entry: recorded, effects };
  }

  // The effect an action asks of the outside world, and the host's own record of what is open.
  #effectOf({ type, params }, seq, at) {
    switch (type) {
      case 'xstate.spawnChild': {
        const run = { run: `${seq}.${params.id}`, id: params.id, actor: params.src, input: params.input };
        this.#runs.set(run.run, run);
        return [{ type: 'run', ...run }];
      }
      case 'xstate.stopChild': {
        const open = [...this.#runs.values()].find((run) => run.id === params.id);
        if (!open) return [];
        this.#runs.delete(open.run);
        return [{ type: 'stop', run: open.run }];
      }
      case 'xstate.raise': {
        if (params.delay == null) break;
        const due = new Date(Date.parse(at) + params.delay).toISOString();
        const timer = { id: params.id, event: params.event, due };
        this.#timers.set(timer.id, timer);
        return [{ type: 'timer', ...timer }];
      }
      case 'xstate.cancel': {
        if (!this.#timers.delete(params.sendId)) return [];
        return [{ type: 'cancel', id: params.sendId }];
      }
    }
    throw new Error(`no effect for action ${type}`);
  }
}
