#!/usr/bin/env bash
# Standard restart-on-crash supervision loop for the autonomous trading
# daemon. No new dependency — this is the simplest form of process
# supervision (systemd/pm2 would work too, but this needs zero setup).
#
# Usage: ./scripts/daemon-watchdog.sh [--poll-seconds=60]
set -u
cd "$(dirname "$0")/.."

while true; do
  echo "[watchdog] $(date -u +%FT%TZ) starting daemon..."
  npx tsx scripts/autonomous-trading-daemon.ts "$@"
  code=$?
  echo "[watchdog] $(date -u +%FT%TZ) daemon exited with code $code — restarting in 5s"
  sleep 5
done
