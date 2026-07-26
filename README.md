# PACKET JOURNEY

**同じ入口へ負荷が来ても、必要なサービスを守れるか。**

Packet Journeyは、2台のRaspberry PiとeBPF/XDPを使ったライブネットワーク実験です。

Pi AからPi Bへテスト用のUDP負荷を送りながら、同じPi B上のHTTPサービスへGETを続けます。Pi Bでは、NIC直後で動くXDPプログラムが指定UDPだけを破棄します。画面では「何packet捨てたか」だけでなく、負荷中も同じHTTPサービスが応答したかまで確認します。

**Webデモ:** https://suisan-neki.github.io/packet-journey/

Webデモの数値は実機出力のサンプルです。Tauri版では、2台のRaspberry PiとXDPから届くイベントだけで画面が進みます。

## 何を比べているのか

UDPとHTTPの性能や安全性を比べる実験ではありません。

| 通信 | この実験での役割 | 取得元 |
| --- | --- | --- |
| UDP :4000 | 意図的に加えるテスト負荷 | Pi Aの`traffic-node` |
| HTTP :8080 | サービスが動き続けているか測る指標 | Pi Aの実HTTP GET |

UDP :4000は、展示用ポリシーで遮断対象に指定しています。UDP一般を危険な通信として扱うものではありません。

## デモの流れ

画面はスクロールせず、同じ通信経路を4段階で追います。

1. **通常時を測る**  
   負荷を加える前に、HTTP :8080のstatusとレイテンシを記録します。
2. **負荷を重ねる**  
   HTTPを測り続けたまま、同じPi BへUDP :4000の負荷を加えます。
3. **入口で分ける**  
   XDPが指定UDPをnetwork stackやアプリへ届く前に`XDP_DROP`します。HTTPは通過します。
4. **前後を比べる**  
   通常時と負荷中で、同じHTTP GETの結果を比較します。

Webデモは自動再生され、各段階をクリックして止めることもできます。実機版は`traffic_health`、`attack_state`、`defense_mode`、`stats`イベントに同期します。

## 実測値の出どころ

画面の結論は、演出用タイマーではなく次のイベントから組み立てます。

| 画面上の値 | イベント / 実装 |
| --- | --- |
| UDP送信量 | `traffic-node`の`attack_state.pps` |
| HTTP status / latency | 1秒ごとの`traffic_health` |
| XDP_PASS / XDP_DROP | per-CPU BPF mapを500msごとに合算した`stats` |
| MONITOR / PROTECT | XDPの実行時設定と`defense_mode` |
| 個別packet | RingBufから配信する`flow` |

RingBufは個別packetの表示経路です。混雑時の集計値はRingBufの受信数ではなく、カーネルのper-CPU counterを正とします。

## 構成

```text
Raspberry Pi A
  traffic-node
    ├─ HTTP GET :8080 ───────────────┐
    └─ UDP load :4000 ───────────────┤
                                      ▼
Raspberry Pi B                    NIC / XDP
  HTTP service :8080  ◀── PASS ─── TCP
  application         ×── DROP ─── UDP :4000
                                      │
                                      ├─ flow / stats :9000
                                      └─ control API :9020

traffic-node ── health / attack state :9001 ──┐
XDP events ────────────────────────────────────┤
                                              ▼
                                      observation-hub :9010
                                              │
                                              ▼
                                      Tauri dashboard
```

### 主な実装

| パス | 役割 |
| --- | --- |
| `xdp-hello/` | Rust + AyaによるXDP/eBPFプログラム、per-CPU counter、実行時モード切替 |
| `observation-core/` | NDJSONイベント型と上流イベントの解釈 |
| `tools/traffic-node/` | HTTPヘルスチェック、UDP負荷生成、XDP制御 |
| `tools/observation-hub/` | 上流イベントを統合してダッシュボードへ配信 |
| `dashboard/` | Tauri / Reactによる展示画面、GitHub Pages用サンプル |

## 操作

Pi Aの`traffic-node`では、標準入力から次の操作を行います。

```text
attack   UDP負荷を開始
stop     UDP負荷を停止
monitor  XDPを観測モードへ変更
protect  XDPを防御モードへ変更
status   現在の送信状態を表示
quit     終了
```

起動例:

```bash
cargo run --release --manifest-path tools/Cargo.toml -p traffic-node -- \
  --hub 192.168.1.20:9001 \
  --target 192.168.1.20 \
  --defense-control 192.168.1.20:9020
```

Pi B:

```bash
cargo run --release --manifest-path xdp-hello/Cargo.toml -p xdp-hello -- \
  --iface eth0 \
  --listen 0.0.0.0:9000 \
  --control-listen 0.0.0.0:9020 \
  --defense-mode monitor \
  --blocked-udp-port 4000
```

ダッシュボード:

```bash
cd dashboard
npm install
npm run tauri dev
```

GitHub Pages用:

```bash
cd dashboard
npm install
npm run build:pages
```

## まだ実装していないこと

- 3Dプリンタ製の物理コントローラから`attack / protect / stop`を操作するGPIOアダプタ
- 通常時と負荷中の計測を一つの実験IDで保存する機能
- 複数の負荷条件やXDPポリシーを選ぶ比較実験

物理コントローラは既存のcontrol APIを呼ぶ構成を想定しています。現時点の実装はCLI操作までです。
