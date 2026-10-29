#!/usr/bin/env node
// SessionStart hook: prints one line, which lands in the session's transcript, naming the harness code
// this session runs and whether it is behind origin/main. In a project that has not installed the
// harness it prints only that the harness is available; with HARNESS_DISABLED=1 it prints nothing.
// In a project that has, it first warms the Library mount, which is slow when cold: it launches this script
// again as `session-start.js warm <folder>...`, a detached child (its own process group, stdio ignored, unref'd)
// that reads every file under this session's ledger folder and the store in parallel, and does not wait for it.
// It must never get in the session's way: it swallows every failure, always exits 0, and a watchdog
// ends it within about 4 s, printing the line with "behind: unknown" if the remote check is still out.
import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gate, version, behind, markerPath, libraryDir, safeId, storeDir } from './host.js';

/** Reads at once in the warm, and the most it may run. */
const WARM_WIDTH = 16;
const WARM_MS = 10 * 60 * 1000;

if (process.argv[2] === 'warm') {
  setTimeout(() => process.exit(0), WARM_MS).unref();
  await warm(process.argv.slice(3));
  process.exit(0);
}

let pending = null; // the line to print if the watchdog fires first
const done = (text) => {
  if (text) process.stdout.write(`${text}\n`);
  process.exit(0);
};
setTimeout(() => done(pending), 3800).unref();

try {
  const state = await gate(1000);
  if (state === 'disabled') done(null);
  if (state === 'installed') {
    try {
      const input = JSON.parse((await stdin(500)) || '{}');
      const session = safeId(input.session_id);
      const folders = [...(session ? [join(libraryDir(), 'ledger', 'sessions', session)] : []), storeDir(input.cwd)];
      spawn(process.execPath, [fileURLToPath(import.meta.url), 'warm', ...folders], { detached: true, stdio: 'ignore', env: { ...process.env, UV_THREADPOOL_SIZE: String(WARM_WIDTH) } }).unref();
    } catch {}
  }
  const v = version();
  const id = `${v.name} ${v.version}`;
  if (state !== 'installed') done(`${id}: available but not installed in this project (no ${markerPath()})`);
  const head = `${id} commit ${v.commit ?? 'unknown (no git)'} from ${v.root}, behind:`;
  pending = `${head} unknown`;
  done(`${head} ${await behind(v, 2500)}`);
} catch {
  done(pending); // swallowed on purpose; see above
}

// The hook's input, or '' when it is not all there within `ms` (a hook must not wait on its stdin).
function stdin(ms) {
  return new Promise((ok) => {
    let text = '';
    setTimeout(() => ok(''), ms).unref();
    process.stdin.setEncoding('utf8').on('data', (d) => (text += d)).on('end', () => ok(text)).on('error', () => ok(''));
  });
}

// Reads every file under `folders`, WARM_WIDTH reads or listings at a time, ignoring every failure.
function warm(folders) {
  const queue = folders.map((path) => ({ path, folder: true }));
  let active = 0;
  return new Promise((finished) => {
    const next = () => {
      while (active < WARM_WIDTH && queue.length) {
        const { path, folder } = queue.shift();
        active++;
        const read = folder
          ? readdir(path, { withFileTypes: true }).then((entries) => { for (const e of entries) queue.push({ path: join(path, e.name), folder: e.isDirectory() }); })
          : readFile(path);
        read.catch(() => {}).finally(() => { active--; next(); });
      }
      if (!active && !queue.length) finished();
    };
    next();
  });
}
