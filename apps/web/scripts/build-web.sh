#!/bin/sh
# The production build. `NEXT_PUBLIC_*` values are INLINED AT BUILD TIME, and
# Next reads them from apps/web/.env*, not from the repository's shared .env —
# so the Dynamic environment id (the ONE public value the link page needs) is
# lifted from the shared .env here when the shell does not already carry it.
# A missing id is not an error: the page then offers the key path only.
set -eu
cd "$(dirname "$0")/.."
if [ -z "${NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID:-}" ] && [ -f ../../.env ]; then
  NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID="$(sed -n 's/^NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID=//p' ../../.env | tail -n 1 | tr -d '"'"'"' \r')"
  export NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID
fi
exec /usr/bin/node "$(readlink -f node_modules/next)/dist/bin/next" build
