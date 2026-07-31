# Service-limit sweep protocol

## 問い

Application / nftables / XDPのどこで指定UDPを破棄するかによって、
同じRaspberry Pi上のHTTP serviceが維持できる負荷上限はどこまで変わるか。

「早く捨てれば処理を省けるか」ではなく、停止位置の違いが利用者に見える
service limitへ与える効果量を測る。

## 固定条件

- sender: Raspberry Pi A
- receiver: Raspberry Pi B
- load: IPv4 / UDP、destination port 4000
- payload: 128 bytes
- default rate steps: 500 / 2,000 / 5,000 / 10,000 / 20,000 / 50,000 pps
- duration: 10 seconds per run
- repetitions: 3 per rate and drop point
- service probe: Pi AからPi Bの`GET /api/ping`、default interval 200ms
- service threshold: success rate >= 99%、p95 latency <= 100ms
- load validity: actual send rate >= 90% of target rate

CLIで値を変えた場合は、`SweepPlan`と`ServiceHealthSummary`へ実値を保存する。
runnerはPi Bのmodel、kernel、interface、MTU、CPU governorと、
XDPのactual attach modeもrunごとに保存する。

## 条件

### Application

- XDP: monitor / pass
- nftables experiment table: absent
- UDP socket: runnerがbindして全受信をcount

### Netfilter

- XDP: monitor / pass
- nftables: `inet packet_journey`のinput hookでUDP :4000をdrop
- UDP socket: 同じsocketを維持し、到達しないことをcount

### XDP

- nftables experiment table: absent
- XDP: protect、UDP :4000を`XDP_DROP`
- attach mode: native / genericをrunへ保存

## 1 runの手順

1. XDPとnftablesを対象条件へ切り替える
2. settle timeを置く
3. Pi BのCPU、NET_RX、UDP socket counterを取得する
4. Pi AのHTTP集計windowをresetし、指定rateでUDP送信を開始する
5. 負荷中に同じHTTP endpointを繰り返しprobeする
6. duration終了後にUDPを停止し、停止直前に始まったprobeの完了を待つ
7. 停止後に始まったprobeは除外し、送信数とHTTP集計を取得する
8. 実計測時間と送信数からactual ppsを計算し、目標rateを出せたか判定する
9. Pi Bのcounter差分と環境情報を`experiment_run`としてpublishする

HTTP probeがreset前に開始していた場合、generationが異なるため当該runへ混ぜない。

## 実行順

rateはrepetitionごとに方向を反転する。

| repetition | rate order |
| --- | --- |
| odd | 500 → 2k → 5k → 10k → 20k → 50k |
| even | 50k → 20k → 10k → 5k → 2k → 500 |

各rate内の停止位置も開始位置を反復ごとに回す。

| repetition | 1番目 | 2番目 | 3番目 |
| --- | --- | --- | --- |
| 1 | Application | Netfilter | XDP |
| 2 | Netfilter | XDP | Application |
| 3 | XDP | Application | Netfilter |

これは展示で実行可能な時間内に、単純な固定順による温度・cache・時間経過の偏りを
減らすためのcounterbalanceである。研究的評価では反復数を増やしたrandomized orderも検討する。

## 主結果

各runについて次を両方満たせば`service_maintained = true`とする。

```text
HTTP success % >= configured minimum
HTTP latency p95 <= configured maximum
```

同じrate・drop pointのrunは多数決でpass / failを決める。ただし、全runで
actual ppsがtarget ppsの設定割合以上に達したrateだけを有効とする。

`max maintained pps`は、最小rateから連続してpassした最後のrateにおける
actual ppsの中央値とする。途中でfailした後に高いrateがpassした場合は、
最大値だけを採用せず非単調な結果として再測定する。

rate sweepは離散値なので、真の限界は「最大pass rate以上、次のfail rate未満」の範囲にある。
結果では未計測の中間値を補間しない。

### Actual send rate

送信側Piの処理限界を、受信側サービスの限界と誤認しないために次を計算する。

```text
actual pps = packets sent / measured duration
load delivery % = actual pps / target pps × 100
```

defaultでは90%未満を`測定不成立`とし、service limitへ含めない。

## 補助指標

### HTTP latency p95

run内のlatencyを昇順に並べ、nearest-rank法の95 percentileを使う。
timeoutとHTTP 200以外はsuccessへ数えない。

### CPU busy

`/proc/stat`のaggregate CPU行をrun開始・終了で読み、counter差分から算出する。

```text
busy% = (delta_total - delta_idle) / delta_total × 100
```

### NET_RX softirq

`/proc/softirqs`の`NET_RX`を全CPUで合算し、run前後の差を取る。
dashboardでは実送信packet数で1万packetあたりへ正規化する。

### Application receive

同じUDP socketの受信counterをrun前後で差分にする。
停止条件が実際に適用されたことを確認する指標である。

## benchmarkを汚さないための処置

- eBPF hot pathでpacketごとの`aya_log`を出さない
- full countはper-CPU BPF map
- RingBufは画面用sampleであり、packet総数に使わない
- cumulative counterをrun結果として使わない
- fixtureと実測streamをbadgeで区別する
- target rateだけでなく実送信数を保存する
- 設定時間ではなくstart応答からstop応答までの実時間を保存する
- Pi model / kernel / interface / MTU / governorをrunへ保存する

## cleanup

runnerは自分専用の`inet packet_journey` tableだけを操作する。
通常終了時とerror時に削除を試み、XDPをmonitorへ、traffic-nodeをstopへ戻す。

異常終了後は次で確認する。

```bash
sudo nft list table inet packet_journey
sudo nft delete table inet packet_journey
```

## 解釈上の制約

- 捨てる対象はUDP destination portで事前に決められるものに限定する
- XDPはアプリの文脈を使う判定の代替ではない
- generic XDPとnative XDPを混ぜない
- Wi-FiとEthernetを混ぜない
- thermal throttling、CPU governor、background processを記録する
- 1つのPi model / kernel / NIC / driverの結果を一般化しない
- 結論は「XDPは常に最良」ではなく、得られたservice limitの範囲として述べる
