# AKATSUKI との関係

packet-poipoi は、現在のAKATSUKI構想をそのまま先行実装したものではありません。

もともとはAKATSUKIの旧構想で考えていた、
**低レイヤで状態を観測しながら、どの段階で介入するかを比較する**という発想を、
技育博で短期間に見せられるネットワーク実験として切り出したものです。

そのため、packet-poipoiの問いを現在のAKATSUKIへ無理に一般化しません。
一方で、今回作った低レイヤ観測や実験制御の技術資産には、現在のAKATSUKIへ持ち帰れる部分があります。

## 旧構想から切り出したもの

packet-poipoiでは、同じ通信をPi Bのどの段階で止めるかを比較します。

```text
Pi Aから通信を送る
        ↓
Pi Bで受信
        ↓
XDP / Netfilter / Application
のどこで止めるかを変える
        ↓
負荷・サービス状態・誤遮断などを比較する
```

ここでは、

- 早い段階で止めると処理負荷を抑えやすい
- 後段まで通すと判断材料を増やしやすい
- 必要な通信を残しながら不要な通信を止めるには、どこで判断するのがよいか

といった問いを扱います。

これは現在のAKATSUKIの中心命題ではありません。
**旧構想の一部を独立した実験として活かしたもの**として扱います。

## 現在のAKATSUKIで扱いたいこと

現在のAKATSUKIでは、
ソフトウェアが「何をするつもりか」ではなく、
**実際にOSやシステムへどのような影響を与えたか**を観測したいと考えています。

対象として想定しているのは、例えば次のような実行です。

```text
ソフトウェアを実行
        ↓
processを起動・終了した
fileを書き換えた・削除した
network connectionを張った
service状態を変えた
        ↓
どの変更がその実行によって生じたか
        ↓
影響範囲はどこまでか
        ↓
その変更は元に戻せるか
```

つまり中心にあるのは、
**OSレベルの実行時挙動を観測し、生じた変更と対応づけながら、影響範囲と可逆性を評価すること**です。

packet-poipoiの「どこで通信を止めるか」という問いそのものを、ここへ持ち込むわけではありません。

## packet-poipoiから持ち帰れそうなもの

現在のAKATSUKIへ再利用したいのは、ネットワーク実験固有の結論よりも、
**低レイヤを観測しながら実験を回すために作った基盤と実装経験**です。

| packet-poipoi | 現在の役割 | AKATSUKIで活かせそうな部分 |
| --- | --- | --- |
| `xdp-hello/` | XDP/eBPFでpacketを観測・処理する | Rust + Ayaでkernel側programをloadし、mapやeventをuserspaceへ回収する経験 |
| `tools/experiment-runner/` | 条件切替、計測、反復、cleanupを実行する | 実行前準備 → 実行 → 観測 → 評価 → cleanupというtrial lifecycle |
| `observation-core/` | 条件・実測値・環境情報を型として残す | evidence / observation schemaを考える土台 |
| `observation-hub/` | eventを集約しDashboardへ流す | 複数observerからのevent集約基盤 |
| Dashboard | 実験状態と結果を表示する | 実行時挙動や影響を人が確認するoperator view |
| per-CPU BPF map等 | 観測自体で測定を壊さないよう集計する | 低オーバーヘッドな観測設計の経験 |
| cleanup処理 | XDP / nftables / trafficを元へ戻す | 実験終了時に状態を戻す責任をrunner側へ持たせる考え方 |

特に重要なのは、

```text
実験条件を設定する
↓
実行前の状態を取る
↓
対象を実行する
↓
実行中・実行後を観測する
↓
結果を記録する
↓
cleanupする
```

という制御の骨格です。

AKATSUKIでは、この対象をnetwork packetからsoftware executionへ広げます。

## そのままは持ち込まないもの

次はpacket-poipoi固有、または旧構想由来なので、
現在のAKATSUKIの中心設計として固定しません。

- XDP / Netfilter / Applicationの停止位置比較
- 「早く止めるか、詳しく見てから止めるか」を中心にした問題設定
- UDP負荷生成そのもの
- nftablesを使ったdrop point切替
- `DropPoint` や `XdpAttachMode` をAKATSUKI共通概念として扱うこと
- packet-poipoiを現在のAKATSUKIの「Experiment 01」と位置づけること

packet-poipoiはあくまで、
**旧構想の活かしどころとして作ったスピンオフ**です。

## 現在のAKATSUKIへ進むときの次の実験

packet-poipoiの後にAKATSUKI側で作るなら、
次はnetworkの停止位置比較ではなく、実際のsoftware executionを対象にします。

例えば、最小構成は次です。

```text
小さなprogramを実行
        ↓
process / filesystem / networkの変化を観測
        ↓
実行前後の差分を記録
        ↓
どの変更がprogramによるものか対応づける
        ↓
影響範囲を整理する
        ↓
cleanup後に状態が戻ったか確認する
        ↓
可逆性を評価する
```

この段階でpacket-poipoiと本当に共通だった部分が見えたら、
`experiment-runner` やevent pipelineから共通coreを抽出します。

先に共通化するのではなく、**2つ目の具体的な実験を作ってから共通部分を決める**方針にします。

## 今後の判断基準

packet-poipoiへ変更を加えるときは、AKATSUKIへの再利用率を無理に上げることを目的にしません。

確認するのは次です。

- 技育博で見せたい実験として分かりやすいか
- 実験条件と実測値を分けて残せるか
- 観測そのものが測定を大きく壊していないか
- errorや中断時にもcleanupできるか
- network固有の処理と、将来再利用できそうな実験基盤を過度に混ぜていないか
- 現在のAKATSUKIを理由に、まだ必要でない抽象化を増やしていないか

位置づけは次のように考えます。

```text
AKATSUKI旧構想
     ↓ 一部を切り出す
packet-poipoi
     ↓ 低レイヤ観測・実験基盤の経験を持ち帰る
現在のAKATSUKI
```

**問いは別でも、そこで得た低レイヤ観測と実験基盤の技術を還流させる。**
これをpacket-poipoiと現在のAKATSUKIの接続点とします。
