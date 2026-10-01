#!/bin/sh
# The production web server. `node_modules/next` is a pnpm symlink resolved at
# every start, for the same reason the indexer wrapper resolves envio: the
# hashed store path changes on every re-pin. Needs a build (`pnpm build`).
set -eu
cd "$(dirname "$0")/.."
exec /usr/bin/node "$(readlink -f node_modules/next)/dist/bin/next" start -p "${PORT:-3000}"
