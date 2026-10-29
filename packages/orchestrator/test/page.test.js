// The page is read from the spec: every state and context field appears on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemLayout, itemSpec } from '../src/item.js';
import { itemPage } from '../src/page.js';
import { itemInspector } from '../src/inspector.js';
import { Host } from '../src/host.js';

test('the page shows every state and every context field', () => {
  const html = itemPage(itemSpec);
  for (const name of Object.keys(itemSpec.states)) assert.ok(html.includes(`id="state-${name}"`), name);
  for (const field of Object.keys(itemSpec.context)) assert.ok(html.includes(`<code>${field}</code>`), field);
});

test('the inspector finds the transition each step of a run took', () => {
  const host = new Host(itemSpec);
  const issue = { url: 'sandbox:issues/1', expect: ['it works'] };
  const inputs = [
    { event: { type: 'xstate.init', input: { issue } }, source: 'person' },
    { run: '0.brief', event: { type: 'xstate.done.actor.brief', output: { builder: 'b.md', verifier: 'v.md' } }, source: 'host' },
    { run: '1.build', event: { type: 'xstate.error.actor.build', error: 'boom' }, source: 'session' }
  ];
  for (const input of inputs) assert.ok(host.accept({ at: '2026-10-29T00:00:00.000Z', ...input }).ok);
  const html = itemInspector(itemSpec, host.journal);
  const { steps } = JSON.parse(html.match(/<script type="application\/json" id="data">(.*?)<\/script>/s)[1]);
  assert.deepEqual(steps.map((s) => [s.what, s.state, s.edge !== null]), [
    ['start', 'briefing', false],
    ['brief done', 'building', true],
    ['build failed', 'replanning', true]
  ]);
  assert.deepEqual(steps[2].changed, ['failure']);
});

test('the layout places only states and transitions the spec has', () => {
  const html = itemInspector(itemSpec, [], itemLayout);
  const { graph } = JSON.parse(html.match(/<script type="application\/json" id="data">(.*?)<\/script>/s)[1]);
  const edges = new Set(graph.edges.map((e) => `${e.from}>${e.to}>${e.when}`));
  for (const name of Object.keys(itemLayout.nodes)) assert.ok(itemSpec.states[name], name);
  for (const key of Object.keys(itemLayout.edges)) assert.ok(edges.has(key), key);
  assert.equal(Object.keys(itemLayout.edges).length, edges.size, 'every transition has a place');
});
