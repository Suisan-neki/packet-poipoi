# 受賞作・類似作品の調査と、Packet Journeyの立ち位置

この文書は「それっぽい画面」を作るためではなく、何を作品の中心に置くかを決めるための調査記録です。事実と、そこから得た設計判断を分けて書きます。

## 技育系で評価されていたもの

### 技育博は「一発審査」ではなく、会話で作者を見る場

技育プロジェクトは、学生の技術力向上とキャリア形成、企業との早期接点を目的にしています。技育博の公式レポートでは、短い全体pitchのあとに長いbooth交流が組まれ、企業賞も授与されています。2024年の開催例では約3分の発表と約40分のbooth交流、2025年の開催例では1分pitchと75分のbooth交流が2回ありました。

Sources:

- [技育プロジェクト2026 協賛企業募集](https://prtimes.jp/main/html/rd/p/000000076.000045025.html)
- [技育博2025 Vol.1開催レポート](https://note.supporterz.jp/n/n64ddd0708b48)
- [技育博2024 Vol.6参加報告](https://www.seikei.ac.jp/university/highlights/2025/18724.html)

公開記事で企業賞を確認できた企業にはCyberAgent、DeNA、CARTA、ゆめみ、ウイングアーク１ｓｔがあります。企業賞は実装量だけでなく、作者がなぜその課題と方法を選んだかまで見ています。たとえば「リフティ」は行動経済学の根拠を持つ点にも評価が及んでいます。

Sources:

- [CyberAgent賞「リフティ」](https://www.seikei.ac.jp/university/news_topics/2025/18691.html)
- [DeNA・ゆめみ・CARTA企業賞「fookeys」](https://www.nzu.ac.jp/news/20241216/)
- [ウイングアーク１ｓｔ賞「CoreVoice」](https://enne.ltd/ja/a/12.html)

したがって作品は、次の3つの深さを同時に持つ必要があります。

1. 10秒: 「同じpacketを、捨てる位置だけ変えてPiの仕事を測る」
2. 3分: 予想、3条件、実測、結果までを一周する
3. booth対話: attach mode、測定式、実行順、限界、再現方法へ掘れる

### 公式の評価軸

2024年の技育展は、一次審査で「作品へのこだわり」「技術的な挑戦・工夫」「継続的な開発余地」、決勝で「価値」「完成度」「技術レベル」を掲げています。完成度には機能だけでなくUI/UXも含まれます。

Source: [技育展 2024](https://talent.supporterz.jp/geekten/2024/)

2025年の決勝進出は約100作品から32作品でした。公式発表はWeb/Appだけでなくハードウェア、視覚的インパクト、プロダクトとしての仕上がりにも触れています。

Source: [技育展2025 決勝大会結果](https://prtimes.jp/main/html/rd/p/000000073.000045025.html)

### 受賞作から確認できたこと

- 2025最優秀のBreathVizAIは、最初の説明が伝わらなかった経験から、過去の技育展・未踏動画を見て発表を組み直しました。3分で課題と解決が分かる構成、事前提出PDF、demo video、Wi-Fi障害に備えたoffline資料まで準備しています。
- 2024の会場レポートでは、全作品の水準が高く、審査員が差を付けにくかったと記録されています。物理作品CuYuは会場を持ち歩いて来場者に試してもらい、接触量そのものを増やしていました。
- 2023最優秀のThe SHITSUKANは、化粧品ECの質感伝達という具体的なgapに対して、研究ベースの3DCG技術を当てています。

Sources:

- [BreathVizAI 技育展2025の記録](https://zenn.dev/0_s0g0/articles/7918ca4a2bc3b8)
- [技育展2024 決勝大会レポート](https://note.supporterz.jp/n/n7e84e3fc0128)
- [The SHITSUKAN紹介](https://www.atpress.ne.jp/news/5460392)

### 2025年の傾向

技育展2025の公式総括は、AI活用が一般化する一方で、hardware融合と視覚的impactが会場で注目されたと述べています。これは「AIを足せば新しい」状況ではないことを意味します。

Source: [技育展2025 決勝大会結果](https://biz.supporterz.jp/news/031)

Packet Journeyの有利な点は、AIを使わないこと自体ではありません。ネットワークの実packet、kernel counter、物理NICという、生成AIでは代替できない観測対象へ正面から取り組めることです。

### 受賞できなかった作品から確認できたこと

Submarineの振り返りでは、総合的に整っていても「圧倒的な一点」「作者のこだわり」が審査員へ残らなかったと分析されています。一方で、記事やSNSを通じた反応やインターンへの接続は起きています。

Source: [技育展で受賞できなかった作品の振り返り](https://qiita.com/Yuma-Satake/items/514bdedec445883d8376)

## ここから採用した設計判断

以下は上記の事例からの推論です。

1. **一文で実験を言えること**  
   「同じpacketを、捨てる場所だけ変えてPiの仕事を測る」に固定する。
2. **画面より先に比較条件を成立させること**  
   fixtureを実測に見せず、run ID・固定条件・反復・取得元を保存する。
3. **技術の難しさを、観客が見える差へ翻訳すること**  
   verifierやmapの説明だけで終わらず、CPU / softirq / app到達の差へ落とす。
4. **物理展示がコードの意味を増幅すること**  
   3D造形は飾りではなく、Linux受信経路と停止位置を触れる模型にする。
5. **3分発表がネットワークに依存しないこと**  
   live、recording、静止した結果画面を同じ構造で用意する。
6. **観客が結果を待つ理由を作ること**  
   最初にApplication / nftables / XDPのどれが最小になるか予想してから、4画面を進める。
7. **中央値だけで安定性を装わないこと**  
   3回の中央値に加え、min–maxを同じ場所へ表示する。
8. **実行環境をresultの一部にすること**  
   Pi model、kernel、interface、MTU、CPU governor、XDP attach modeをrunへ保存する。

## 他ハッカソンから見た「触れる問い」

JPHACKS 2025のBest Hack / Audience Award「AshiArt」は、一筆書きからGPSランニングコースを作るという、説明前でも触って試せる入口を持っていました。審査員特別賞「4DX@HOME」は映像解析を振動・風・水・光へつなぎ、softwareの結果を身体で理解できる形にしています。

Sources:

- [JPHACKS 2025 Award Day結果](https://jphacks.com/information/result-report2025/)
- [JPHACKS 2025受賞作品](https://jphacks.com/2025/result/)

Open Hack Uの「MusicScribble」は、AIが流行する中で安易にAIへ寄せなかった判断も評価されています。ヒーローズ・リーグ2025のMAヒーロー「～～（なみなみ）」は、波を発生させる物理装置という触覚的な体験が中心です。

Sources:

- [MusicScribble受賞紹介](https://www.nagoyadenki.jp/news/detail/0000187.php)
- [ヒーローズ・リーグ2025](https://protopedia.net/event/hl2025)

ここから得るべきものは派手な筐体ではなく、**観客の行為が問いと結果をつなぐこと**です。Packet Journeyでは、観客が停止位置を予想し、3つの物理blockのどこで光が止まるかを追い、最後に自分の予想と実測を照合します。

## 未踏との境界

2026年度未踏IT人材発掘・育成事業には「eBPFによる行動評価を活用した低レイヤ学習プラットフォーム」が採択されています。browser上の低レイヤ教材で、学習者の`openat`や`read`などの行動過程をeBPFで評価する構想です。採択理由は教育へのeBPF活用を評価する一方、教材の具体性、eBPFの必然性、UX上の利点を今後の論点として挙げています。

Source: [eBPFによる行動評価を活用した低レイヤ学習プラットフォーム](https://www.ipa.go.jp/jinzai/mitou/it/2026/gaiyou-tk-2.html)

この隣接事例があるため、Packet Journeyを「eBPFを学べるWeb教材」と定義しません。

|  | 未踏採択プロジェクト | Packet Journey |
| --- | --- | --- |
| 中心 | 学習者の行動過程を評価するplatform | 同一負荷のdrop pointを比較する実験装置 |
| eBPFの役割 | learner processの観測 | driver entryで実packetを処理し、比較条件を成立させる |
| 主な出力 | 学習支援・評価 | CPU / NET_RX / userspace到達の再現可能なrun |
| 体験 | browser上の教材 | 2台のPi、LED path、実測dashboard |

未踏2025のsystem software採択例には、高性能・高耐障害MySQLや3D print preprocessorがあります。また携帯型pin arrayは、用途が固まり切る前でも難しい技術課題へ継続して手を動かした点を評価されています。低レイヤであることは弱みではありませんが、難しさと出口を具体的に示す必要があります。

Sources:

- [未踏2025スーパークリエータ](https://www.ipa.go.jp/jinzai/mitou/it/2025/supercreator.html)
- [高性能かつ耐障害性に優れたMySQLの開発](https://www.ipa.go.jp/jinzai/mitou/it/2025/gaiyou-tn-2.html)
- [携帯型pin array device](https://www.ipa.go.jp/jinzai/mitou/it/2025/gaiyou-tn-1.html)

## 類似作品・製品

| 類似例 | 強いところ | Packet Journeyで吸収する | 差別化するところ |
| --- | --- | --- | --- |
| [JOPIL](https://devpost.com/software/jopil-journey-of-a-packet-in-linux-kernel) | eBPF/XDPのreal-time flow、protocol分類、per-CPU表示 | live eventとkernel counter | 観測dashboardではなく、停止位置を操作変数にした反復実験 |
| [OSI Model Simulator](https://osi-model-simulator.roboticela.com/) | 初学者が順番を追えるstep表示 | 1画面1論点、前後操作 | simulatorではなく2台のPiとLinux kernelの実測 |
| [Connected Dots](https://www.connecteddots.online/resources/connected-dots-device-simulators/visualization-tool) | device内部処理とprotocol交換のvisualization | 入口からappまでの一貫したpath | protocol解説ではなく処理コスト比較 |
| [Raspberry Pi LED network sphere](https://www.tomshardware.com/raspberry-pi/this-raspberry-pi-project-visualizes-your-real-time-network-traffic-in-the-most-beautiful-way) | ネットワーク活動を物理光へ変える展示力 | 物理LEDで状態を即読させる | activity量ではなくpacketが止まったlayerを光らせる |
| [OML network lab](https://omllabs.com/) | browser、実機、packet capture、採点を一体化 | 再現手順と結果保存 | 大規模labではなく、1台のLinux受信経路を深く掘る |
| [xdp-project/xdp-tutorial](https://github.com/xdp-project/xdp-tutorial) | XDPのload、inspect、programmingを段階的に学べる | 自己完結した再現手順、正確な用語 | setup中心のtutorialではなく、初見でも参加できる比較実験 |
| [xdp-project/xdp-tools](https://github.com/xdp-project/xdp-tools) | `xdp-bench`、`xdp-dump`、monitorなど標準的なoperator tool | benchmarkの技術的厳密さ | CLI toolではなく、停止位置の意味まで見える物理展示 |

## 立ち位置

既存のpacket visualizerは「何が流れているか」を見せるものが多く、network simulatorは「どうつながるか」を学ぶものが多いです。

Packet Journeyは、**同じ入力を同じLinuxへ与え、処理を止める位置だけを変えたとき、kernelとuserspaceの仕事がどう変わるかを実測する装置**です。

派手さのために低レイヤを使うのではなく、低レイヤでなければ比較できない問いを置きます。

productionとの接続もあります。CiliumはeBPFを使うnetworking / security / observability基盤としてCNCF graduated projectであり、OpenTelemetry Go auto-instrumentationはeBPF方式をbeta公開しています。MetaのKatranもXDPをnetwork load balancerへ利用しています。

Sources:

- [Cilium | CNCF](https://www.cncf.io/projects/cilium/)
- [OpenTelemetry Go auto-instrumentation using eBPF](https://www.cncf.io/blog/2025/03/03/announcing-the-beta-release-of-opentelemetry-go-auto-instrumentation-using-ebpf/)
- [Meta: Open-sourcing Katran](https://engineering.fb.com/2018/05/22/open-source/open-sourcing-katran-a-scalable-network-load-balancer/)

したがって、portfolio上の一文は次です。

> production systemが行う「packetをどれだけ早く拒否するか」という設計判断を、机上の2台のRaspberry Piで再現・測定できる実験装置。

## 技術的な正直さ

XDPはattach modeで意味が変わります。libbpfの説明では、flagを指定しない場合はdriver/nativeを試し、非対応ならSKB/genericへfallbackします。generic modeはskb確保後に動くため、nativeと同じ「早さ」として見せられません。

Sources:

- [libbpf `bpf_xdp_attach`](https://docs.ebpf.io/ebpf-library/libbpf/userspace/bpf_xdp_attach/)
- [XDP program type / operating modes](https://docs.ebpf.io/linux/program-type/BPF_PROG_TYPE_XDP/)

そのため、このrepoではnativeを明示的に試し、fallback時は`generic`を各runへ記録します。
