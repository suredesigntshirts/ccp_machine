# harness plugin

This folder is the installable plugin. The setup script links it as it is
(`infra/cloud-environment/setup.sh`): nothing is copied by hand. It is not in the marketplace
(`.claude-plugin/marketplace.json`) yet: marketplace plugins on this account sync into every project.

- **Per-project gate** (`scripts/host.js`): a marketplace plugin loads into every project of the
  account, so every hook does nothing (exit 0, no output, no writes) unless the project has installed
  the harness: the marker `$HARNESS_LIBRARY_DIR/install.json` exists (default
  `/mnt/project-files/harness/install.json`, read once, capped at 1 s). `HARNESS_DISABLED=1` turns every
  hook off even where the marker exists. The marker path and the variable are defined only in `host.js`.
- **SessionStart hook** (`scripts/session-start.js`): prints one line into the transcript, such as
  `harness 0.2.0 commit <sha> from <plugin root>, behind: no`. The commit comes from git when the plugin
  sits in a checkout (the setup script's skills-dir link); a synced copy prints `unknown (no git)` and
  its version names the build. `behind` compares with origin/main by `git ls-remote` (2.5 s cap), else
  `unknown`. Without the marker it prints only `available but not installed`. It always exits 0 within
  about 4 s.
- **Stop hook** (`scripts/file-turns.js`): after every turn, re-reads the session transcript and writes
  its ledger to `$HARNESS_LIBRARY_DIR/ledger/sessions/<session>.json`. Each record carries
  `harness: { name, version, commit, root, hook, hooks }`: `hook` is the registration that wrote it
  (`plugin` from `hooks/hooks.json`, `settings` from the repo's `.claude/settings.json`, passed as the
  first argument) and `hooks` every registration seen for the session, so a session where both fire
  shows both. Filing is idempotent (one file per session, replaced atomically). It never fails the
  session. `ledger collect` merges the filed sessions into one ledger for the report.
- **Status line and `/harness` pane** (`hooks/status.tsx`, the harness-status mod, named under `modules`
  in `hooks/hooks.json`; its `$.state` contract is `types/index.d.ts`). A hooks module, so it loads with
  the plugin by the same route, `harness@skills-dir` included; there is no separate copy. Placeholder
  content only: it runs `scripts/status.js`, which answers host.js's gate and version (one Library read,
  the marker; no network), at session start and then at most once a minute. The status line reads
  `harness 0.3.0 commit <sha7> · installed`, or `harness 0.3.0: available, not installed` without the
  marker; `HARNESS_DISABLED=1` shows nothing. `/harness` (registered only when installed) opens a pane
  with the same facts. Every hook swallows its errors.
- **Load record**: when the module loads in an installed project, `status.js --record <session>` writes
  `$HARNESS_LIBRARY_DIR/status-mod/<session>.json`, one JSON object
  `{ session, event: "loaded", plugin, version, commit, root, at }`, replaced at each load or reload.
  No file for a session that ran the hooks (its ledger exists) means the module did not load there; the
  reason is in that session's debug log as `hooks module harness@skills-dir not loaded: <reason>`. A
  headless `claude -p` loads it the same way (verified), but has no status row to draw in.
- **Version**: `.claude-plugin/plugin.json`. CI fails a pull request that changes `plugins/harness`
  without raising it (`scripts/check-plugin-version.mjs`), so one version is one build.
- **`lib/ledger/`**: a copy of `packages/ledger/src` (no dependencies), so the plugin needs no
  `npm ci`. Do not edit it here: change `packages/ledger/src`, run `npm run build:plugin` from the repo
  root, and commit both. `npm test` and CI run `npm run build:plugin -- --check`, which fails when the
  copy differs from a fresh build. `npm run build:plugin -- --zip` also writes `dist/harness-plugin.zip`.
- **Orchestrator skill: parked.** It is not in this plugin, because its prose had drifted from the
  XState machines (Library `research/harness-root-cause-audit/README.md`, R4 and R6). Its last version
  and its lint test are in `suredesigntshirts/ccp_machine_test` (`plugins/harness/skills/orchestrator/`,
  `packages/harness/test/skill-lint.test.js` at commit `1244253`). It comes back only once it is derived
  from the machines in `packages/harness/spec/`; see the Library `notes/harness-reflection/plan.md`.
