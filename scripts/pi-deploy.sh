#!/usr/bin/env bash
# Pi A/Pi Bへ役割別の実行バイナリと起動設定を配置する。
# 例: PI_HOST=pi@192.168.50.10 ROLE=pi-a ./scripts/pi-deploy.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_HOST="${PI_HOST:-}"
PI_TARGET="${PI_TARGET:-aarch64-unknown-linux-gnu}"
ROLE="${ROLE:-}"
REMOTE_DIR="${REMOTE_DIR:-~/packet-poipoi-bin}"
DEPLOY_BUILD="${DEPLOY_BUILD:-1}"
CONFIG_FILE="${CONFIG_FILE:-$REPO_ROOT/scripts/packet-poipoi.env}"

if [[ -z "$PI_HOST" ]]; then
  echo "PI_HOST を指定してください。例: PI_HOST=pi@192.168.50.10 ROLE=pi-a $0" >&2
  exit 1
fi

case "$ROLE" in
  pi-a) PACKAGES=(traffic-node) ;;
  pi-b) PACKAGES=(observation-hub experiment-runner xdp-hello) ;;
  *)
    echo "ROLE は pi-a または pi-b です。" >&2
    exit 1
    ;;
esac

if [[ "$DEPLOY_BUILD" -eq 1 ]]; then
  "$REPO_ROOT/scripts/pi-build.sh" "$ROLE"
fi

ssh "$PI_HOST" "mkdir -p $REMOTE_DIR"

for package in "${PACKAGES[@]}"; do
  if [[ "$package" == "xdp-hello" ]]; then
    bin="$REPO_ROOT/xdp-hello/target/$PI_TARGET/release/xdp-hello"
    [[ -x "$bin" ]] || bin="$REPO_ROOT/xdp-hello/target/release/xdp-hello"
  else
    bin="$REPO_ROOT/tools/target/$PI_TARGET/release/$package"
    [[ -x "$bin" ]] || bin="$REPO_ROOT/tools/target/release/$package"
  fi
  if [[ ! -x "$bin" ]]; then
    echo "missing built binary: $bin" >&2
    exit 1
  fi
  scp "$bin" "$PI_HOST:$REMOTE_DIR/$package"
done

if [[ -f "$CONFIG_FILE" ]]; then
  scp "$CONFIG_FILE" "$PI_HOST:$REMOTE_DIR/packet-poipoi.env"
else
  scp "$REPO_ROOT/scripts/packet-poipoi.env.example" "$PI_HOST:$REMOTE_DIR/packet-poipoi.env.example"
fi
scp "$REPO_ROOT/scripts/pi-start.sh" "$PI_HOST:$REMOTE_DIR/pi-start.sh"

echo "deployed ${PACKAGES[*]} to $PI_HOST:$REMOTE_DIR"
