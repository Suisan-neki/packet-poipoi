#!/usr/bin/env bash
# 【Mac のターミナルでのみ実行】Lima のシェル内では使えない（limactl がホスト側に必要）。
# Mac ホストから Lima インスタンスの ~/packet-poipoi にリポジトリを同期する。
# （共有マウントは書き込み不可のため、VM 内のホームにコピーしてビルドする流れ用）
# cargo プロジェクト（eBPF 本体）は ~/packet-poipoi/xdp-hello/ 以下。
set -euo pipefail

LIMA_INSTANCE="${LIMA_INSTANCE:-ubuntu-lts}"
DO_BUILD=0
DO_RUN=0

usage() {
  echo "このスクリプトは Mac ホストで実行する（Lima の中ではない）。" >&2
  echo "Usage: $0 [--build] [--run] [--instance NAME]" >&2
  echo "  --build   同期後に VM 内で cargo build --release（xdp-hello/xdp-hello）" >&2
  echo "  --run     同期後に VM 内で cargo run（sudo runner 付き）※ --build より後に評価" >&2
  echo "  環境変数 LIMA_INSTANCE でインスタンス名を変えられる（既定: ubuntu-lts）" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) DO_BUILD=1 ;;
    --run) DO_RUN=1 ;;
    --instance)
      shift
      [[ $# -gt 0 ]] || usage
      LIMA_INSTANCE="$1"
      ;;
    -h | --help) usage ;;
    *)
      echo "unknown option: $1" >&2
      usage
      ;;
  esac
  shift
done

if ! command -v limactl >/dev/null 2>&1; then
  echo "limactl が PATH にありません。Lima をインストールしてください。" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

limactl start "$LIMA_INSTANCE"

echo "==> Sync $REPO_ROOT -> ${LIMA_INSTANCE}:~/packet-poipoi (excluding .git, xdp-hello/target)"
tar -C "$REPO_ROOT" \
  --exclude='./.git' \
  --exclude='./xdp-hello/target' \
  -cf - . | limactl shell "$LIMA_INSTANCE" -- bash -c 'mkdir -p "$HOME/packet-poipoi" && tar -xf - -C "$HOME/packet-poipoi"'

if [[ "$DO_BUILD" -eq 1 ]]; then
  echo "==> cargo build --release (in VM)"
  limactl shell "$LIMA_INSTANCE" -- bash -lc 'cd "$HOME/packet-poipoi/xdp-hello" && cargo build --release'
fi

if [[ "$DO_RUN" -eq 1 ]]; then
  echo "==> cargo run --release (in VM, sudo runner)"
  limactl shell "$LIMA_INSTANCE" -- bash -lc 'cd "$HOME/packet-poipoi/xdp-hello" && RUST_LOG=info cargo run --release --config '"'"'target."cfg(all())".runner="sudo -E"'"'"''
fi

echo "==> Done."
