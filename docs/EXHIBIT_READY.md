# 展示完成までの残り作業

展示本番では Raspberry Pi を常時稼働させず、前日に取得した実測値をUIで再生する。
Pi A / Pi B は「実験に使った機器」として簡素に展示する。

## 明日やること

1. Pi A / Pi B を接続し、正式な実験を完走する。
2. XDP / Netfilter / Application の各条件で以下を確定する。
   - max maintained pps
   - CPU busy %
   - HTTP latency p95
   - HTTP success %
3. `dashboard/src/app/exhibitData.ts` を更新する。
   - `source: "sample"` → `source: "measured"`
   - `measuredAt` に測定日を入れる
   - 3条件の値を実測値へ差し替える
4. Dashboard を起動し、1 / 2 / 3 のキーで最後までデモが流れることを確認する。

## 展示ストーリー

1. 3つの停止位置から選ぶ。
   - 1: XDP
   - 2: Netfilter
   - 3: Application
2. 同じUDP負荷を段階的に上げた実測結果を再生する。
3. Webサービスが維持できた最大ppsを比較する。
4. 「じゃあ全部XDPで止めればいい？」と問い返す。
5. HTTPSでは入口からURL・認証状態・sessionなどをそのまま使えないことを示す。
6. Applicationまで来ると判断材料が増えることを示す。
7. 「どこで見るかで、できる判断が変わる。だからネットワークって面白い。」で終える。

## 物理ボタン

Dashboard はキーボードの `1` / `2` / `3` で各デモを開始できる。
そのため、物理ボタン側は最終的にこの3キーを送るだけでよい。

一番簡単な構成は Raspberry Pi Pico を USB HID keyboard として使う方法。

- ボタン1 → `1`
- ボタン2 → `2`
- ボタン3 → `3`
- 各ボタンは GPIO と GND 間へ接続し、内部 pull-up を使う

展示UIと実験系を分離することで、当日のPi起動失敗が展示そのものの停止につながらない構成にする。

## 展示する実機

Pi A / Pi B は電源を入れず、説明札だけ付ける。

- Pi A: 送る側。実験用UDP負荷とHTTP probeを生成した機器
- Pi B: 受ける側。XDP / Netfilter / Application の停止位置を比較した機器

可能なら2台をLANケーブルで接続した状態で置き、「この2台で実測した」と分かるようにする。
