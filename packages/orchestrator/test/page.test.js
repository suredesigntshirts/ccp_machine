// The page is read from the spec: every state and context field appears on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemSpec } from '../src/item.js';
import { itemPage } from '../src/page.js';

test('the page shows every state and every context field', () => {
  const html = itemPage(itemSpec);
  for (const name of Object.keys(itemSpec.states)) assert.ok(html.includes(`id="state-${name}"`), name);
  for (const field of Object.keys(itemSpec.context)) assert.ok(html.includes(`<code>${field}</code>`), field);
});
