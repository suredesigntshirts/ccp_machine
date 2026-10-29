// The work item spec and an item kept in a folder: its journal is <dir>/journal.jsonl.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Host } from './host.js';
import { fileJournal } from './journal.js';

export const itemSpec = JSON.parse(readFileSync(new URL('../spec/item.machine.json', import.meta.url), 'utf8'));

/** Where the inspector draws each state and transition of the item spec. Drawing only; it changes no behaviour. */
export const itemLayout = JSON.parse(readFileSync(new URL('../spec/item.layout.json', import.meta.url), 'utf8'));

/** The item in dir as its journal leaves it: { host, journal }. */
export const openItem = (dir, spec = itemSpec) => {
  const journal = fileJournal(join(dir, 'journal.jsonl'));
  return { host: Host.replay(spec, journal.read()), journal };
};
