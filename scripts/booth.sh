#!/usr/bin/env bash
# 展示側: observation-hub + Tauri dashboardを起動する。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="$REPO_ROOT/tools"
DASHBOARD_DIR="$REPO_ROOT/dashboard"
START_DASHBOARD=1

if [[ "${1:-}" == "--no-dashboard" ]]; then
  START_DASHBOARD=0
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--no-dashboard]" >&2
  exit 1
fi

cleanup() {
  [[ -n "${HUB_PID:-}" ]] && kill "$HUB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cargo build --release --manifest-path "$TOOLS_DIR/Cargo.toml" \
  -p observation-hub \
  -p experiment-runner

"$TOOLS_DIR/target/release/observation-hub" \
  --event-listen 0.0.0.0:9001 \
  --http-listen 0.0.0.0:8080 &
HUB_PID=$!

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
LAN_IP="${LAN_IP:-127.0.0.1}"

echo ""
echo "パケットぽいぽい booth:"
echo "  dashboard stream : 127.0.0.1:9010"
echo "  event ingest     : ${LAN_IP}:9001"
echo "  HTTP canary      : http://${LAN_IP}:8080/api/ping"
echo ""
echo "Pi Bで比較実験を開始:"
echo "  sudo $TOOLS_DIR/target/release/experiment-runner \\"
echo "    --traffic-control <PI_A_IP>:9030 --xdp-control 127.0.0.1:9020"
echo ""

if [[ "$START_DASHBOARD" -eq 1 ]]; then
  cd "$DASHBOARD_DIR"
  npm install
  npm run tauri dev
else
  wait "$HUB_PID"
fi
