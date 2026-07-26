# Packet Journey dashboard

同じUDP負荷をApplication / nftables / XDPで止めた実験を、4画面で追う展示UIです。

## 画面

1. Applicationまで届ける基準
2. nftablesで止める条件
3. XDPで止める条件
4. CPU / NET_RX softirq / userspace到達率の比較

HTTPは比較対象ではなく、負荷中もPi Bのserviceが応答するかを見るcanaryとして常に上部へ固定しています。

## GitHub Pages

```shell
npm install
npm run build:pages
npm run preview:pages
```

公開URL: https://suisan-neki.github.io/packet-journey/

Web buildはUI fixtureを再生します。badgeとfooterでfixtureであることを明示し、数値を実測として扱いません。

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
