# Packet Journey dashboard

同じ量の実験用通信を「アプリまで運ぶ・OSの途中で止める・LANの入口で止める」の3条件で比べる展示UIです。Application / nftables / XDPは、それぞれの技術上の条件名として併記します。

## 画面

1. アプリまで運ぶ（Application）
2. OSの途中で止める（nftables）
3. LANの入口で止める（XDP）
4. Piの仕事量、OSの受信処理、アプリ到達率を比較

HTTPは比較対象ではなく、負荷中もPi Bのserviceが応答するかを見るcanaryとして常に上部へ固定しています。

## GitHub Pages

```shell
npm install
npm run build:pages
npm run preview:pages
```

公開URL: https://suisan-neki.github.io/packet-journey/

Web buildは画面確認用のサンプルデータを再生します。badgeとfooterでサンプルであることを明示し、数値を実測として扱いません。

## Tauri / live

```shell
npm run tauri dev
```

Tauri版は`127.0.0.1:9010`のNDJSON streamを購読します。各条件3回分の`experiment_run`がそろうと比較画面へ進みます。

## Port

| port | role |
| --- | --- |
| 9000 | xdp-hello event stream |
| 9001 | traffic-node / experiment-runner ingest |
| 9010 | dashboard stream |
| 8080 | HTTP canary |
| 9020 | XDP mode control |
| 9030 | traffic-node load control |
