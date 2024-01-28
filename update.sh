#!/usr/bin/bash -x
set -e
shopt -s expand_aliases
alias ctl='node ../../packages/ctl --config ../../../releasetest/eter.js --plugin-list ../../plugin-list.json'

for host in "$@"; do
    echo "Updating $host"
    ctl remote-scripts host-run "$host" npm-update.sh
    ctl host restart "$host" || echo failed to update "$host"
done
