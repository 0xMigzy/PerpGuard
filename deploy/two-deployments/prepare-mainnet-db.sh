#!/usr/bin/env bash
# THE MAINNET DATABASE, ONCE (12 Oct 2026). Run as root on the box, with both backends' data at rest
# is NOT required: it only READS the existing database.
#
#   The existing database (perpguard) becomes the TESTNET deployment's, untouched: its links, sealed
#   keys, Rescue rules and settings are all testnet records.
#   The new database (perpguard_mainnet) starts with a copy of the PUBLIC tables only: who has
#   started the bot, their watch lists and alert settings, the wallet-key switch, the feed cursor
#   and delivery ledger (so nothing already sent is sent again) and the treasury scan (so it is not
#   rescanned). NO account-bound table is copied: account ids are not shared between networks.
#
# Refuses to run if the target already exists. Prints table names and row counts, never a row.
set -euo pipefail
SOURCE=${SOURCE_DB:-perpguard}
TARGET=${TARGET_DB:-perpguard_mainnet}
OWNER=${DB_OWNER:-envio}
PUBLIC_TABLES=(telegram_identities watch_subscriptions watch_warning_state alert_preferences feature_flags event_cursor event_deliveries protocol_treasury_cursor protocol_treasury_movements)

if sudo -u postgres psql -Atc "select 1 from pg_database where datname = '${TARGET}'" | grep -q 1; then
  echo "${TARGET} already exists: nothing done. Drop it yourself if you mean to start again." >&2
  exit 1
fi
sudo -u postgres createdb -O "${OWNER}" "${TARGET}"
args=()
for t in "${PUBLIC_TABLES[@]}"; do
  if sudo -u postgres psql -At -d "${SOURCE}" -c "select to_regclass('public.${t}') is not null" | grep -q t; then args+=(-t "public.${t}"); else echo "  (no ${t} in ${SOURCE}: skipped)"; fi
done
sudo -u postgres pg_dump -d "${SOURCE}" --no-owner --no-privileges "${args[@]}" | sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d "${TARGET}" > /dev/null
sudo -u postgres psql -q -d "${TARGET}" -c "reassign owned by postgres to ${OWNER}" 2>/dev/null || true
for t in "${PUBLIC_TABLES[@]}"; do
  sudo -u postgres psql -q -d "${TARGET}" -c "alter table if exists public.${t} owner to ${OWNER}" > /dev/null
done
echo "${TARGET} created, owned by ${OWNER}. Copied:"
for t in "${PUBLIC_TABLES[@]}"; do
  n=$(sudo -u postgres psql -At -d "${TARGET}" -c "select count(*) from public.${t}" 2>/dev/null || echo "-")
  echo "  ${t}: ${n} rows"
done
echo "Not copied, on purpose: account_links, account_keys, wallet_proofs, account_settings, automation_state, rescue_rules, rescue_attempts, manual_alert_state, close_all_runs, action_log, alert_log."
