#!/bin/sh
# The backend, from the repo root so relative paths in config resolve.
# Environment comes from the unit (shared .env, then deploy/systemd/backend.env);
# the --env-file flag is kept so a hand launch behaves the same, and Node never
# lets it override a variable the process already has.
set -eu
cd "$(dirname "$0")/../../.."
# WHICH ENV FILE: each deployment (mainnet, testnet) has its own COMPLETE file, named by its unit.
# Node never overrides a variable the unit already set, but a variable only the OTHER deployment
# sets would still leak in from a shared file, so the file is chosen, never layered.
exec /usr/bin/node --env-file-if-exists="${PERPGUARD_ENV_FILE:-.env}" apps/backend/src/server.ts
