#!/bin/bash
# ccp_machine per-session setup. The environment caches the container that setup.sh built, so the steps
# that must see the session's fresh clone run here, at every session start, as a SessionStart hook that
# the repo's .claude/settings.json defines (setup.sh's first run of this script copies that entry into
# ~/.claude/settings.json). setup.sh runs this script too, for the same steps.
# 1. Merges the repo's .claude/settings.json into the user-level ~/.claude/settings.json (repo wins).
# 2. Links the repo's .claude/skills into ~/.claude/skills, because a cloud thread does not load
#    the repo's own .claude/ (untrusted workspace).
# 3. Links every plugin in the repo (a folder with .claude-plugin/plugin.json) the same way.
#    plugins/harness is self-contained (its ledger copy is committed), so it needs no npm install.
# 4. Logs the harness version and the clone's commit.
# Everything goes to the setup log, never to the session, and it always exits 0. Never logs a value of
# an environment variable or setting. A settings change made here reaches the session after this one.
out="${CCP_SETUP_DIR:-/tmp}"
log="$out/ccp-machine-setup.log"
H="${HOME:-/root}"
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

{
  echo "== session-start start $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # 1. Settings. A thread ignores the repo's .claude/settings.json (untrusted workspace), so merge
  # it into the user settings file, the repo's values winning. Logs key names only.
  settings="$H/.claude/settings.json"
  src="$repo/.claude/settings.json"
  mkdir -p "$H/.claude"
  [ -s "$settings" ] || echo '{}' > "$settings"
  if [ ! -f "$src" ]; then
    echo "settings: no $src; $settings left as it was"
  elif tmp=$(jq -s '.[0] * .[1]' "$settings" "$src"); then
    printf '%s\n' "$tmp" > "$settings"
    echo "settings merged from $src: keys $(jq -r 'keys | join(" ")' "$settings"); env keys $(jq -r '.env // {} | keys | join(" ")' "$settings"); hook events $(jq -r '.hooks // {} | keys | join(" ")' "$settings")"
  else
    echo "settings: jq failed on $src; $settings left as it was"
  fi
  # The harness plugin registers its own Stop hook, so an older copy of the repo's file-turns.js Stop
  # entry in the user settings (kept by the additive merge) would fire twice. Drop exactly that entry.
  if tmp=$(jq 'if (.hooks.Stop | type) == "array" then
      .hooks.Stop |= map(select(([.hooks[]?.args[]?, .hooks[]?.command?] | map(strings) | any(contains("plugins/harness/scripts/file-turns.js"))) | not))
      | if (.hooks.Stop | length) == 0 then del(.hooks.Stop) else . end
      | if (.hooks | length) == 0 then del(.hooks) else . end
    else . end' "$settings") && [ -n "$tmp" ]; then
    if [ "$tmp" != "$(jq . "$settings")" ]; then
      printf '%s\n' "$tmp" > "$settings"
      echo "settings: removed stale file-turns.js Stop hook entry"
    fi
  else
    echo "settings: stale Stop hook cleanup skipped; $settings left as it was"
  fi

  # 2. Repo skills. Link, not copy: the clone is fresh every session while this container is cached.
  mkdir -p "$H/.claude/skills"
  for s in "$repo"/.claude/skills/*/; do
    [ -f "$s/SKILL.md" ] || continue
    name=$(basename "$s")
    ln -sfn "${s%/}" "$H/.claude/skills/$name" && echo "linked skill $name"
  done

  # 3. Repo plugins. A folder holding .claude-plugin/plugin.json, linked into ~/.claude/skills,
  # loads as <name>@skills-dir. Named from its plugin.json, else its folder.
  find "$repo" -maxdepth 4 \( -name node_modules -o -name .git \) -prune -o \
    -path '*/.claude-plugin/plugin.json' -print 2>/dev/null | while read -r manifest; do
    dir=$(dirname "$(dirname "$manifest")")
    name=$(jq -r '.name // empty' "$manifest" 2>/dev/null)
    name=${name:-$(basename "$dir")}
    version=$(jq -r '.version // "unknown"' "$manifest" 2>/dev/null)
    ln -sfn "$dir" "$H/.claude/skills/$name" && echo "linked plugin $name ${version:-unknown} from ${dir#"$repo"}/"
  done

  # 4. Versions.
  echo "harness $(jq -r '.version // "unknown"' "$repo/packages/harness/package.json" 2>/dev/null || echo unknown) at $(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo 'no commit')"
  echo "== session-start end $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >> "$log" 2>&1
exit 0
