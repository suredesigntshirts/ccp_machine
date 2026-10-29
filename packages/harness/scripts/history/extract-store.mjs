#!/usr/bin/env node
// E1 (epic #59): the old-store extractor. Reads a store's events.jsonl and turns each row into a history row
// (spec/history.schema.json): the row as the store wrote it, with provenance migrated and `from` naming the archive
// ref and the line, and `placeholders` listing each field that holds a legacy placeholder. A row that is already a
// history row (it has provenance) passes through as it is. A row it cannot turn into a valid one is skipped, never guessed at, and the skip names its line and why (the shared
// candidate writer, candidates.mjs, does both). It only reads the store:
// rows go to stdout as JSONL, skips and the count to stderr, one JSON object per line.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidates } from './candidates.mjs';

const [dir, ref] = process.argv.slice(2);
if (!dir || !ref) {
  console.error('usage: extract-store.mjs <store dir> <archive ref>');
  process.exit(2);
}
const out = candidates(ref);
readFileSync(join(dir, 'events.jsonl'), 'utf8')
  .split('\n')
  .forEach((text, i) => {
    if (!text.trim()) return;
    let r;
    try {
      r = JSON.parse(text);
    } catch {
      return out.skip({ ref, line: i + 1 }, 'not JSON');
    }
    out.write(r, { origin: 'migrated', from: { source: 'store', ref, line: i + 1 } });
  });
out.done();
