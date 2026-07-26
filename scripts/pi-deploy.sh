#!/usr/bin/env bash
# Pi Aへtraffic-node、Pi Bへexperiment-runnerを配置する。
# 例: PI_HOST=pi@192.168.1.11 ROLE=traffic ./scripts/pi-deploy.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_HOST="${PI_HOST:-}"
PI_TARGET="${PI_TARGET:-aarch64-unknown-linux-gnu}"
ROLE="${ROLE:-traffic}"

if [[ -z "$PI_HOST" ]]; then
  echo "PI_HOSTを指定してください。" >&2
  exit 1
fi

case "$ROLE" in
  traffic) PACKAGE="traffic-node" ;;
  experiment) PACKAGE="experiment-runner" ;;
  *)
    echo "ROLEはtrafficまたはexperimentです。" >&2
    exit 1
    ;;
esac

if ! command -v cross >/dev/null 2>&1; then
  echo "crossが必要です。Pi上で直接cargo buildする方法でも構いません。" >&2
  exit 1
fi

cross build \
  --release \
  --manifest-path "$REPO_ROOT/tools/Cargo.toml" \
  -p "$PACKAGE" \
  --target "$PI_TARGET"

BIN="$REPO_ROOT/tools/target/$PI_TARGET/release/$PACKAGE"
REMOTE_DIR="~/packet-journey-bin"
ssh "$PI_HOST" "mkdir -p $REMOTE_DIR"
scp "$BIN" "$PI_HOST:$REMOTE_DIR/$PACKAGE"
echo "deployed $PACKAGE to $PI_HOST:$REMOTE_DIR/$PACKAGE"
