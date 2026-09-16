# AKATSUKI への接続

packet-poipoi は、AKATSUKIで作ろうとしている基盤そのものではありません。
**低レイヤを観測しながら条件を変えて安全に試すための、最初の具体的な実験系**として扱います。

## 上位の問題意識

AKATSUKIで扱いたいのは、生成AIなどによってソフトウェアを作ること自体は容易になった一方で、
そのソフトウェアを安全に実行・運用できるかを確かめる負担が残っている問題です。

最終的には、次の流れを一つの基盤として扱える状態を目指します。

```text
状態を観測・保存する
        ↓
実行条件と許可範囲を決める
        ↓
ソフトウェアを試す
        ↓
実行中・実行後の変化を観測する
        ↓
危険な操作は止める
        ↓
元に戻せるか確認し、必要なら rollback する
        ↓
何を行い、なぜ止めたかを記録する
```

packet-poipoi が現在扱うのは、このうち主に **観測・条件切替・介入・cleanup** です。

## packet-poipoi を「実験01」として見る

現在の問いは具体的です。

> 同じ不要UDP通信を Application / nftables / XDP のどこで破棄するかによって、Pi B上のHTTPサービスが維持できる負荷上限はどこまで変わるか。

この問い自体をAKATSUKI全体へ一般化しません。

一方で、問いを実験へ落とすために作った仕組みには再利用できる部分があります。

| packet-poipoi | 現在の役割 | AKATSUKIでの読み替え |
| --- | --- | --- |
| `tools/traffic-node/` | 再現可能なUDP負荷とHTTP probeを与える | stimulus / workload driver |
| `tools/experiment-runner/` | 条件切替、計測、反復、cleanupを順序立てて実行する | trial orchestrator |
| `observation-core/` | 条件・実測値・環境情報を型として残す | evidence / observation schema の原型 |
| `xdp-hello/` | XDPで通信を観測・破棄する | network observer / guard の一実装 |
| nftables制御 | 中間層で通信を破棄する | network guard の一実装 |
| `observation-hub/` | イベントを集約し、HTTP serviceとDashboardへ流す | observation/event hub |
| Dashboard | 実験状態と結果を人が読む | operator view |

この対応関係を保てる限り、packet-poipoiで得た実装経験をAKATSUKIへ持ち込めます。

## すでに使える設計

### 1. configure → observe → execute → observe → cleanup

`experiment-runner` は各runで、おおむね次の順に処理します。

```text
破棄条件を設定
↓
settle
↓
CPU / NET_RX / application counter を記録
↓
負荷を開始
↓
HTTP service を観測
↓
負荷を停止
↓
差分を集計
↓
結果をvalidateしてpublish
↓
XDP / nftables / trafficをcleanup
```

これはAKATSUKIで必要になる trial lifecycle に近い形です。

### 2. 要求値ではなく実測値を残す

packet-poipoiでは target pps だけを信用せず、実送信ppsを計算します。
XDPも要求したattach modeではなく、実際の native / generic をrunへ保存します。

AKATSUKIでも同じ考え方を使います。
「こう設定した」ではなく、「実際に何が起きたか」を証拠として残します。

### 3. cleanupを正常系以外でも行う

`experiment-runner` は正常終了だけでなく error / SIGINT でも、

- 実験用nftables tableの削除
- XDPをmonitorへ戻す
- traffic generatorの停止

を試みます。

現時点ではこれは rollback そのものではありません。
ただし「試した後に状態を戻す責任をrunnerが持つ」という設計は、その原型として残します。

## まだAKATSUKIには足りないもの

packet-poipoiの現在の型やrunnerを、そのまま汎用基盤として扱わないでください。
不足しているものがあります。

### 実行前状態のsnapshot

現在はCPUやNET_RXなどの計測開始値を持ちますが、
ファイル、process、service、DBなどの状態を復元可能な形では保存していません。

### rollbackの検証

cleanupコマンドを実行したことは確認できますが、
「実験前と同じ状態まで戻ったか」はまだ確認していません。

AKATSUKIでは、操作したことと元へ戻ったことを分けて扱います。

### 汎用的なobserver

現在の主な観測対象はnetworkとCPUです。
今後は少なくとも次を候補にします。

- process起動・終了
- filesystem変更
- network接続
- resource使用量
- service状態

どこまで実装するかは、具体的な実験を通じて決めます。

### policy / irreversible operation guard

現在もtraffic-nodeにはpublic networkへ高pps通信を送らないguardがありますが、
「この操作は実行してよいか」を一般的に判定する層はありません。

AKATSUKIでは、観測可能・rollback可能な操作と、不可逆または外部影響が大きい操作を区別する必要があります。

### action journal / reason

何を実行したかというログに加え、
なぜその操作を許可・拒否したかを後から読める形で残す必要があります。

## 今は汎用化しないもの

理解する前に次を実施しません。

- `DropPoint` を抽象的な万能enumへ置き換える
- `ExperimentRun` に将来必要そうなfieldを大量追加する
- `experiment-runner` を先に巨大なframeworkへする
- XDP / nftablesを無理に同じtraitへ押し込む
- packet-poipoi repoをAKATSUKI本体へ改名する

packet-poipoiで一度、実機上の因果関係と失敗の仕方を理解します。
その後、2つ目の実験を追加するときに共通部分を抽出します。

## 次の発展

packet-poipoiの実測後、AKATSUKIへ進む最初の候補は次です。

```text
Experiment 01: network load / drop point
    packet-poipoi

Experiment 02: process + filesystem change
    小さなプログラムを実行
    ↓
    process / file changeを観測
    ↓
    実行前後の差分を記録
    ↓
    cleanup後に状態が戻ったか確認

Experiment 03: isolated trial + rollback
    VM / snapshot等を使い
    より強い可逆性を持たせる
```

Experiment 02を作る段階で、Experiment 01と本当に共通だった部分をAKATSUKI側のcoreとして抽出します。

## 判断基準

packet-poipoiへ今後変更を加えるときは、次を確認します。

- 実験固有の問いが明確なままか
- 条件と実測値を区別して保存しているか
- 実行前後で何が変化したか追えるか
- errorや中断後にも安全な状態へ戻そうとしているか
- cleanupを「rollback完了」と誤認していないか
- AKATSUKIの将来像を理由に、まだ必要でない抽象化を増やしていないか

この基準を満たす範囲で、packet-poipoiはAKATSUKIの実験基盤を考えるための実機教材として使います。
