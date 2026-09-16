#!/usr/bin/env bash
# Lima VM 内でパケットぽいぽいの最小 smoke を実行する。
# Mac ホストから実行する。
set -euo pipefail

LIMA_INSTANCE="${LIMA_INSTANCE:-ubuntu-lts}"

if ! command -v limactl >/dev/null 2>&1; then
  echo "limactl が PATH にありません。Lima をインストールしてください。" >&2
  exit 1
fi

usage() {
  echo "Usage: $0 [smoke|xdp-build]" >&2
  echo "  smoke     : VM 内で observation-hub / traffic-node / runner の短時間 smoke を実行" >&2
  echo "  xdp-build : VM 内で XDP workspace を build" >&2
  exit 1
}

MODE="${1:-smoke}"

limactl start "$LIMA_INSTANCE" >/dev/null

case "$MODE" in
  smoke)
    echo "==> packet-poipoi smoke in Lima"
    limactl shell "$LIMA_INSTANCE" -- bash -lc '
      set -euo pipefail
      cd "$HOME/packet-poipoi"
      ./scripts/pi-smoke-test.sh
    '
    ;;
  xdp-build)
    echo "==> XDP workspace build in Lima"
    limactl shell "$LIMA_INSTANCE" -- bash -lc '
      set -euo pipefail
      cd "$HOME/packet-poipoi"
      cargo test --manifest-path xdp-hello/Cargo.toml -p xdp-hello-common
      cargo build --manifest-path xdp-hello/Cargo.toml --workspace
    '
    ;;
  *)
    usage
    ;;
esac

echo "==> Done."
