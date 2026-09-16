# 実機へ進む前の理解パス

この文書は、Raspberry Piを起動する前に「何が起きる実験なのか」を自分で説明できる状態まで進むためのものです。

目的はコードを全部暗記することではありません。
**データの流れ、制御の流れ、何を測っているか、どこで失敗するか**を自分の言葉で追えることを目標にします。

## 到達点

実機へ進む前に、次を説明できれば十分です。

- Pi AとPi Bがそれぞれ何を担当するか
- HTTPとUDPをなぜ同時に使うか
- Application / nftables / XDPで捨てる違い
- `experiment-runner` が1 runで何をしているか
- target ppsとactual ppsを分ける理由
- CPU busyとNET_RXを主結果にしていない理由
- XDP native / genericを混ぜない理由
- cleanupとrollbackが同じではない理由
- packet-poipoiで得た何を、現在のAKATSUKIへ持ち帰れそうか

## Phase 1: まず通信の道だけ理解する

読むもの:

1. `README.md` の「30秒でわかる実験」
2. `README.md` の「3つの捨てどころ」
3. `docs/EXPERIMENT_PROTOCOL.md` の「問い」「条件」

最初はコードを読みません。

理解したい図はこれだけです。

```text
Pi A
  ├─ UDP load ────────────────┐
  └─ HTTP probe ──────────────┤
                              v
Pi B
  NIC → XDP → network stack → nftables → UDP socket
                              └────────→ HTTP service
```

ここで区別します。

- UDP: 実験用に量を増減する刺激
- HTTP: 守りたいサービスの状態を見るprobe

### 自分で答える問い

- UDPを大量に送るだけでは、なぜ「サービスが壊れた」と判断できないか
- HTTP probeだけでは、なぜ3つの破棄位置の差を作れないか
- XDPはApplicationより何を省略できるか

## Phase 2: control pathを追う

読むもの:

1. `tools/experiment-runner/src/main.rs`
2. `tools/traffic-node/src/main.rs` のcontrol server部分
3. `xdp-hello/xdp-hello/src/main.rs` のcontrol server部分

この段階では各関数の細部より、誰が誰へ命令しているかを追います。

```text
experiment-runner (Pi B)
   │
   ├── Pi A traffic-nodeへ
   │      start / stop / status
   │
   ├── Pi B xdp-helloへ
   │      monitor / protect
   │
   └── Pi Bのnftablesを直接操作
```

`experiment-runner` が実験の司令塔です。
Dashboardは実験条件を決める司令塔ではありません。

### 自分で答える問い

- なぜtraffic-nodeをPi Aに分けるのか
- なぜnftablesはrunnerが直接操作し、XDPはcontrol API経由なのか
- runnerが途中で落ちたとき何が残る可能性があるか

## Phase 3: 1 runを時間順に追う

中心に読む関数:

- `run_experiment`
- `run_condition`
- `configure_drop_point`

紙やメモに次を書きます。

```text
1. condition設定
2. settle
3. before snapshot
4. load start
5. 計測
6. load stop
7. after snapshot
8. 差分計算
9. validate
10. publish
```

重要なのは、CPUやNET_RXの値そのものではなく**before / afterの差分**をrunへ入れていることです。

### 自分で答える問い

- condition変更直後にsettle timeを置く理由
- UDP停止後にHTTP probeの完了を少し待つ理由
- cumulative counterをそのまま結果にしない理由

## Phase 4: 「結果」の意味を理解する

読むもの:

1. `observation-core/src/experiment.rs`
2. `docs/EXPERIMENT_PROTOCOL.md` の「主結果」「Actual send rate」

ここで初めて型を読みます。

特に見る型:

- `DropPoint`
- `ExperimentEnvironment`
- `ServiceHealthSummary`
- `SweepPlan`
- `ExperimentRun`

### 主結果

packet-poipoiの主結果はCPU使用率ではありません。

```text
HTTP success >= threshold
AND
HTTP p95 <= threshold
```

を維持できた最大の実送信ppsです。

### targetとactual

```text
target pps
  = Pi Aへ要求した値

actual pps
  = 実際に送信できたpacket数 / 実計測時間
```

Pi A自身が50000ppsを出せなかった場合、それをPi Bの限界と呼ばないために分けています。

### 自分で答える問い

- なぜtarget ppsだけでは不十分か
- CPU 100%に近くてもHTTPが維持できていたらどう扱うか
- HTTPが壊れていないのにCPUが低いことを主結果にできるか

## Phase 5: XDPとnftablesの違いを理解する

読むもの:

1. `xdp-hello/xdp-hello-ebpf/src/main.rs`
2. `xdp-hello/xdp-hello-common/src/lib.rs`
3. `experiment-runner` のnftables設定部分

全部のeBPF文法を理解する必要はありません。

見るポイントは、packetがLinuxのどの位置まで進んだ後に捨てられるかです。

```text
NIC
 ↓
XDP            ← ここでdrop可能
 ↓
network stack
 ↓
nftables       ← ここでdrop可能
 ↓
UDP socket
 ↓
Application    ← ここで読み捨て
```

### native / generic

XDPは同じコードでもattach方法によって通る経路が異なります。
そのためpacket-poipoiではnativeとgenericを同じ条件として混ぜません。

### 自分で答える問い

- XDPでURLやlogin userを見て判断しにくいのはなぜか
- nftablesがApplicationより早く捨てられるのはどの処理を省けるからか
- XDP nativeとgenericを混ぜると比較が崩れるのはなぜか

## Phase 6: cleanupを読む

読むもの:

- `experiment-runner` の終了処理
- `NftGuard`
- `scripts/pi-start.sh` のstop処理

現在のcleanup対象は主に、

- 実験用nftables table
- XDP mode
- traffic generator

です。

ここでは、cleanupと「本当に元へ戻ったことを確認すること」を区別します。

```text
cleanup
  操作した設定を戻そうとする

rollback verification
  実行前状態と比較し、本当に元へ戻ったことを確かめる
```

packet-poipoiは前者を持っていますが、後者はまだ十分ではありません。
この区別は、現在のAKATSUKIで可逆性を考えるときにも重要になります。

### 自分で答える問い

- cleanupコマンドが成功したら必ず元通りと言えるか
- processやfileを実験対象にした場合、何を保存しないとrollbackを確認できないか

## Phase 7: 現在のAKATSUKIとの関係を整理する

最後に `docs/AKATSUKI_BRIDGE.md` を読みます。

packet-poipoiは、現在のAKATSUKIをそのまま小さく実装したものではありません。
AKATSUKIの旧構想から、低レイヤで通信を観測し、介入位置を変えて比較する部分を切り出して技育博向けに発展させたスピンオフです。

そのため、この段階で考えるのは「packet-poipoiをどうAKATSUKIへ一般化するか」ではなく、
**今回の実装で得たどの技術・設計経験を、現在のAKATSUKIへ持ち帰れそうか**です。

候補は次です。

```text
packet-poipoiで得るもの
  ├─ Rust / AyaでeBPFをload・制御する経験
  ├─ kernel側の計測値をuserspaceへ回収する経験
  ├─ experiment-runnerによる実験手順の自動化
  ├─ 条件・実測値・環境情報を分けて記録する設計
  ├─ observation-hub / event streamによる観測結果の集約
  └─ cleanupを実験ライフサイクルへ組み込む設計

現在のAKATSUKI
  └─ OSレベルの実行時挙動と、生じた変更・影響範囲・可逆性を評価する基盤
```

一方で、次はpacket-poipoi固有のものとして扱います。

- XDP / Netfilter / Applicationのどこで通信を止めるかという問い
- UDP負荷そのもの
- traffic-nodeを使ったネットワーク負荷生成
- 「早く介入するか、後まで見て判断するか」をAKATSUKI全体の中心命題にすること

共通基盤を先に決めません。
現在のAKATSUKIで別の具体的な実験を作ったとき、packet-poipoiと本当に共通していた部分だけを抽出します。

### 自分で答える問い

- packet-poipoiの問いそのものと、再利用できそうな実装経験を分けて説明できるか
- XDPのdrop処理を持ち込まなくても、eBPF/Ayaの経験がAKATSUKIで役立つのはなぜか
- `experiment-runner` のどの考え方なら、network以外の実験でも使えそうか

## 実機へ進んでよい条件

次の問いに、自分の言葉で短く答えられればbring-upへ進みます。

1. packet-poipoiでは何を変えて、何を固定して比較するのか
2. Pi AとPi Bを分ける理由は何か
3. 3つのdrop pointはLinuxのどこにあるか
4. `experiment-runner` の1 runを時間順に説明できるか
5. target ppsとactual ppsの違いは何か
6. 主結果がCPU使用率ではないのはなぜか
7. cleanupとrollback verificationの違いは何か
8. packet-poipoiの問いそのものではなく、何を現在のAKATSUKIへ持ち帰れそうか

全部を完璧に答える必要はありません。
分からない箇所が特定できた状態なら、そこを確認してから実機へ進みます。
