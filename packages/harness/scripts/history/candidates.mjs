// The candidate writer every extractor shares (epic #59: E1 extract-store.mjs, E3 extract-github.mjs). It turns one
// record into a history row (spec/history.schema.json): the draft gets its provenance (origin and from) unless it has
// one, and `placeholders` lists each field holding a legacy placeholder. A row that passes validate() goes to stdout
// as one JSONL line; one that does not is skipped, never guessed at, and the skip goes to stderr naming where the
// record was and why. done() writes the count last, one JSON object per line like everything else on stderr.
import { validate, legacyPaths } from '../../src/history.js';

export function candidates(ref, { out = process.stdout, err = process.stderr } = {}) {
  let rows = 0;
  let skips = 0;
  const say = (o) => err.write(JSON.stringify(o) + '\n');
  /** Skip a record: where names it (ref, line), reason says why. */
  const skip = (where, reason) => {
    skips++;
    say({ skip: where, reason });
  };
  /** A draft row as a history row, written if valid; else skipped at `where` (default: its from, less the source). */
  const write = (draft, { origin, from }) => {
    const placeholders = draft?.provenance ? [] : legacyPaths(draft ?? {});
    const row = draft?.provenance ? draft : { ...draft, provenance: { origin, from, ...(placeholders.length && { placeholders }) } };
    const problems = validate(row);
    if (problems.length) return skip({ ref: from.ref, line: from.line }, problems.join('; '));
    rows++;
    out.write(JSON.stringify(row) + '\n');
  };
  return { write, skip, say, done: (extra = {}) => say({ ref, rows, skips, ...extra }) };
}
