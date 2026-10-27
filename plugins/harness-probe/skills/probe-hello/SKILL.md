---
name: probe-hello
description: Report that the harness-probe plugin is installed, with its version and root path. Use when asked to check the harness-probe plugin.
---

# probe-hello

Report to the user:

1. The plugin version line printed at session start (`harness-probe <version> loaded from <root> (session <id>)`), or say it is absent.
2. The plugin root path: `${CLAUDE_PLUGIN_ROOT}`.

If a shell is available, also run `claude plugin list 2>&1 | grep -i probe` and show the output.
