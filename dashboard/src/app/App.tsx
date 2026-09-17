import { useEffect, useMemo, useRef, useState } from "react";
import { isWebDemo, subscribeStream } from "../stream.js";
import { LABELS, actualPps, isRun, sampleRuns, stagesFor, summarize, upsertRun,
  type AttachMode, type DropPoint, type ExperimentRun, type Summary } from "./model";

const boardImage = new URL("./pi-board.svg", import.meta.url).href;
const number = (value: number) => new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 }).format(value);
const attach = (value: unknown): AttachMode => value === "native" || value === "generic" ? value : "unknown";

function PiImage({ name }: { name: string }) {
  return <img className="pi-image" src={boardImage} alt={`${name}：Raspberry Piの基板`} width="155" height="102" />;
}

function Directions({ moving }: { moving: boolean }) {
  return <div className={`directions ${moving ? "is-moving" : ""}`} aria-label="通信は双方向。今回はPi AからPi Bへの受信方向に注目">
    <span className="direction-focus">今回はこの向きに注目</span>
    <svg viewBox="0 0 160 30" role="img" aria-label="Pi AからPi Bへ" className="arrow-forward">
      <path d="M0 10 H138 V1 L159 15 L138 29 V20 H0 Z" />
    </svg>
    <svg viewBox="0 0 160 30" role="img" aria-label="Pi BからPi Aへ" className="arrow-return">
      <path d="M160 10 H22 V1 L1 15 L22 29 V20 H160 Z" />
    </svg>
  </div>;
}

function Balance() {
  return <div className="balance-wrap" aria-label="不要な通信を止めることと、必要な通信を残すことのバランス">
    <svg className="balance-svg" viewBox="0 0 400 182" role="img" aria-label="安全性と通信可用性の天秤">
      <g fill="none" stroke="#526379" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M200 18 V157 M80 41 L200 31 L320 41" strokeWidth="9" />
        <path d="M80 43 L33 112 M80 43 L127 112 M320 43 L273 112 M320 43 L367 112" strokeWidth="2" />
      </g>
      <path d="M26 110 H134 Q129 135 80 135 Q31 135 26 110" fill="#cfe4ff" stroke="#1769e0" strokeWidth="2" />
      <path d="M266 110 H374 Q369 135 320 135 Q271 135 266 110" fill="#d4f2e5" stroke="#21825a" strokeWidth="2" />
      <circle cx="200" cy="32" r="10" fill="#fff" stroke="#526379" strokeWidth="6" />
      <path d="M173 151 H227 L249 172 H151 Z" fill="#526379" />
      <text x="80" y="88" textAnchor="middle" className="scale-label scale-label--safety">安全性</text>
      <text x="320" y="88" textAnchor="middle" className="scale-label scale-label--availability">通信可用性</text>
    </svg>
    <div className="scale-captions"><span>不要な通信を止める</span><span>必要な通信を残す</span></div>
  </div>;
}

function ResultCard({ summary, selected, onSelect }: { summary: Summary; selected: boolean; onSelect: () => void }) {
  const meta = LABELS[summary.dropPoint];
  const label = summary.invalid ? "要確認" : summary.result ? number(summary.result.actualPps)
    : summary.complete ? "維持できず" : summary.count ? "集計中" : "未計測";
  return <button className={`result-card tone-${summary.dropPoint} ${selected ? "is-selected" : ""}`}
    type="button" onClick={onSelect} aria-pressed={selected} title={`${meta.label}の説明図を表示（実機の設定は変わりません）`}>
    <div className="result-heading"><b className="point-number">{meta.number}</b><span><strong>{meta.label}</strong><small>{meta.technical}</small></span></div>
    <div className={`result-number ${summary.result ? "has-result" : ""}`}>{label}{summary.result && <small>pps{summary.lowerBound ? "以上" : ""}</small>}</div>
    <div className="result-detail">{summary.reason ?? (summary.result
      ? `HTTP成功率 ${number(summary.result.success)}% ／ p95 ${number(summary.result.latency)} ms`
      : summary.count ? `${summary.count} / ${summary.expected} 回の結果を受信` : "実験するとここに結果が出ます")}</div>
  </button>;
}

export default function App() {
  const demo = isWebDemo();
  const [runs, setRuns] = useState<ExperimentRun[]>(() => demo ? sampleRuns() : []);
  const [connection, setConnection] = useState("waiting");
  const [mode, setMode] = useState<AttachMode>(demo ? "generic" : "unknown");
  const [defense, setDefense] = useState("monitor");
  const [receivedPps, setReceivedPps] = useState<number | null>(null);
  const [traffic, setTraffic] = useState<{ active: boolean; target: number } | null>(null);
  const [health, setHealth] = useState<{ success: boolean; latency: number; status: number | null; at: number } | null>(null);
  const [explanation, setExplanation] = useState<DropPoint | null>(null);
  const lastMessage = useRef(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (demo) return;
    let disposed = false;
    let unsubscribe: undefined | (() => void);
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (lastMessage.current && Date.now() - lastMessage.current > 5000) setConnection("disconnected");
    }, 1000);
    void subscribeStream({
      onStatus: status => {
        if (!disposed) setConnection(status.startsWith("connected") ? "connected" : status.startsWith("waiting") ? "waiting" : "disconnected");
      },
      onEvent: raw => {
        if (disposed || raw == null || typeof raw !== "object") return;
        const event = raw as Record<string, unknown>;
        // 接続通知が購読開始より先に届いていても、実データの受信で接続状態を回復する。
        lastMessage.current = Date.now();
        setConnection("connected");
        if (event.type === "stats") {
          if (typeof event.pps === "number" && Number.isFinite(event.pps) && event.pps >= 0) setReceivedPps(event.pps);
          if (attach(event.attach_mode) !== "unknown") setMode(attach(event.attach_mode));
          if (event.mode === "monitor" || event.mode === "protect") setDefense(event.mode);
        } else if (event.type === "defense_mode") {
          if (event.mode === "monitor" || event.mode === "protect") setDefense(event.mode);
          if (attach(event.attach_mode) !== "unknown") setMode(attach(event.attach_mode));
        } else if (event.type === "traffic_health" && typeof event.success === "boolean" && typeof event.latency_ms === "number" && Number.isFinite(event.latency_ms)) {
          setHealth({ success: event.success, latency: event.latency_ms, status: typeof event.status_code === "number" ? event.status_code : null, at: Date.now() });
        } else if (event.type === "attack_state" && typeof event.active === "boolean" && typeof event.pps === "number" && Number.isFinite(event.pps)) {
          setTraffic({ active: event.active, target: event.pps });
        } else if (event.type === "experiment_run" && isRun(event)) {
          setRuns(current => upsertRun(current, event));
          if (attach(event.xdp_attach_mode) !== "unknown") setMode(attach(event.xdp_attach_mode));
          setExplanation(null);
        }
      },
    }).then(subscription => {
      if (disposed) subscription.unsubscribe(); else unsubscribe = subscription.unsubscribe;
    }).catch(() => { if (!disposed) setConnection("disconnected"); });
    return () => { disposed = true; window.clearInterval(timer); unsubscribe?.(); };
  }, [demo]);

  const summaries = useMemo(() => summarize(runs), [runs]);
  const latest = runs.at(-1);
  const complete = summaries.every(s => s.complete);
  const invalid = summaries.some(s => s.invalid);
  const connected = !demo && connection === "connected";
  const sending = connected && !!traffic?.active;
  const selected = explanation ?? (sending && defense === "protect" ? "xdp" : sending ? null : latest?.drop_point ?? null);
  const selectedMeta = selected ? LABELS[selected] : null;
  const displayContext = explanation ? "説明表示" : sending && selected === "xdp" ? "遮断中" : latest && !sending ? "直前の結果" : "3つの停止位置";
  const status = demo ? "サンプル表示" : !connected ? (connection === "waiting" ? "Pi Bに接続中" : "接続を確認してください")
    : sending ? "実験中" : complete ? (invalid ? "結果の確認が必要" : "計測完了") : runs.length ? "結果を受信中" : "実験待ち";
  const healthFresh = connected && health && now - health.at < 6000;
  const healthText = demo ? "サンプル：HTTP 200" : !health ? "計測待ち" : !healthFresh ? "更新待ち"
    : health.success ? `HTTP ${health.status ?? 200} ／ ${number(health.latency)} ms` : "応答を確認できません";
  const stages = stagesFor(mode);
  const stopIndex = selected ? stages.findIndex(stage => stage.id === selected) : -1;

  return <main className="slide-ui">
    <header className="slide-header">
      <div className="headline"><span className="brand">パケットぽいぽい <small>packet-poipoi</small></span>
        <h1>どこで止めるのが、ちょうどいい？</h1>
        <p>同じ負荷を送り、止める場所による違いを実機で比べる。</p>
      </div>
      <aside className={`status-card ${demo ? "is-sample" : ""}`} aria-live="polite" aria-label="実験の状態">
        <span className="connection-label"><i className={connected ? "connected" : ""} />{demo ? "説明用・実測値ではありません" : connected ? "Pi Bと接続済み" : "実機データの受信待ち"}</span>
        <strong data-testid="experiment-status">{status}</strong>
        <small>{demo ? "画面の動作を確認するサンプルです" : runs.length ? `${runs.length} / ${summaries.reduce((n, s) => n + s.expected, 0)} 回の結果を受信`
          : "結果は各条件の終了後に更新します"}</small>
      </aside>
    </header>

    <section className="network-panel" aria-labelledby="network-title">
      <h2 className="section-title" id="network-title">今回、見ているのはここ</h2>
      <div className="devices">
        <article className="sender pi-card">
          <h3>Pi A</h3><span className="role-label">送る側</span><PiImage name="Pi A" />
          <div className="traffic-labels"><span><i className="load-dot" />実験用の負荷 <b>UDP :4000</b></span><span><i className="http-dot" />サービスの確認 <b>HTTP :8080</b></span></div>
          <div className="sender-reading"><small>{sending ? "送信設定" : latest ? "直前の実送信" : "送信量"}</small>
            <strong>{sending ? number(traffic!.target) : latest ? number(actualPps(latest)) : "—"} <span>pps</span></strong></div>
        </article>
        <Directions moving={sending} />
        <article className="receiver pi-card">
          <div className="receiver-title"><div><h3>Pi B</h3><span className="role-label">受ける側（サーバー役）</span></div>
            <span className="diagram-state">{displayContext}{selectedMeta && <b> {selectedMeta.number} {selectedMeta.label}</b>}</span></div>
          <div className="receiver-interior">
            <div className="receiver-picture"><PiImage name="Pi B" /><small>ラズパイの中で処理</small></div>
            <div className="flow-area"><h4 title="実験用UDP :4000の受信経路">通信の処理の流れ</h4>
              <div className="pipeline" data-mode={mode}>
                {stages.map((stage, index) => {
                  const point = stage.id === "xdp" || stage.id === "netfilter" || stage.id === "application" ? stage.id : null;
                  const meta = point ? LABELS[point] : null;
                  return <div key={stage.id} className={`stage ${point ? `tone-${point}` : ""} ${stage.id === selected ? "is-selected" : ""} ${stopIndex >= 0 && index > stopIndex ? "is-after" : ""}`} data-stage={stage.id}>
                    {index > 0 && <span className="stage-arrow" aria-hidden="true">→</span>}
                    {stage.id === "netfilter" && <span className="nft-note">nftablesでルールを設定<span aria-hidden="true">↓</span></span>}
                    <div className="stage-node"><strong>{stage.title}</strong><small>{stage.technical}</small></div>
                    {meta && <div className="stage-caption"><b className="point-number">{meta.number}</b><span>{meta.label}</span></div>}
                  </div>;
                })}
              </div>
              <div className="flow-foot"><span className="mode-note">{mode === "generic" ? `${demo ? "図の例" : "実機"}：generic XDP（skb生成後）` : mode === "native" ? "実機：native XDP（NICドライバ内）" : "XDPの実行モードを確認中"}</span>
                <span className={`health ${healthFresh && health?.success ? "is-ok" : ""}`}><i />Webサービス <b>{healthText}</b></span></div>
            </div>
          </div>
        </article>
      </div>
    </section>

    <section className="tradeoff-panel" aria-labelledby="tradeoff-title">
      <h2 className="section-title" id="tradeoff-title">安全性と通信可用性のトレードオフ</h2>
      <div className="tradeoff-content">
        <article className="tradeoff-copy early"><h3>早い段階で止めると…</h3>
          <p><b>後段の処理を減らせる</b><span>アプリまで届ける負担を抑える</span></p>
          <p><b>アプリの文脈は使いにくい</b><span>判断条件によっては正常な通信も巻き込む</span></p>
        </article>
        <Balance />
        <article className="tradeoff-copy late"><h3>アプリまで通すと…</h3>
          <p><b>サービスの意味を踏まえて判断</b><span>URL・ログイン状態・権限などを使える</span></p>
          <p><b>判断するまでの処理が必要</b><span>不要な通信もそこまで処理する</span></p>
        </article>
      </div>
      <p className="tradeoff-note">停止位置だけで判定精度は決まりません。使える情報と判断条件によって変わります。</p>
    </section>

    <section className="results" aria-labelledby="results-title"><div className="results-title"><h2 id="results-title">HTTPを保てた実送信量</h2><span>pps ＝ 1秒あたりのパケット数</span></div>
      <div className="result-cards">{summaries.map(summary => <ResultCard key={summary.dropPoint} summary={summary}
        selected={selected === summary.dropPoint} onSelect={() => setExplanation(current => current === summary.dropPoint ? null : summary.dropPoint)} />)}</div>
      <div className="results-note"><span>カードを押すと説明図が切り替わります。実機の設定は変わりません。</span><span>{demo ? "サンプルデータ" : `Pi Bの受信観測：${connected && receivedPps !== null ? number(receivedPps) : "—"} pps`}</span></div>
    </section>
    <footer>今回の実験はUDP :4000の破棄による負荷とHTTPの応答を比較します。正常通信の誤遮断率・判定精度は測定していません。</footer>
  </main>;
}
