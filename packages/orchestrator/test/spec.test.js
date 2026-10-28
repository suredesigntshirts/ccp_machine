// Static checks on the spec: everything it names exists, and every piece of work has a way to fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemSpec } from '../src/item.js';

const states = Object.entries(itemSpec.states);
const transitions = (s) => [
  ...Object.values(s.on ?? {}),
  ...Object.values(s.after ?? {}),
  ...(s.invoke ? [s.invoke.onDone, s.invoke.onError] : [])
].flatMap((t) => [t ?? []].flat()).map((t) => (typeof t === 'string' ? { target: t } : t));

test('every guard a state needs or a transition takes is defined', () => {
  const used = states.flatMap(([, s]) => [...(s.meta?.needs ?? []), ...transitions(s).map((t) => t.guard).filter(Boolean)]);
  assert.deepEqual(used.filter((g) => !itemSpec.meta.guards[g]), []);
});

test('every target is a state, and every state but the first is a target', () => {
  const targets = new Set(states.flatMap(([, s]) => transitions(s).map((t) => t.target).filter(Boolean)));
  assert.deepEqual([...targets].filter((t) => !itemSpec.states[t]), []);
  assert.deepEqual(states.map(([k]) => k).filter((k) => k !== itemSpec.initial && !targets.has(k)), []);
});

test('every invoked actor has an output schema and an error path', () => {
  for (const [name, s] of states.filter(([, s]) => s.invoke)) {
    assert.ok(itemSpec.meta.actors[s.invoke.src], `${name}: ${s.invoke.src} has an output schema`);
    assert.ok(s.invoke.onError, `${name}: ${s.invoke.src} has onError`);
  }
});

test('every event taken from outside has a schema, and every delay a value', () => {
  assert.deepEqual(states.flatMap(([, s]) => Object.keys(s.on ?? {})).filter((e) => !itemSpec.meta.events[e]), []);
  assert.deepEqual(states.flatMap(([, s]) => Object.keys(s.after ?? {})).filter((d) => !(d in itemSpec.meta.delays)), []);
});

test('context changes only through set and inc', () => {
  const actions = states.flatMap(([, s]) => transitions(s).flatMap((t) => t.actions ?? []));
  assert.deepEqual([...new Set(actions.map((a) => a.type))].sort(), ['inc', 'set']);
});
