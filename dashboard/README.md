# パケットぽいぽい dashboard

Application / nftables / XDPの各条件でUDP負荷を段階的に上げ、
同じRaspberry Pi上のHTTP serviceが維持できた最大ppsを比べる展示UIです。

## 4画面

1. Applicationで捨てたときの負荷上限
2. nftablesで捨てたときの負荷上限
3. XDPで捨てたときの負荷上限
4. HTTP成功率99%以上かつp95 100ms以下を維持できた最大ppsを比較

各条件画面の中心は、500 → 50,000 ppsの負荷レールです。
それぞれのrateを「維持 / 限界超え」で示し、最後に最大pass rateを横並びにします。
CPUとNET_RXは勝敗ではなく、限界が動いた理由を読む補助指標です。

## GitHub Pages

```shell
npm install
npm run build:pages
npm run preview:pages
```

公開URL: https://suisan-neki.github.io/packet-poipoi/

Web buildは画面説明用のサンプルデータを再生します。
badgeとfooterでサンプルであることを明示し、実測値として扱いません。

## Tauri / live

```shell
npm run tauri dev
```

Tauri版は`127.0.0.1:9010`のNDJSON streamを購読します。
各drop point・各rateで`SweepPlan.repetitions`ぶんのrunがそろうと比較画面へ進みます。

## Port

| port | role |
| --- | --- |
| 9000 | xdp-hello event stream |
| 9001 | traffic-node / experiment-runner ingest |
| 9010 | dashboard stream |
| 8080 | HTTP service |
| 9020 | XDP mode control |
| 9030 | traffic-node load control |
