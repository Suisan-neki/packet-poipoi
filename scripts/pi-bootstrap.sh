#!/usr/bin/env bash
# Raspberry Pi OS 64-bit / Debian arm64 の最小依存関係を役割別に入れる。
set -euo pipefail

ROLE="${1:-}"

usage() {
  echo "Usage: $0 [pi-a|pi-b|booth]" >&2
  exit 1
}

install_common() {
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl build-essential pkg-config
}

install_rust() {
  if ! command -v rustup >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  fi
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
  rustup toolchain install stable
}

install_bpf_linker() {
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch="x86_64" ;;
    aarch64|arm64) arch="aarch64" ;;
    *)
      echo "unsupported architecture for bpf-linker: $(uname -m)" >&2
      exit 1
      ;;
  esac
  local archive="bpf-linker-${arch}-unknown-linux-musl.tar.zst"
  local tmpdir
  tmpdir="$(mktemp -d)"
  curl -fsSLo "$tmpdir/$archive" "https://github.com/aya-rs/bpf-linker/releases/latest/download/$archive"
  tar -xpf "$tmpdir/$archive" -C "$HOME/.cargo/bin"
  rm -rf "$tmpdir"
  "$HOME/.cargo/bin/bpf-linker" --version
}

case "$ROLE" in
  pi-a)
    install_common
    install_rust
    ;;
  pi-b)
    install_common
    sudo apt-get install -y clang llvm libelf-dev nftables iproute2 zstd
    sudo apt-get install -y raspberrypi-kernel-headers \
      || sudo apt-get install -y linux-headers-"$(uname -r)" \
      || echo "kernel headers were not installed; continue if your Pi image already provides BPF-capable headers"
    install_rust
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
    rustup toolchain install nightly --component rust-src
    install_bpf_linker
    ;;
  booth)
    install_common
    sudo apt-get install -y libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf nodejs npm \
      || sudo apt-get install -y libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libgtk-3-dev libappindicator3-dev librsvg2-dev patchelf nodejs npm
    install_rust
    ;;
  *)
    usage
    ;;
esac

echo "bootstrap complete for $ROLE"
