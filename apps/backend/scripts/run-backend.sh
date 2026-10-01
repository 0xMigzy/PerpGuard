#!/bin/sh
# The backend, from the repo root so relative paths in config resolve.
# Environment comes from the unit (shared .env, then deploy/systemd/backend.env);
# the --env-file flag is kept so a hand launch behaves the same, and Node never
# lets it override a variable the process already has.
set -eu
cd "$(dirname "$0")/../../.."
exec /usr/bin/node --env-file-if-exists=.env apps/backend/src/server.ts
