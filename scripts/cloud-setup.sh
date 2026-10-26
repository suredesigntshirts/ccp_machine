#!/bin/bash
# ccp_machine cloud setup script. Paste into Project settings > Cloud environment > gear > Setup
# script. It runs when the container is built, after the repo clone and before Claude Code starts;
# the environment then caches the container, so edits here take effect only on the next cache build.
# 1. Sets user-level Claude Code settings (~/.claude/settings.json): the subagent nesting depth.
# 2. Links the repo's .claude/skills into ~/.claude/skills, because a cloud thread does not load
#    the repo's own .claude/ (untrusted workspace).
# 3. Audits the environment into /tmp/ccp-machine-env.txt (env var NAMES only, never values).
# Log: /tmp/ccp-machine-setup.log. Never logs a value of an environment variable or setting.
log=/tmp/ccp-machine-setup.log
audit=/tmp/ccp-machine-env.txt
H="${HOME:-/root}"
repo=/home/user/ccp_machine

{
  echo "== setup start $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # 1. Subagent depth. Threads launch with CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1, and the repo's
  # .claude/settings.json env is ignored in threads (PR #6), so set it in the user settings file.
  settings="$H/.claude/settings.json"
  mkdir -p "$H/.claude"
  [ -s "$settings" ] || echo '{}' > "$settings"
  if tmp=$(jq '.env = ((.env // {}) + {"CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "3"})' "$settings"); then
    printf '%s\n' "$tmp" > "$settings"
    echo "settings $settings env keys: $(jq -r '.env | keys | join(" ")' "$settings")"
  else
    echo "settings: jq failed; $settings left as it was"
  fi

  # 2. Repo skills. Link, not copy: the clone is fresh every session while this container is cached.
  mkdir -p "$H/.claude/skills"
  for s in "$repo"/.claude/skills/*/; do
    [ -f "$s/SKILL.md" ] || continue
    name=$(basename "$s")
    ln -sfn "${s%/}" "$H/.claude/skills/$name" && echo "linked skill $name"
  done
} >> "$log" 2>&1

# 3. Audit. Names only for environment variables.
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
  echo "## network (HTTP status, 5 s timeout)"
  for u in https://github.com https://api.github.com https://registry.npmjs.org https://api.anthropic.com; do
    curl -s -o /dev/null -m 5 -w "$u %{http_code}\n" "$u" 2>&1 &
  done; wait
  echo "## environment variable names (values never recorded)"
  compgen -e | sort | tr '\n' ' '; echo
} > "$audit" 2>&1

echo "audit $audit: $(wc -l < "$audit") lines" >> "$log"
echo "== setup end $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$log"
exit 0
