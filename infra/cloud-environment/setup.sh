#!/bin/bash
# ccp_machine cloud setup script. Paste into Project settings > Cloud environment > gear > Setup
# script. It runs when the container is built, after the repo clone and before Claude Code starts;
# the environment then caches the container, so edits here take effect only on the next cache build.
# 1. Merges the repo's .claude/settings.json into the user-level ~/.claude/settings.json.
# 2. Links the repo's .claude/skills into ~/.claude/skills, because a cloud thread does not load
#    the repo's own .claude/ (untrusted workspace).
# 3. Links every plugin in the repo (a folder with .claude-plugin/plugin.json) the same way.
#    plugins/harness is self-contained (its ledger copy is committed), so it needs no npm install.
# 4. Installs the repo's npm workspaces (npm ci) for the harness and ledger CLIs, if it has a lockfile.
# 5. Audits the environment into /tmp/ccp-machine-env.txt (env var NAMES only, never values).
# Log: /tmp/ccp-machine-setup.log. Never logs a value of an environment variable or setting.
log=/tmp/ccp-machine-setup.log
audit=/tmp/ccp-machine-env.txt
H="${HOME:-/root}"
repo=/home/user/ccp_machine

{
  echo "== setup start $(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
    echo "settings merged from $src: keys $(jq -r 'keys | join(" ")' "$settings"); env keys $(jq -r '.env // {} | keys | join(" ")' "$settings")"
  else
    echo "settings: jq failed on $src; $settings left as it was"
  fi

  # 2. Repo skills. Link, not copy: the clone is fresh every session while this container is cached.
  mkdir -p "$H/.claude/skills"
  for s in "$repo"/.claude/skills/*/; do
    [ -f "$s/SKILL.md" ] || continue
    name=$(basename "$s")
    ln -sfn "${s%/}" "$H/.claude/skills/$name" && echo "linked skill $name"
  done

  # 3. Repo plugins. A folder holding .claude-plugin/plugin.json, linked into ~/.claude/skills,
  # loads as <name>@skills-dir. Named from its plugin.json, else its folder. mods/ holds Claude Code
  # mods, not plugins, so it is skipped.
  find "$repo" -maxdepth 4 \( -name node_modules -o -name .git -o -path "$repo/mods" \) -prune -o \
    -path '*/.claude-plugin/plugin.json' -print 2>/dev/null | while read -r manifest; do
    dir=$(dirname "$(dirname "$manifest")")
    name=$(jq -r '.name // empty' "$manifest" 2>/dev/null)
    name=${name:-$(basename "$dir")}
    ln -sfn "$dir" "$H/.claude/skills/$name" && echo "linked plugin $name from ${dir#"$repo"}/"
  done

  # 4. npm workspaces (packages/*): the harness CLI needs xstate. Output to the log; never fatal.
  if [ -f "$repo/package-lock.json" ] && command -v npm >/dev/null 2>&1; then
    (cd "$repo" && npm ci --no-audit --no-fund --loglevel=error) && echo "npm ci done in $repo" || echo "npm ci failed in $repo"
  else
    echo "npm ci skipped: no $repo/package-lock.json or no npm"
  fi
} >> "$log" 2>&1

# 5. Audit. Names only for environment variables.
v() { command -v "$1" >/dev/null 2>&1 && echo "$1: $("$@" 2>&1 | head -1)" || echo "$1: missing"; }
{
  echo "# ccp_machine environment audit $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "## system"
  echo "user=$(whoami) uid=$(id -u) pwd=$(pwd) HOME=$H"
  echo "os=$(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}") kernel=$(uname -r) arch=$(uname -m)"
  echo "cpus=$(nproc 2>/dev/null) mem=$(free -h 2>/dev/null | awk '/^Mem:/{print $2" total, "$7" available"}')"
  echo "disk: $(df -h /home/user /tmp 2>/dev/null | awk 'NR>1{print $6"="$4" free of "$2}' | tr '\n' ' ')"
  echo "## tools"
  for t in node npm python3 git gh jq rg curl claude; do v "$t" --version; done
  echo "global npm: $(ls "$(npm root -g 2>/dev/null)" 2>&1 | tr '\n' ' ')"
  echo "## repos in /home/user"
  for r in /home/user/*/; do
    [ -d "$r/.git" ] && echo "$r branch=$(git -C "$r" branch --show-current 2>&1) head=$(git -C "$r" log --oneline -1 2>&1) remote=$(git -C "$r" remote get-url origin 2>&1 | sed 's#//[^@]*@#//#')"
  done
  echo "## claude config"
  echo "~/.claude: $(ls -A "$H/.claude" 2>&1 | tr '\n' ' ')"
  echo "~/.claude/skills: $(ls -A "$H/.claude/skills" 2>&1 | tr '\n' ' ')"
  echo "settings.json env keys: $(jq -r '.env // {} | keys | join(" ")' "$H/.claude/settings.json" 2>&1)"
  echo "## environment variable names (values never recorded)"
  compgen -e | sort | tr '\n' ' '; echo
} > "$audit" 2>&1

echo "audit $audit: $(wc -l < "$audit") lines" >> "$log"
echo "== setup end $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$log"
exit 0
