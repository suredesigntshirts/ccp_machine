#!/usr/bin/env node
// SessionStart hook: prints one line, which lands in the session's transcript, naming the harness code
// this session runs and whether it is behind origin/main. In a project that has not installed the
// harness it prints only that the harness is available; with HARNESS_DISABLED=1 it prints nothing.
// It must never get in the session's way: it swallows every failure, always exits 0, and a watchdog
// ends it within about 4 s, printing the line with "behind: unknown" if the remote check is still out.
import { gate, version, behind, markerPath } from './host.js';

let pending = null; // the line to print if the watchdog fires first
const done = (text) => {
  if (text) process.stdout.write(`${text}\n`);
  process.exit(0);
};
setTimeout(() => done(pending), 3800).unref();

try {
  const state = await gate(1000);
  if (state === 'disabled') done(null);
  const v = version();
  const id = `${v.name} ${v.version}`;
  if (state !== 'installed') done(`${id}: available but not installed in this project (no ${markerPath()})`);
  const head = `${id} commit ${v.commit ?? 'unknown (no git)'} from ${v.root}, behind:`;
  pending = `${head} unknown`;
  done(`${head} ${await behind(v, 2500)}`);
} catch {
  done(pending); // swallowed on purpose; see above
}
