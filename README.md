# パケットぽいぽい

**捨てる位置で、Webサービスが耐えられる負荷の上限は何倍変わる？**

2台のRaspberry Piで通信負荷を段階的に上げ、不要な通信を
Application / nftables / XDPのどこで捨てると、同じPi上のWebサービスが
どこまで応答を維持できるかを実測する装置です。

[Webデモを見る](https://suisan-neki.github.io/packet-poipoi/)

> Webデモは画面説明用のサンプルデータです。展示ではRaspberry Piの実測値へ置き換わります。

## 30秒でわかる実験

公開されたコンピュータには、本来のサービスが使う通信と、
受け取らずに止めたい通信の両方が届きます。

不要な通信は早く捨てるほど処理を省けそうです。ただし、それだけなら予想できます。
パケットぽいぽいが測るのは、**その違いがWebサービスの限界を実際に何倍動かすか**です。

1. Pi AからPi BのWebサービスへHTTP GETを送り、通常時の応答を測る
2. 別のUDP通信を500、2,000、5,000、10,000、20,000、50,000回/秒と増やす
3. UDPを捨てる位置だけ変え、負荷中も同じHTTP GETを繰り返す
4. HTTP成功率99%以上かつp95応答時間100ms以下を維持できた最大負荷を比べる

ここでUDPとHTTPの優劣を比べているわけではありません。
UDPは量を制御しやすい**実験用の負荷**、HTTPは守りたい**本来のサービス**です。

## 3つの捨てどころ

受信したデータは、LANの入口からLinuxの処理を通り、最後にアプリへ届きます。

```text
Pi A                         Raspberry Pi B

実験用UDP ───> NIC ───> XDP ───> Linux network stack ───> nftables ───> Application
                    入口で捨てる            途中で捨てる              最後に捨てる

HTTP GET ───────────────────────────────────────────────────────────> Web service
         負荷の前後・負荷中に同じURLの成功率と応答時間を測る
```

| 条件 | どこで捨てるか | その先で省ける処理 |
| --- | --- | --- |
| Application | UDP socketで受信した後 | なし |
| nftables | Linuxのfirewall | アプリまで運び、受信する処理 |
| XDP | NIC driverに近い入口 | 通常のLinux受信処理とアプリ処理 |

入口で捨てれば常に正解、という作品ではありません。
入口ほど使える判断材料は少なく、URLやユーザーの状態などアプリの文脈が必要な判定はできません。
この実験では「UDPの宛先port 4000を止める」と事前に決められる条件だけを扱います。

## 何を結果にするか

主結果はCPU使用率ではなく、各条件の**サービス維持限界**です。

| 指標 | 役割 |
| --- | --- |
| 最大維持負荷（pps） | 低いrateから連続してHTTP基準を満たした、実送信ppsの中央値。3条件の主結果 |
| HTTP成功率 | 負荷中のGETが成功した割合。99%以上が合格 |
| HTTP p95 latency | 遅い側5%の境目。100ms以下が合格 |
| 負荷到達率 | 目標ppsを送信側Piが本当に出せたか。90%未満は「測定不成立」 |
| CPU busy | サービス限界が動いた理由を読む補助指標 |
| NET_RX softirq | Linuxが行った受信処理量を読む補助指標 |
| Application到達率 | 指定した場所で実際にUDPを止められたかの確認 |

各rate・各停止位置を3回ずつ測ります。条件の開始位置を反復ごとに回し、
rateは昇順と降順を交互にして、熱や実行順の偏りを減らします。
Piの型、kernel、interface、MTU、CPU governor、XDP attach modeもrunへ保存します。
高いrateで送信側Piが先に限界へ達した場合は、受信側サービスの限界として扱いません。

## デモの見方

Dashboardはスクロールせず、4画面を順に追います。

1. Applicationで捨てたときの負荷上限
2. nftablesで捨てたときの負荷上限
3. XDPで捨てたときの負荷上限
4. 3条件の最大維持負荷を比較

各条件の画面では、負荷を上げた6段階を「維持 / 限界超え / 測定不成立」で表示します。
最後の画面では、CPUの小ささではなく、HTTPが耐えた最大ppsを横並びにします。

## システム構成

```text
Pi A
  traffic-node
    ├─ UDP load generator ───────────────┐
    └─ repeated HTTP probe ──────────────┤
                                         v
Pi B                                 XDP → nftables → UDP socket
  experiment-runner ─ condition/rate切替、CPU・NET_RX・socket到達数を計測
  observation-hub ─── HTTP service / event集約 ───> Tauri dashboard
```

| component | 役割 |
| --- | --- |
| `xdp-hello/` | Rust + Ayaで書いたXDP programとloader |
| `tools/traffic-node/` | rate可変UDP負荷と約200ms間隔のHTTP probe |
| `tools/experiment-runner/` | rate sweep、3条件の切替、反復、計測、cleanup |
| `tools/observation-hub/` | HTTP service、event集約、dashboard配信 |
| `observation-core/` | sweep条件、HTTP集計、実測結果の共通Rust型 |
| `dashboard/` | Tauri / Reactの展示UI |

XDPのfull countはper-CPU BPF mapで数えます。RingBufは画面表示用sampleだけに使い、
packetごとのlogでbenchmarkを汚しません。

## 実機で動かす

必要なもの:

- Ethernet接続したRaspberry Pi 2台
- Linux、Rust toolchain、nftables
- Dashboard用のNode.jsとTauri prerequisites

自分が管理する隔離LANで実行してください。Step 1〜3は別terminalで起動したままにします。

<details>
<summary>起動コマンドを開く</summary>

### 1. Pi B: event hubとHTTP service

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

`auto`はnativeを先に試し、NICやdriverが非対応ならgenericへ切り替えます。
要求値ではなく、実際にattachできたmodeを結果へ保存します。

### 3. Pi A: traffic generator

```bash
cargo run --release --manifest-path tools/Cargo.toml -p traffic-node -- \
  --hub <PI_B_IP>:9001 \
  --target <PI_B_IP> \
  --defense-control <PI_B_IP>:9020 \
  --control-listen 0.0.0.0:9030 \
  --health-interval-ms 200
```

### 4. Pi B: experiment runner

`experiment-runner`はnftablesを操作するためroot権限が必要です。

```bash
sudo cargo run --release --manifest-path tools/Cargo.toml -p experiment-runner -- \
  --traffic-control <PI_A_IP>:9030 \
  --xdp-control 127.0.0.1:9020 \
  --hub 127.0.0.1:9001 \
  --interface eth0 \
  --pps-steps 500,2000,5000,10000,20000,50000 \
  --duration-secs 10 \
  --repetitions 3 \
  --service-min-success-percent 99 \
  --service-max-p95-ms 100 \
  --min-load-delivery-percent 90
```

### 5. Dashboard

```bash
cd dashboard
npm install
npm run tauri dev
```

</details>

計算式、実行順、判定方法、cleanupは
[実験プロトコル](docs/EXPERIMENT_PROTOCOL.md)にまとめています。

## 計測上の制約

- パケットぽいぽいは攻撃を検知する防御製品ではなく、停止位置の設計差を測る実験装置です。
- 現在のparserはEthernet上のIPv4を対象とし、IPv6、VLAN、fragment、IP optionsには対応していません。
- `generic` XDPと`native` XDPは同じ結果として混ぜません。
- CPU busyとNET_RXはbackground process、thermal throttling、NIC、driverの影響を受けます。
- 目標rateの90%を送れなかったrunは測定不成立とし、サービス維持限界へ含めません。
- pass / failが負荷順に並ばない場合は上限を断定せず、再測定します。
- rate sweepは試した段階の間にある厳密な限界値までは特定しません。
- 1台のPiで得た結果を、すべてのmachineやworkloadへ一般化しません。
- Control APIに認証はありません。外部へ公開しないでください。

## Dashboardだけ確認する

```bash
cd dashboard
npm install
npm run build:pages
npm run preview:pages
```
