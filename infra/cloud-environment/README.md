# Cloud environment

Setup for the claude.ai cloud environment that this project's threads run in.

## setup.sh

The environment's setup script. Do not paste this file. Paste `paste-me.sh` (a 5-line stub) once into
Project settings > Cloud environment menu > gear > Setup script, and save. The stub runs this file
from the fresh clone at each container build, so changes here need no re-paste; if the file is
missing it logs one line to `/tmp/ccp-machine-setup.log`. It always exits 0.

It runs when the container is built, after the repo clone and before Claude Code starts. The
environment then caches the container, so setup.sh does only what needs a build; whatever must see each
session's fresh clone is in `session-start.sh` (below), which setup.sh runs too.

What it does, because threads ignore the repo's own `.claude/` (untrusted workspace):

1. Runs `session-start.sh` (its steps below), which copies the SessionStart hook entry into the user
   settings file, so every later session reruns it.
2. Runs `npm ci` in the clone for the harness and ledger CLIs (`packages/`).
3. Writes an environment audit.

## session-start.sh

The per-session steps. The repo's `.claude/settings.json` defines one SessionStart hook that runs it
from the clone (`/home/user/ccp_machine`), and setup.sh's settings copy carries that entry into
`~/.claude/settings.json`, so nothing in setup.sh hardcodes a settings entry. At every session start it:

1. Merges the repo's `.claude/settings.json` into `~/.claude/settings.json` (repo values win), and removes a stale `file-turns.js` Stop hook entry
   left by older builds (the harness plugin registers that hook itself).
   This is how `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` reaches threads, which launch with it set to 1.
   Claude Code has read its settings before the hook runs, so a settings change reaches the session
   after the one that copied it, with no container rebuild.
2. Links each skill in `.claude/skills/` into `~/.claude/skills/`.
3. Links every plugin in the repo (a folder with `.claude-plugin/plugin.json`) into
   `~/.claude/skills/<name>`, where it loads as `<name>@skills-dir`. `plugins/harness` is
   self-contained, so this needs no install.
4. Logs each plugin's version, the harness version and the clone's commit.

It writes only to the setup log, never to the session, and always exits 0. Edits to it take effect at
the next session start. `packages/ledger/test/cloud-setup.test.js` runs setup.sh and then the hook in a
scratch `HOME` (`CCP_SETUP_DIR` moves the log and audit off `/tmp` for that test).

| File | Holds |
|---|---|
| `/tmp/ccp-machine-setup.log` | What setup.sh and session-start.sh did each run |
| `/tmp/ccp-machine-env.txt` | System, tools, repos, Claude config, environment variable names |

Rules: log names, never values, of environment variables and settings; no network probes; no
hardcoded settings (put them in `.claude/settings.json`).
