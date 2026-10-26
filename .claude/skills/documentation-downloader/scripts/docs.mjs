#!/usr/bin/env node
/**
 * `docs` — the documentation-downloader CLI.
 *
 *   node scripts/docs.mjs <command> [options]     (run `--help` for commands)
 *
 * Each command lives in scripts/commands/<name>.mjs and exports
 * `run(argv) → Promise<number>` (the exit code) and `summary` (one line for help).
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'commands');

function available() {
  try {
    return readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.mjs')).map(f => f.slice(0, -4)).sort();
  } catch {
    return [];
  }
}

async function help() {
  console.log('Usage: node scripts/docs.mjs <command> [options]\n\nCommands:');
  for (const name of available()) {
    const mod = await import(join(COMMANDS_DIR, `${name}.mjs`));
    console.log(`  ${name.padEnd(10)} ${mod.summary || ''}`);
  }
  console.log('\nRun `node scripts/docs.mjs <command> --help` for a command\'s options.');
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  await help();
  process.exit(cmd ? 0 : 1);
}
if (!available().includes(cmd)) {
  console.error(`Unknown command: ${cmd}\n`);
  await help();
  process.exit(1);
}
const mod = await import(join(COMMANDS_DIR, `${cmd}.mjs`));
process.exitCode = await mod.run(rest);
