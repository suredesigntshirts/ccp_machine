#!/usr/bin/env node
// Stop hook: re-reads this session's transcript and writes its ledger to the Library, one file per
// session (this session is its only writer). Each record names the harness code that wrote it and the
// registration that ran it: the first argument, `plugin` (hooks/hooks.json) or `settings`
// (.claude/settings.json). `hooks` keeps every registration seen for the session, so a session where
// both fire shows both from its second turn (on one turn they run at once and the last write wins),
// and `updates` what the UserPromptSubmit hook did about newer harness versions (notice-behind.js).
// With no argument it is `settings` when ~/.claude/settings.json registers this script as a Stop hook
// (the old setup.sh did, without the argument), else `unknown`. A session whose `hooks` lacks `plugin`
// started before the plugin hooks shipped and cannot load them without a restart.
// Before filing, it refreshes the clone this code runs from (host.js refresh(): at most every 10
// minutes, fast-forward only, never in a worktree) and stamps `refreshed` (the result) and `behind`
// (commits behind origin/main as of the last fetch, null when unknown).
// It does nothing unless the project has installed the harness (host.js), and
// it must never get in the session's way, so every failure is swallowed and it always exits 0.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildLedger } from '../lib/ledger/index.js';
import { gate, libraryDir, version, updatesPath, refresh, behindCount } from './host.js';

/** True when ~/.claude/settings.json registers file-turns.js as a Stop hook. */
function fromSettings() {
  try {
    const { hooks } = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
    return (hooks?.Stop ?? []).flatMap((h) => h.hooks ?? [])
      .some((h) => [h.command, ...(h.args ?? [])].some((s) => typeof s === 'string' && s.includes('scripts/file-turns.js')));
  } catch { return false; }
}
const arg = process.argv[2];
const hook = ['plugin', 'settings'].includes(arg) ? arg : !arg && fromSettings() ? 'settings' : 'unknown';

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  if ((await gate(5000)) === 'installed') {
    const ran = version(); // the code that runs this hook, before the refresh moves the clone
    const refreshed = refresh(ran.root);
    const [session] = !input.transcript_path ? [] : buildLedger([input.transcript_path]).sessions;
    if (session) {
      const dir = join(libraryDir(), 'ledger', 'sessions');
      mkdirSync(dir, { recursive: true });
      const id = String(input.session_id ?? session.sessionId).replace(/[^A-Za-z0-9_-]/g, '');
      const file = join(dir, `${id}.json`);
      let seen = [];
      try { seen = JSON.parse(readFileSync(file, 'utf8')).harness?.hooks ?? []; } catch {}
      let updates = []; // what notice-behind.js did when this session's harness fell behind
      try { updates = JSON.parse(readFileSync(updatesPath(id), 'utf8')).updates ?? []; } catch {}
      const harness = { ...ran, hook, hooks: [...new Set([...seen, hook])].sort(), behind: behindCount(ran.root), refreshed, ...(updates.length && { updates }) };
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
