# harness plugin

- **Stop hook** (`scripts/file-turns.js`): after every turn, re-reads the session transcript and writes
  its ledger to `$HARNESS_LIBRARY_DIR/ledger/sessions/<session>.json` (default
  `/mnt/project-files/harness`). It writes only if that folder already exists, and it never fails the
  session. `ledger collect` merges the filed sessions into one ledger for the report, so the
  coordinator and every thread show up, not only the session that builds the report.
- **orchestrator skill**: the loop an orchestrator thread runs on each wake (events in, effects out,
  page refreshed).

Build with `npm run build:plugin` (from the repo root): `dist/harness/` is the plugin, with a copy of
`@ccp/ledger` in `lib/`, and `dist/harness-plugin.zip` is the same as an archive. Repository `.claude/`
folders do not load in Project threads, so the plugin has to be installed for the environment, for
example by uploading the archive as a plugin or by the environment's setup script.
