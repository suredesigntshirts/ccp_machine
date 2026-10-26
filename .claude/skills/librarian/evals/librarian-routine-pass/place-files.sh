#!/usr/bin/env bash
set -eu
cp -R "$(dirname "$0")/files/." .
# Library files must look settled (unchanged for 10+ minutes), as they would in real use
find . -exec touch -d "2 days ago" {} +
