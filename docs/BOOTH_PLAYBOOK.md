# 技育博 booth playbook

この文書は、画面を説明する台本ではありません。観客の知識量に合わせて、同じ作品を10秒、90秒、3分、技術対話へ伸縮させるための運用設計です。

## 観客が立ち止まる前

画面は「予想する」状態で待機させます。

> 同じpacketを、Application、nftables、XDPのどこで捨てると、このPiの仕事が一番減ると思いますか？

3つのbuttonまたは物理buttonを指して、観客に1つ選んでもらいます。ここではeBPFを説明しません。

## 10秒

> 2台のRaspberry Piへ同じUDPを流し、捨てる位置だけ変えます。CPUとkernelの仕事がどれだけ変わるかを実測する装置です。

伝えるのは「同じ入力」「位置だけ変える」「実測」の3点です。

## 90秒

1. Pi AがPi Bへ`2,000 pps / 128 B`の同じUDPを送る。
2. 1回目はUDP socketまで届け、Applicationで読み捨てる。
3. 2回目はLinux network stack内のnftablesで捨てる。
4. 3回目はNIC直後のXDPで、network stackへ入る前に捨てる。
5. 各条件を3回ずつ、開始順を回して測る。
6. CPU busy、NET_RX softirq、Application到達率を比較する。
7. HTTPは比較対象ではなく、負荷中も同じPiのserviceが生きているかを見るcanary。

締め:

> XDPが何packet捨てたかではなく、後段へ渡さなかった仕事の差を見せています。

## 3分

### 0:00–0:25 問い

packetを捨てる処理は、ApplicationにもfirewallにもNIC直後にも書けます。同じものを捨てるなら、位置の違いはPiの仕事量へどれだけ出るのかを測ります。

### 0:25–1:20 実験

画面を1から3へ進めます。毎回、送信レート、payload、時間は固定し、光る停止位置だけを指します。packet animationを説明せず、経路がどこまで続いたかを説明します。

### 1:20–2:15 結果

結果画面で次の順に指します。

1. CPU busyの中央値とmin–max
2. 1万packetあたりのNET_RX softirq
3. Application到達率
4. XDPのactual attach mode

### 2:15–3:00 技術的な正直さ

- 3回では一般化できないため、中央値と範囲を両方出す。
- nativeとgeneric XDPを混ぜない。
- Pi model、kernel、NIC、MTU、governorをrunへ残す。
- HTTPのstatus / latencyだけで防御性能を断定しない。

締め:

> これはDDoS対策製品そのものではなく、production networkが行う「どの段階でpacketを拒否するか」という設計判断を、机上で再現できる実験装置です。

## 相手の知識別の分岐

### 初学者

- NIC = network cableからpacketを受け取る入口
- network stack = Linuxが通信をApplicationへ渡すまでの処理
- XDP = その入口に置ける小さなprogram

`softirq`や`skb`は相手から聞かれるまで出しません。

### Web / Application engineer

- reverse proxyやApplication middlewareで拒否する場合との違い
- service processへ届く前に仕事を減らす意味
- HTTP canaryは主指標ではないこと

### SRE / infrastructure engineer

- native / generic attach mode
- per-CPU mapとpacketごとのlogを避けた理由
- NET_RX softirqを選んだ理由と限界
- IRQ affinity、RPS/RFS、offload、CPU governorが交絡になること

### 採用担当・manager

- 問いを立て直した経緯
- UI fixtureと実測値を分けた判断
- 2台のPi、Rust、Aya、nftables、Tauriを一つの再現可能な系にしたこと
- 失敗後に「見栄え」から「比較可能な実験」へ作り直したこと

## 想定質問

### なぜUDPなのか

接続確立や再送制御の影響を避け、一定rateの入力を作りやすいからです。HTTPは負荷ではなくservice canaryとして別の役割を持たせています。

### なぜCPUだけではないのか

CPU busyだけではbackground processの影響を受けます。NET_RX softirqとuserspace到達も合わせ、経路のどこまで仕事をしたかを複数の観測で確認します。

### XDPが常に最速なのか

この構成での測定結果しか主張しません。NIC driver、attach mode、packet size、rate、offload設定で結果は変わります。

### 既存のxdp-benchでよくないか

operator向けbenchmark toolは技術検証に強い一方、初見の観客が停止位置の意味を理解しにくいです。本作は実測の厳密さと、触って予想できる展示体験を一つにしています。

## 当日の失敗対策

- live run
- 直前に同じ実機で取得したrecording
- fixtureであることを明記したpublic UI

この3つを同じ4画面で再生できる状態にします。録画値をliveに見せません。

## やらないこと

- 「DDoSを完全防御した」と言わない
- fixtureの値をbenchmark結果として引用しない
- HTTP 200だけを成功根拠にしない
- AI、医療、security buzzwordを後付けしない
- 3D printを飾りにしない
