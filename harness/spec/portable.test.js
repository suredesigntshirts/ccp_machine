// The spec must stay loadable by XState v6 (alpha, installed as `xstate-v6`) so a move to v6 costs
// nothing. v6 builds machines straight from JSON and validates them while it builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v6 from 'xstate-v6';
import { specs } from './implementations.js';

const any = new Proxy({}, { get: () => () => true });

test('every spec machine builds from its JSON in XState v6 and enters its initial state', () => {
  for (const [name, json] of Object.entries(specs)) {
    const machine = v6.machineFromJSON(structuredClone(json), {
      actors: { budget: v6.createMachine({}), workItem: v6.createMachine({}), decision: v6.createMachine({}) },
      guards: any,
      actions: any
    });
    const [snapshot] = v6.initialTransition(machine);
    assert.equal(snapshot.status, 'active', name);
  }
});
