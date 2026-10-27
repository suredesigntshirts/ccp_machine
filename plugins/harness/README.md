# harness plugin

This folder is the installable plugin. The setup script links it as it is
(`infra/cloud-environment/setup.sh`), and a marketplace can install it as it is: nothing is copied by hand.

```
/plugin install harness --marketplace suredesigntshirts/ccp_machine
```

- **Stop hook** (`hooks/hooks.json`, `scripts/file-turns.js`): after every turn, re-reads the session
  transcript and writes its ledger to `$HARNESS_LIBRARY_DIR/ledger/sessions/<session>.json` (default
  `/mnt/project-files/harness`). It writes only if that folder already exists, and it never fails the
  session. `ledger collect` merges the filed sessions into one ledger for the report, so the
  coordinator and every thread show up, not only the session that builds the report. The repo's
  `.claude/settings.json` also registers `scripts/file-turns.js` as a Stop hook; filing is idempotent
  (one file per session, replaced atomically), so a second run rewrites the same file.
- **`lib/ledger/`**: a copy of `packages/ledger/src` (no dependencies), so the plugin needs no
  `npm ci`. Do not edit it here: change `packages/ledger/src`, run `npm run build:plugin` from the repo
  root, and commit both. `npm test` and CI run `npm run build:plugin -- --check`, which fails when the
  copy differs from a fresh build. `npm run build:plugin -- --zip` also writes `dist/harness-plugin.zip`.
- **Orchestrator skill: parked.** It is not in this plugin, because its prose had drifted from the
  XState machines (Library `research/harness-root-cause-audit/README.md`, R4 and R6). Its last version
  and its lint test are in `suredesigntshirts/ccp_machine_test` (`plugins/harness/skills/orchestrator/`,
  `packages/harness/test/skill-lint.test.js` at commit `1244253`). It comes back only once it is derived
  from the machines in `packages/harness/spec/`; see the Library `notes/harness-reflection/plan.md`.
