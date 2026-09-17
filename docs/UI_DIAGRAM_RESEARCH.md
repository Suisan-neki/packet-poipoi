# 通信図の見直し（2026-09-17）

## 今回の変更範囲

1画面のまま通信図を置き換える。タイトル、既存の3条件ボタン、実験集計ロジック、
実機側の遮断ルールは変更しない。画面遷移、天秤、結論を言い聞かせる画面は追加しない。

## 調べたものと反映

- Netfilter公式の[処理経路図](https://wiki.nftables.org/wiki-nftables/index.php/Netfilter_hooks)
  は処理点と接続経路を明示している。今回の図も粒をノード外の飾りにせず、
  ノード内部を横断する経路に載せる。Netfilterは今回使うinput hookと明記する。
  網羅的なLinux内部図ではなく受信方向の抜粋として扱う。
- Cloudflareの[L4Dropの説明](https://blog.cloudflare.com/l4drop-xdp-ebpf-based-ddos-mitigations/)
  はルールに一致した通信の破棄と、それ以外の通過を分けている。
  選択地点に通信全体をせき止める壁を置かず、対象UDPにだけ停止端を表示する。
- デジタル庁の[タイポグラフィ](https://design.digital.go.jp/dads/foundations/typography/)
  と[カラー](https://design.digital.go.jp/dads/foundations/color/accessibility/)
  を参考に、細かなラベルの改行崩れ、濃淡の弱さ、過剰な影と色数を見直す。
  ノードは同じ線幅・余白・文字階層とし、選択位置と通信種別にだけ強い色を使う。
- W3Cの[Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)
  を参考に、UDPは四角、HTTPは丸とし、色に加えて形とポート表示で識別する。
- Carbonの[Motion](https://carbondesignsystem.com/elements/motion/overview/)
  を参考に、動きを処理経路の説明に限定する。バウンド、落下、無限に蓄積する演出はしない。
  [Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html)
  に合わせて一時停止を用意し、prefers-reduced-motionでは静止状態から始める。

## 表現と計測の区別

この実験は「UDP宛先ポート4000を破棄する」という既知の条件を使う。
そのため、選択地点へ到達した当該UDPをすべて破棄する表現は実験条件に対応する。
通信全体を遮断するという意味ではなく、HTTP :8080は判定対象外として通過させる。

- 2本のトラックは通信種別の見分け用。異なるNICや別ネットワークを表すものではない。
- 四角と丸の数・速度・通過時間は模式表現。実測ppsや個々のパケットのトレースではない。
- 表示上の粒を数えた値をDROP実測数として表示しない。
- HTTPのフィルタ通過と、HTTP要求が成功したかは別。成功率からパケットの脱落位置を捏造しない。
- 現在のHTTP観測値は既存streamの値を別表示する。アニメーションから成功率を生成しない。
- XDP modeは渡された値を表示し、未取得時にnative/genericを推測しない。
- Application条件の破棄はUDPソケット受信後。Webサービスそのものを破棄点と呼ばない。

## 実装

`dashboard/src/app/PacketFlow.tsx` が既存Reactの選択状態と観測値を渡す。
`packet-diagram.js` は独立したSVGレンダラーで、既存の装飾用CSSと干渉しないよう
Shadow DOM内で描画する。依存パッケージは増やしていない。

属性の値はtextContentで表示する。ルール変更や測定を実機へ送る操作は行わない。
描画はrequestAnimationFrameで更新し、非表示タブ・要素の破棄時には停止する。

## 確認したこと

Chromiumで描画コンポーネントを実行し、1920 / 1440 / 1366 / 1280 / 960 / 390 pxの
6画面幅と3条件の計18組を確認。各条件で時間を進め、以下を検証した。

- 対象UDPが選択した停止端を越えず、下へ落ちない。
- HTTPが同じノード内を通り、選択地点より先まで進む。
- ノードの見出し・補足ラベルが枠に収まる。
- 一時停止、再生、reduced motion、ウィンドウのリサイズ、再接続が動作する。
- 観測値の更新でアニメーションから偽の成功値を生成せず、HTMLを挿入しない。

これは描画コンポーネントの確認であり、Mac上のTauri実行・Pi実測の確認ではない。
