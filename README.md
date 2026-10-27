# ccp_machine

The agent harness for Claude Projects, its plugin and the project's cloud setup. Standalone tools the
harness can use live in `suredesigntshirts/ccp_machine_test`. Rules for working here are in
[CLAUDE.md](CLAUDE.md).

## What is here

**`packages/harness` (`@ccp/harness`).** The harness itself: XState v5 JSON machines for the harness, each
work item and the budget (`spec/*.machine.json`, the source of truth for behaviour), and a
restore-apply-persist runtime over a file store. The `harness` CLI applies events, lists and acks
effects, and renders mission control and the item pages. See [its README](packages/harness/README.md).

**`packages/ledger` (`@ccp/ledger`).** A turn-level audit ledger of Claude Code sessions: turns, requests,
tools, subagents, cost and usage windows, with a budget and an HTML report. See
[its README](packages/ledger/README.md).

**`plugins/harness`.** The Claude Code plugin threads load: a SessionStart hook that prints the harness
version and commit, and a Stop hook that files each turn's ledger into the Library. Both stay quiet in
projects without the install marker. The folder is the plugin as installed. See [its README](plugins/harness/README.md).

**`mods/harness-status`.** A Claude Code mod with a status line and a `/harness` pane over the harness
store. See [its README](mods/harness-status/README.md).

**`infra/cloud-environment`.** The environment's setup script. See [its README](infra/cloud-environment/README.md).

## Commands

From the repo root, after `npm ci`:

| Command | What it does |
|---|---|
| `npm test` | every workspace's `node:test` suite |
| `npm run scenarios` | replay the harness scenarios in `packages/harness/scenarios/` |
| `npm run sim` | drive 12 synthetic items through a scratch store at WIP 3 and 12 |
| `npm run pages:check` | render the harness pages and check them in Chromium at phone and desktop widths |
| `npm run build:plugin` | refresh `plugins/harness/lib/ledger` from `packages/ledger/src` (`-- --check` to verify, `-- --zip` for `dist/harness-plugin.zip`) |

The CLIs: `node packages/harness/bin/harness.js --help` and `node packages/ledger/bin/ledger.js --help`.
The harness store is `/mnt/project-files/harness/state/main` (set `HARNESS_DIR`).
