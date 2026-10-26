#!/usr/bin/env node
// Stop hook: re-reads this session's transcript and writes its ledger to the Library, one file per
// session (this session is its only writer). It must never get in the session's way, so every
// failure is swallowed and it always exits 0.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildLedger } from '../lib/ledger/index.js';

const root = process.env.HARNESS_LIBRARY_DIR ?? '/mnt/project-files/harness';

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  // Only write where the Library area already exists: a hook must not create top-level folders.
  if (input.transcript_path && existsSync(root)) {
    const [session] = buildLedger([input.transcript_path]).sessions;
    if (session) {
      const dir = join(root, 'ledger', 'sessions');
      mkdirSync(dir, { recursive: true });
      const id = String(input.session_id ?? session.sessionId).replace(/[^A-Za-z0-9_-]/g, '');
      const record = { filedAt: new Date().toISOString(), cwd: input.cwd ?? null, session };
      const tmp = join(dir, `.${id}.${process.pid}.json.tmp`);
      writeFileSync(tmp, JSON.stringify(record));
      renameSync(tmp, join(dir, `${id}.json`));
    }
  }
} catch {
  // Swallowed on purpose; see above.
}
