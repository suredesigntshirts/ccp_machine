import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  let version = 'unknown';
  try {
    version = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  } catch {}
  const session = process.env.CLAUDE_CODE_SESSION_ID || 'unknown';
  console.log(`harness-probe ${version} loaded from ${root} (session ${session})`);
} catch {}
process.exit(0);
