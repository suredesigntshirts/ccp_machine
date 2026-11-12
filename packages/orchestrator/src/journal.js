// The journal on disk: one JSON entry per line, appended and never rewritten.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const fileJournal = (path) => ({
  path,
  read: () => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
  append: (entry) => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + '\n');
  }
});
