// Turns a machine spec (spec/*.machine.json) into an XState machine. The JSON is plain XState config plus
// four small conventions, and this file is the whole interpreter for them:
//
// - Paths. A string like "context.pr.headSha" or "event.output" reads from { context, event };
//   { "value": x } is the literal x. Invoke input and the root output map names to paths.
// - Context ops. Actions are { type: "set", params: { "<context path>": <path or value> } } and
//   { type: "inc", params: "<context path>" }. Nothing else writes context.
// - Guards. meta.guards names lists of conditions that must all hold: a path that must be present,
//   { path, is: literal }, { path, same: otherPath } or { path, below: number }.
// - Needs. A state's meta.needs names the guards that must hold to enter it. Every transition into the
//   state checks them, together with its own guard, against the context as the transition's actions
//   leave it. So no state is ever entered without what it needs, and the JSON says what that is.
import { setup, assign, fromPromise } from 'xstate';

export const get = (root, path) => path.split('.').reduce((v, k) => v?.[k], root);
const resolve = (source, scope) => (typeof source === 'string' ? get(scope, source) : source?.value);
const present = (v) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
const setIn = (obj, [key, ...rest], value) => ({ ...obj, [key]: rest.length ? setIn(obj?.[key] ?? {}, rest, value) : value });
export const mapPaths = (map, scope) => Object.fromEntries(Object.entries(map).map(([k, source]) => [k, resolve(source, scope)]));

const ops = {
  set: (context, event, params) => Object.entries(params).reduce((c, [path, source]) => setIn(c, path.split('.'), resolve(source, { context, event })), context),
  inc: (context, _event, path) => setIn(context, path.split('.'), (get(context, path) ?? 0) + 1)
};
const applyActions = (context, event, actions) => actions.reduce((c, { type, params }) => ops[type](c, event, params), context);

const holds = (condition, scope) => {
  if (typeof condition === 'string') return present(get(scope, condition));
  const value = get(scope, condition.path);
  if ('is' in condition) return value === condition.is;
  if ('same' in condition) return present(value) && value === get(scope, condition.same);
  if ('below' in condition) return value < condition.below;
  throw new Error(`unknown condition ${JSON.stringify(condition)}`);
};

/** The guards (by name) that fail for { context, event }; empty when all hold. */
export const failing = (spec, names, scope) => names.filter((name) => !spec.meta.guards[name].every((c) => holds(c, scope)));

// A transition as XState takes it (a target, an object, or a list of either), as a list of objects.
const asList = (t) => [t].flat().map((x) => (typeof x === 'string' ? { target: x } : x));

// A state with each of its transitions guarded by its own guard and its target's needs. Targets are sibling
// state names (a transition without one stays, and keeps the needs of the state it is in).
const bindState = (spec, siblings, state) => {
  const bind = (t) => {
    const actions = t.actions ?? [];
    const target = t.target ? siblings[t.target] : state;
    if (!target) throw new Error(`no state ${t.target} beside the transition to it`);
    const names = [...(t.guard ? [t.guard] : []), ...(target.meta?.needs ?? [])];
    const guard = names.length && (({ context, event }) => failing(spec, names, { context: applyActions(context, event, actions), event }).length === 0);
    return { ...t, ...(guard ? { guard } : {}) };
  };
  const out = { ...state };
  for (const key of ['on', 'after']) if (state[key]) out[key] = Object.fromEntries(Object.entries(state[key]).map(([ev, t]) => [ev, asList(t).map(bind)]));
  if (state.invoke) {
    const { input = {}, onDone, onError } = state.invoke;
    out.invoke = {
      ...state.invoke,
      input: (scope) => mapPaths(input, scope),
      ...(onDone ? { onDone: asList(onDone).map(bind) } : {}),
      ...(onError ? { onError: asList(onError).map(bind) } : {})
    };
  }
  if (state.states) out.states = Object.fromEntries(Object.entries(state.states).map(([k, s]) => [k, bindState(spec, state.states, s)]));
  return out;
};

/** The XState machine for a spec. Actors never run here: a host reads their start from transition()'s actions. */
export const machineOf = (spec) => {
  const srcs = Object.keys(spec.meta.actors);
  const remote = fromPromise(() => new Promise(() => {}));
  const { output, ...config } = bindState(spec, {}, spec);
  return setup({
    actors: Object.fromEntries(srcs.map((src) => [src, remote])),
    actions: {
      set: assign(({ context, event }, params) => ops.set(context, event, params)),
      inc: assign(({ context, event }, params) => ops.inc(context, event, params))
    },
    delays: spec.meta.delays ?? {}
  }).createMachine({
    ...config,
    context: ({ input }) => ({ ...spec.context, ...input }),
    ...(output ? { output: (scope) => mapPaths(output, scope) } : {})
  });
};
