# 3D printed packet path

## 目的

3D printerで筐体を豪華にするのではなく、Linuxの受信経路を手で追える物理interfaceにします。

観客は最初に停止位置を予想し、実験中はLEDがどこまで進んだかを見て、最後にdashboardのCPU / NET_RXと照合します。

## 構成

```text
Pi A / traffic
      │
      ▼
[ NIC ]—[ XDP ]—[ network stack ]—[ nftables ]—[ UDP socket ]
            ▲                              ▲              ▲
         stop 3                         stop 2          stop 1
```

- Pi A: traffic generator、HTTP canary
- Pi B: XDP、nftables、UDP sink、計測
- path block: NIC / XDP / network stack / nftables / UDP socket
- input button: Application / nftables / XDPの予想
- status LED: 到達したblockをteal、停止位置をrust、未到達を消灯

## 造形ルール

- blockは同じ外形にし、技術の優劣を形状で誘導しない
- labelは日本語の役割を大きく、固有名詞を小さくする
- cableが入るNIC側を物理的な入口として左端へ固定する
- XDPを「Piの外」に置かず、Pi Bの入口blockとして置く
- caseを開けなくてもPi A / Pi B、電源、Ethernetを交換できる
- LED diffuserと電子部品を別partにし、再printを減らす

## UIとの同期protocol

dashboardと物理装置は同じ状態名を使います。

| state | 点灯 |
| --- | --- |
| `application` | NIC → XDP → stack → nftables → UDP socket、socketを停止色 |
| `netfilter` | NIC → XDP → stack → nftables、nftablesを停止色 |
| `xdp` | NIC → XDP、XDPを停止色 |
| `compare` | 3つの停止位置を順にpulse |

packetごとの正確なLED表示はしません。LEDは現在の実験条件を表し、packet countはkernel counterから取得します。展示演出と計測値を混ぜないためです。

## 最小prototype

1. 5つの紙labelと既存LEDでpathを机上に置く
2. dashboardのphase切替とLED stateを同期する
3. 観客5人に、説明なしで入口と停止位置を指せるか確認する
4. 読めないlabelと間隔を直してから造形する
5. 最後に3D printする

## 完成条件

- 3m離れても「同じ道の途中で止まる」ことが分かる
- 初学者が30秒以内にNIC側からApplication側を指でたどれる
- engineerがXDPとnftablesの位置関係を誤解しない
- 物理装置がなくてもdashboardとrecordingだけで発表を完走できる
- dashboardがなくてもblockだけで3条件を説明できる
