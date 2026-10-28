#!/bin/bash
# ccp_machine cloud setup script. Do not paste this file: paste the stub paste-me.sh once into
# Project settings > Cloud environment > gear > Setup script, and it runs this file from the fresh
# clone at each container build, so edits here need no re-paste.
# It runs when the container is built, after the repo clone and before Claude Code starts; the
# environment then caches the container, so it does only what needs a build. The steps that must see
# each session's fresh clone are in session-start.sh, which the repo's .claude/settings.json runs as a
# SessionStart hook.
# 1-3. Runs session-start.sh: merges the repo's .claude/settings.json into ~/.claude/settings.json
#    (which carries the SessionStart hook entry), links the repo's skills and plugins, logs versions.
# 4. Installs the repo's npm workspaces (npm ci) for the harness and ledger CLIs, if it has a lockfile.
# 5. Audits the environment into /tmp/ccp-machine-env.txt (env var NAMES only, never values).
# Log: /tmp/ccp-machine-setup.log. Never logs a value of an environment variable or setting.
# The repo is the clone this file sits in; CCP_SETUP_DIR (tests only) moves the log and audit off /tmp.
out="${CCP_SETUP_DIR:-/tmp}"
log="$out/ccp-machine-setup.log"
audit="$out/ccp-machine-env.txt"
H="${HOME:-/root}"
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

{
  echo "== setup start $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # 1-3. The per-session steps (settings copy, skill and plugin links, versions). session-start.sh
  # logs them itself; the SessionStart hook it copies into the user settings reruns it each session.
  bash "$repo/infra/cloud-environment/session-start.sh"

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
