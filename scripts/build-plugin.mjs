// Builds the installable harness plugin into dist/harness/ (and dist/harness-plugin.zip when zip is
// available): the plugin sources plus a copy of @ccp/ledger, which has no dependencies.
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const out = 'dist/harness';
rmSync('dist', { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync('plugins/harness', out, { recursive: true });
cpSync('packages/ledger/src', `${out}/lib/ledger`, { recursive: true });
try {
  execFileSync('zip', ['-qr', '../harness-plugin.zip', '.'], { cwd: out });
  console.log('built dist/harness and dist/harness-plugin.zip');
} catch {
  console.log('built dist/harness (zip not available)');
}
