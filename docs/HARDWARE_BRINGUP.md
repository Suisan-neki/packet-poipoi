# Hardware bring-up

この手順の前提は Raspberry Pi OS 64-bit / Debian arm64、Ethernet だけで接続した管理下の隔離LANです。
HTTP service under test は Pi B の `observation-hub` が提供する `GET /api/ping` です。

## 推奨機材

- Pi A: Raspberry Pi 4/5、64-bit OS、有線Ethernet
- Pi B: Raspberry Pi 4/5、64-bit OS、有線Ethernet、XDP generic/native を試せる kernel/NIC
- 展示PC: Tauri Dashboard を動かす Linux/macOS/Windows
- 2台のPiと展示PCだけを収容するスイッチ、または同等の隔離LAN

Wi-Fi と Ethernet の結果は混ぜません。CPU governor、Pi model、kernel、interface、MTU は runner が run に記録します。

## 役割と既定IP

| node | role | default IP |
| --- | --- | --- |
| Pi A | `traffic-node`: UDP load generator + HTTP probe | `192.168.50.10` |
| Pi B | `observation-hub`, HTTP canary, `xdp-hello`, `experiment-runner`, nftables, metrics | `192.168.50.20` |
| 展示PC | Tauri Dashboard | `192.168.50.30` など |

例:

```bash
sudo nmcli con mod "Wired connection 1" ipv4.method manual ipv4.addresses 192.168.50.10/24
sudo nmcli con up "Wired connection 1"
```

Pi B は `192.168.50.20/24` にします。default gateway は不要です。

## 設定ファイル

開発PCまたは展示PCで:

```bash
cp scripts/packet-poipoi.env.example scripts/packet-poipoi.env
```

実LANに合わせて最低限これを更新します。

```bash
PI_A_HOST=pi@192.168.50.10
PI_B_HOST=pi@192.168.50.20
PI_A_IP=192.168.50.10
PI_B_IP=192.168.50.20
PI_IFACE=eth0
PACKET_POIPOI_STREAM_ADDR=192.168.50.20:9010
```

同じ `packet-poipoi.env` を Pi A/Pi B/展示PCで使います。

## Bootstrap

Pi A:

```bash
ssh "$PI_A_HOST" 'bash -s' < scripts/pi-bootstrap.sh pi-a
```

Pi B:

```bash
ssh "$PI_B_HOST" 'bash -s' < scripts/pi-bootstrap.sh pi-b
```

Pi B bootstrap は `nftables`, `clang`, `llvm`, `libelf-dev`, kernel headers、nightly `rust-src`,
`bpf-linker` を入れます。`xdp-hello` と `experiment-runner` は root 権限が必要です。

展示PC:

```bash
./scripts/pi-bootstrap.sh booth
```

OSごとの Tauri prerequisite が別途必要な場合は Tauri のLinux/macOS/Windows手順に従ってください。

## Build / deploy

開発PCから cross build して配布する場合:

```bash
BUILD_MODE=cross ROLE=pi-a PI_HOST="$PI_A_HOST" CONFIG_FILE=scripts/packet-poipoi.env ./scripts/pi-deploy.sh
BUILD_MODE=cross ROLE=pi-b PI_HOST="$PI_B_HOST" CONFIG_FILE=scripts/packet-poipoi.env ./scripts/pi-deploy.sh
```

Pi上で直接 build する場合はリポジトリをPiへ置き、各Piで:

```bash
./scripts/pi-build.sh pi-a
./scripts/pi-build.sh pi-b
```

deploy 後の既定配置先は `~/packet-poipoi-bin` です。

Pi A に配置されるもの:

- `traffic-node`
- `packet-poipoi.env`
- `pi-start.sh`

Pi B に配置されるもの:

- `observation-hub`
- `experiment-runner`
- `xdp-hello`
- `packet-poipoi.env`
- `pi-start.sh`

## Start

Pi B を先に起動します。

```bash
ssh "$PI_B_HOST" '~/packet-poipoi-bin/pi-start.sh pi-b start'
```

起動内容:

- `observation-hub`: `0.0.0.0:9001` ingest、`0.0.0.0:9010` dashboard stream、`0.0.0.0:8080` HTTP canary
- `xdp-hello`: `eth0` に attach、`0.0.0.0:9020` control、初期 mode `monitor`

次に Pi A:

```bash
ssh "$PI_A_HOST" '~/packet-poipoi-bin/pi-start.sh pi-a start'
```

起動内容:

- `traffic-node`: Pi B `GET /api/ping` probe、Pi B UDP :4000 load、`0.0.0.0:9030` control

展示PC:

```bash
CONFIG_FILE=scripts/packet-poipoi.env ./scripts/booth.sh
```

Dashboard は `PACKET_POIPOI_STREAM_ADDR` の Pi B observation-hub へ接続します。

## Smoke test

物理Pi到着前の Linux VM smoke:

```bash
./scripts/pi-smoke-test.sh
```

これは localhost 上で次を通します。

1. Pi B相当 `observation-hub` と HTTP canary
2. Pi A相当 `traffic-node`
3. `experiment-runner` の Application / nftables / XDP 条件切替
4. nftables table 作成・削除
5. dashboard stream への `experiment_run` 配信

XDP attach は fake control API で置き換えます。実NICへの native/generic attach は物理Piで確認します。

## Real experiment

Pi Bで:

```bash
ssh "$PI_B_HOST" '~/packet-poipoi-bin/pi-start.sh experiment start'
```

既定条件:

- pps: `500,2000,5000,10000,20000,50000`
- duration: 10秒
- repetitions: 3
- service maintained: HTTP success >= 99%、p95 <= 100ms
- load valid: actual send rate >= target pps の90%

`experiment-runner` は通常終了、error、SIGINT のいずれでも次の cleanup を試みます。

- `inet packet_poipoi_experiment` nftables table 削除
- XDP mode を `monitor` に戻す
- Pi A traffic generator を `stop`

## Cleanup

```bash
ssh "$PI_A_HOST" '~/packet-poipoi-bin/pi-start.sh pi-a stop'
ssh "$PI_B_HOST" '~/packet-poipoi-bin/pi-start.sh pi-b stop'
ssh "$PI_B_HOST" 'sudo nft delete table inet packet_poipoi_experiment 2>/dev/null || true'
```

## Troubleshooting

- Dashboard が `WAITING <addr>` のまま: `PACKET_POIPOI_STREAM_ADDR` が Pi B の `:9010` を指しているか確認します。
- HTTP probe が失敗: Pi A から `curl http://<PI_B_IP>:8080/api/ping` を確認します。
- Netfilter 条件が失敗: Pi B で `sudo nft list tables` と root 権限を確認します。
- XDP native attach が失敗: `--xdp-mode auto` は generic へ fallback します。native と generic は結果を混ぜません。
- traffic-node が起動しない: 送信先が private/local address か確認します。公開IP宛ては既定で拒否されます。
