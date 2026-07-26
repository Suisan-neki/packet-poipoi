# Packet Journey

同じUDP負荷を **Application / nftables / XDP** の3か所で止め、Raspberry Piの受信処理がどう変わるかを比べる実験です。

[Webデモを見る](https://suisan-neki.github.io/packet-journey/)

> Webデモの数値は、画面の流れを確認するためのサンプルです。実測結果ではありません。

## 何を比べるのか

Pi AからPi Bへ、同じ条件のUDPパケットを送ります。変えるのは、Pi Bがパケットを止める位置だけです。

```text
Raspberry Pi A                         Raspberry Pi B

UDP :4000 ─────────> NIC ──> XDP ──> network stack ──> nftables ──> UDP socket
                      │       │                              │             │
                   LANの入口   └─ XDP条件                     │             └─ Application条件
                                                         └─ nftables条件
```

- **NIC**: 有線LANからパケットを受け取る装置
- **XDP**: Linuxの通常のネットワーク処理へ渡す前に動くeBPF hook
- **nftables**: Linux内のfirewall
- **Application**: UDP socketからパケットを読むuserspace process

比較する3条件は次のとおりです。

| 条件 | パケットを止める場所 | その手前の動作 |
| --- | --- | --- |
| Application | UDP socketまで到達した後 | XDPは通過、nftablesも通過 |
| nftables | Linux network stack内 | XDPは通過 |
| XDP | NIC driver付近 | 後段のnetwork stackへ渡さない |

標準設定は2,000 pps、128 byte、15秒です。各条件を3回ずつ実行し、開始順も入れ替えます。

確かめたいのは、**同じパケットでも、止める位置によってPi Bの処理量に差が出るか**です。XDPが必ず最良だとは決めず、実機の値で比較します。

## 何を測るのか

| 指標 | 見ているもの |
| --- | --- |
| CPU busy | 計測中にPi BのCPUが動いていた割合 |
| NET_RX softirq | Linuxが行ったネットワーク受信処理の回数 |
| Application receive | UDP socketまで到達したパケットの割合 |
| XDP attach mode | 実際に使われた`native` / `generic` |

代表値は3回の中央値です。ばらつきを隠さないよう、最小値と最大値も残します。Piの型、kernel、interface、MTU、CPU governorもrunごとに記録します。

HTTP GETは比較対象ではありません。UDP負荷をかけている間もPi B上のサービスが応答しているかを見るcanaryです。

## デモの流れ

Dashboardは、1画面に全情報を詰め込まず、実験を順番に追います。

1. Applicationまで届ける
2. nftablesで止める
3. XDPで止める
4. 3条件のCPU / NET_RX / 到達率を比べる

GitHub Pages版はサンプルデータを再生します。Tauri版は、各条件3回分の`experiment_run`がそろった時だけ比較結果を表示します。

## システム構成

```text
data path
  Pi A: traffic-node ── UDP / HTTP ──> Pi B: XDP ─> nftables ─> socket

control / observation
  Pi B: experiment-runner
          ├─ traffic-node、XDP、nftablesを条件ごとに切り替える
          └─ CPU、NET_RX、socket到達数を測る
                         │
                         v
                observation-hub ── NDJSON ──> Tauri dashboard
```

| component | 役割 |
| --- | --- |
| `xdp-hello/` | Rust + Ayaで書いたXDP programとloader |
| `tools/traffic-node/` | UDP負荷の送信とHTTP canary |
| `tools/experiment-runner/` | 3条件の切替、反復、計測、cleanup |
| `tools/observation-hub/` | eventの集約とdashboardへの配信 |
| `observation-core/` | 実験条件と結果の共通Rust型 |
| `dashboard/` | Tauri / Reactの展示UI |

XDPの全パケット数はper-CPU BPF mapで数えます。RingBufは画面表示用のsampleだけに使い、パケットごとのlogをbenchmark中に出しません。

## 実機で動かす

必要なもの:

- Ethernet接続したRaspberry Pi 2台
- Linux、Rust toolchain、nftables
- Dashboard用のNode.jsとTauri prerequisites

安全のため、自分が管理する隔離LANで実行してください。以下のStep 1〜3は別々のterminalで起動したままにします。

<details>
<summary>起動コマンドを開く</summary>

### 1. Pi B: event hubとHTTP canary

```bash
cargo run --release --manifest-path tools/Cargo.toml -p observation-hub -- \
  --event-listen 0.0.0.0:9001 \
  --listen 0.0.0.0:9010 \
  --http-listen 0.0.0.0:8080
```

### 2. Pi B: XDP program

```bash
sudo cargo run --release --manifest-path xdp-hello/Cargo.toml -p xdp-hello -- \
  --iface eth0 \
  --listen 0.0.0.0:9000 \
  --control-listen 0.0.0.0:9020 \
  --defense-mode monitor \
  --blocked-udp-port 4000 \
  --xdp-mode auto
```

`auto`はnative modeを先に試し、NICやdriverが対応していない場合はgeneric modeへ切り替えます。実際に使ったmodeは結果へ保存されます。

### 3. Pi A: traffic generator

```bash
cargo run --release --manifest-path tools/Cargo.toml -p traffic-node -- \
  --hub <PI_B_IP>:9001 \
  --target <PI_B_IP> \
  --defense-control <PI_B_IP>:9020 \
  --control-listen 0.0.0.0:9030 \
  --attack-pps 2000
```

### 4. Pi B: experiment runner

`experiment-runner`はnftablesを操作するため、root権限が必要です。

```bash
sudo cargo run --release --manifest-path tools/Cargo.toml -p experiment-runner -- \
  --traffic-control <PI_A_IP>:9030 \
  --xdp-control 127.0.0.1:9020 \
  --hub 127.0.0.1:9001 \
  --interface eth0 \
  --duration-secs 15 \
  --repetitions 3
```

### 5. Dashboard

```bash
cd dashboard
npm install
npm run tauri dev
```

</details>

固定条件、計算式、実行順、cleanupは[実験プロトコル](docs/EXPERIMENT_PROTOCOL.md)にまとめています。

## 計測上の制約

- 現在のparserはEthernet上のIPv4を対象とし、IPv6、VLAN、fragment、IP optionsには対応していません。
- `generic` XDPは`native` XDPと同じ条件として集計しません。
- CPU busyとNET_RXは、Pi B全体の状態やbackground processの影響を受けます。
- 1つのPi、kernel、NIC、送信rateで得た結果を、すべての環境へ一般化しません。
- Control APIに認証はありません。外部へ公開しないでください。

## Dashboardだけ確認する

```bash
cd dashboard
npm install
npm run build:pages
npm run preview:pages
```
