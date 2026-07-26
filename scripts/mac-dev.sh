#!/usr/bin/env bash
# UI / event pipelineをMac単体で確認する。XDPと比較実験はLinux / Raspberry Piで動かす。
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

echo "==> building observation hub"
cargo build --release --manifest-path "$TOOLS_DIR/Cargo.toml" -p observation-hub

echo "==> starting observation-hub"
"$TOOLS_DIR/target/release/observation-hub" &
HUB_PID=$!

echo ""
echo "local pipeline:"
echo "  dashboard stream : 127.0.0.1:9010"
echo "  event ingest     : 127.0.0.1:9001"
echo "  HTTP canary      : http://127.0.0.1:8080/api/ping"
echo "  XDP upstream     : 127.0.0.1:9000"
echo ""

if [[ "$START_DASHBOARD" -eq 1 ]]; then
  cd "$DASHBOARD_DIR"
  npm install
  npm run tauri dev
else
  wait "$HUB_PID"
fi
