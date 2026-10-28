// One item's host, as a pure value. The journal of inputs from outside is the truth: replaying it rebuilds
// the snapshot, the runs in flight and the timers set. accept() takes one input, refuses what the machine
// would not take, and returns the journal entry to append and the effects to carry out. The host reads no
// clock and does no I/O; the driver does both.
//
// Effects are XState's own actions, renamed for the outside world:
//   xstate.spawnChild -> { type: 'run', run, actor, input }   start an invoked actor's work
//   xstate.stopChild  -> { type: 'stop', run }                its state was left; drop its result
//   delayed raise     -> { type: 'timer', id, event, due }    send event at due
//   xstate.cancel     -> { type: 'cancel', id }
import { createHash } from 'node:crypto';
import { initialTransition, transition } from 'xstate';
import { machineOf, failing } from './spec.js';
import { check } from './schema.js';

const DONE = 'xstate.done.actor.';
const ERROR = 'xstate.error.actor.';
const INIT = 'xstate.init';
const AFTER = 'xstate.after.';

/** A short hash of what the item is: its state and context. Each entry records the one it led to. */
export const hashOf = (snapshot) => createHash('sha256').update(JSON.stringify([snapshot.value, snapshot.context])).digest('hex').slice(0, 12);

export class Host {
  #spec;
  #machine;
  #runs = new Map(); // run id -> { run, id, actor, input }
  #timers = new Map(); // timer id -> { id, event, due }
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
      const { entry: again } = host.#apply(entry);
      if (again.hash !== entry.hash) throw new Error(`journal entry ${entry.seq} replays to ${again.hash}, not ${entry.hash}: the spec changed`);
    }
    return host;
  }

  get done() {
    return this.snapshot?.status === 'done';
  }

  /** What is still open: the runs in flight and the timers set, as the effects that started them. */
  get pending() {
    return [...[...this.#runs.values()].map((r) => ({ type: 'run', ...r })), ...[...this.#timers.values()].map((t) => ({ type: 'timer', ...t }))];
  }

  /** Take one input from outside: { event, at, source, run? }. The first is { type: 'xstate.init', input }. Returns { ok, entry, effects } or { ok: false, reason }. */
  accept(input) {
    const reason = this.#refusal(input);
    return reason ? { ok: false, reason } : { ok: true, ...this.#apply({ seq: this.journal.length, ...input }) };
  }

  // Why an input cannot be taken, or null. An input is the start, a run's completion or error (only from a
  // run in flight, and a completion only with output its actor's schema allows), a timer that is set, or an
  // event the spec takes from outside (with a payload its schema allows); and the machine must take it now.
  #refusal({ event, run }) {
    const { meta } = this.#spec;
    const { type, ...payload } = event ?? {};
    const problems = (schema, value) => check(schema, value, meta.schemas).join('; ');
    if (!this.snapshot) return type === INIT ? problems(meta.input, event.input) || this.#unmet(initialTransition(this.#machine, event.input)[0]) : 'the item has not started';
    if (type === INIT) return 'the item has started';
    if (this.done) return 'the item is done';
    if (type.startsWith(DONE) || type.startsWith(ERROR)) {
      const open = this.#runs.get(run);
      if (!open || ![DONE + open.id, ERROR + open.id].includes(type)) return `run ${run} is not in flight for ${type}`;
      const bad = type.startsWith(DONE) && problems(meta.actors[open.actor], event.output);
      if (bad) return `${open.actor} output: ${bad}`;
    } else if (type.startsWith(AFTER)) {
      if (!this.#timers.has(type)) return `no timer ${type} is set`;
    } else {
      if (!meta.events[type]) return `${type} is not an event this machine takes from outside`;
      const bad = problems(meta.events[type], payload);
      if (bad) return `${type}: ${bad}`;
    }
    return this.snapshot.can(event) ? null : `${type} is not taken in ${JSON.stringify(this.snapshot.value)}`;
  }

  // The initial state's needs, which no transition guards.
  #unmet(snapshot) {
    const names = Object.values(snapshot.getMeta()).flatMap((m) => m.needs ?? []);
    const unmet = failing(this.#spec, names, { context: snapshot.context });
    return unmet.length ? `the initial state needs ${unmet.join(', ')}` : null;
  }

  #apply(entry) {
    const { seq, event, run } = entry;
    if (run) this.#runs.delete(run); // it finished; its stopChild is no effect
    if (event.type.startsWith(AFTER)) this.#timers.delete(event.type);
    const [snapshot, actions] = event.type === INIT ? initialTransition(this.#machine, event.input) : transition(this.#machine, this.snapshot, event);
    this.snapshot = snapshot;
    const recorded = { ...entry, hash: hashOf(snapshot) };
    this.journal.push(recorded);
    return { entry: recorded, effects: actions.flatMap((a) => this.#effect(a, seq, entry.at)) };
  }

  #effect({ type, params }, seq, at) {
    if (type === 'xstate.spawnChild') {
      const r = { run: `${seq}.${params.id}`, id: params.id, actor: params.src, input: params.input };
      this.#runs.set(r.run, r);
      return [{ type: 'run', ...r }];
    }
    if (type === 'xstate.stopChild') {
      const r = [...this.#runs.values()].find((x) => x.id === params.id);
      return r && this.#runs.delete(r.run) ? [{ type: 'stop', run: r.run }] : [];
    }
    if (type === 'xstate.raise' && params.delay != null) {
      const t = { id: params.id, event: params.event, due: new Date(Date.parse(at) + params.delay).toISOString() };
      this.#timers.set(t.id, t);
      return [{ type: 'timer', ...t }];
    }
    if (type === 'xstate.cancel') {
      return this.#timers.delete(params.sendId) ? [{ type: 'cancel', id: params.sendId }] : [];
    }
    throw new Error(`no effect for action ${type}`);
  }
}
