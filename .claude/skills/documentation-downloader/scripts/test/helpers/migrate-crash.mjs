/**
 * Child process for migrate.test.mjs: runs `applyMigration` and SIGKILLs itself
 * right after the Nth page is copied and verified — before its original is
 * removed — which is the least convenient moment to die.
 *
 *   node migrate-crash.mjs <from> <to> <n>
 */

import { applyMigration } from '../../lib/store/migrate.mjs';

const [from, to, n] = process.argv.slice(2);
let copied = 0;
await applyMigration({
  from, to,
  hooks: { afterCopy: () => { if (++copied === Number(n)) process.kill(process.pid, 'SIGKILL'); } },
});
