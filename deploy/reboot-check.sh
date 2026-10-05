#!/bin/bash
# Verifies that PerpGuard came back after a reboot with nobody touching it.
# Compares against the snapshot deploy/reboot-check.sh --before wrote.
#   deploy/reboot-check.sh --before   # just before rebooting
#   deploy/reboot-check.sh            # after; prints PASS/FAIL per check
set -u
DIR=/root/perpguard-reboot-check
# The index database, from the shared .env (never written into this public repo).
DB=$(sed -n 's/^INDEXER_DATABASE_URL=//p' /root/PerpGuard/.env | tail -n 1 | tr -d '"'"'"' ' | sed 's/?.*//')
block() { psql "$DB" -Atc "select latest_processed_block from perpguard_full.chain_metadata" 2>/dev/null | head -1; }
if [ "${1:-}" = "--before" ]; then
  mkdir -p "$DIR"
  { echo "boot_id=$(cat /proc/sys/kernel/random/boot_id)"; echo "at=$(date -u +%FT%TZ)"; echo "block=$(block)"; echo "backend_log_lines=$(wc -l < /var/log/perpguard/backend.log)"; } > "$DIR/before.env"
  cat "$DIR/before.env"; exit 0
fi
. "$DIR/before.env"
fails=0
check() { if [ "$2" = ok ]; then echo "PASS  $1${3:+  ($3)}"; else echo "FAIL  $1${3:+  ($3)}"; fails=$((fails+1)); fi; }
now_boot=$(cat /proc/sys/kernel/random/boot_id)
[ "$now_boot" != "$boot_id" ] && check "machine rebooted" ok "up since $(uptime -s)" || check "machine rebooted" fail "same boot id as before"
for u in postgresql@16-main caddy perpguard-backend perpguard-backfill perpguard-web; do
  s=$(systemctl is-active $u); [ "$s" = active ] && check "unit $u" ok "active, restarts $(systemctl show $u -p NRestarts --value)" || check "unit $u" fail "$s"
done
[ "$(systemctl is-enabled perpguard-indexer 2>/dev/null)" = disabled ] && check "old live indexer stays off" ok || check "old live indexer stays off" fail
code=$(curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}' https://api.perpguard.app/api/analytics/health)
[ "$code" = "200 0" ] && check "https://api.perpguard.app health" ok "200, certificate verified" || check "https://api.perpguard.app health" fail "$code"
m=$(curl -sS -o /dev/null -w '%{http_code}' "https://api.perpguard.app/api/analytics/metrics?timeframe=24h")
[ "$m" = 200 ] && check "https://api.perpguard.app real endpoint (metrics 24h)" ok || check "https://api.perpguard.app real endpoint" fail "$m"
exp=$(echo | openssl s_client -connect api.perpguard.app:443 -servername api.perpguard.app 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
[ -n "$exp" ] && check "Caddy certificate served" ok "expires $exp" || check "Caddy certificate served" fail
b1=$(block); sleep 20; b2=$(block)
if [ -n "$b1" ] && [ "$b1" -gt "$block" ] && [ "$b2" -gt "$b1" ]; then check "indexer advancing" ok "pre-reboot $block -> $b1 -> $b2 over 20s"; else check "indexer advancing" fail "pre-reboot $block, now $b1 then $b2"; fi
for p in / /risk /traders; do w=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000$p"); [ "$w" = 200 ] && check "web $p" ok || check "web $p" fail "$w"; done
new=$(tail -n +"$((backend_log_lines+1))" /var/log/perpguard/backend.log)
if echo "$new" | grep -q "telegram bot @.* polling" && ! echo "$new" | grep -q "telegram polling stopped"; then check "telegram bot polling" ok "$(echo "$new" | grep -o 'telegram bot @[A-Za-z_]* polling' | tail -1)"; else check "telegram bot polling" fail; fi
echo "---"; [ $fails -eq 0 ] && echo "ALL PASS" || echo "$fails FAILED"
exit $fails
