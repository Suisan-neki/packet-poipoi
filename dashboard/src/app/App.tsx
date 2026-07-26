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
    label: "アプリまで運ぶ",
    short: "Application",
    code: "APPLICATION",
    dropPoint: "application",
  },
  {
    label: "途中で止める",
    short: "nftables",
    code: "NETFILTER",
    dropPoint: "netfilter",
  },
  {
    label: "入口で止める",
    short: "XDP",
    code: "XDP",
    dropPoint: "xdp",
  },
  {
    label: "仕事量を比べる",
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
    eyebrow: "条件1 / 最後まで運ぶ",
    title: "止めると決めた通信を、アプリまで運んでから捨てる。",
    description:
      "この条件では、アプリが受け取ってから捨てます。入口からアプリまでの全経路が動くため、早く止めた条件と比べる基準になります。技術上の条件名はApplicationです。",
    focus: "色のついた経路が、右端のアプリまで続いている",
  },
  netfilter: {
    eyebrow: "条件2 / 途中で止める",
    title: "同じ通信を、アプリへ届く前に止める。",
    description:
      "送る量は変えません。Linuxの途中にあるfirewallで捨て、アプリまで運んで受け取る仕事を発生させません。この仕組みがnftablesです。",
    focus: "経路が途中の判定で止まり、アプリまで届かない",
  },
  xdp: {
    eyebrow: "条件3 / 入口で止める",
    title: "同じ通信を、受け取った直後に止める。",
    description:
      "有線LANから受け取った直後に捨て、Linuxの通常の受信処理やアプリまで運ぶ仕事を発生させません。この入口の仕組みがXDPです。",
    focus: "入口の判定だけで経路が終わっている",
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
  { id: "nic", label: "LANの入口", sub: "NIC" },
  { id: "xdp", label: "入口の判定", sub: "XDP" },
  { id: "stack", label: "通信の処理", sub: "Linux network stack" },
  { id: "netfilter", label: "途中の判定", sub: "nftables" },
  { id: "application", label: "アプリ", sub: "UDP socket" },
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
            ? "アプリまで運ぶ"
            : dropPoint === "netfilter"
              ? "途中で止める"
              : "入口で止める",
        location:
          dropPoint === "application"
            ? "Application"
            : dropPoint === "netfilter"
              ? "nftables"
              : "XDP",
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
  if (dropPoint === "application") return "アプリまで運ぶ";
  if (dropPoint === "netfilter") return "途中で止める";
  if (dropPoint === "xdp") return "入口で止める";
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
        <strong>実験用の通信</strong>
        <em>UDP :4000 · 2,000回/秒</em>
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
                    {dropPoint === "application" ? "ここで受信" : "ここで破棄"}
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
            ? "アプリまで運んでから捨てる"
            : dropPoint === "netfilter"
              ? "途中のfirewallで止める"
              : "入口のXDPで止める"}
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
      label: "アプリまで運ぶ",
      location: "Application",
    },
    {
      dropPoint: "netfilter",
      label: "途中で止める",
      location: "nftables",
    },
    {
      dropPoint: "xdp",
      label: "入口で止める",
      location: "XDP",
    },
  ];

  return (
    <div className="prediction-backdrop">
      <section className="prediction-panel" aria-labelledby="prediction-title">
        <span>BEFORE THE DEMO / 知識は必要ありません</span>
        <h2 id="prediction-title">
          同じ通信を、
          <strong>どこで止めるとPiの仕事は最も減る？</strong>
        </h2>
        <p>
          通信を捨てること自体が目的ではありません。止めると決めた通信を
          アプリまで運ばず、その先の仕事を発生させないことで、
          本来のサービスへ余力を残せるかを確かめます。まず予想してみてください。
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
                <small>技術名: {choice.location}</small>
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
            <small>Piの仕事量 · CPU busy</small>
            <strong>{formatNumber(summary.cpuPercent, 1)}%</strong>
            <em>{formatRange(summary.cpuRange, 1, "%")}</em>
          </div>
          <div>
            <small>OSの受信処理 · NET_RX / 1万回</small>
            <strong>{formatNumber(summary.softirqPer10k)}</strong>
            <em>{formatRange(summary.softirqRange, 0)}</em>
          </div>
          <div>
            <small>アプリまで届いた割合</small>
            <strong>{formatNumber(summary.appReceivePercent, 1)}%</strong>
            <em>{formatRange(summary.appReceiveRange, 1, "%")}</em>
          </div>
          <div>
            <small>{dropPoint === "xdp" ? "XDPの動作mode" : "計測回数"}</small>
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
  const measuredBestLabel = predictionLabel(measuredBest);
  return (
    <div className="compare-stage">
      <section className="compare-heading">
        <div>
          <span>RESULT / 同じ通信、違う停止位置</span>
          <h2>止める位置で、Piに残せた余力はどう変わったか。</h2>
        </div>
        <p>
          CPUとOSの受信処理が小さいほど、通信を止めるために使った仕事が少なく、
          本来のサービスへ残せる余地の目安になります。
        </p>
      </section>

      <div className="comparison-table" role="table" aria-label="停止位置ごとの実測比較">
        <div className="comparison-row comparison-row--head" role="row">
          <span role="columnheader">止めた場所</span>
          <span role="columnheader">Piの仕事量 / CPU</span>
          <span role="columnheader">OSの受信処理 / NET_RX</span>
          <span role="columnheader">アプリまで到達</span>
          <span role="columnheader">発生しなかった処理</span>
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
                ? "なし。全経路が動く"
                : summary.dropPoint === "netfilter"
                  ? "アプリまで運ぶ処理"
                  : "通常のOS受信処理とアプリ"}
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
          {hasCompletedRun
            ? `この表示では「${measuredBestLabel}」のCPU使用が最小でした。`
            : "3条件の計測がそろうと、ここに結果を表示します。"}
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
            <strong>パケットぽいぽい</strong>
            <small>Raspberry Pi × Rust × eBPF/XDP</small>
          </div>
        </div>
        <div className="header-status">
          <span className={demo ? "fixture-badge" : "live-badge"}>
            {demo ? "SAMPLE DATA" : "LIVE"}
          </span>
          <div>
            <small>計測ID</small>
            <strong>{representative?.experiment_id ?? "WAITING"}</strong>
          </div>
          <div>
            <small>データ</small>
            <strong>{demo ? "SAMPLE" : streamStatus.toUpperCase()}</strong>
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
              止めると決めた通信を早く止め、
              <strong>本来のサービスへ余力を残せるか。</strong>
            </h1>
          </div>
          <div className="fixed-condition">
            <small>全条件で同じ</small>
            <strong>2,000回/秒</strong>
            <strong>128 byte</strong>
            <strong>15秒 × 3回</strong>
          </div>
        </section>

        <section className="canary-strip">
          <div>
            <span>本来のサービス</span>
            <strong>負荷中も応答できるか</strong>
          </div>
          <p>
            実験用の通信を流している間も、同じPiのWebサービスを定期確認
          </p>
          <div className={health.success ? "canary-ok" : "canary-ng"}>
            <span>{health.success ? "応答あり" : "応答なし"}</span>
            <strong>
              {health.latencyMs || "—"} ms{" "}
              <i>HTTP {health.statusCode ?? "—"}</i>
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
                  <strong>{item.label}</strong>
                  <small>{item.short}</small>
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
            <p>公開版は画面確認用のサンプルデータです。実機版では計測結果だけを表示します。</p>
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
