# harness plugin (installed copy)

Built from suredesigntshirts/ccp_machine_test (`npm run build:plugin`, then copy `dist/harness/` here
without `hooks/`). Do not edit it here: change the source there and copy the build again.

- `infra/cloud-environment/setup.sh` links this folder into `~/.claude/skills`, so the
  `orchestrator` skill loads in Project threads. This takes effect when the environment builds a new
  container, because the setup script runs only then.
- The Stop hook (`scripts/file-turns.js`, which files each session's turn ledger in
  `/mnt/project-files/harness/ledger/sessions/<session>.json`) is not registered yet. Registering a
  hook needs the person's own change, because Claude's safety check blocks Claude from adding hooks.
  To enable it, add this to `.claude/settings.json`; the setup script merges it into the user settings:

```json
"hooks": {
  "Stop": [
    { "hooks": [ { "type": "command", "command": "node",
      "args": ["/home/user/ccp_machine/plugins/harness/scripts/file-turns.js"], "timeout": 30 } ] }
  ]
}
```
