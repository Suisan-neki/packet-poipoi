import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
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
  { short: "送信", label: "HTTPを送る", code: "HTTP" },
  { short: "追加", label: "UDPも送る", code: "UDP" },
  { short: "判定", label: "XDPで選別", code: "XDP" },
  { short: "証拠", label: "実測値を確認", code: "PROOF" },
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
      role="img"
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
}: {
  phase: ExperimentPhase;
  harbor: HarborState;
  baseline: HealthSnapshot;
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
            ? "まず、HTTP :8080の経路を追う"
            : phase === 1
              ? "同じPi BのNICへ、UDP :4000も送る"
              : phase === 2
                ? "XDPがprotocolと宛先portを見て判定"
                : "3つの実測値で、選別結果を確認"}
        </strong>
      </div>

      <div className="route route--http">
        <div className={`route-origin ${phase === 0 ? "is-focus" : ""}`}>
          <small>Raspberry Pi A / 送信</small>
          <strong>HTTP GET</strong>
          <em>TCP → :8080</em>
        </div>
        <PacketTrack kind="http" count={4} />
        <div className={`route-gate route-gate--http ${phase === 2 ? "is-focus" : ""}`}>
          <small>Raspberry Pi B / NIC直後</small>
          <strong>XDP</strong>
          <em>{defending ? "XDP_PASS" : "MONITOR / PASS"}</em>
        </div>
        <div className="route-after route-after--pass">
          <span>→</span>
        </div>
        <div className={`route-destination route-destination--service ${phase === 3 ? "is-focus" : ""}`}>
          <small>Pi B / アプリ</small>
          <strong>HTTP :8080</strong>
          <em>{displayedHealth.statusCode ?? "—"} / {displayedHealth.latencyMs || "—"} ms</em>
        </div>
      </div>

      <div
        className={`route route--load ${showLoad ? "is-visible" : ""}`}
        aria-hidden={!showLoad}
      >
        <div className={`route-origin ${phase === 1 ? "is-focus" : ""}`}>
          <small>Raspberry Pi A / 追加送信</small>
          <strong>テストUDP</strong>
          <em>:{harbor.attackPort} / {formatCount(harbor.attackPps)} pps</em>
        </div>
        <PacketTrack kind="load" count={9} active={showLoad} />
        <div className={`route-gate route-gate--load ${phase === 2 ? "is-focus" : ""}`}>
          <small>HTTPと同じNIC</small>
          <strong>XDP</strong>
          <em>{defending ? "RULE MATCH" : "MONITOR / PASS"}</em>
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
          } ${phase === 3 ? "is-focus" : ""}`}
        >
          <small>{defending ? "network stackへ入る前" : "MONITORモード"}</small>
          <strong>{defending ? "XDP_DROP" : "XDP_PASS"}</strong>
          <em>
            {defending
              ? `${formatCount(harbor.dropped)} packets`
              : "この段階ではまだ通す"}
          </em>
        </div>
      </div>

      <div className="map-legend" aria-label="通信の役割">
        <span><i className="legend-mark legend-mark--http" />HTTP :8080 = 通す通信</span>
        {showLoad && (
          <span><i className="legend-mark legend-mark--load" />UDP :{harbor.attackPort} = 止める通信</span>
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
  const [autoplay, setAutoplay] = useState(() =>
    typeof window === "undefined"
      ? true
      : !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [latencies, setLatencies] = useState<number[]>(
    demo ? [18, 17, 16, 15, 16, 14, 14] : [],
  );
  const [showDetails, setShowDetails] = useState(false);
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  const closeDetailsButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
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
  const serviceMaintained =
    harbor.healthSuccess && harbor.statusCode === 200;
  const phaseHeadline =
    phase === 0
      ? "まず、HTTPだけを送る。"
      : phase === 1
        ? "次に、同じPi BへUDPも送る。"
        : phase === 2
          ? "XDPが、2種類の通信を見分ける。"
          : serviceMaintained
            ? "UDPは止まり、HTTPは届いた。"
            : "HTTPの到達を確認できない。";
  const phaseDescription =
    phase === 0
      ? "Pi AからPi BのHTTP :8080へGETを送ります。この通信は、最後まで通したい側です。"
      : phase === 1
        ? `HTTPを送り続けたまま、テスト用UDP :${harbor.attackPort}を同じNICへ追加します。UDPとHTTPの性能比較ではありません。`
        : phase === 2
          ? `ルールは1つです。UDPかつ宛先portが${harbor.attackPort}ならDROP。それ以外はPASSします。`
          : "UDP送信量、XDP_DROP、実HTTP GETの3つを別々の取得元から確認します。";
  const phaseFocus =
    phase === 0
      ? "HTTPの送信元"
      : phase === 1
        ? "同じNICへ追加するUDP"
        : phase === 2
          ? "NIC直後のXDP"
          : "送信・判定・到達の実測値";

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

  function openDetails() {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : detailsButtonRef.current;
    setShowDetails(true);
  }

  function closeDetails() {
    setShowDetails(false);
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
    if (showDetails) {
      closeDetailsButtonRef.current?.focus();
      return;
    }

    previousFocusRef.current?.focus();
  }, [showDetails]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeDetails();
        return;
      }

      if (showDetails) {
        if (event.key === "Tab") {
          event.preventDefault();
          closeDetailsButtonRef.current?.focus();
        }
        return;
      }

      const target = event.target;
      const isInteractive =
        target instanceof HTMLElement &&
        Boolean(
          target.closest(
            "button, a, input, select, textarea, [contenteditable='true']",
          ),
        );
      if (
        isInteractive ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }

      if (event.key.toLowerCase() === "d") {
        openDetails();
        return;
      }
      if (!demo) return;
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
          <button ref={detailsButtonRef} type="button" onClick={openDetails}>
            技術詳細 <kbd>D</kbd>
          </button>
        </div>
      </header>

      <main className="booth-screen">
        <section className="experiment-question">
          <div>
            <span>この実験で確かめること</span>
            <h1>
              同じNICへ届く2種類の通信を、
              <strong>アプリの手前で選別できるか。</strong>
            </h1>
          </div>
          <div className="question-rule" aria-label="この実験の選別ルール">
            <small>今回のルール</small>
            <strong><i className="rule-mark rule-mark--pass" />HTTP :8080 は通す</strong>
            <strong><i className="rule-mark rule-mark--drop" />UDP :{harbor.attackPort} は止める</strong>
          </div>
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

        <section className={`stage stage--${phase + 1}`}>
          <header className="stage-heading">
            <div className="stage-heading__index">
              <span className="stage-code">
                STEP 0{phase + 1} / {PHASES[phase].code}
              </span>
              <small>いま見る場所</small>
              <strong>{phaseFocus}</strong>
            </div>
            <div className="stage-heading__copy">
              <h2>{phaseHeadline}</h2>
              <p>{phaseDescription}</p>
            </div>
            <span className="sr-only" aria-live="polite">
              {PHASES[phase].label}: {phaseHeadline}
            </span>
          </header>

          <div className="stage-visual">
            <JourneyMap
              phase={phase}
              harbor={harbor}
              baseline={baseline}
            />
          </div>

          <div className="stage-evidence" aria-label="この段階の観測値">
            <div className={phase === 0 ? "is-current" : ""}>
              <small>1 / HTTPを送信</small>
              <strong>GET :8080</strong>
              <span>{baseline.statusCode ?? harbor.statusCode ?? "—"} / {baseline.latencyMs || harbor.latencyMs || "—"} ms</span>
            </div>
            <b>→</b>
            <div className={phase === 1 ? "is-current" : ""}>
              <small>2 / UDPも送信</small>
              <strong>{phase >= 1 ? `${formatCount(harbor.attackPps)} pps` : "待機中"}</strong>
              <span>UDP :{harbor.attackPort}</span>
            </div>
            <b>→</b>
            <div className={phase === 2 ? "is-current" : ""}>
              <small>3 / XDPで判定</small>
              <strong>{phase >= 2 ? "XDP_DROP" : "MONITOR"}</strong>
              <span>{phase >= 2 ? `${formatCount(harbor.dropped)} packets` : "まだ遮断しない"}</span>
            </div>
            <b>→</b>
            <div className={`${phase === 3 ? "is-current" : ""} ${serviceMaintained ? "is-success" : ""}`}>
              <small>4 / HTTPの到達</small>
              <strong>{phase === 3 ? harbor.statusCode ?? "—" : "確認中"}</strong>
              <span>{phase === 3 ? `${harbor.latencyMs || "—"} ms / 実HTTP GET` : "最後に確認"}</span>
            </div>
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
          onMouseDown={closeDetails}
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
              <button
                ref={closeDetailsButtonRef}
                type="button"
                onClick={closeDetails}
              >
                閉じる <kbd>Esc</kbd>
              </button>
            </header>

            <div className="details-grid">
              <article>
                <span>構成</span>
                <h3>Raspberry Pi 2台</h3>
                <p>
                  Pi Aの<code>traffic-node</code>が、Pi B上のHTTP :8080へ
                  GETを続けながら、同じNICへテストUDPを送ります。
                </p>
              </article>
              <article>
                <span>役割</span>
                <h3>通す通信と止める通信</h3>
                <dl>
                  <div><dt>XDP_PASS</dt><dd>HTTP :8080</dd></div>
                  <div><dt>XDP_DROP</dt><dd>UDP :{harbor.attackPort}</dd></div>
                </dl>
                <p>UDP一般ではなく、宛先portが一致したテスト通信だけを止めます。</p>
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
                  status codeとレイテンシを1秒ごとに測定し、
                  XDP選別中もHTTPがPi Bへ届くことを確認します。
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
