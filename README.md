# パケットぽいぽい

Raspberry PiとRust/eBPFで、通信の「捨てどころ」を比べる実験。

止めると決めた通信を、コンピュータの入口で捨てるのと、アプリまで運んでから捨てるのでは、仕事量はどれくらい変わるのか。

パケットぽいぽいは、この問いを2台のRaspberry Piと実際の通信で確かめます。

[Webデモを見る](https://suisan-neki.github.io/packet-journey/)

> Webデモの数値は、画面の流れを確認するためのサンプルです。実測結果ではありません。

## なぜ測るのか

通信を捨てること自体が目的ではありません。

公開されたコンピュータには、本来のサービスが使う通信だけでなく、運用上は受け取らずに止めたい通信も届きます。その通信もアプリまで運べば、OSやアプリは受信のためにCPUを使います。早く止めれば、その先へ運ぶ仕事を発生させず、CPUの余力を本来のサービスへ残せる可能性があります。

では、止める位置だけで実際の仕事量はどこまで変わるのか。思い込みではなく実機で確かめます。

パケットぽいぽいは防御製品ではありません。普段は見えない「どの段階で通信を止めるか」という設計の違いを、手元の小さなコンピュータで測り、目で追えるようにする実験装置です。

## 何を比べるのか

一方のPiから、もう一方のPiへ同じ量の実験用通信を送ります。変えるのは、受け取ったPiが通信を止める位置だけです。

```text
Raspberry Pi A                         Raspberry Pi B

実験用の通信 ───────> LANの入口 ─> 入口の判定 ─> OSの受信処理 ─> 途中の判定 ─> アプリ
                       NIC          XDP       network stack    nftables    Application
```

通信を最後まで運べば、入口からアプリまでの処理がすべて動きます。途中や入口で止めれば、その先の処理は発生しません。実際にどの程度の差が出るかを、PiのCPUとLinuxの受信処理から測ります。

比較する3条件は次のとおりです。

| 何をするか | 技術上の条件名 | 通信が通る範囲 |
| --- | --- | --- |
| アプリまで運んでから捨てる | Application | 入口からUDP socketまで |
| OSの途中で止める | nftables | Linux network stackまで |
| LANの入口で止める | XDP | NIC driver付近まで |

標準設定は2,000 pps、128 byte、15秒です。各条件を3回ずつ実行し、開始順も入れ替えます。

実験用の通信にはUDPを使います。接続や再送の影響を受けにくく、同じrateで送り続けやすいためです。XDPが必ず最良だとは決めず、実機の値で比較します。

## 何を測るのか

| 指標 | 見ているもの |
| --- | --- |
| Piの仕事量（CPU busy） | 計測中にCPUが動いていた割合 |
| OSの受信処理（NET_RX softirq） | Linuxが行ったネットワーク受信処理の回数 |
| アプリ到達率 | UDP socketまで届いた通信の割合 |
| XDPの動作条件 | 実際に使われた`native` / `generic` mode |

代表値は3回の中央値です。ばらつきを隠さないよう、最小値と最大値も残します。Piの型、kernel、interface、MTU、CPU governorもrunごとに記録します。

横では、Pi B上のWebサービスが応答しているかも確認します。これは「守りたいサービス」の生存確認で、3条件を比較する指標ではありません。技術的にはHTTP GETをcanaryとして使っています。

## デモの流れ

Dashboardは、1画面に全情報を詰め込まず、実験を順番に追います。

1. アプリまで運ぶ（Application）
2. OSの途中で止める（nftables）
3. LANの入口で止める（XDP）
4. Piの仕事量と、OS・アプリまで届いた処理を比べる

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
