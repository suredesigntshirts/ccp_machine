# harness plugin (installed copy)

Built from suredesigntshirts/ccp_machine_test at commit `1244253` (2026-10-27): `plugins/harness`
plus `packages/ledger/src` as `lib/ledger`, without `hooks/`. Do not edit it here: change the source
there and copy it again, and update the commit above when you do.

- **Stop hook: registered.** `.claude/settings.json` on main registers `scripts/file-turns.js` as a
  Stop hook (since e664b49, 2026-10-26 18:21 UTC). It files each session's turn ledger in
  `/mnt/project-files/harness/ledger/sessions/<session>.json`. `infra/cloud-environment/setup.sh`
  merges the repo settings into `~/.claude/settings.json`, so it takes effect only in containers built
  after the change. Check a session with `jq .hooks ~/.claude/settings.json`.
- **Orchestrator skill: parked.** It was removed from this copy on 2026-10-27, because its prose had
  drifted from the XState machines (Library `research/harness-root-cause-audit/README.md`, R4 and R6).
  It comes back only once it is derived from the machines again; see the Library
  `notes/harness-reflection/plan.md`.
- `harness-plugin.zip` in the Library (`harness/plugin/`) is the 18:06 first build. It is not needed:
  the setup script installs this folder. Do not upload it.
