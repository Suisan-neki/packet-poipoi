import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { isWebDemo, subscribeStream } from "../stream.js";

type DropPoint = "application" | "netfilter" | "xdp";
type ExperimentPhase = 0 | 1 | 2 | 3;

interface ExperimentEnvironment {
  receiver_model: string;
  kernel_release: string;
  network_interface: string;
  mtu: number | null;
  cpu_governor: string;
}

interface ExperimentRun {
  experiment_id: string;
  run_id: string;
  repetition: number;
  drop_point: DropPoint;
  duration_ms: number;
  target_pps: number;
  payload_bytes: number;
  packets_sent: number;
  packets_received_by_app: number;
  cpu_busy_percent: number;
  net_rx_softirq_delta: number;
  xdp_attach_mode: "native" | "generic" | "not_used" | "unknown";
  environment?: ExperimentEnvironment;
}

interface HarborEvent extends Partial<ExperimentRun> {
  type?: string;
  success?: boolean;
  latency_ms?: number;
  status_code?: number;
  attach_mode?: string;
}

interface ConditionSummary {
  dropPoint: DropPoint;
  label: string;
  location: string;
  cpuPercent: number;
  cpuRange: [number, number];
  softirqPer10k: number;
  softirqRange: [number, number];
  appReceivePercent: number;
  appReceiveRange: [number, number];
  repetitions: number;
  attachMode: string;
}

interface HealthState {
  success: boolean;
  latencyMs: number;
  statusCode: number | null;
}

const PHASES = [
  {
    label: "アプリで捨てる",
    short: "基準",
    code: "APPLICATION",
    dropPoint: "application",
  },
  {
    label: "nftablesで捨てる",
    short: "カーネル",
    code: "NETFILTER",
    dropPoint: "netfilter",
  },
  {
    label: "XDPで捨てる",
    short: "入口",
    code: "XDP",
    dropPoint: "xdp",
  },
  {
    label: "3条件を比べる",
    short: "結果",
    code: "COMPARE",
    dropPoint: null,
  },
] as const;

const CONDITION_COPY: Record<
  DropPoint,
  {
    eyebrow: string;
    title: string;
    description: string;
    focus: string;
  }
> = {
  application: {
    eyebrow: "基準 / 全経路を通す",
    title: "まず、パケットをアプリまで届けて捨てる。",
    description:
      "NIC、XDP、network stackを通り、UDP socketで受信します。これを「全部処理した」基準にします。",
    focus: "右の経路が、最後までつながっているところ",
  },
  netfilter: {
    eyebrow: "比較1 / network stack内",
    title: "次に、同じ負荷をnftablesで止める。",
    description:
      "送信条件は変えません。パケットはnetwork stackへ入りますが、UDP socketへ届く前に破棄されます。",
    focus: "network stackの中にある停止位置",
  },
  xdp: {
    eyebrow: "比較2 / driver entry",
    title: "最後に、同じ負荷をXDPで入口から止める。",
    description:
      "同じUDPだけを、network stackへ入る前に破棄します。実際のattach modeも結果へ残します。",
    focus: "NIC直後で経路が終わるところ",
  },
};

// GitHub Pagesで画面の読み方だけを確認するためのfixture。
// ベンチマーク値として引用されないよう、画面上でも明示する。
const FIXTURE_RUNS: ExperimentRun[] = [
  ["application", 62.4, 10_450, 99.6, "not_used"],
  ["netfilter", 41.7, 8_420, 0, "not_used"],
  ["xdp", 18.9, 2_180, 0, "native"],
].flatMap(([dropPoint, cpu, softirq, app, attach]) =>
  [1, 2, 3].map(repetition => ({
    experiment_id: "ui-fixture",
    run_id: `ui-fixture-${dropPoint}-${repetition}`,
    repetition,
    drop_point: dropPoint as DropPoint,
    duration_ms: 15_000,
    target_pps: 2_000,
    payload_bytes: 128,
    packets_sent: 30_000,
    packets_received_by_app: Math.round(30_000 * Number(app) / 100),
    cpu_busy_percent: Number(cpu) + (repetition - 2) * 0.7,
    net_rx_softirq_delta:
      Math.round(Number(softirq) * 3) + (repetition - 2) * 180,
    xdp_attach_mode: attach as ExperimentRun["xdp_attach_mode"],
    environment: {
      receiver_model: "Raspberry Pi 5 Model B Rev 1.0",
      kernel_release: "6.6.51+rpt-rpi-2712",
      network_interface: "eth0",
      mtu: 1500,
      cpu_governor: "performance",
    },
  })),
);

const DEFAULT_HEALTH: HealthState = {
  success: true,
  latencyMs: 14,
  statusCode: 200,
};

const LAYERS = [
  { id: "nic", label: "NIC", sub: "受信" },
  { id: "xdp", label: "XDP", sub: "driver entry" },
  { id: "stack", label: "network stack", sub: "Linux kernel" },
  { id: "netfilter", label: "nftables", sub: "filter hook" },
  { id: "application", label: "UDP socket", sub: "userspace" },
] as const;

function clampPhase(value: number): ExperimentPhase {
  return Math.max(0, Math.min(3, value)) as ExperimentPhase;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function minMax(values: number[]): [number, number] {
  if (values.length === 0) return [0, 0];
  return [Math.min(...values), Math.max(...values)];
}

function summarizeRuns(runs: ExperimentRun[]): ConditionSummary[] {
  return (["application", "netfilter", "xdp"] as DropPoint[]).map(
    dropPoint => {
      const conditionRuns = runs.filter(run => run.drop_point === dropPoint);
      const representative = conditionRuns.at(-1);
      const cpuValues = conditionRuns.map(run => run.cpu_busy_percent);
      const softirqValues = conditionRuns.map(run =>
        run.packets_sent === 0
          ? 0
          : run.net_rx_softirq_delta * 10_000 / run.packets_sent,
      );
      const appValues = conditionRuns.map(run =>
        run.packets_sent === 0
          ? 0
          : run.packets_received_by_app * 100 / run.packets_sent,
      );
      return {
        dropPoint,
        label:
          dropPoint === "application"
            ? "Application"
            : dropPoint === "netfilter"
              ? "nftables"
              : "XDP",
        location:
          dropPoint === "application"
            ? "userspace"
            : dropPoint === "netfilter"
              ? "network stack"
              : "driver entry",
        cpuPercent: median(cpuValues),
        cpuRange: minMax(cpuValues),
        softirqPer10k: median(softirqValues),
        softirqRange: minMax(softirqValues),
        appReceivePercent: median(appValues),
        appReceiveRange: minMax(appValues),
        repetitions: conditionRuns.length,
        attachMode: representative?.xdp_attach_mode ?? "unknown",
      };
    },
  );
}

function formatNumber(value: number, digits = 0) {
  return new Intl.NumberFormat("ja-JP", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function formatRange(
  [minimum, maximum]: [number, number],
  digits = 1,
  suffix = "",
) {
  return `${formatNumber(minimum, digits)}–${formatNumber(maximum, digits)}${suffix}`;
}

function predictionLabel(dropPoint: DropPoint | null) {
  if (dropPoint === "application") return "Application";
  if (dropPoint === "netfilter") return "nftables";
  if (dropPoint === "xdp") return "XDP";
  return "未回答";
}

function ShipMark() {
  return (
    <svg viewBox="0 0 220 72" aria-hidden="true">
      <path d="M10 44 Q16 57 28 60 L192 60 Q204 57 210 44 Z" />
      <rect x="26" y="37" width="168" height="7" />
      <rect x="128" y="20" width="42" height="17" />
      <rect x="160" y="8" width="8" height="13" />
      <line x1="116" y1="8" x2="116" y2="37" />
      <rect x="32" y="28" width="24" height="9" />
      <rect x="60" y="28" width="24" height="9" />
      <rect x="88" y="28" width="24" height="9" />
    </svg>
  );
}

function LayerPath({ dropPoint }: { dropPoint: DropPoint }) {
  const stopIndex =
    dropPoint === "xdp" ? 1 : dropPoint === "netfilter" ? 3 : 4;
  return (
    <div className={`layer-path layer-path--${dropPoint}`}>
      <div className="packet-source">
        <span>同じ入力</span>
        <strong>UDP :4000</strong>
        <em>2,000 pps · 128 B</em>
      </div>
      <div className="layer-sequence" aria-label="Linuxの受信経路">
        {LAYERS.map((layer, index) => {
          const reached = index <= stopIndex;
          const stopped = index === stopIndex;
          return (
            <div className="layer-unit" key={layer.id}>
              {index > 0 && (
                <div className={`path-link ${reached ? "is-reached" : ""}`}>
                  <i style={{ "--link-index": index } as CSSProperties} />
                </div>
              )}
              <div
                className={`layer-card ${reached ? "is-reached" : ""} ${
                  stopped ? "is-stop" : ""
                }`}
              >
                <small>{layer.sub}</small>
                <strong>{layer.label}</strong>
                {stopped && (
                  <span>
                    {dropPoint === "application" ? "RECEIVE" : "DROP"}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="path-reading">
        <span>この条件で変えるのは</span>
        <strong>
          {dropPoint === "application"
            ? "アプリまで処理させる"
            : dropPoint === "netfilter"
              ? "カーネル内で止める"
              : "入口で止める"}
        </strong>
      </div>
    </div>
  );
}

function PredictionIntro({
  onChoose,
  onSkip,
}: {
  onChoose: (dropPoint: DropPoint) => void;
  onSkip: () => void;
}) {
  const choices: Array<{
    dropPoint: DropPoint;
    label: string;
    location: string;
  }> = [
    {
      dropPoint: "application",
      label: "Application",
      location: "全部通してから捨てる",
    },
    {
      dropPoint: "netfilter",
      label: "nftables",
      location: "カーネルの途中で捨てる",
    },
    {
      dropPoint: "xdp",
      label: "XDP",
      location: "NIC直後で捨てる",
    },
  ];

  return (
    <div className="prediction-backdrop">
      <section className="prediction-panel" aria-labelledby="prediction-title">
        <span>BEFORE THE DEMO / まず予想する</span>
        <h2 id="prediction-title">
          同じpacketなら、
          <strong>どこで捨てるとPiの仕事が最も減る？</strong>
        </h2>
        <p>
          変えるのは停止位置だけです。予想を1つ選ぶと、
          同じ負荷を3つの経路で順に測ります。
        </p>
        <div className="prediction-choices">
          {choices.map((choice, index) => (
            <button
              type="button"
              key={choice.dropPoint}
              onClick={() => onChoose(choice.dropPoint)}
            >
              <b>0{index + 1}</b>
              <span>
                <strong>{choice.label}</strong>
                <small>{choice.location}</small>
              </span>
            </button>
          ))}
        </div>
        <button className="prediction-skip" type="button" onClick={onSkip}>
          予想せず実験を見る →
        </button>
      </section>
    </div>
  );
}

function ConditionStage({
  dropPoint,
  summary,
}: {
  dropPoint: DropPoint;
  summary: ConditionSummary;
}) {
  const copy = CONDITION_COPY[dropPoint];
  return (
    <div className="condition-stage">
      <section className="stage-copy">
        <span>{copy.eyebrow}</span>
        <h2>{copy.title}</h2>
        <p>{copy.description}</p>
        <div className="look-here">
          <small>まず、ここを見る</small>
          <strong>{copy.focus}</strong>
        </div>
      </section>

      <section className="stage-path">
        <LayerPath dropPoint={dropPoint} />
        <div className="condition-metrics">
          <div>
            <small>CPU busy · 中央値</small>
            <strong>{formatNumber(summary.cpuPercent, 1)}%</strong>
            <em>{formatRange(summary.cpuRange, 1, "%")}</em>
          </div>
          <div>
            <small>NET_RX / 1万packet</small>
            <strong>{formatNumber(summary.softirqPer10k)}</strong>
            <em>{formatRange(summary.softirqRange, 0)}</em>
          </div>
          <div>
            <small>アプリへ到達 · 中央値</small>
            <strong>{formatNumber(summary.appReceivePercent, 1)}%</strong>
            <em>{formatRange(summary.appReceiveRange, 1, "%")}</em>
          </div>
          <div>
            <small>{dropPoint === "xdp" ? "実attach mode" : "反復"}</small>
            <strong>
              {dropPoint === "xdp"
                ? summary.attachMode
                : `${summary.repetitions} runs`}
            </strong>
            <em>{dropPoint === "xdp" ? `${summary.repetitions} runs` : "中央値 / min–max"}</em>
          </div>
        </div>
      </section>
    </div>
  );
}

function CompareStage({
  summaries,
  prediction,
}: {
  summaries: ConditionSummary[];
  prediction: DropPoint | null;
}) {
  const completedSummaries = summaries.filter(summary => summary.repetitions > 0);
  const hasCompletedRun = completedSummaries.length > 0;
  const bestCpu = Math.min(...completedSummaries.map(item => item.cpuPercent));
  const measuredBest =
    (hasCompletedRun
      ? summaries.find(summary => summary.cpuPercent === bestCpu)?.dropPoint
      : null) ?? null;
  return (
    <div className="compare-stage">
      <section className="compare-heading">
        <div>
          <span>RESULT / 同じ入力、違う停止位置</span>
          <h2>「何を捨てたか」ではなく、「どこで捨てたか」を比べる。</h2>
        </div>
        <p>
          送信レート・payload・時間を固定し、3回ずつ測定。
          CPUとNET_RX softirqは中央値、app到達率は実受信数から算出します。
        </p>
      </section>

      <div className="comparison-table" role="table" aria-label="停止位置ごとの実測比較">
        <div className="comparison-row comparison-row--head" role="row">
          <span role="columnheader">捨てる位置</span>
          <span role="columnheader">CPU busy</span>
          <span role="columnheader">NET_RX / 1万packet</span>
          <span role="columnheader">アプリ到達</span>
          <span role="columnheader">意味</span>
        </div>
        {summaries.map((summary, index) => (
          <div
            className={`comparison-row comparison-row--${summary.dropPoint} ${
              hasCompletedRun && summary.cpuPercent === bestCpu ? "is-best" : ""
            }`}
            role="row"
            key={summary.dropPoint}
          >
            <span role="cell">
              <b>0{index + 1}</b>
              <strong>{summary.label}</strong>
              <small>{summary.location}</small>
            </span>
            <span className="metric-cell" role="cell">
              <strong>{formatNumber(summary.cpuPercent, 1)}%</strong>
              <small>{formatRange(summary.cpuRange, 1, "%")}</small>
            </span>
            <span className="metric-cell" role="cell">
              <strong>{formatNumber(summary.softirqPer10k)}</strong>
              <small>{formatRange(summary.softirqRange, 0)}</small>
            </span>
            <span className="metric-cell" role="cell">
              <strong>{formatNumber(summary.appReceivePercent, 1)}%</strong>
              <small>{formatRange(summary.appReceiveRange, 1, "%")}</small>
            </span>
            <span role="cell">
              {summary.dropPoint === "application"
                ? "全経路を処理する基準"
                : summary.dropPoint === "netfilter"
                  ? "アプリの仕事を省く"
                  : "stackの仕事から省く"}
            </span>
          </div>
        ))}
      </div>

      <div className="result-statement">
        <span>
          <small>あなたの予想</small>
          {predictionLabel(prediction)}
          <i>→</i>
          <small>CPU実測最小</small>
          {predictionLabel(measuredBest)}
        </span>
        <strong>
          早く捨てるほど、後段へ渡す仕事を減らせる。
          XDPの価値をDROP数ではなく処理差で示す。
        </strong>
      </div>
    </div>
  );
}

export default function App() {
  const demo = isWebDemo();
  const [phase, setPhase] = useState<ExperimentPhase>(0);
  const [autoplay, setAutoplay] = useState(() =>
    typeof window === "undefined"
      ? true
      : !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [streamStatus, setStreamStatus] = useState(
    demo ? "fixture" : "waiting",
  );
  const [runs, setRuns] = useState<ExperimentRun[]>(
    demo ? FIXTURE_RUNS : [],
  );
  const [health, setHealth] = useState<HealthState>(
    demo ? DEFAULT_HEALTH : { success: false, latencyMs: 0, statusCode: null },
  );
  const [showDetails, setShowDetails] = useState(false);
  const [prediction, setPrediction] = useState<DropPoint | null>(null);
  const [showPrediction, setShowPrediction] = useState(true);
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const manualPhaseRef = useRef(false);

  const summaries = useMemo(() => summarizeRuns(runs), [runs]);
  const activeDropPoint = PHASES[phase].dropPoint;
  const activeSummary = activeDropPoint
    ? summaries.find(item => item.dropPoint === activeDropPoint)
    : undefined;
  const representative = runs.at(-1);

  function choosePhase(next: number) {
    manualPhaseRef.current = true;
    setPhase(clampPhase(next));
    if (demo) setAutoplay(false);
  }

  function choosePrediction(dropPoint: DropPoint) {
    manualPhaseRef.current = false;
    setPrediction(dropPoint);
    setShowPrediction(false);
    setPhase(0);
    if (demo) setAutoplay(true);
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
        if (event.type === "traffic_health") {
          setHealth({
            success: Boolean(event.success),
            latencyMs: Number(event.latency_ms ?? 0),
            statusCode:
              event.status_code == null ? null : Number(event.status_code),
          });
          return;
        }
        if (
          event.type === "experiment_run" &&
          event.experiment_id &&
          event.run_id &&
          event.drop_point
        ) {
          const run = event as ExperimentRun & { type: string };
          setRuns(current => {
            const sameExperiment = current.filter(
              item => item.experiment_id === run.experiment_id,
            );
            return [...sameExperiment.filter(item => item.run_id !== run.run_id), run];
          });
          if (!manualPhaseRef.current) {
            const nextPhase =
              run.drop_point === "application"
                ? 0
                : run.drop_point === "netfilter"
                  ? 1
                  : 2;
            setPhase(nextPhase);
          }
        }
      },
    }).then(subscription => {
      if (disposed) {
        subscription.unsubscribe();
        return;
      }
      unsubscribe = subscription.unsubscribe;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!demo || !autoplay || showDetails || showPrediction) return;
    const timer = window.setTimeout(() => {
      setPhase(current => ((current + 1) % 4) as ExperimentPhase);
    }, 7_500);
    return () => window.clearTimeout(timer);
  }, [autoplay, demo, phase, showDetails, showPrediction]);

  useEffect(() => {
    if (!demo || !showPrediction || !autoplay) return;
    const timer = window.setTimeout(() => setShowPrediction(false), 12_000);
    return () => window.clearTimeout(timer);
  }, [autoplay, demo, showPrediction]);

  useEffect(() => {
    if (showDetails) {
      closeButtonRef.current?.focus();
    } else {
      previousFocusRef.current?.focus();
    }
  }, [showDetails]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeDetails();
        return;
      }
      if (showDetails) return;
      if (event.key.toLowerCase() === "d") {
        openDetails();
        return;
      }
      if (event.key === "ArrowRight") choosePhase(phase + 1);
      if (event.key === "ArrowLeft") choosePhase(phase - 1);
      const target = event.target as HTMLElement | null;
      const isInteractive =
        target?.closest("button, a, input, select, textarea") != null;
      if (event.key === " " && !isInteractive) {
        event.preventDefault();
        setAutoplay(current => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phase, showDetails]);

  useEffect(() => {
    if (demo || phase === 3 || manualPhaseRef.current) return;
    const hasEveryCondition = summaries.every(item => item.repetitions >= 3);
    if (hasEveryCondition) setPhase(3);
  }, [demo, phase, summaries]);

  return (
    <div className="booth-app">
      <header className="booth-header">
        <div className="brand">
          <div className="brand-mark"><ShipMark /></div>
          <div>
            <strong>PACKET JOURNEY</strong>
            <small>Raspberry Pi × Rust × eBPF/XDP</small>
          </div>
        </div>
        <div className="header-status">
          <span className={demo ? "fixture-badge" : "live-badge"}>
            {demo ? "UI FIXTURE" : "LIVE"}
          </span>
          <div>
            <small>EXPERIMENT</small>
            <strong>{representative?.experiment_id ?? "WAITING"}</strong>
          </div>
          <div>
            <small>STREAM</small>
            <strong>{streamStatus.toUpperCase()}</strong>
          </div>
          <button ref={detailsButtonRef} type="button" onClick={openDetails}>
            計測方法 <kbd>D</kbd>
          </button>
        </div>
      </header>

      <main className="booth-screen">
        <section className="experiment-question">
          <div>
            <span>QUESTION</span>
            <h1>
              同じUDP負荷を、3つの場所で捨てる。
              <strong>Piの仕事はどれだけ変わる？</strong>
            </h1>
          </div>
          <div className="fixed-condition">
            <small>3条件で固定</small>
            <strong>2,000 pps</strong>
            <strong>128 B</strong>
            <strong>15 sec × 3</strong>
          </div>
        </section>

        <section className="canary-strip">
          <div>
            <span>HTTP CANARY</span>
            <strong>比較対象ではありません</strong>
          </div>
          <p>
            UDPで負荷を加えている間も、同じPi BのHTTPサービスが応答するか横で確認
          </p>
          <div className={health.success ? "canary-ok" : "canary-ng"}>
            <span>{health.success ? "SERVICE UP" : "NO RESPONSE"}</span>
            <strong>
              {health.statusCode ?? "—"} <i>/</i> {health.latencyMs || "—"} ms
            </strong>
          </div>
        </section>

        <ol className="phase-strip" aria-label="比較実験の進行">
          {PHASES.map((item, index) => (
            <li
              key={item.code}
              className={`${index < phase ? "is-complete" : ""} ${
                index === phase ? "is-active" : ""
              }`}
            >
              <button
                type="button"
                onClick={() => choosePhase(index)}
                aria-current={index === phase ? "step" : undefined}
              >
                <b>{index + 1}</b>
                <span>
                  <small>{item.short}</small>
                  <strong>{item.label}</strong>
                </span>
                {demo && index === phase && autoplay && !showDetails && (
                  <i className="phase-progress" key={`progress-${phase}`} />
                )}
              </button>
            </li>
          ))}
        </ol>

        <section className={`stage stage--${phase + 1}`}>
          {activeDropPoint && activeSummary ? (
            <ConditionStage
              dropPoint={activeDropPoint}
              summary={activeSummary}
            />
          ) : (
            <CompareStage summaries={summaries} prediction={prediction} />
          )}
          {showPrediction && (
            <PredictionIntro
              onChoose={choosePrediction}
              onSkip={() => setShowPrediction(false)}
            />
          )}
        </section>

        <footer className="demo-controls">
          <div>
            <span>{phase + 1} / 4</span>
            <strong>{PHASES[phase].label}</strong>
          </div>
          {demo && (
            <p>公開版の数値はUI確認用fixtureです。実機版では計測結果だけを表示します。</p>
          )}
          <nav aria-label="画面の操作">
            <button
              type="button"
              className="prediction-reset"
              onClick={() => {
                manualPhaseRef.current = false;
                setPhase(0);
                setPrediction(null);
                setShowPrediction(true);
              }}
            >
              予想から
            </button>
            <button
              type="button"
              onClick={() => choosePhase(phase - 1)}
              disabled={phase === 0}
            >
              ← 前へ
            </button>
            {demo && (
              <button
                type="button"
                className="autoplay-button"
                onClick={() => setAutoplay(current => !current)}
              >
                {autoplay ? "一時停止" : "自動再生"} <kbd>Space</kbd>
              </button>
            )}
            <button
              type="button"
              onClick={() => choosePhase(phase + 1)}
              disabled={phase === 3}
            >
              次へ →
            </button>
          </nav>
        </footer>
      </main>

      {showDetails && (
        <div className="details-backdrop" role="presentation" onMouseDown={closeDetails}>
          <section
            className="details-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="details-title"
            onMouseDown={event => event.stopPropagation()}
          >
            <header>
              <div>
                <span>EXPERIMENT PROTOCOL</span>
                <h2 id="details-title">数字を信じられるようにするための設計</h2>
              </div>
              <button ref={closeButtonRef} type="button" onClick={closeDetails}>
                閉じる <kbd>Esc</kbd>
              </button>
            </header>
            <div className="details-grid">
              <article>
                <span>変えるもの</span>
                <h3>停止位置だけ</h3>
                <p>
                  application / nftables / XDPの3条件で、送信レート、
                  payload、計測時間は固定します。
                </p>
              </article>
              <article>
                <span>順序の偏り</span>
                <h3>3回、開始位置を回す</h3>
                <p>
                  熱や実行順の影響を減らすため、反復ごとに3条件の順番を
                  ローテーションします。
                </p>
              </article>
              <article>
                <span>CPU</span>
                <h3>/proc/statの差分</h3>
                <p>
                  条件開始と終了のaggregate CPU counterからbusy率を計算し、
                  3回の中央値を表示します。
                </p>
              </article>
              <article>
                <span>kernel work</span>
                <h3>NET_RX softirq</h3>
                <p>
                  /proc/softirqsのNET_RX差分を送信packet数で正規化し、
                  1万packetあたりで比較します。
                </p>
              </article>
              <article>
                <span>userspace</span>
                <h3>UDP socketの実受信数</h3>
                <p>
                  application条件ではrunner自身が受信。nftables/XDP条件では
                  socketに届かなかったことを同じcounterで確認します。
                </p>
              </article>
              <article>
                <span>XDP</span>
                <h3>attach modeを記録</h3>
                <p>
                  nativeを試し、非対応ならgenericへfallback。要求値ではなく、
                  実際にattachできたmodeを各runへ保存します。
                </p>
              </article>
            </div>
            <div className="environment-strip">
              <span>RECORDED ENVIRONMENT</span>
              <dl>
                <div>
                  <dt>Receiver</dt>
                  <dd>{representative?.environment?.receiver_model || "unknown"}</dd>
                </div>
                <div>
                  <dt>Kernel</dt>
                  <dd>{representative?.environment?.kernel_release || "unknown"}</dd>
                </div>
                <div>
                  <dt>NIC / MTU</dt>
                  <dd>
                    {representative?.environment?.network_interface || "unknown"} /{" "}
                    {representative?.environment?.mtu ?? "unknown"}
                  </dd>
                </div>
                <div>
                  <dt>CPU governor</dt>
                  <dd>{representative?.environment?.cpu_governor || "unknown"}</dd>
                </div>
              </dl>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
