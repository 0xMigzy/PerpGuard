#!/bin/sh
# Launch envio from wherever pnpm currently keeps it.
#
# The store path under node_modules/.pnpm embeds the resolved peer versions,
# so it changes whenever a dependency is re-pinned; a unit that named it
# would break on the next install while the old process carried on running
# from a directory that no longer existed — which is exactly how the live
# indexer was found on Oct 1 2026. `node_modules/envio` is a symlink pnpm
# keeps current, so it is resolved here, at every start.
set -eu
cd "$(dirname "$0")/.."
exec /usr/bin/node "$(readlink -f node_modules/envio)/bin.mjs" start
