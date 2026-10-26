# Cloud environment

Setup for the claude.ai cloud environment that this project's threads run in.

## setup.sh

The environment's setup script. This file is the source of truth: after changing it, paste the
whole file into Project settings > Cloud environment menu > gear > Setup script, and save.

It runs when the container is built, after the repo clone and before Claude Code starts. The
environment then caches the container, so a change reaches threads only after the next cache build.

What it does, because threads ignore the repo's own `.claude/` (untrusted workspace):

1. Merges the repo's `.claude/settings.json` into `~/.claude/settings.json` (repo values win).
   This is how `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` reaches threads, which launch with it set to 1.
2. Links each skill in `.claude/skills/` into `~/.claude/skills/`.
3. Links every plugin in the repo (a folder with `.claude-plugin/plugin.json`) into
   `~/.claude/skills/<name>`, where it loads as `<name>@skills-dir`.
4. Writes an environment audit.

| File | Holds |
|---|---|
| `/tmp/ccp-machine-setup.log` | What the script did each run |
| `/tmp/ccp-machine-env.txt` | System, tools, repos, Claude config, environment variable names |

Rules: log names, never values, of environment variables and settings; no network probes; no
hardcoded settings (put them in `.claude/settings.json`).
