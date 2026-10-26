/** Tracker blocking (lib/fetch/blocklist.mjs): cached engine, the off switch. No network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FiltersEngine } from '@ghostery/adblocker';
import { loadBlocker, resetBlocker } from '../lib/fetch/blocklist.mjs';

test('blocklist: a cached engine is used; first-party page resources are never blocked by it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-block-'));
  try {
    writeFileSync(join(dir, 'adblock-engine.bin'), Buffer.from(FiltersEngine.parse('||tracker.example^').serialize()));
    resetBlocker();
    const blocked = await loadBlocker({ dir, env: {} });
    assert.equal(typeof blocked, 'function');
    assert.equal(blocked('https://tracker.example/collect.js', 'https://docs.example/page', 'script'), true);
    assert.equal(blocked('https://docs.example/static/app.js', 'https://docs.example/page', 'script'), false);
    assert.equal(blocked('https://cdn.example/lib.js', 'https://docs.example/page', 'script'), false);
  } finally { resetBlocker(); rmSync(dir, { recursive: true, force: true }); }
});

test('blocklist: DD_BLOCK_TRACKERS=0 turns it off', async () => {
  resetBlocker();
  assert.equal(await loadBlocker({ env: { DD_BLOCK_TRACKERS: '0' } }), null);
  resetBlocker();
});
