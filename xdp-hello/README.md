# xdp-hello

## Prerequisites

1. stable rust toolchain: `rustup toolchain install stable`
1. nightly rust toolchain with eBPF sources: `rustup toolchain install nightly --component rust-src`
1. Linux build prerequisites: `sudo apt-get install clang llvm llvm-dev libelf-dev`
1. (if cross-compiling) rustup target: `rustup target add ${ARCH}-unknown-linux-musl`
1. (if cross-compiling) LLVM: (e.g.) `brew install llvm` (on macOS)
1. (if cross-compiling) C toolchain: (e.g.) [`brew install filosottile/musl-cross/musl-cross`](https://github.com/FiloSottile/homebrew-musl-cross) (on macOS)
1. bpf-linker: `cargo +nightly install bpf-linker --locked`

## Build & Run

Use `cargo build`, `cargo check`, etc. as normal. Run your program with:

```shell
sudo cargo run --release -- \
  --iface eth0 \
  --listen 127.0.0.1:9000 \
  --control-listen 0.0.0.0:9020 \
  --defense-mode monitor \
  --blocked-udp-port 4000 \
  --xdp-mode auto
```

Cargo build scripts are used to automatically build the eBPF correctly and include it in the
program.

CI also builds the eBPF crate directly:

```shell
RUSTFLAGS="-C panic=abort" cargo +nightly build \
  --manifest-path xdp-hello/Cargo.toml \
  -p xdp-hello-ebpf \
  --target bpfel-unknown-none \
  -Z build-std=core \
  --release
```

## Cross-compiling on macOS

Cross compilation should work on both Intel and Apple Silicon Macs.

```shell
CC=${ARCH}-linux-musl-gcc cargo build --package xdp-hello --release \
  --target=${ARCH}-unknown-linux-musl \
  --config=target.${ARCH}-unknown-linux-musl.linker=\"${ARCH}-linux-musl-gcc\"
```
The cross-compiled program `target/${ARCH}-unknown-linux-musl/release/xdp-hello` can be
copied to a Linux server or VM and run there.

## License

With the exception of eBPF code, xdp-hello is distributed under the terms
of either the [MIT license] or the [Apache License] (version 2.0), at your
option.

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this crate by you, as defined in the Apache-2.0 license, shall
be dual licensed as above, without any additional terms or conditions.

### eBPF

All eBPF code is distributed under either the terms of the
[GNU General Public License, Version 2] or the [MIT license], at your
option.

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this project by you, as defined in the GPL-2 license, shall be
dual licensed as above, without any additional terms or conditions.

[Apache license]: LICENSE-APACHE
[MIT license]: LICENSE-MIT
[GNU General Public License, Version 2]: LICENSE-GPL2
