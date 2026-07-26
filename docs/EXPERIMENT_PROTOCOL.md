# Drop-point comparison protocol

## 問い

同じUDP負荷をApplication / nftables / XDPで破棄したとき、Raspberry Pi Bの処理量はどう変わるか。

## 固定条件

- sender: Raspberry Pi A
- receiver: Raspberry Pi B
- protocol: IPv4 / UDP
- destination port: 4000
- default target: 2,000 pps
- payload: 128 bytes
- duration: 15 seconds
- repetitions: 3
- HTTP canary: Pi AからPi Bの`GET /api/ping`

CLIで値を変えた場合、各`experiment_run`へ実値を保存します。

## 条件

### Application

- XDP: monitor / pass
- nftables experiment table: absent
- UDP socket: runnerがbindして全受信をcount

### Netfilter

- XDP: monitor / pass
- nftables: `inet packet_journey`のinput hookでUDP :4000をdrop
- UDP socket:同じsocketを維持し、到達しないことをcount

### XDP

- nftables experiment table: absent
- XDP: protect、UDP :4000を`XDP_DROP`
- attach mode: native / genericをrunへ保存

## 実行順

固定順による温度・cache・時間経過の偏りを減らすため、開始位置を反復ごとに回します。

| repetition | 1番目 | 2番目 | 3番目 |
| --- | --- | --- | --- |
| 1 | Application | Netfilter | XDP |
| 2 | Netfilter | XDP | Application |
| 3 | XDP | Application | Netfilter |

本格評価では、反復数を増やしたrandomized orderも検討します。

## 指標

### CPU busy

`/proc/stat`のaggregate CPU行を条件開始・終了で読み、counter差分から算出します。

```text
busy% = (delta_total - delta_idle) / delta_total × 100
```

### NET_RX softirq

`/proc/softirqs`の`NET_RX`を全CPUで合算し、条件前後の差を取ります。送信packet数がわずかにずれても比べられるよう、dashboardでは1万packetあたりへ正規化します。

### Application receive

同じUDP socketの受信counterを条件前後で差分にします。

### HTTP canary

サービスが生きているかを見る補助指標です。UDPや停止位置との優劣比較には使いません。

## benchmarkを汚さないための処置

- eBPF hot pathでpacketごとの`aya_log`を出さない
- full countはper-CPU BPF map
- RingBufは画面用sampleであり、packet総数に使わない
- cumulative counterをrun結果として使わない
- fixtureと実測streamをbadgeで区別する

## cleanup

runnerは自分専用の`inet packet_journey` tableだけを操作します。通常終了時とdrop時に削除を試み、XDPをmonitorへ、traffic-nodeをstopへ戻します。

異常終了後は次で確認できます。

```bash
sudo nft list table inet packet_journey
sudo nft delete table inet packet_journey
```

## 解釈上の制約

- 1つのPi model / kernel / NIC / driverの結果を一般化しない
- generic XDPとnative XDPを混ぜない
- Wi-FiとEthernetを混ぜない
- thermal throttling、CPU governor、background processを記録する
- target rateだけでなく実送信数を分母にする
- 結論は「XDPは常に最速」ではなく、得られたrunの中央値から述べる
