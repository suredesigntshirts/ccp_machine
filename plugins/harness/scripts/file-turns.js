#!/usr/bin/env node
// Stop hook: re-reads this session's transcript and writes its ledger to the Library, one file per
// session (this session is its only writer). Each record names the harness code that wrote it and the
// registration that ran it: the first argument, `plugin` (hooks/hooks.json) or `settings`
// (.claude/settings.json). `hooks` keeps every registration seen for the session, so a session where
// both fire shows both from its second turn (on one turn they run at once and the last write wins).
// It does nothing unless the project has installed the harness (host.js), and
// it must never get in the session's way, so every failure is swallowed and it always exits 0.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildLedger } from '../lib/ledger/index.js';
import { gate, libraryDir, version } from './host.js';

const hook = ['plugin', 'settings'].includes(process.argv[2]) ? process.argv[2] : 'unknown';

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  if (input.transcript_path && (await gate(5000)) === 'installed') {
    const [session] = buildLedger([input.transcript_path]).sessions;
    if (session) {
      const dir = join(libraryDir(), 'ledger', 'sessions');
      mkdirSync(dir, { recursive: true });
      const id = String(input.session_id ?? session.sessionId).replace(/[^A-Za-z0-9_-]/g, '');
      const file = join(dir, `${id}.json`);
      let seen = [];
      try { seen = JSON.parse(readFileSync(file, 'utf8')).harness?.hooks ?? []; } catch {}
      const harness = { ...version(), hook, hooks: [...new Set([...seen, hook])].sort() };
      const record = { filedAt: new Date().toISOString(), cwd: input.cwd ?? null, remoteSessionId: process.env.CLAUDE_CODE_REMOTE_SESSION_ID ?? null, harness, session };
      const tmp = join(dir, `.${id}.${process.pid}.json.tmp`);
      writeFileSync(tmp, JSON.stringify(record));
      renameSync(tmp, file);
    }
  }
} catch {
  // Swallowed on purpose; see above.
}
process.exit(0);
