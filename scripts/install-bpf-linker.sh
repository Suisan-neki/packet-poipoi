#!/usr/bin/env bash
# rustup 環境向けに公式 release tarball から bpf-linker を導入する。
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${BPF_LINKER_VERSION:-latest}"

command -v curl >/dev/null 2>&1 || {
  echo "curl is required to install bpf-linker" >&2
  exit 1
}
command -v zstd >/dev/null 2>&1 || {
  echo "zstd is required to extract bpf-linker release archives" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) os="unknown-linux-musl" ;;
  Darwin) os="apple-darwin" ;;
  MINGW*|MSYS*|CYGWIN*) os="pc-windows-gnullvm" ;;
  *)
    echo "unsupported OS for bpf-linker installer: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch="x86_64" ;;
  aarch64|arm64) arch="aarch64" ;;
  *)
    echo "unsupported architecture for bpf-linker installer: $(uname -m)" >&2
    exit 1
    ;;
esac

triple="${arch}-${os}"
archive="bpf-linker-${triple}.tar.zst"
if [[ "$VERSION" == "latest" ]]; then
  url="https://github.com/aya-rs/bpf-linker/releases/latest/download/${archive}"
else
  url="https://github.com/aya-rs/bpf-linker/releases/download/v${VERSION}/${archive}"
fi

tmpdir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

mkdir -p "$INSTALL_DIR"
curl -fsSLo "$tmpdir/$archive" "$url"
tar -xpf "$tmpdir/$archive" -C "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/bpf-linker" 2>/dev/null || true
"$INSTALL_DIR/bpf-linker" --version
