#!/usr/bin/env bash
# Shallow-clone the xstate source at the tag matching the installed version, into vendor/xstate
# (gitignored), so the engine can be read next to the harness model.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
version="$(node -p "require('$root/node_modules/xstate/package.json').version")"
dest="$root/vendor/xstate"
if [ -d "$dest/.git" ]; then
  echo "vendor/xstate already present ($(git -C "$dest" describe --tags 2>/dev/null || echo unknown))"
  exit 0
fi
mkdir -p "$root/vendor"
git clone --depth 1 --branch "xstate@$version" https://github.com/statelyai/xstate.git "$dest"
echo "cloned xstate@$version into vendor/xstate"
