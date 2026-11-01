#!/bin/sh
# Install or update the Skipper org policy hook for Claude Code. Needs no Python and no separate
# Node.js: it uses the Node.js that ships with the Salesforce CLI, or any node on the PATH.
# Options are passed on to install.js (for example --config-dir DIR).
set -e
cd "$(dirname "$0")"

# The Salesforce CLI installer bundles node next to the sf launcher; follow its symlinks to find it.
sf_node() {
  sf=$(command -v sf 2>/dev/null) || return 1
  while [ -L "$sf" ]; do
    link=$(readlink "$sf")
    case "$link" in /*) sf=$link ;; *) sf=$(dirname "$sf")/$link ;; esac
  done
  for candidate in "$(dirname "$sf")/node" "$(dirname "$sf")/../client/bin/node"; do
    [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

NODE=$(sf_node) || NODE=$(command -v node 2>/dev/null) || {
  for candidate in /usr/local/lib/sf/bin/node "$HOME/.local/share/sf/client/current/bin/node"; do
    [ -x "$candidate" ] && NODE=$candidate && break
  done
}
if [ -z "$NODE" ]; then
  echo "Could not find the Salesforce CLI (sf). Install it first:" >&2
  echo "  https://developer.salesforce.com/tools/salesforcecli" >&2
  exit 1
fi

exec "$NODE" install.js "$@"
