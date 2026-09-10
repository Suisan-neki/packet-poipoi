#!/usr/bin/env bash
# 展示側PC: Pi B の observation-hub へ接続する Tauri dashboardを起動する。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DASHBOARD_DIR="$REPO_ROOT/dashboard"
CONFIG_FILE="${CONFIG_FILE:-$REPO_ROOT/scripts/packet-poipoi.env}"

if [[ $# -gt 0 ]]; then
  echo "Usage: CONFIG_FILE=./scripts/packet-poipoi.env $0" >&2
  exit 1
fi

if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

PI_B_IP="${PI_B_IP:-192.168.50.20}"
export PACKET_POIPOI_STREAM_ADDR="${PACKET_POIPOI_STREAM_ADDR:-${PI_B_IP}:9010}"

echo ""
echo "パケットぽいぽい booth:"
echo "  dashboard stream : ${PACKET_POIPOI_STREAM_ADDR}"
echo "  Pi B event ingest: ${PI_B_IP}:9001"
echo "  Pi B HTTP canary : http://${PI_B_IP}:8080/api/ping"
echo ""
cd "$DASHBOARD_DIR"
npm install
npm run tauri dev
