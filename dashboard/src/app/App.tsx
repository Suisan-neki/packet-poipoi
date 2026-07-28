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

interface ServiceHealthSummary {
  checks: number;
  successes: number;
  latency_p95_ms: number;
  latency_max_ms: number;
  min_success_percent: number;
  max_p95_latency_ms: number;
}

interface SweepPlan {
  pps_steps: number[];
  repetitions: number;
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
  service_health?: ServiceHealthSummary;
  sweep?: SweepPlan;
}

interface HarborEvent extends Partial<ExperimentRun> {
  type?: string;
  success?: boolean;
  latency_ms?: number;
  status_code?: number;
}

interface RateSummary {
  targetPps: number;
  cpuPercent: number;
  softirqPer10k: number;
  appReceivePercent: number;
  successPercent: number;
  latencyP95Ms: number;
  runs: number;
  maintained: boolean;
}

interface ConditionSummary {
  dropPoint: DropPoint;
  label: string;
  location: string;
  rates: RateSummary[];
  maxMaintainedPps: number | null;
  limitResult: RateSummary | null;
  totalRuns: number;
  attachMode: string;
}

interface HealthState {
  success: boolean;
  latencyMs: number;
  statusCode: number | null;
}

const DROP_POINTS: DropPoint[] = ["application", "netfilter", "xdp"];
const SAMPLE_PPS_STEPS = [500, 2_000, 5_000, 10_000, 20_000, 50_000];
const SAMPLE_REPETITIONS = 3;

const PHASES = [
  {
    label: "アプリで捨てる",
    short: "Application",
    code: "APPLICATION",
    dropPoint: "application",
  },
  {
    label: "途中で捨てる",
    short: "nftables",
    code: "NETFILTER",
    dropPoint: "netfilter",
  },
  {
    label: "入口で捨てる",
    short: "XDP",
    code: "XDP",
    dropPoint: "xdp",
  },
  {
    label: "限界を比べる",
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
    eyebrow: "条件1 / APPLICATION",
    title: "アプリまで運んでから捨てる。",
    description:
      "不要と決めたUDPも、Linuxの受信処理を通してアプリが受け取ります。この条件を基準に、HTTPが止まらずに耐えられる負荷の上限を探します。",
    focus: "右の負荷を上げ、HTTPが維持できなくなる境目を見る",
  },
  netfilter: {
    eyebrow: "条件2 / NFTABLES",
    title: "Linuxの途中で捨てる。",
    description:
      "同じUDPをfirewallで止め、アプリへ運ぶ仕事を省きます。送る量と判定基準は変えず、HTTPが耐えられる上限だけを比べます。",
    focus: "条件1より右の負荷まで「維持」が続くかを見る",
  },
  xdp: {
    eyebrow: "条件3 / XDP",
    title: "有線LANの入口で捨てる。",
    description:
      "同じUDPをNIC直後のXDPで止め、通常のLinux受信処理へ進ませません。どれだけ早い段階で止めたかではなく、サービス限界がどこまで動いたかを測ります。",
    focus: "最も高い負荷でもHTTPの基準を守れたかを見る",
  },
};

const SAMPLE_PROFILES: Record<
  DropPoint,
  { cpu: number[]; p95: number[]; success: number[]; app: number[] }
> = {
  application: {
    cpu: [15, 21, 31, 49, 79, 96],
    p95: [18, 19, 27, 132, 310, 850],
    success: [100, 100, 100, 98, 84, 38],
    app: [100, 100, 99.8, 99, 93, 72],
  },
  netfilter: {
    cpu: [11, 14, 20, 31, 53, 79],
    p95: [17, 18, 20, 34, 125, 420],
    success: [100, 100, 100, 100, 98, 66],
    app: [0, 0, 0, 0, 0, 0],
  },
  xdp: {
    cpu: [8, 10, 12, 17, 28, 52],
    p95: [16, 16, 17, 19, 29, 146],
    success: [100, 100, 100, 100, 100, 98],
    app: [0, 0, 0, 0, 0, 0],
  },
};

// 公開ページは実験画面を説明するためのfixture。実測値ではない。
const FIXTURE_RUNS: ExperimentRun[] = DROP_POINTS.flatMap(dropPoint =>
  SAMPLE_PPS_STEPS.flatMap((targetPps, rateIndex) =>
    [1, 2, 3].map(repetition => {
      const profile = SAMPLE_PROFILES[dropPoint];
      const jitter = repetition - 2;
      const checks = 50;
      const successes = Math.round(
        checks * profile.success[rateIndex] / 100,
      );
      return {
        experiment_id: "sample-service-limit",
        run_id: `sample-${dropPoint}-${targetPps}-${repetition}`,
        repetition,
        drop_point: dropPoint,
        duration_ms: 10_000,
        target_pps: targetPps,
        payload_bytes: 128,
        packets_sent: targetPps * 10,
        packets_received_by_app: Math.round(
          targetPps * 10 * profile.app[rateIndex] / 100,
        ),
        cpu_busy_percent: profile.cpu[rateIndex] + jitter * 0.8,
        net_rx_softirq_delta: Math.round(
          targetPps * 10 *
            (dropPoint === "xdp" ? 0.18 : dropPoint === "netfilter" ? 0.62 : 0.9),
        ),
        xdp_attach_mode: dropPoint === "xdp" ? "native" : "not_used",
        environment: {
          receiver_model: "Raspberry Pi 5 Model B Rev 1.0",
          kernel_release: "6.6.51+rpt-rpi-2712",
          network_interface: "eth0",
          mtu: 1500,
          cpu_governor: "performance",
        },
        service_health: {
          checks,
          successes,
          latency_p95_ms: Math.max(1, profile.p95[rateIndex] + jitter * 2),
          latency_max_ms: Math.max(1, profile.p95[rateIndex] * 2 + jitter * 3),
          min_success_percent: 99,
          max_p95_latency_ms: 100,
        },
        sweep: {
          pps_steps: SAMPLE_PPS_STEPS,
          repetitions: SAMPLE_REPETITIONS,
        },
      };
    }),
  ),
);

const DEFAULT_HEALTH: HealthState = {
  success: true,
  latencyMs: 14,
  statusCode: 200,
};

const LAYERS = [
  { id: "nic", label: "LANの入口", sub: "NIC" },
  { id: "xdp", label: "入口の判定", sub: "XDP" },
  { id: "stack", label: "通信の処理", sub: "Linux stack" },
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

function successPercent(health?: ServiceHealthSummary) {
  if (!health || health.checks === 0) return 0;
  return health.successes * 100 / health.checks;
}

function serviceMaintained(health?: ServiceHealthSummary) {
  if (!health || health.checks === 0) return false;
  return (
    successPercent(health) >= health.min_success_percent &&
    health.latency_p95_ms <= health.max_p95_latency_ms
  );
}

function summarizeRuns(runs: ExperimentRun[]): ConditionSummary[] {
  return DROP_POINTS.map(dropPoint => {
    const conditionRuns = runs.filter(run => run.drop_point === dropPoint);
    const ppsSteps = [
      ...new Set(conditionRuns.map(run => run.target_pps)),
    ].sort((a, b) => a - b);
    const rates = ppsSteps.map(targetPps => {
      const rateRuns = conditionRuns.filter(run => run.target_pps === targetPps);
      const maintainedRuns = rateRuns.filter(run =>
        serviceMaintained(run.service_health),
      ).length;
      return {
        targetPps,
        cpuPercent: median(rateRuns.map(run => run.cpu_busy_percent)),
        softirqPer10k: median(
          rateRuns.map(run =>
            run.packets_sent === 0
              ? 0
              : run.net_rx_softirq_delta * 10_000 / run.packets_sent,
          ),
        ),
        appReceivePercent: median(
          rateRuns.map(run =>
            run.packets_sent === 0
              ? 0
              : run.packets_received_by_app * 100 / run.packets_sent,
          ),
        ),
        successPercent: median(
          rateRuns.map(run => successPercent(run.service_health)),
        ),
        latencyP95Ms: median(
          rateRuns.map(run => run.service_health?.latency_p95_ms ?? 0),
        ),
        runs: rateRuns.length,
        maintained:
          rateRuns.length > 0 && maintainedRuns * 2 >= rateRuns.length,
      };
    });
    const maintainedRates = rates.filter(rate => rate.maintained);
    const limitResult = maintainedRates.at(-1) ?? null;
    return {
      dropPoint,
      label:
        dropPoint === "application"
          ? "アプリで捨てる"
          : dropPoint === "netfilter"
            ? "途中で捨てる"
            : "入口で捨てる",
      location:
        dropPoint === "application"
          ? "Application"
          : dropPoint === "netfilter"
            ? "nftables"
            : "XDP",
      rates,
      maxMaintainedPps: limitResult?.targetPps ?? null,
      limitResult,
      totalRuns: conditionRuns.length,
      attachMode: conditionRuns.at(-1)?.xdp_attach_mode ?? "unknown",
    };
  });
}

function formatNumber(value: number, digits = 0) {
  return new Intl.NumberFormat("ja-JP", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function formatPps(value: number | null) {
  if (value == null) return "—";
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}k`;
  return formatNumber(value);
}

function predictionLabel(dropPoint: DropPoint | null) {
  if (dropPoint === "application") return "アプリ";
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
        <span>実験用UDPを増やす</span>
        <strong>500 → 50,000 /秒</strong>
        <em>128 byte · 宛先 :4000</em>
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
                    {dropPoint === "application" ? "受信して破棄" : "ここで破棄"}
                  </span>
                )}
              </div>
            </div>
          );
        })}
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
      label: "アプリで捨てる",
      location: "Application",
    },
    {
      dropPoint: "netfilter",
      label: "途中で捨てる",
      location: "nftables",
    },
    {
      dropPoint: "xdp",
      label: "入口で捨てる",
      location: "XDP",
    },
  ];

  return (
    <div className="prediction-backdrop">
      <section className="prediction-panel" aria-labelledby="prediction-title">
        <span>BEFORE THE DEMO / 専門知識は不要です</span>
        <h2 id="prediction-title">
          どこで捨てると、
          <strong>Webサービスは最も大きな負荷まで耐えられる？</strong>
        </h2>
        <p>
          「早く捨てる方が有利そう」までは予想できます。この実験で知りたいのは、
          その差が実機では何倍になるのか。UDPの量を段階的に増やしながら、
          同じPiのHTTPが正常に応答できる上限を探します。
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

function LoadSweep({ summary }: { summary: ConditionSummary }) {
  return (
    <div className="load-sweep">
      <header>
        <span>LOAD SWEEP / 送信量を段階的に上げる</span>
        <strong>
          HTTP成功率 99%以上 ＋ p95 100ms以下なら「維持」
        </strong>
      </header>
      <div className="rate-steps">
        {summary.rates.map(rate => (
          <div
            className={`rate-step ${
              rate.maintained ? "is-maintained" : "is-failed"
            }`}
            key={rate.targetPps}
          >
            <small>{formatPps(rate.targetPps)} /秒</small>
            <strong>{rate.maintained ? "維持" : "限界超え"}</strong>
            <span>
              HTTP {formatNumber(rate.successPercent)}% · p95{" "}
              {formatNumber(rate.latencyP95Ms)}ms
            </span>
          </div>
        ))}
      </div>
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
  const limit = summary.limitResult;
  return (
    <div className="condition-stage">
      <section className="stage-copy">
        <span>{copy.eyebrow}</span>
        <h2>{copy.title}</h2>
        <p>{copy.description}</p>
        <div className="limit-callout">
          <small>HTTPを維持できた最大負荷</small>
          <strong>
            {formatPps(summary.maxMaintainedPps)}
            <em> packets / 秒</em>
          </strong>
        </div>
        <div className="look-here">
          <small>この画面で見るところ</small>
          <strong>{copy.focus}</strong>
        </div>
      </section>

      <section className="stage-path">
        <LayerPath dropPoint={dropPoint} />
        <LoadSweep summary={summary} />
        <div className="condition-metrics">
          <div>
            <small>耐えられた上限</small>
            <strong>{formatPps(summary.maxMaintainedPps)} pps</strong>
            <em>条件内の最大pass</em>
          </div>
          <div>
            <small>上限時のHTTP成功率</small>
            <strong>
              {limit ? `${formatNumber(limit.successPercent, 0)}%` : "—"}
            </strong>
            <em>基準 99%以上</em>
          </div>
          <div>
            <small>上限時の応答時間 p95</small>
            <strong>
              {limit ? `${formatNumber(limit.latencyP95Ms)} ms` : "—"}
            </strong>
            <em>基準 100ms以下</em>
          </div>
          <div>
            <small>上限時のCPU busy</small>
            <strong>
              {limit ? `${formatNumber(limit.cpuPercent, 1)}%` : "—"}
            </strong>
            <em>
              {dropPoint === "xdp"
                ? `XDP ${summary.attachMode}`
                : `${summary.totalRuns} runs`}
            </em>
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
  const measured = summaries.filter(summary => summary.maxMaintainedPps != null);
  const measuredBest = measured.reduce<ConditionSummary | null>(
    (best, current) =>
      best == null ||
      Number(current.maxMaintainedPps) > Number(best.maxMaintainedPps)
        ? current
        : best,
    null,
  );
  const baseline = summaries.find(item => item.dropPoint === "application");
  const ratio =
    measuredBest?.maxMaintainedPps && baseline?.maxMaintainedPps
      ? measuredBest.maxMaintainedPps / baseline.maxMaintainedPps
      : null;

  return (
    <div className="compare-stage">
      <section className="compare-heading">
        <div>
          <span>RESULT / HTTPが耐えた上限を比較</span>
          <h2>止める位置で、サービス維持限界はどこまで変わったか。</h2>
        </div>
        <p>
          各条件で、成功率99%以上かつp95 100ms以下を最後に満たした
          UDP送信量を比較します。CPUの小ささだけを勝敗にはしません。
        </p>
      </section>

      <div className="comparison-table" role="table" aria-label="停止位置ごとの実測比較">
        <div className="comparison-row comparison-row--head" role="row">
          <span role="columnheader">捨てた場所</span>
          <span role="columnheader">HTTPを維持できた上限</span>
          <span role="columnheader">上限時のHTTP</span>
          <span role="columnheader">上限時のCPU</span>
          <span role="columnheader">省けた受信経路</span>
        </div>
        {summaries.map((summary, index) => {
          const limit = summary.limitResult;
          return (
            <div
              className={`comparison-row comparison-row--${summary.dropPoint} ${
                measuredBest?.dropPoint === summary.dropPoint ? "is-best" : ""
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
                <strong>{formatPps(summary.maxMaintainedPps)} pps</strong>
                <small>最大pass rate</small>
              </span>
              <span className="metric-cell" role="cell">
                <strong>
                  {limit
                    ? `${formatNumber(limit.successPercent)}% / ${formatNumber(limit.latencyP95Ms)}ms`
                    : "—"}
                </strong>
                <small>成功率 / p95</small>
              </span>
              <span className="metric-cell" role="cell">
                <strong>
                  {limit ? `${formatNumber(limit.cpuPercent, 1)}%` : "—"}
                </strong>
                <small>CPU busy</small>
              </span>
              <span role="cell">
                {summary.dropPoint === "application"
                  ? "なし。アプリまで運ぶ"
                  : summary.dropPoint === "netfilter"
                    ? "アプリへ運ぶ処理"
                    : "通常のOS受信処理とアプリ"}
              </span>
            </div>
          );
        })}
      </div>

      <div className="result-statement">
        <span>
          <small>あなたの予想</small>
          {predictionLabel(prediction)}
          <i>→</i>
          <small>実測の最大値</small>
          {predictionLabel(measuredBest?.dropPoint ?? null)}
        </span>
        <strong>
          {measuredBest && ratio
            ? `${measuredBest.location}では、Applicationの約${formatNumber(ratio, 1)}倍の負荷までHTTPを維持しました。`
            : "全rateの計測がそろうと、ここにサービス維持限界を表示します。"}
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
  const sweepSteps = representative?.sweep?.pps_steps ?? SAMPLE_PPS_STEPS;
  const repetitions =
    representative?.sweep?.repetitions ?? SAMPLE_REPETITIONS;

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
            return [
              ...sameExperiment.filter(item => item.run_id !== run.run_id),
              run,
            ];
          });
          if (!manualPhaseRef.current) {
            setPhase(
              run.drop_point === "application"
                ? 0
                : run.drop_point === "netfilter"
                  ? 1
                  : 2,
            );
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
    }, 9_000);
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
    const hasEveryRun = DROP_POINTS.every(dropPoint =>
      sweepSteps.every(
        targetPps =>
          runs.filter(
            run =>
              run.drop_point === dropPoint && run.target_pps === targetPps,
          ).length >= repetitions,
      ),
    );
    if (hasEveryRun) setPhase(3);
  }, [demo, phase, repetitions, runs, sweepSteps]);

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
              捨てる位置で、
              <strong>Webサービスが耐えられる負荷の上限は何倍変わる？</strong>
            </h1>
          </div>
          <div className="fixed-condition">
            <small>全条件で同じ</small>
            <strong>128 byte</strong>
            <strong>10秒 × 3回</strong>
            <strong>500 → 50k /秒</strong>
          </div>
        </section>

        <section className="canary-strip">
          <div>
            <span>サービス維持の基準</span>
            <strong>成功率 99%以上 ＋ p95 100ms以下</strong>
          </div>
          <p>
            UDP負荷を増やしながら、同じPiのWebサービスへHTTP GETを繰り返す
          </p>
          <div className={health.success ? "canary-ok" : "canary-ng"}>
            <span>{health.success ? "現在も応答" : "応答なし"}</span>
            <strong>
              HTTP {health.statusCode ?? "—"}{" "}
              <i>{health.latencyMs || "—"} ms</i>
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
            <p>公開版は画面説明用のサンプルです。実機版ではPiの計測結果だけを表示します。</p>
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
                <h2 id="details-title">「何倍違う」を信じられる実験にする</h2>
              </div>
              <button ref={closeButtonRef} type="button" onClick={closeDetails}>
                閉じる <kbd>Esc</kbd>
              </button>
            </header>
            <div className="details-grid">
              <article>
                <span>問い</span>
                <h3>サービス維持限界を探す</h3>
                <p>
                  500から50,000 ppsまで負荷を上げ、HTTP成功率99%以上かつ
                  p95 100ms以下を最後に満たしたrateを比較します。
                </p>
              </article>
              <article>
                <span>変えるもの</span>
                <h3>負荷量と停止位置</h3>
                <p>
                  payload、各runの時間、HTTPの宛先、合格基準は固定。
                  Application / nftables / XDPだけを同じrateで比べます。
                </p>
              </article>
              <article>
                <span>順序の偏り</span>
                <h3>条件を回し、rateを往復</h3>
                <p>
                  反復ごとに3条件の開始位置を回し、rateは昇順と降順を交互にして、
                  熱や実行順の影響を減らします。
                </p>
              </article>
              <article>
                <span>サービス</span>
                <h3>HTTP成功率とp95</h3>
                <p>
                  負荷中に約200ms間隔で同じURLを確認。平均では隠れる遅い応答を
                  見逃さないよう95パーセンタイルを記録します。
                </p>
              </article>
              <article>
                <span>kernel work</span>
                <h3>CPUとNET_RXも記録</h3>
                <p>
                  /proc/statのbusy率とNET_RX softirq差分を保存し、
                  サービス限界が動いた理由を低レイヤの仕事量から読めるようにします。
                </p>
              </article>
              <article>
                <span>適用範囲</span>
                <h3>捨てる対象は事前に既知</h3>
                <p>
                  この実験は防御製品ではありません。入口ほど判断材料は少なく、
                  アプリの文脈が必要な通信は同じ方法では判定できません。
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
