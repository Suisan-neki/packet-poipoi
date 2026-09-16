#!/usr/bin/env bash
# Raspberry Pi OS 64-bit / Debian arm64 向けに役割別バイナリを build する。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROLE="${1:-all}"
PI_TARGET="${PI_TARGET:-aarch64-unknown-linux-gnu}"
BUILD_MODE="${BUILD_MODE:-native}"

usage() {
  echo "Usage: $0 [pi-a|pi-b|all]" >&2
  echo "  BUILD_MODE=native は現在の環境向け、BUILD_MODE=cross は ${PI_TARGET} 向けに cross build" >&2
  exit 1
}

build_tools() {
  local packages=("$@")
  local package_args=()
  for package in "${packages[@]}"; do
    package_args+=("-p" "$package")
  done
  if [[ "$BUILD_MODE" == "cross" ]]; then
    command -v cross >/dev/null 2>&1 || {
      echo "BUILD_MODE=cross には cross が必要です。" >&2
      exit 1
    }
    cross build --release --manifest-path "$REPO_ROOT/tools/Cargo.toml" --target "$PI_TARGET" "${package_args[@]}"
  else
    cargo build --release --manifest-path "$REPO_ROOT/tools/Cargo.toml" "${package_args[@]}"
  fi
}

build_xdp() {
  if [[ "$BUILD_MODE" == "cross" ]]; then
    command -v cross >/dev/null 2>&1 || {
      echo "BUILD_MODE=cross には cross が必要です。" >&2
      exit 1
    }
    cross build --release --manifest-path "$REPO_ROOT/xdp-hello/Cargo.toml" -p xdp-hello --target "$PI_TARGET"
  else
    cargo build --release --manifest-path "$REPO_ROOT/xdp-hello/Cargo.toml" -p xdp-hello
  fi
}

case "$ROLE" in
  pi-a)
    build_tools traffic-node
    ;;
  pi-b)
    build_tools observation-hub experiment-runner
    build_xdp
    ;;
  all)
    build_tools traffic-node observation-hub experiment-runner
    build_xdp
    ;;
  *)
    usage
    ;;
esac
