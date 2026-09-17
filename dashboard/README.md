# パケットぽいぽい 展示UI

説明スライドの構図を使った展示画面です。Pi A／Pi Bの基板画像、双方向の矢印、受信側の処理順、天秤と3条件の結果を同じ画面に配置します。画像は提供スライドから切り出して同梱し、表示時の外部アクセスを不要にしています。

## Macから実機に接続

Pi Bのobservation-hubを起動してから、**Macのターミナル（SSH先ではない方）**で実行します。

```sh
cd ~/packet-poipoi/dashboard
npm install
PACKET_POIPOI_STREAM_ADDR=192.168.50.20:9010 npm run tauri dev
```

Tauri版は既存のNDJSON購読処理を利用します。stats.ppsはPi Bの受信観測値です。Pi Aの実送信量には使いません。実送信量はexperiment_runの送信数と実測時間から計算します。送信中のattack_state.ppsは「送信設定」です。

- 接続済みでも結果がなければ「実験待ち」。背景通信だけで実験中にしません。
- monitorだけではNetfilterとApplicationを特定できません。現在の停止位置を推測表示せず、結果到着後に「直前の結果」として示します。
- 結果カードは説明図を切り替える操作です。実機の設定は変わりません。物理ボタンの実験開始機構は別途必要です。
- 5秒間データが来なければ接続の確認を促し、古いHTTP成功を現在の成功として表示し続けません。
- 接続通知が購読開始前に届いた場合でも、実データの受信で接続済み表示へ戻ります。

## XDPの位置

stats.attach_modeに従って図を変えます。

- generic：NIC → Linuxの受信処理・skb生成 → XDP → Netfilter input → ソケット → 実験用アプリ
- native：NIC → XDP（NICドライバ内）→ Linuxの受信処理 → Netfilter input → ソケット → 実験用アプリ

NetfilterはLinuxのネットワーク処理に含まれる介入基盤です。nftablesはルールの設定側であり、別の通過地点には描きません。HTTPサービスは同じPi Bで動く別のアプリです。UDP負荷の受け取り先とHTTPサービスを同一アプリとして描きません。

参考： https://docs.ebpf.io/linux/program-type/BPF_PROG_TYPE_XDP/

## 結果の読み方

必要な反復が揃った段階だけを評価します。目標送信量未達、XDPモード混在、計画の不一致、低負荷で失敗して高負荷で成功する結果は上限値として採用しません。最上段まで維持できた場合は「以上」を付け、真の限界を測れたとは表現しません。

天秤は設計上の問題意識です。現在の実験はUDP :4000を事前に破棄対象としており、誤遮断率や判定精度は実測していません。停止位置から安全性や精度の得点を作ったり、天秤を実測値のように傾けたりしません。

## Web版とテスト

```sh
npm test
npm run check
npm run build:pages
npm run preview
```

Web版は説明用サンプルで、実測値ではない旨を上部へ表示します。buildは集計テストとTypeScriptチェックを実行します。新たな依存パッケージは追加していません。

横長の展示画面を基本とし、狭い画面では縦に並べます。動きを減らすOS設定にも対応します。

## Pi Aを用意する前の接続リハーサル

Macを送信役にする接続確認です。Pi Aの実測結果とは混ぜず、負荷の上限を調べる目的にも使いません。MacとPi Bを手元の隔離Ethernetで接続したまま行います。施設のWi-Fiへ負荷を送らないでください。

Pi Bのobservation-hubとxdp-helloを起動し、UDP :4000を待ち受けている手動のncはCtrl+Cで終了しておきます。Dashboardも先に起動してください。

**Macの別ターミナル**で送信役を起動します。起動だけではUDP負荷を開始しません。

```sh
cd ~/packet-poipoi
cargo run --release --manifest-path tools/Cargo.toml -p traffic-node -- --node-id mac-rehearsal --hub 192.168.50.20:9001 --target 192.168.50.20 --defense-control 192.168.50.20:9020 --control-listen 192.168.50.30:9030
```

**Pi BへSSHしたターミナル**で低負荷・短時間の3条件を1回ずつ実行します。Macのファイアウォールが接続を確認した場合は、この管理下の実験LANに対する接続だけを許可します。

```sh
sudo ~/packet-poipoi-bin/experiment-runner --traffic-control 192.168.50.30:9030 --xdp-control 127.0.0.1:9020 --hub 127.0.0.1:9001 --udp-listen 192.168.50.20:4000 --interface eth0 --pps-steps 500 --duration-secs 3 --repetitions 1
```

3つの結果が届くこと、終了後にUDP送信が止まること、同じ操作をもう1回できることを確認します。これはリハーサル手順であり、Mac実機での完走確認を済ませたという意味ではありません。

## 本番までに別途確認すること

物理ボタンの接続、起動操作の一本化、電源を切った状態からの再現試験は、このUI変更だけでは完了しません。依存関係のダウンロードやビルドを会場で行わずに済む起動方法を用意し、会場ネットワークなしで繰り返し確認します。

## 使用ポート

| ポート | 用途 |
| --- | --- |
| 9000 | xdp-helloのイベント配信（Pi B内） |
| 9001 | traffic-node / experiment-runnerのイベント受信 |
| 9010 | Macへの画面用データ配信 |
| 8080 | HTTPサービス /api/ping |
| 9020 | XDPの動作モード制御 |
| 9030 | traffic-nodeの送信制御 |
