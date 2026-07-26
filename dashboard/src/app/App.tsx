import { useEffect, useMemo, useState } from "react";
import { isWebDemo, subscribeStream } from "../stream.js";

type HarborMode = "monitor" | "protect";

interface HarborEvent {
  type?: string;
  mode?: string;
  pps?: number;
  total?: number;
  pass?: number;
  drop?: number;
  success?: boolean;
  latency_ms?: number;
  status_code?: number;
  active?: boolean;
  packets_sent?: number;
  target?: string;
  dst_port?: number;
  protocol?: string;
  action?: string;
  src?: string;
  src_port?: number;
  dst?: string;
}

interface HarborState {
  mode: HarborMode;
  pps: number;
  total: number;
  passed: number;
  dropped: number;
  healthSuccess: boolean;
  latencyMs: number;
  statusCode: number | null;
  attackActive: boolean;
  attackPps: number;
  attackPackets: number;
  attackPort: number;
  target: string;
}

interface LogEntry {
  id: number;
  time: string;
  message: string;
  tone: "quiet" | "pass" | "drop" | "warn";
}

const DEMO_STATE: HarborState = {
  mode: "protect",
  pps: 1874,
  total: 148620,
  passed: 6254,
  dropped: 142366,
  healthSuccess: true,
  latencyMs: 14,
  statusCode: 200,
  attackActive: true,
  attackPps: 1832,
  attackPackets: 98420,
  attackPort: 4000,
  target: "192.168.1.10",
};

const INITIAL_STATE: HarborState = {
  mode: "monitor",
  pps: 0,
  total: 0,
  passed: 0,
  dropped: 0,
  healthSuccess: false,
  latencyMs: 0,
  statusCode: null,
  attackActive: false,
  attackPps: 0,
  attackPackets: 0,
  attackPort: 4000,
  target: "192.168.1.10",
};

function nowLabel() {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function formatCount(value: number) {
  return new Intl.NumberFormat("ja-JP").format(Math.max(0, Math.round(value)));
}

function ShipMark() {
  return (
    <svg viewBox="0 0 220 72" aria-hidden="true">
      <path d="M10 44 Q16 57 28 60 L192 60 Q204 57 210 44 Z" className="ship-hull" />
      <rect x="26" y="37" width="168" height="7" className="ship-deck" />
      <rect x="128" y="20" width="42" height="17" className="ship-cabin" />
      <rect x="133" y="24" width="6" height="4" className="ship-window" />
      <rect x="143" y="24" width="6" height="4" className="ship-window" />
      <rect x="153" y="24" width="6" height="4" className="ship-window" />
      <rect x="160" y="8" width="8" height="13" className="ship-stack" />
      <line x1="116" y1="8" x2="116" y2="37" className="ship-mast" />
      <rect x="32" y="28" width="24" height="9" className="cargo cargo--sand" />
      <rect x="60" y="28" width="24" height="9" className="cargo cargo--green" />
      <rect x="88" y="28" width="24" height="9" className="cargo cargo--dim" />
    </svg>
  );
}

function LatencyTrace({ values }: { values: number[] }) {
  const points = useMemo(() => {
    if (values.length === 0) return "";
    const max = Math.max(80, ...values);
    return values
      .map((value, index) => {
        const x = values.length === 1 ? 100 : (index / (values.length - 1)) * 100;
        const y = 34 - Math.min(30, (value / max) * 30);
        return `${x},${y}`;
      })
      .join(" ");
  }, [values]);

  return (
    <svg className="latency-trace" viewBox="0 0 100 38" preserveAspectRatio="none" aria-label="直近のHTTP応答時間">
      <line x1="0" y1="34" x2="100" y2="34" />
      {points && <polyline points={points} />}
    </svg>
  );
}

export default function App() {
  const demo = isWebDemo();
  const [streamStatus, setStreamStatus] = useState(demo ? "demo" : "waiting");
  const [harbor, setHarbor] = useState<HarborState>(demo ? DEMO_STATE : INITIAL_STATE);
  const [latencies, setLatencies] = useState<number[]>(demo ? [18, 15, 16, 14, 15, 13, 14] : []);
  const [showDetails, setShowDetails] = useState(false);
  const [experimentPhase, setExperimentPhase] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      id: 1,
      time: "--:--:--",
      message: demo
        ? "WEB展示見本を表示しています。数値は実機の出力例です。"
        : "観測ノードからの接続を待っています。",
      tone: "quiet",
    },
  ]);

  function addLog(message: string, tone: LogEntry["tone"] = "quiet") {
    setLogs(current =>
      [
        {
          id: Date.now() + Math.random(),
          time: nowLabel(),
          message,
          tone,
        },
        ...current,
      ].slice(0, 4),
    );
  }

  useEffect(() => {
    let disposed = false;
    let unsubscribe: undefined | (() => void);

    void subscribeStream({
      onStatus: status => {
        if (!disposed) setStreamStatus(status);
      },
      onEvent: raw => {
        if (disposed) return;
        const event = raw as HarborEvent;

        if (event.type === "stats") {
          setHarbor(current => ({
            ...current,
            mode: event.mode === "protect" ? "protect" : event.mode === "monitor" ? "monitor" : current.mode,
            pps: Number(event.pps ?? current.pps),
            total: Number(event.total ?? current.total),
            passed: Number(event.pass ?? current.passed),
            dropped: Number(event.drop ?? current.dropped),
          }));
          return;
        }

        if (event.type === "traffic_health") {
          const latency = Number(event.latency_ms ?? 0);
          const success = Boolean(event.success);
          setHarbor(current => {
            if (!demo && success) {
              setExperimentPhase(current.attackActive ? (current.mode === "protect" ? 3 : 1) : 0);
            }
            return {
              ...current,
              healthSuccess: success,
              latencyMs: latency,
              statusCode: event.status_code == null ? null : Number(event.status_code),
            };
          });
          setLatencies(current => [...current, latency].slice(-30));
          if (!success) addLog("通常HTTPの応答が途切れました。", "warn");
          return;
        }

        if (event.type === "attack_state") {
          const active = Boolean(event.active);
          setHarbor(current => ({
            ...current,
            attackActive: active,
            attackPps: Number(event.pps ?? 0),
            attackPackets: Number(event.packets_sent ?? current.attackPackets),
            attackPort: Number(event.dst_port ?? current.attackPort),
            target: event.target ?? current.target,
          }));
          addLog(active ? "UDP負荷通信を開始しました。" : "UDP負荷通信を停止しました。", active ? "warn" : "quiet");
          setExperimentPhase(active ? 1 : 0);
          return;
        }

        if (event.type === "defense_mode") {
          const mode: HarborMode = event.mode === "protect" ? "protect" : "monitor";
          setHarbor(current => ({
            ...current,
            mode,
            attackPort: Number(event.dst_port ?? current.attackPort),
          }));
          addLog(
            mode === "protect"
              ? "PROTECTへ変更。指定UDPをXDP_DROPします。"
              : "MONITORへ変更。パケットを観測して通過させます。",
            mode === "protect" ? "drop" : "quiet",
          );
          setExperimentPhase(mode === "protect" ? 2 : 1);
          return;
        }

        if (event.type === "flow" && (event.action === "DROP" || event.protocol === "TCP")) {
          const route = `${event.src ?? "?"}:${event.src_port ?? "?"} → ${event.dst ?? "?"}:${event.dst_port ?? "?"}`;
          addLog(
            `${event.protocol ?? "IP"} ${route} / ${event.action ?? "PASS"}`,
            event.action === "DROP" ? "drop" : "pass",
          );
        }
      },
    }).then(subscription => {
      if (disposed) {
        subscription.unsubscribe();
        return;
      }
      unsubscribe = subscription.unsubscribe;
      if (subscription.mode === "web") setStreamStatus("demo");
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!demo) return;
    const timer = window.setInterval(() => {
      setExperimentPhase(current => (current + 1) % 4);
    }, 4500);
    return () => window.clearInterval(timer);
  }, [demo]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowDetails(false);
      if (event.key.toLowerCase() === "d") setShowDetails(current => !current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const dropRatio = harbor.total > 0 ? (harbor.dropped / harbor.total) * 100 : 0;
  const phases = [
    ["通常時の応答を測る", "BASELINE"],
    ["テスト負荷を加える", "LOAD"],
    ["指定した負荷を遮断", "DEFENSE"],
    ["応答が続くか測る", "RESULT"],
  ];

  return (
    <div className="booth-app">
      <header className="booth-header">
        <div className="brand">
          <div className="brand-ship"><ShipMark /></div>
          <div>
            <div className="brand-name">PACKET HARBOR</div>
            <div className="brand-sub">Raspberry Pi × Rust × eBPF/XDP</div>
          </div>
        </div>

        <div className="header-status">
          <span className={demo ? "sample-badge" : "live-badge"}>{demo ? "SAMPLE" : "LIVE"}</span>
          <div><small>MODE</small><strong>{harbor.mode.toUpperCase()}</strong></div>
          <div><small>STREAM</small><strong>{streamStatus.toUpperCase()}</strong></div>
          <button type="button" onClick={() => setShowDetails(true)}>技術詳細 <kbd>D</kbd></button>
        </div>
      </header>

      <div className="sample-notice">
        {demo
          ? "表示中の数値は実機デモの出力例です"
          : "2台のRaspberry PiとXDPから受信した実測値です"}
      </div>

      <main className="booth-screen">
        <ol className="phase-strip" aria-label="デモの進行状況">
          {phases.map(([label], index) => (
            <li key={label} className={`${index < experimentPhase ? "is-complete" : ""} ${index === experimentPhase ? "is-active" : ""}`}>
              <button type="button" onClick={() => demo && setExperimentPhase(index)} disabled={!demo}>
                <span>{index + 1}</span>
                <strong>{label}</strong>
              </button>
            </li>
          ))}
        </ol>

        <section className={`stage-scene stage-scene--${experimentPhase + 1}`} aria-live="polite">
          <header className="stage-copy">
            <span>STEP 0{experimentPhase + 1} / {phases[experimentPhase][1]}</span>
            {experimentPhase === 0 && <><h1>まず、負荷をかける前の<br />HTTP応答を測ります。</h1><p>あとで同じURLを測り、負荷の前後でサービスが変わったか比べるための基準です。</p></>}
            {experimentPhase === 1 && <><h1>次に、UDP :{harbor.attackPort}の<br />テスト負荷を加えます。</h1><p>UDPは比較相手ではなく、サーバーへ負荷を加える実験条件。HTTPの監視は止めずに続けます。</p></>}
            {experimentPhase === 2 && <><h1>XDPが指定UDPを<br />入口で遮断します。</h1><p>パケットをアプリへ届ける前に破棄。HTTPは遮断対象ではないため、同じ入口を通過します。</p></>}
            {experimentPhase === 3 && <><h1>負荷中もHTTPが応答。<br />防御は成功です。</h1><p>負荷を加えた状態で、最初と同じHTTP GETが成功するかを結果指標にしています。</p></>}
          </header>

          <div className="stage-visual">
            {experimentPhase === 0 && <>
              <div className="stage-node"><small>Raspberry Pi A</small><strong>HTTP GET</strong><em>サービス確認</em></div>
              <div className="stage-flow stage-flow--http">→</div>
              <div className="stage-node stage-node--service"><small>Raspberry Pi B / :8080</small><strong>{harbor.statusCode ?? 200}</strong><em>{harbor.latencyMs || 14} ms</em></div>
            </>}
            {experimentPhase === 1 && <>
              <div className="stage-node stage-node--load"><small>Raspberry Pi A</small><strong>UDP :{harbor.attackPort}</strong><em>{formatCount(harbor.attackPps)} pps</em></div>
              <div className="stage-flow stage-flow--load">→ → →</div>
              <div className="stage-node"><small>Raspberry Pi B</small><strong>同じNICへ到着</strong><em>HTTP監視も継続中</em></div>
            </>}
            {experimentPhase === 2 && <>
              <div className="stage-node stage-node--load"><small>指定UDP</small><strong>{formatCount(harbor.attackPps)} pps</strong><em>実験で加えた負荷</em></div>
              <div className="stage-gate"><small>NIC直後</small><strong>XDP</strong><em>XDP_DROP</em></div>
              <div className="stage-node stage-node--blocked"><small>アプリへ届く前</small><strong>{dropRatio.toFixed(1)}%</strong><em>{formatCount(harbor.dropped)} packets 遮断</em></div>
            </>}
            {experimentPhase === 3 && <>
              <div className="result-chain"><small>負荷条件</small><strong>{formatCount(harbor.attackPps)} <em>pps</em></strong></div>
              <div className="result-arrow">→</div>
              <div className="result-chain"><small>入口で遮断</small><strong>{dropRatio.toFixed(1)}<em>%</em></strong></div>
              <div className="result-arrow">→</div>
              <div className="result-chain result-chain--success"><small>HTTPサービス</small><strong>{harbor.statusCode ?? 200} <em>/ {harbor.latencyMs || 14}ms</em></strong></div>
            </>}
          </div>

          <footer className="stage-note">
            <span>{experimentPhase === 0 ? "比較の基準" : experimentPhase === 1 ? "実験条件" : experimentPhase === 2 ? "防御処理" : "結果"}</span>
            <strong>{experimentPhase === 0 ? "通常時のHTTP応答" : experimentPhase === 1 ? "UDPで負荷を発生" : experimentPhase === 2 ? "XDPで対象だけ破棄" : "負荷中もサービスを維持"}</strong>
            <em>{demo ? "約4.5秒で次へ・上の番号で切替" : "実機イベントに合わせて進行"}</em>
          </footer>
        </section>
      </main>

      {showDetails && (
        <div className="details-backdrop" role="presentation" onMouseDown={() => setShowDetails(false)}>
          <section
            className="details-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="details-title"
            onMouseDown={event => event.stopPropagation()}
          >
            <header>
              <div><span>TECHNICAL DETAILS</span><h2 id="details-title">このデモが実際に測っているもの</h2></div>
              <button type="button" onClick={() => setShowDetails(false)}>閉じる <kbd>Esc</kbd></button>
            </header>

            <div className="details-grid">
              <article>
                <span>構成</span>
                <h3>Raspberry Pi 2台</h3>
                <p>Pi AがPi Bへテスト負荷を加えながら、Pi B上のHTTPサービスへGETを送り続けます。UDP自体を危険とみなすのではなく、この展示では<code>UDP :4000</code>を遮断対象として設定しています。</p>
              </article>
              <article>
                <span>遮断位置</span>
                <h3>アプリより手前</h3>
                <div className="mini-path"><b>NIC</b><i />XDP<i />network stack<i />app</div>
                <p>指定UDPはソケットやアプリケーションへ届く前に<code>XDP_DROP</code>されます。</p>
              </article>
              <article>
                <span>カウンタ</span>
                <h3>per-CPU BPF map</h3>
                <dl>
                  <div><dt>XDP_PASS</dt><dd>{formatCount(harbor.passed)}</dd></div>
                  <div><dt>XDP_DROP</dt><dd>{formatCount(harbor.dropped)}</dd></div>
                  <div><dt>入口の流量</dt><dd>{formatCount(harbor.pps)} pps</dd></div>
                </dl>
              </article>
              <article>
                <span>サービス確認</span>
                <h3>実際のHTTP GET</h3>
                <p>UDP負荷とは別にHTTP :8080へ継続アクセスし、statusとlatencyを測定します。</p>
                <LatencyTrace values={latencies} />
              </article>
              <article>
                <span>モード</span>
                <h3>MONITOR / PROTECT</h3>
                <p><code>MONITOR</code>は観測して通過。<code>PROTECT</code>は指定UDPを入口で破棄します。</p>
              </article>
              <article>
                <span>直近のイベント</span>
                <h3>Event stream</h3>
                <ol className="details-log">
                  {logs.slice(0, 3).map(entry => (
                    <li key={entry.id}><time>{entry.time}</time><span>{entry.message}</span></li>
                  ))}
                </ol>
              </article>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
