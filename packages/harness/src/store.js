// A harness store on disk: one folder per harness. The snapshot is replaced whole on each write
// (write a temp file, then rename); the event log, outbox and acks are append-only JSONL, so a
// reader never sees half a write and nothing is edited in place. One writer at a time holds the lock.
import { readFileSync, writeFileSync, appendFileSync, renameSync, openSync, closeSync, unlinkSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const STALE_LOCK_MS = 60_000;

export function openStore(dir) {
  mkdirSync(dir, { recursive: true });
  const file = (n) => join(dir, n);
  const readJsonl = (n) =>
    existsSync(file(n))
      ? readFileSync(file(n), 'utf8')
          .split('\n')
          .filter(Boolean)
          .flatMap((l) => {
            try {
              return [JSON.parse(l)];
            } catch {
              return [];
            }
          })
      : [];
  const append = (n, rows) => rows.length && appendFileSync(file(n), rows.map((r) => JSON.stringify(r) + '\n').join(''));

  return {
    dir,
    /** @returns {{version: number, snapshot: object, appliedIds: string[], updatedAt: string} | null} */
    read: () => (existsSync(file('state.json')) ? JSON.parse(readFileSync(file('state.json'), 'utf8')) : null),
    // Compare-and-set: refuses unless the stored version is still the one the caller read.
    write(state, expectedVersion) {
      const current = this.read();
      if ((current?.version ?? 0) !== expectedVersion)
        throw new Error(`state changed: expected version ${expectedVersion}, found ${current?.version ?? 0}`);
      const tmp = file(`state.json.${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify(state, null, 1));
      renameSync(tmp, file('state.json'));
    },
    events: () => readJsonl('events.jsonl'),
    outbox: () => readJsonl('outbox.jsonl'),
    acks: () => readJsonl('acks.jsonl'),
    appendEvents: (rows) => append('events.jsonl', rows),
    appendOutbox: (rows) => append('outbox.jsonl', rows),
    appendAcks: (rows) => append('acks.jsonl', rows),
    pending() {
      const done = new Set(this.acks().map((a) => a.effectId));
      return this.outbox().filter((e) => !done.has(e.id));
    },
    withLock(fn) {
      const lock = file('lock');
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock);
      let fd;
      try {
        fd = openSync(lock, 'wx');
      } catch {
        throw new Error(`another writer holds ${lock}`);
      }
      try {
        return fn();
      } finally {
        closeSync(fd);
        unlinkSync(lock);
      }
    }
  };
}
