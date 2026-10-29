#!/usr/bin/env node
// E1 (epic #59): the old-store extractor. Reads a store's events.jsonl and turns each row into a history row
// (spec/history.schema.json): the row as the store wrote it, with provenance migrated and `from` naming the archive
// ref and the line, and `placeholders` listing each field that holds a legacy placeholder. A row that is already a
// history row (it has provenance) passes through as it is. A row it cannot turn into a valid one is skipped, never guessed at, and the skip names its line and why. It only reads the store:
// rows go to stdout as JSONL, skips and the count to stderr, one JSON object per line.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate, legacyPaths } from '../../src/history.js';

const [dir, ref] = process.argv.slice(2);
if (!dir || !ref) {
  console.error('usage: extract-store.mjs <store dir> <archive ref>');
  process.exit(2);
}
let rows = 0;
let skips = 0;
const skip = (line, reason) => {
  skips++;
  console.error(JSON.stringify({ skip: { ref, line }, reason }));
};
readFileSync(join(dir, 'events.jsonl'), 'utf8')
  .split('\n')
  .forEach((text, i) => {
    if (!text.trim()) return;
    let r;
    try {
      r = JSON.parse(text);
    } catch {
      return skip(i + 1, 'not JSON');
    }
    const placeholders = r?.provenance ? [] : legacyPaths(r ?? {});
    const row = r?.provenance ? r : { ...r, provenance: { origin: 'migrated', from: { source: 'store', ref, line: i + 1 }, ...(placeholders.length && { placeholders }) } };
    const problems = validate(row);
    if (problems.length) return skip(i + 1, problems.join('; '));
    rows++;
    process.stdout.write(JSON.stringify(row) + '\n');
  });
console.error(JSON.stringify({ ref, rows, skips }));
