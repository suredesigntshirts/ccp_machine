// Builds the harness plugin in place: plugins/harness is the installable plugin, and this copies
// @ccp/ledger's sources (no dependencies) into plugins/harness/lib/ledger, which is committed so the
// folder is self-contained for a marketplace or the setup script. With --check it writes nothing and
// exits 1 when the committed copy differs from a fresh build (CI runs it). With --zip it also writes
// dist/harness-plugin.zip when zip is available.
import { cpSync, rmSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'packages/ledger/src');
const out = join(root, 'plugins/harness/lib/ledger');
const args = process.argv.slice(2);

const files = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : []);

if (args.includes('--check')) {
  const want = files(src);
  const have = files(out);
  const stale = [...new Set([...want, ...have])].filter((f) => {
    const a = join(src, f), b = join(out, f);
    if (!existsSync(a) || !existsSync(b)) return true;
    try { return !readFileSync(a).equals(readFileSync(b)); } catch { return false; } // directories
  });
  if (stale.length) {
    console.error(`plugins/harness/lib/ledger differs from packages/ledger/src (${stale.join(', ')}); run npm run build:plugin and commit`);
    process.exit(1);
  }
  console.log('plugins/harness/lib/ledger matches packages/ledger/src');
} else {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(src, out, { recursive: true });
  console.log('built plugins/harness/lib/ledger');
  if (args.includes('--zip')) {
    mkdirSync(join(root, 'dist'), { recursive: true });
    const zip = join(root, 'dist/harness-plugin.zip');
    rmSync(zip, { force: true });
    try {
      execFileSync('zip', ['-qr', zip, '.'], { cwd: join(root, 'plugins/harness') });
      console.log('built dist/harness-plugin.zip');
    } catch {
      console.log('zip not available; no archive');
    }
  }
}
