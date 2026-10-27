#!/bin/bash
# Paste this stub (not setup.sh) into Project settings > Cloud environment > gear > Setup script, once.
# It runs setup.sh from the fresh clone at each container build. Always exits 0.
s=/home/user/ccp_machine/infra/cloud-environment/setup.sh
if [ -f "$s" ]; then bash "$s"; else echo "paste-me: $s missing; setup skipped" >> /tmp/ccp-machine-setup.log; fi
exit 0
