# PACKET JOURNEY

**同じpacketを、どこで捨てるか。**

Packet Journeyは、2台のRaspberry PiでLinuxの受信処理を実測する低レイヤ実験です。

Pi AからPi Bへ同じUDP負荷を送り、破棄する位置だけを変えます。

1. **Application** — UDP socketまで届け、userspaceで読み捨てる
2. **nftables** — Linux network stack内で捨てる
3. **XDP** — driver entryで、network stackへ入る前に捨てる

各条件でCPU busy率、NET_RX softirq、userspace到達数を測定します。HTTPは比較対象ではありません。負荷中もPi B上のサービスが応答するかを確認するcanaryです。

**Web demo:** https://suisan-neki.github.io/packet-journey/

公開版は画面の読み方を確認するUI fixtureです。ベンチマーク値ではありません。Tauri版は`experiment-runner`が出した実測イベントだけを表示します。

## 30秒で分かる実験

```text
Pi A                                  Raspberry Pi B
traffic-node                          eth0
  UDP :4000 / 2,000 pps ──────────────┬─ XDP ─ network stack ─ nftables ─ UDP socket
  HTTP GET :8080 ──────────────────────┘
                                       ↑       ↑                 ↑
                                    XDP DROP   nft DROP       app receive
```

変えるのは停止位置だけです。送信レート、payload、計測時間を固定し、各条件を3回ずつ実行します。熱や実行順の偏りを減らすため、反復ごとに条件の開始位置を回します。

| 測るもの | 取得元 | 表示 |
| --- | --- | --- |
| CPU busy | Pi Bの`/proc/stat`差分 | 3回の中央値 |
| network受信処理 | Pi Bの`/proc/softirqs`にある`NET_RX`差分 | 1万packetあたり |
| userspace到達 | runnerのUDP socket実受信数 | 送信数に対する割合 |
| XDP実行条件 | 実際にattachできたmode | native / generic |
| サービス生存 | Pi AからPi Bへの実HTTP GET | status / latency |

XDPの価値を「たくさんDROPした」ではなく、**後段へ渡さなかった仕事の差**として示します。

## なぜpacket viewerではないのか

Packet Journeyの主役はanimationではなく比較実験です。

- 個々のpacket表示はRingBufのsample
- 集計は競合を避けたper-CPU BPF map
- benchmark中はpacketごとのeBPF logを出さない
- cumulative counterではなくrunごとの差分を保存
- native XDPが使えない場合はgenericへのfallbackを結果へ明記
- public demoのfixtureと実測値を明確に区別

設計判断の根拠は[受賞作・類似作品の調査](docs/RESEARCH_AND_POSITIONING.md)、再現条件は[実験プロトコル](docs/EXPERIMENT_PROTOCOL.md)にまとめています。

## 構成

| パス | 役割 |
| --- | --- |
| `xdp-hello/` | Rust + AyaのXDP/eBPF program、per-CPU counter、runtime mode切替 |
| `tools/traffic-node/` | Pi Aの固定UDP負荷、HTTP canary、remote control |
| `tools/experiment-runner/` | Pi Bで3条件を切替・反復し、CPU / softirq / app受信数をrun化 |
| `tools/observation-hub/` | NDJSON eventを統合してdashboardへ配信 |
| `observation-core/` | 実験条件と結果を曖昧な文字列にしないRust型 |
| `dashboard/` | 4画面で停止位置と結果を追うTauri / React UI |

## 実機で動かす

### 1. Pi B: observation-hub

```bash
cargo run --release --manifest-path tools/Cargo.toml -p observation-hub -- \
  --event-listen 0.0.0.0:9001 \
  --listen 0.0.0.0:9010 \
  --http-listen 0.0.0.0:8080
```

### 2. Pi B: XDP

```bash
sudo cargo run --release --manifest-path xdp-hello/Cargo.toml -p xdp-hello -- \
  --iface eth0 \
  --listen 0.0.0.0:9000 \
  --control-listen 0.0.0.0:9020 \
  --defense-mode monitor \
  --blocked-udp-port 4000 \
  --xdp-mode auto
```

`auto`はnativeを先に試し、NIC/driverが非対応ならgenericへfallbackします。結果には実際のmodeが残ります。

### 3. Pi A: traffic-node

```bash
cargo run --release --manifest-path tools/Cargo.toml -p traffic-node -- \
  --hub <PI_B_IP>:9001 \
  --target <PI_B_IP> \
  --defense-control <PI_B_IP>:9020 \
  --control-listen 0.0.0.0:9030 \
  --attack-pps 2000
```

### 4. Pi B: 3条件を実行

`experiment-runner`は自分専用の`inet packet_journey` tableだけを作成・削除します。nftables操作のためroot権限が必要です。

```bash
sudo cargo run --release --manifest-path tools/Cargo.toml -p experiment-runner -- \
  --traffic-control <PI_A_IP>:9030 \
  --xdp-control 127.0.0.1:9020 \
  --hub 127.0.0.1:9001 \
  --duration-secs 15 \
  --repetitions 3
```

### 5. Dashboard

```bash
cd dashboard
npm install
npm run tauri dev
```

GitHub Pages用:

```bash
npm run build:pages
```

## 安全と計測上の範囲

- 自分が管理する隔離LANだけで実行してください。
- UDP負荷は1〜100,000 ppsにclampしています。
- XDP parserの対象はEthernet上のIPv4、IP optionsなしです。IPv6、VLAN、fragmentは今回の実験範囲外です。
- control APIは隔離した実験LAN向けで、認証機能はありません。
- 1つのpacket size / 1つの送信rateだけで一般化しません。複数条件は次の検証項目です。
- `generic` XDPはskb確保後に動くため、`native`と同じ結果として扱いません。

## 次に作るもの

3DプリンタでLinux受信経路を5つのblockとして作り、packetが止まった場所だけLEDを点灯させます。Web UIの装飾ではなく、application / nftables / XDPの位置関係を手で追える実験装置にします。
