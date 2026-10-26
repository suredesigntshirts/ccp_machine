import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchCandidates } from '../lib/browser.mjs';

const labels = (c) => c.map(x => x.label);

test('launchCandidates: cloud without system Chrome pins TLS 1.2 on installed full Chromium builds; the headless shell is last, via Node', () => {
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const c = launchCandidates({ CLAUDE_CODE_REMOTE: 'true' }, [exe], false);
  assert.deepEqual(labels(c), [`installed Chromium + TLS 1.2 pin (${exe})`, 'Playwright managed Chromium (headless shell; Node networking)']);
  assert.ok(c.every(x => x.args.includes('--no-sandbox')));
  assert.ok(c[0].args.includes('--ssl-version-max=tls1.2'));
  assert.equal(c[0].network, 'browser');
  assert.equal(c[1].network, 'node');
});

test('launchCandidates: cloud with system Chrome tries the TLS 1.2 configuration first', () => {
  const c = launchCandidates({ CLAUDE_CODE_REMOTE: 'true' }, [], true);
  assert.equal(c[0].channel, 'chrome');
  assert.ok(c[0].args.includes('--ssl-version-max=tls1.2'));
  assert.equal(c[0].network, 'browser');
});

test('defaultNetwork: follows the launched candidate in the cloud; env override wins', async () => {
  const { defaultNetwork } = await import('../lib/fetch/render.mjs');
  const { IS_CLOUD } = await import('../lib/browser.mjs');
  assert.equal(defaultNetwork({ DD_RENDER_NETWORK: 'node' }, 'browser'), 'node');
  if (IS_CLOUD) {
    assert.equal(defaultNetwork({}, 'browser'), 'browser');
    assert.equal(defaultNetwork({}, null), 'node');
  } else assert.equal(defaultNetwork({}, null), 'browser');
});

test('launchCandidates: DD_BROWSER_PATH always wins, and local runs never get --no-sandbox', () => {
  const c = launchCandidates({ DD_BROWSER_PATH: '/x/chrome' }, [], true);
  assert.equal(c[0].executablePath, '/x/chrome');
  assert.ok(c.every(x => !x.args.includes('--no-sandbox')));
  assert.equal(c.at(-1).channel, 'chrome');
});
