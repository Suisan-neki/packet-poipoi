import {
  useEffect,
  useMemo,
  useReducer,
  useState,
  type CSSProperties,
} from "react";
import { isWebDemo, subscribeStream } from "../stream.js";

type HarborMode = "monitor" | "protect";
type ExperimentPhase = 0 | 1 | 2 | 3;

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
  blocked_udp_port?: number;
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

interface HealthSnapshot {
  recorded: boolean;
  success: boolean;
  latencyMs: number;
  statusCode: number | null;
}

interface LiveExperiment {
  harbor: HarborState;
  baseline: HealthSnapshot;
  phase: ExperimentPhase;
  resultReady: boolean;
}

interface LogEntry {
  id: number;
  time: string;
  message: string;
  tone: "quiet" | "pass" | "drop" | "warn";
}

type LiveAction =
  | { type: "event"; event: HarborEvent }
  | { type: "reveal-result" };

const DEMO_HARBOR: HarborState = {
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

const INITIAL_HARBOR: HarborState = {
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

const DEMO_BASELINE: HealthSnapshot = {
  recorded: true,
  success: true,
  latencyMs: 18,
  statusCode: 200,
};

const EMPTY_BASELINE: HealthSnapshot = {
  recorded: false,
  success: false,
  latencyMs: 0,
  statusCode: null,
};

const PHASES = [
  { short: "基準", label: "通常時を測る", code: "BASELINE" },
  { short: "負荷", label: "負荷を重ねる", code: "LOAD" },
  { short: "防御", label: "入口で分ける", code: "XDP" },
  { short: "結果", label: "前後を比べる", code: "RESULT" },
] as const;

function clampPhase(value: number): ExperimentPhase {
  return Math.max(0, Math.min(3, value)) as ExperimentPhase;
}

function liveExperimentReducer(
  state: LiveExperiment,
  action: LiveAction,
): LiveExperiment {
  if (action.type === "reveal-result") {
    if (!state.resultReady) return state;
    return { ...state, phase: 3 };
  }

  const event = action.event;

  if (event.type === "stats") {
    const mode =
      event.mode === "protect"
        ? "protect"
        : event.mode === "monitor"
          ? "monitor"
          : state.harbor.mode;
    const harbor = {
      ...state.harbor,
      mode,
      pps: Number(event.pps ?? state.harbor.pps),
      total: Number(event.total ?? state.harbor.total),
      passed: Number(event.pass ?? state.harbor.passed),
      dropped: Number(event.drop ?? state.harbor.dropped),
    };
    const phase =
      harbor.attackActive && mode === "protect"
        ? Math.max(state.phase, 2) as ExperimentPhase
        : state.phase;
    return { ...state, harbor, phase };
  }

  if (event.type === "traffic_health") {
    const health: HealthSnapshot = {
      recorded: true,
      success: Boolean(event.success),
      latencyMs: Number(event.latency_ms ?? 0),
      statusCode:
        event.status_code == null ? null : Number(event.status_code),
    };
    const harbor = {
      ...state.harbor,
      healthSuccess: health.success,
      latencyMs: health.latencyMs,
      statusCode: health.statusCode,
    };

    if (!state.harbor.attackActive) {
      return {
        harbor,
        baseline: health.success ? health : state.baseline,
        phase: 0,
        resultReady: false,
      };
    }

    if (state.harbor.mode === "protect") {
      return {
        ...state,
        harbor,
        phase: Math.max(state.phase, 2) as ExperimentPhase,
        resultReady: true,
      };
    }

    return { ...state, harbor, phase: 1 };
  }

  if (event.type === "attack_state") {
    const active = Boolean(event.active);
    const harbor = {
      ...state.harbor,
      attackActive: active,
      attackPps: Number(event.pps ?? 0),
      attackPackets: Number(
        event.packets_sent ?? state.harbor.attackPackets,
      ),
      attackPort: Number(event.dst_port ?? state.harbor.attackPort),
      target: event.target ?? state.harbor.target,
    };
    return {
      ...state,
      harbor,
      phase: active
        ? state.harbor.mode === "protect"
          ? 2
          : 1
        : 0,
      resultReady: false,
    };
  }

  if (event.type === "defense_mode") {
    const mode: HarborMode =
      event.mode === "protect" ? "protect" : "monitor";
    const harbor = {
      ...state.harbor,
      mode,
      attackPort: Number(
        event.blocked_udp_port ??
          event.dst_port ??
          state.harbor.attackPort,
      ),
    };
    return {
      ...state,
      harbor,
      phase: state.harbor.attackActive
        ? mode === "protect"
          ? 2
          : 1
        : 0,
      resultReady: false,
    };
  }

  return state;
}

function nowLabel() {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function formatCount(value: number) {
  return new Intl.NumberFormat("ja-JP").format(
    Math.max(0, Math.round(value)),
  );
}

function ShipMark() {
  return (
    <svg viewBox="0 0 220 72" aria-hidden="true">
      <path
        d="M10 44 Q16 57 28 60 L192 60 Q204 57 210 44 Z"
        className="ship-hull"
      />
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
        const x =
          values.length === 1 ? 100 : (index / (values.length - 1)) * 100;
        const y = 34 - Math.min(30, (value / max) * 30);
        return `${x},${y}`;
      })
      .join(" ");
  }, [values]);

  return (
    <svg
      className="latency-trace"
      viewBox="0 0 100 38"
      preserveAspectRatio="none"
      aria-label="直近のHTTP応答時間"
    >
      <line x1="0" y1="34" x2="100" y2="34" />
      {points && <polyline points={points} />}
    </svg>
  );
}

function PacketTrack({
  kind,
  count,
  active = true,
}: {
  kind: "http" | "load";
  count: number;
  active?: boolean;
}) {
  return (
    <div
      className={`packet-track packet-track--${kind} ${
        active ? "is-moving" : ""
      }`}
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, index) => (
        <i
          key={index}
          style={{ "--packet-index": index } as CSSProperties}
        />
      ))}
    </div>
  );
}

function JourneyMap({
  phase,
  harbor,
  baseline,
  dropRatio,
}: {
  phase: ExperimentPhase;
  harbor: HarborState;
  baseline: HealthSnapshot;
  dropRatio: number;
}) {
  const showLoad = phase >= 1;
  const defending = phase >= 2;
  const displayedHealth = phase === 0 && baseline.recorded
    ? baseline
    : {
        statusCode: harbor.statusCode,
        latencyMs: harbor.latencyMs,
      };

  return (
    <div className={`journey-map journey-map--phase-${phase + 1}`}>
      <div className="map-caption">
        <span>LIVE PACKET PATH</span>
        <strong>
          {phase === 0
            ? "HTTP応答を、比較の基準として記録"
            : "役割の違う2種類の通信が、同じ入口へ向かう"}
        </strong>
      </div>

      <div className="route route--http">
        <div className="route-origin">
          <small>Pi Aから確認</small>
          <strong>HTTP</strong>
          <em>TCP :8080</em>
        </div>
        <PacketTrack kind="http" count={4} />
        <div className="route-gate route-gate--http">
          <small>Pi B / NIC直後</small>
          <strong>XDP</strong>
          <em>{defending ? "PASS" : "観測"}</em>
        </div>
        <div className="route-after route-after--pass">
          <span>→</span>
        </div>
        <div className="route-destination route-destination--service">
          <small>守りたいサービス</small>
          <strong>HTTP :8080</strong>
          <em>{displayedHealth.statusCode ?? "—"} / {displayedHealth.latencyMs || "—"} ms</em>
        </div>
      </div>

      <div
        className={`route route--load ${showLoad ? "is-visible" : ""}`}
        aria-hidden={!showLoad}
      >
        <div className="route-origin">
          <small>Pi Aから追加</small>
          <strong>UDP負荷</strong>
          <em>:{harbor.attackPort} / {formatCount(harbor.attackPps)} pps</em>
        </div>
        <PacketTrack kind="load" count={9} active={showLoad} />
        <div className="route-gate route-gate--load">
          <small>同じ入口</small>
          <strong>XDP</strong>
          <em>{defending ? "DROP" : "観測"}</em>
        </div>
        <div
          className={`route-after ${
            defending ? "route-after--blocked" : "route-after--open"
          }`}
        >
          <span>{defending ? "×" : "→"}</span>
        </div>
        <div
          className={`route-destination ${
            defending
              ? "route-destination--drop"
              : "route-destination--load"
          }`}
        >
          <small>{defending ? "アプリへ届く前に" : "防御前"}</small>
          <strong>{defending ? "遮断" : "到着"}</strong>
          <em>
            {defending
              ? `全観測packetの${dropRatio.toFixed(1)}%`
              : "HTTP監視は継続"}
          </em>
        </div>
      </div>

      <div className="map-legend" aria-label="通信の役割">
        <span><i className="legend-mark legend-mark--http" />HTTP = 守れたかを測る</span>
        {showLoad && (
          <span><i className="legend-mark legend-mark--load" />UDP = 意図的に加える負荷</span>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const demo = isWebDemo();
  const [streamStatus, setStreamStatus] = useState(
    demo ? "sample" : "waiting",
  );
  const [live, dispatchLive] = useReducer(liveExperimentReducer, {
    harbor: demo ? DEMO_HARBOR : INITIAL_HARBOR,
    baseline: demo ? DEMO_BASELINE : EMPTY_BASELINE,
    phase: 0,
    resultReady: false,
  });
  const [demoPhase, setDemoPhase] = useState<ExperimentPhase>(0);
  const [autoplay, setAutoplay] = useState(true);
  const [latencies, setLatencies] = useState<number[]>(
    demo ? [18, 17, 16, 15, 16, 14, 14] : [],
  );
  const [showDetails, setShowDetails] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      id: 1,
      time: "--:--:--",
      message: demo
        ? "実機デモで取得した値のサンプルを再生しています。"
        : "2台のRaspberry Piからのイベントを待っています。",
      tone: "quiet",
    },
  ]);

  const phase = clampPhase(demo ? demoPhase : live.phase);
  const harbor = live.harbor;
  const baseline = live.baseline;
  const displayMode: HarborMode =
    demo && phase < 2 ? "monitor" : harbor.mode;
  const dropRatio =
    harbor.total > 0 ? (harbor.dropped / harbor.total) * 100 : 0;
  const serviceMaintained =
    harbor.healthSuccess && harbor.statusCode === 200;
  const latencyDelta =
    baseline.recorded && harbor.latencyMs > 0
      ? harbor.latencyMs - baseline.latencyMs
      : null;

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
      ].slice(0, 5),
    );
  }

  function chooseDemoPhase(next: number, pause = true) {
    if (!demo) return;
    setDemoPhase(clampPhase(next));
    if (pause) setAutoplay(false);
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
        dispatchLive({ type: "event", event });

        if (event.type === "traffic_health") {
          const latency = Number(event.latency_ms ?? 0);
          setLatencies(current => [...current, latency].slice(-30));
          if (!event.success) {
            addLog("HTTP :8080の応答を確認できません。", "warn");
          }
          return;
        }

        if (event.type === "attack_state") {
          addLog(
            event.active
              ? `UDP :${event.dst_port ?? 4000}のテスト負荷を開始。`
              : "UDPテスト負荷を停止。",
            event.active ? "warn" : "quiet",
          );
          return;
        }

        if (event.type === "defense_mode") {
          addLog(
            event.mode === "protect"
              ? `XDPでUDP :${event.blocked_udp_port ?? 4000}を遮断。`
              : "XDPを観測のみの状態へ変更。",
            event.mode === "protect" ? "drop" : "quiet",
          );
          return;
        }

        if (
          event.type === "flow" &&
          (event.action === "DROP" || event.protocol === "TCP")
        ) {
          const route = `${event.src ?? "?"}:${event.src_port ?? "?"} → ${
            event.dst ?? "?"
          }:${event.dst_port ?? "?"}`;
          addLog(
            `${event.protocol ?? "IP"} ${route} / ${
              event.action ?? "PASS"
            }`,
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
      if (subscription.mode === "web") setStreamStatus("sample");
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!demo || !autoplay || showDetails) return;
    const timer = window.setTimeout(() => {
      setDemoPhase(current => ((current + 1) % 4) as ExperimentPhase);
    }, 6200);
    return () => window.clearTimeout(timer);
  }, [autoplay, demo, demoPhase, showDetails]);

  useEffect(() => {
    if (demo || live.phase !== 2 || !live.resultReady) return;
    const timer = window.setTimeout(() => {
      dispatchLive({ type: "reveal-result" });
    }, 2200);
    return () => window.clearTimeout(timer);
  }, [demo, live.phase, live.resultReady]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowDetails(false);
        return;
      }
      if (event.key.toLowerCase() === "d") {
        setShowDetails(current => !current);
        return;
      }
      if (!demo || showDetails) return;
      if (event.key === "ArrowRight") {
        chooseDemoPhase(phase + 1);
      }
      if (event.key === "ArrowLeft") {
        chooseDemoPhase(phase - 1);
      }
      if (event.key === " ") {
        event.preventDefault();
        setAutoplay(current => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [demo, phase, showDetails]);

  return (
    <div className="booth-app">
      <header className="booth-header">
        <div className="brand">
          <div className="brand-ship"><ShipMark /></div>
          <div>
            <div className="brand-name">PACKET JOURNEY</div>
            <div className="brand-sub">Raspberry Pi × Rust × eBPF/XDP</div>
          </div>
        </div>

        <div className="header-status">
          <span className={demo ? "sample-badge" : "live-badge"}>
            {demo ? "SAMPLE DATA" : "LIVE"}
          </span>
          <div>
            <small>XDP MODE</small>
            <strong>{displayMode.toUpperCase()}</strong>
          </div>
          <div>
            <small>EVENT STREAM</small>
            <strong>{streamStatus.toUpperCase()}</strong>
          </div>
          <button type="button" onClick={() => setShowDetails(true)}>
            技術詳細 <kbd>D</kbd>
          </button>
        </div>
      </header>

      <main className="booth-screen">
        <section className="experiment-question">
          <div>
            <span>この実験で確かめること</span>
            <h1>
              同じ入口へテスト負荷を流しても、
              <strong>HTTPサービスを守れるか。</strong>
            </h1>
          </div>
          <p>
            {demo
              ? "公開ページでは、実機で得られる値のサンプルを順に再生します。"
              : "表示値は、2台のRaspberry PiとXDPから届いた実測値です。"}
          </p>
        </section>

        <ol className="phase-strip" aria-label="実験の進行">
          {PHASES.map((item, index) => (
            <li
              key={item.code}
              className={`${index < phase ? "is-complete" : ""} ${
                index === phase ? "is-active" : ""
              }`}
            >
              <button
                type="button"
                onClick={() => chooseDemoPhase(index)}
                disabled={!demo}
                aria-current={index === phase ? "step" : undefined}
              >
                <span>{index + 1}</span>
                <div>
                  <small>{item.short}</small>
                  <strong>{item.label}</strong>
                </div>
                {demo && index === phase && autoplay && !showDetails && (
                  <i className="phase-progress" key={`progress-${phase}`} />
                )}
              </button>
            </li>
          ))}
        </ol>

        <section className={`stage stage--${phase + 1}`} aria-live="polite">
          <div className="stage-copy">
            <span className="stage-code">
              STEP 0{phase + 1} / {PHASES[phase].code}
            </span>

            {phase === 0 && (
              <>
                <h2>負荷を加える前の、<br />HTTP応答を記録する。</h2>
                <p>
                  Pi AからPi BのHTTPサービスへGETを送ります。
                  この値が、あとで負荷中の応答と比べる基準です。
                </p>
                <div className="focus-callout focus-callout--http">
                  <small>ここで見る値</small>
                  <strong>{baseline.statusCode ?? harbor.statusCode ?? "—"}</strong>
                  <span>{baseline.latencyMs || harbor.latencyMs || "—"} ms</span>
                  <em>通常時のHTTP GET</em>
                </div>
              </>
            )}

            {phase === 1 && (
              <>
                <h2>HTTPを測り続けたまま、<br />UDP負荷を重ねる。</h2>
                <p>
                  UDPとHTTPの性能比較ではありません。
                  UDPは意図的に加える負荷、HTTPはサービスが動いているかを見る測定役です。
                </p>
                <div className="focus-callout focus-callout--load">
                  <small>新しく加えた条件</small>
                  <strong>{formatCount(harbor.attackPps)}</strong>
                  <span>pps</span>
                  <em>UDP :{harbor.attackPort}</em>
                </div>
              </>
            )}

            {phase === 2 && (
              <>
                <h2>同じ入口で、<br />XDPが通信を選別する。</h2>
                <p>
                  指定したUDPだけを、network stackやアプリへ届く前に破棄。
                  HTTPは遮断対象ではないため、そのまま通過します。
                </p>
                <div className="focus-callout focus-callout--drop">
                  <small>カーネルでの処理</small>
                  <strong>{formatCount(harbor.dropped)}</strong>
                  <span>packets</span>
                  <em>XDP_DROP / per-CPU map</em>
                </div>
              </>
            )}

            {phase === 3 && (
              <>
                <h2>
                  {serviceMaintained
                    ? "負荷中も、同じHTTPが応答した。"
                    : "負荷中のHTTP応答を確認できない。"}
                </h2>
                <p>
                  通常時と負荷中で、同じURLのstatusとレイテンシを比較します。
                  防御の成否は、UDPを止めた数だけでは決めません。
                </p>
                <div
                  className={`verdict ${
                    serviceMaintained ? "verdict--success" : "verdict--failure"
                  }`}
                >
                  <small>実験結果</small>
                  <strong>
                    {serviceMaintained ? "HTTP応答を維持" : "HTTP応答なし"}
                  </strong>
                  <span>
                    {harbor.statusCode ?? "—"} / {harbor.latencyMs || "—"} ms
                  </span>
                </div>
              </>
            )}
          </div>

          <div className="stage-visual">
            {phase < 3 ? (
              <JourneyMap
                phase={phase}
                harbor={harbor}
                baseline={baseline}
                dropRatio={dropRatio}
              />
            ) : (
              <div className="result-board">
                <div className="comparison-title">
                  <span>SAME HTTP ENDPOINT</span>
                  <strong>負荷の前後で、同じものを測る</strong>
                </div>

                <div className="comparison">
                  <article>
                    <span>BEFORE / 通常時</span>
                    <strong>{baseline.statusCode ?? "—"}</strong>
                    <em>{baseline.latencyMs || "—"} ms</em>
                    <small>HTTP GET :8080</small>
                  </article>
                  <div className="comparison-arrow">→</div>
                  <article className={serviceMaintained ? "is-success" : "is-failure"}>
                    <span>DURING LOAD / 負荷中</span>
                    <strong>{harbor.statusCode ?? "—"}</strong>
                    <em>{harbor.latencyMs || "—"} ms</em>
                    <small>
                      {latencyDelta == null
                        ? "差分を計測中"
                        : `通常時との差 ${latencyDelta >= 0 ? "+" : ""}${latencyDelta} ms`}
                    </small>
                  </article>
                </div>

                <div className="causal-proof" aria-label="結果を支える実測値">
                  <div>
                    <small>加えた負荷</small>
                    <strong>{formatCount(harbor.attackPps)} <em>pps</em></strong>
                    <span>traffic-node</span>
                  </div>
                  <b>→</b>
                  <div>
                    <small>入口で破棄</small>
                    <strong>{dropRatio.toFixed(1)}<em>%</em></strong>
                    <span>XDP_DROP / 全観測packet比</span>
                  </div>
                  <b>→</b>
                  <div className="causal-proof__result">
                    <small>サービスの応答</small>
                    <strong>{harbor.statusCode ?? "—"} <em>/ {harbor.latencyMs || "—"}ms</em></strong>
                    <span>実HTTP GET</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        <footer className="demo-controls">
          <div>
            <span>{phase + 1} / 4</span>
            <strong>{PHASES[phase].label}</strong>
          </div>
          {demo ? (
            <nav aria-label="サンプル再生操作">
              <button
                type="button"
                onClick={() => chooseDemoPhase(phase - 1)}
                disabled={phase === 0}
              >
                ← 前へ
              </button>
              <button
                type="button"
                className="autoplay-button"
                onClick={() => setAutoplay(current => !current)}
              >
                {autoplay ? "一時停止" : "自動再生"}
                <kbd>Space</kbd>
              </button>
              <button
                type="button"
                onClick={() => chooseDemoPhase(phase + 1)}
                disabled={phase === 3}
              >
                次へ →
              </button>
            </nav>
          ) : (
            <p>実機イベントに合わせて画面が進みます</p>
          )}
        </footer>
      </main>

      {showDetails && (
        <div
          className="details-backdrop"
          role="presentation"
          onMouseDown={() => setShowDetails(false)}
        >
          <section
            className="details-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="details-title"
            onMouseDown={event => event.stopPropagation()}
          >
            <header>
              <div>
                <span>TECHNICAL DETAILS</span>
                <h2 id="details-title">画面の結論を、どこから得ているか</h2>
              </div>
              <button type="button" onClick={() => setShowDetails(false)}>
                閉じる <kbd>Esc</kbd>
              </button>
            </header>

            <div className="details-grid">
              <article>
                <span>構成</span>
                <h3>Raspberry Pi 2台</h3>
                <p>
                  Pi Aの<code>traffic-node</code>がPi BへUDP負荷を送りながら、
                  同じPi B上のHTTP :8080へGETを続けます。
                </p>
              </article>
              <article>
                <span>役割</span>
                <h3>条件と結果を分ける</h3>
                <dl>
                  <div><dt>実験条件</dt><dd>UDP :{harbor.attackPort}</dd></div>
                  <div><dt>結果指標</dt><dd>HTTP :8080</dd></div>
                </dl>
                <p>UDP一般を危険な通信として扱っているわけではありません。</p>
              </article>
              <article>
                <span>遮断位置</span>
                <h3>アプリより手前</h3>
                <div className="mini-path">
                  <b>NIC</b><i />XDP<i />network stack<i />app
                </div>
                <p>
                  指定UDPはLinux network stackへ入る前に
                  <code>XDP_DROP</code>されます。
                </p>
              </article>
              <article>
                <span>カウンタ</span>
                <h3>per-CPU BPF map</h3>
                <dl>
                  <div><dt>XDP_PASS</dt><dd>{formatCount(harbor.passed)}</dd></div>
                  <div><dt>XDP_DROP</dt><dd>{formatCount(harbor.dropped)}</dd></div>
                  <div><dt>入口の流量</dt><dd>{formatCount(harbor.pps)} pps</dd></div>
                </dl>
                <p>DROP率は、入口で観測した全packetに対する比率です。</p>
              </article>
              <article>
                <span>サービス確認</span>
                <h3>1秒ごとの実HTTP GET</h3>
                <p>
                  status codeとレイテンシを通常時・負荷中で同じ方法により測定します。
                </p>
                <LatencyTrace values={latencies} />
              </article>
              <article>
                <span>直近のイベント</span>
                <h3>NDJSON stream</h3>
                <ol className="details-log">
                  {logs.slice(0, 4).map(entry => (
                    <li className={`log--${entry.tone}`} key={entry.id}>
                      <time>{entry.time}</time>
                      <span>{entry.message}</span>
                    </li>
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
