# 受賞作・類似作品の調査と、Packet Journeyの立ち位置

この文書は「それっぽい画面」を作るためではなく、何を作品の中心に置くかを決めるための調査記録です。事実と、そこから得た設計判断を分けて書きます。

## 技育系で評価されていたもの

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

## 類似作品・製品

| 類似例 | 強いところ | Packet Journeyで吸収する | 差別化するところ |
| --- | --- | --- | --- |
| [JOPIL](https://devpost.com/software/jopil-journey-of-a-packet-in-linux-kernel) | eBPF/XDPのreal-time flow、protocol分類、per-CPU表示 | live eventとkernel counter | 観測dashboardではなく、停止位置を操作変数にした反復実験 |
| [OSI Model Simulator](https://osi-model-simulator.roboticela.com/) | 初学者が順番を追えるstep表示 | 1画面1論点、前後操作 | simulatorではなく2台のPiとLinux kernelの実測 |
| [Connected Dots](https://www.connecteddots.online/resources/connected-dots-device-simulators/visualization-tool) | device内部処理とprotocol交換のvisualization | 入口からappまでの一貫したpath | protocol解説ではなく処理コスト比較 |
| [Raspberry Pi LED network sphere](https://www.tomshardware.com/raspberry-pi/this-raspberry-pi-project-visualizes-your-real-time-network-traffic-in-the-most-beautiful-way) | ネットワーク活動を物理光へ変える展示力 | 物理LEDで状態を即読させる | activity量ではなくpacketが止まったlayerを光らせる |
| [OML network lab](https://omllabs.com/) | browser、実機、packet capture、採点を一体化 | 再現手順と結果保存 | 大規模labではなく、1台のLinux受信経路を深く掘る |

## 立ち位置

既存のpacket visualizerは「何が流れているか」を見せるものが多く、network simulatorは「どうつながるか」を学ぶものが多いです。

Packet Journeyは、**同じ入力を同じLinuxへ与え、処理を止める位置だけを変えたとき、kernelとuserspaceの仕事がどう変わるかを実測する装置**です。

派手さのために低レイヤを使うのではなく、低レイヤでなければ比較できない問いを置きます。

## 技術的な正直さ

XDPはattach modeで意味が変わります。libbpfの説明では、flagを指定しない場合はdriver/nativeを試し、非対応ならSKB/genericへfallbackします。generic modeはskb確保後に動くため、nativeと同じ「早さ」として見せられません。

Sources:

- [libbpf `bpf_xdp_attach`](https://docs.ebpf.io/ebpf-library/libbpf/userspace/bpf_xdp_attach/)
- [XDP program type / operating modes](https://docs.ebpf.io/linux/program-type/BPF_PROG_TYPE_XDP/)

そのため、このrepoではnativeを明示的に試し、fallback時は`generic`を各runへ記録します。
