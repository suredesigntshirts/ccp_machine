// Temp folders for tests: each is made under the OS temp folder and removed when the test file's process
// exits, pass or fail, so a test run leaves nothing behind.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = [];
process.on('exit', () => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A new empty folder named prefix + random, removed when this process exits. */
export function tempDir(prefix = 'harness-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
