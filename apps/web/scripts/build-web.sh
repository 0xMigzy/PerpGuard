#!/bin/sh
# The production build. `NEXT_PUBLIC_*` values are INLINED AT BUILD TIME, and
# Next reads them from apps/web/.env*, not from the repository's shared .env —
# so the WalletConnect project id (the ONE public value the link page needs)
# is lifted from the shared .env here when the shell does not already carry it.
# A missing id is not an error: the page then lists installed (extension)
# wallets only, with no QR code.
set -eu
cd "$(dirname "$0")/.."
if [ -z "${NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID:-}" ] && [ -f ../../.env ]; then
  NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID="$(sed -n 's/^NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=//p' ../../.env | tail -n 1 | tr -d '"'"'"' \r')"
  export NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
fi
# The public site URL, for absolute link-preview image URLs (metadataBase).
if [ -z "${PUBLIC_WEB_URL:-}" ] && [ -f ../../.env ]; then
  PUBLIC_WEB_URL="$(sed -n 's/^PUBLIC_WEB_URL=//p' ../../.env | tail -n 1 | tr -d '"'"'"' \r')"
  export PUBLIC_WEB_URL
fi
# ALWAYS A CLEAN BUILD. Twice a build that reused .next or the incremental
# type-check cache (tsconfig.tsbuildinfo) passed while a clean one failed: a
# React version mismatch, then an invalid export from the /link layout. Both
# would have broken a deploy. So the output dir and the type cache go first,
# every time, here and in CI.
DIST="${NEXT_DIST_DIR:-.next}"
rm -rf "$DIST" tsconfig.tsbuildinfo
exec node "$(readlink -f node_modules/next)/dist/bin/next" build
