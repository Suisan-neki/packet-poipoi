import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { isWebDemo, subscribeStream } from "../stream.js";

type DropPoint = "application" | "netfilter" | "xdp";
type RateStatus = "maintained" | "failed" | "unverified";

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
  min_load_delivery_percent?: number;
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
  actualPps: number;
  successPercent: number;
  latencyP95Ms: number;
  cpuPercent: number;
  maintained: boolean;
  status: RateStatus;
}

interface ConditionSummary {
  dropPoint: DropPoint;
  rates: RateSummary[];
  maxMaintainedPps: number | null;
  limitResult: RateSummary | null;
  attachMode: string;
  mixedAttachModes: boolean;
  nonMonotonic: boolean;
}

interface HealthState {
  success: boolean;
  latencyMs: number;
  statusCode: number | null;
}

const DROP_POINTS: DropPoint[] = ["application", "netfilter", "xdp"];
const SAMPLE_PPS_STEPS = [500, 2_000, 5_000, 10_000, 20_000, 50_000];
const SAMPLE_REPETITIONS = 3;

const CONDITION_META = {
  application: {
    order: "01",
    plain: "アプリで捨てる",
    short: "アプリ",
    technical: "Application / UDP socket",
    scoreTechnical: "UDP socket",
    stopIndex: 4,
    description: "UDP socketまで届け、アプリが受信した後に破棄します。",
  },
  netfilter: {
    order: "02",
    plain: "途中で捨てる",
    short: "途中",
    technical: "nftables / Netfilter input",
    scoreTechnical: "Netfilter",
    stopIndex: 3,
    description: "nftablesのdrop ruleをNetfilter input hookで適用します。",
  },
  xdp: {
    order: "03",
    plain: "入口で捨てる",
    short: "入口",
    technical: "eBPF / XDP_DROP",
    scoreTechnical: "XDP",
    stopIndex: 1,
    description: "eBPFプログラムがXDP hookでXDP_DROPを返します。",
  },
} satisfies Record<
  DropPoint,
  {
    order: string;
    plain: string;
    short: string;
    technical: string;
    scoreTechnical: string;
    stopIndex: number;
    description: string;
  }
>;

const PATH_LAYERS = [
  { id: "nic", plain: "LAN", technical: "NIC" },
  { id: "xdp", plain: "入口", technical: "XDP hook" },
  { id: "stack", plain: "受信処理", technical: "network stack" },
  { id: "netfilter", plain: "ルール", technical: "Netfilter input" },
  { id: "application", plain: "アプリ", technical: "UDP socket" },
] as const;

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
            (dropPoint === "xdp"
              ? 0.18
              : dropPoint === "netfilter"
                ? 0.62
                : 0.9),
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
          min_load_delivery_percent: 90,
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

function actualPps(run: ExperimentRun) {
  if (run.duration_ms <= 0) return 0;
  return run.packets_sent * 1_000 / run.duration_ms;
}

function loadRateAchieved(run: ExperimentRun) {
  if (run.target_pps <= 0) return false;
  const threshold = run.sweep?.min_load_delivery_percent ?? 90;
  return actualPps(run) * 100 / run.target_pps >= threshold;
}

function summarizeRuns(runs: ExperimentRun[]): ConditionSummary[] {
  return DROP_POINTS.map(dropPoint => {
    const conditionRuns = runs.filter(run => run.drop_point === dropPoint);
    const ppsSteps = [
      ...new Set(conditionRuns.map(run => run.target_pps)),
    ].sort((a, b) => a - b);
    const observedAttachModes =
      dropPoint === "xdp"
        ? [
            ...new Set(
              conditionRuns
                .map(run => run.xdp_attach_mode)
                .filter(mode => mode === "native" || mode === "generic"),
            ),
          ]
        : [];
    const mixedAttachModes = observedAttachModes.length > 1;

    const rates = ppsSteps.map(targetPps => {
      const rateRuns = conditionRuns.filter(run => run.target_pps === targetPps);
      const validRuns = rateRuns.filter(loadRateAchieved);
      const maintainedRuns = validRuns.filter(run =>
        serviceMaintained(run.service_health),
      ).length;
      const valid =
        !mixedAttachModes &&
        rateRuns.length > 0 &&
        validRuns.length === rateRuns.length;
      const maintained =
        valid &&
        validRuns.length > 0 &&
        maintainedRuns * 2 > validRuns.length;

      return {
        targetPps,
        actualPps: median(rateRuns.map(actualPps)),
        successPercent: median(
          rateRuns.map(run => successPercent(run.service_health)),
        ),
        latencyP95Ms: median(
          rateRuns.map(run => run.service_health?.latency_p95_ms ?? 0),
        ),
        cpuPercent: median(rateRuns.map(run => run.cpu_busy_percent)),
        maintained,
        status: !valid
          ? "unverified" as const
          : maintained
            ? "maintained" as const
            : "failed" as const,
      };
    });

    const firstNonMaintained = rates.findIndex(rate => !rate.maintained);
    const maintainedPrefix =
      firstNonMaintained === -1
        ? rates
        : rates.slice(0, firstNonMaintained);
    const limitResult = maintainedPrefix.at(-1) ?? null;
    const nonMonotonic =
      firstNonMaintained !== -1 &&
      rates.slice(firstNonMaintained + 1).some(rate => rate.maintained);

    return {
      dropPoint,
      rates,
      maxMaintainedPps: limitResult?.actualPps ?? null,
      limitResult,
      attachMode:
        mixedAttachModes
          ? `${observedAttachModes.join(" / ")}（混在）`
          : observedAttachModes.at(0) ??
            conditionRuns.at(-1)?.xdp_attach_mode ??
            "unknown",
      mixedAttachModes,
      nonMonotonic,
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

function PacketMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <rect x="7" y="9" width="34" height="30" rx="8" />
      <path d="M14 19h13" />
      <path d="m24 14 5 5-5 5" />
      <path d="M34 29H21" />
      <path d="m24 24-5 5 5 5" />
    </svg>
  );
}

function RigView({
  selected,
  displayPps,
  modeLabel,
  loadLabel,
  health,
  payloadBytes,
  xdpAttachMode,
}: {
  selected: DropPoint;
  displayPps: number | null;
  modeLabel: string;
  loadLabel: string;
  health: HealthState;
  payloadBytes: number;
  xdpAttachMode: string;
}) {
  const meta = CONDITION_META[selected];
  const waiting =
    !health.success && health.statusCode == null && health.latencyMs === 0;
  const healthLabel = waiting
    ? "計測待ち"
    : health.success
      ? `HTTP ${health.statusCode ?? "OK"} · ${health.latencyMs || "—"} ms`
      : "応答なし";

  return (
    <section className="showcase-rig" aria-label="Raspberry Pi 2台の実験構成">
      <div className="showcase-rig__topline">
        <span><i /> {modeLabel}</span>
        <strong>{meta.plain}</strong>
        <code>{meta.technical}</code>
      </div>

      <div className="showcase-rig__flow">
        <div className="showcase-device showcase-device--sender">
          <b>Pi A</b>
          <strong>{loadLabel}</strong>
          <span>{formatPps(displayPps)} <em>pps</em></span>
          <small>UDP :4000 · {payloadBytes} byte</small>
        </div>

        <div className="showcase-wire" aria-label="Ethernet接続">
          <i className="packet packet--1" />
          <i className="packet packet--2" />
          <i className="packet packet--3" />
          <span>Ethernet</span>
        </div>

        <div className="showcase-device showcase-device--receiver">
          <header>
            <div>
              <b>Pi B</b>
              <strong>捨てながらHTTPを守る</strong>
            </div>
            <div className={`showcase-health ${health.success ? "is-ok" : waiting ? "is-waiting" : "is-down"}`}>
              <i />
              <span>
                <small>Webサービス</small>
                <strong>{healthLabel}</strong>
              </span>
            </div>
          </header>

          <div className="showcase-path">
            {PATH_LAYERS.map((layer, index) => {
              const stopped = index === meta.stopIndex;
              const reached = index <= meta.stopIndex;
              return (
                <div className="showcase-path__step" key={layer.id}>
                  {index > 0 && (
                    <span className={`showcase-path__link ${reached ? "is-active" : ""}`}>
                      {reached && <i />}
                    </span>
                  )}
                  <div className={`showcase-path__node ${stopped ? "is-stop" : reached ? "is-reached" : "is-after"}`}>
                    <small>{layer.plain}</small>
                    <strong>{layer.technical}</strong>
                    {stopped && <em>DROP</em>}
                  </div>
                </div>
              );
            })}
          </div>

          {selected === "xdp" && (
            <p>XDP attach: <strong>{xdpAttachMode}</strong></p>
          )}
        </div>
      </div>
    </section>
  );
}

function ScoreCards({
  summaries,
  selected,
  onSelect,
}: {
  summaries: ConditionSummary[];
  selected: DropPoint;
  onSelect: (dropPoint: DropPoint) => void;
}) {
  return (
    <section className="showcase-scores" aria-label="3条件の比較結果">
      {summaries.map(summary => {
        const meta = CONDITION_META[summary.dropPoint];
        return (
          <button
            key={summary.dropPoint}
            type="button"
            className={`showcase-score showcase-score--${summary.dropPoint} ${selected === summary.dropPoint ? "is-selected" : ""}`}
            aria-pressed={selected === summary.dropPoint}
            onClick={() => onSelect(summary.dropPoint)}
          >
            <span className="showcase-score__label">
              <b>{meta.order}</b>
              <span>
                <strong>{meta.plain}</strong>
                <small>{meta.scoreTechnical}</small>
              </span>
            </span>
            <span className="showcase-score__value">
              <strong>{formatPps(summary.maxMaintainedPps)}</strong>
              <em>pps</em>
            </span>
          </button>
        );
      })}
    </section>
  );
}

function DetailsDialog({
  onClose,
  closeButtonRef,
  representative,
  summaries,
}: {
  onClose: () => void;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  representative?: ExperimentRun;
  summaries: ConditionSummary[];
}) {
  const minSuccess = representative?.service_health?.min_success_percent ?? 99;
  const maxP95 = representative?.service_health?.max_p95_latency_ms ?? 100;
  const minDelivery = representative?.sweep?.min_load_delivery_percent ?? 90;
  const repetitions = representative?.sweep?.repetitions ?? SAMPLE_REPETITIONS;
  const duration = (representative?.duration_ms ?? 10_000) / 1_000;
  const xdpMode = summaries.find(item => item.dropPoint === "xdp")?.attachMode ?? "unknown";

  return (
    <div className="showcase-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="showcase-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="showcase-details-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <header>
          <div>
            <span>TECHNICAL DETAILS</span>
            <h2 id="showcase-details-title">聞かれたときに見せる計測条件</h2>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose}>
            閉じる <kbd>Esc</kbd>
          </button>
        </header>

        <div className="showcase-dialog__body">
          <section className="showcase-detail-lead">
            <article>
              <span>増やす通信</span>
              <strong>IPv4 / UDP :4000</strong>
              <p>量を制御するための実験用負荷です。</p>
            </article>
            <article>
              <span>守る通信</span>
              <strong>HTTP GET /api/ping</strong>
              <p>同じPi上のWebサービスを成功率と応答時間で監視します。</p>
            </article>
          </section>

          <section className="showcase-detail-section">
            <h3>上限値の判定</h3>
            <div className="showcase-rules">
              <article>
                <b>1</b>
                <strong>実送信量</strong>
                <p>目標ppsの{formatNumber(minDelivery)}%未満は測定不成立</p>
              </article>
              <article>
                <b>2</b>
                <strong>HTTP維持</strong>
                <p>成功率{formatNumber(minSuccess)}%以上・p95 {formatNumber(maxP95)}ms以下</p>
              </article>
              <article>
                <b>3</b>
                <strong>反復</strong>
                <p>{formatNumber(duration, 1)}秒 × {repetitions}回、多数決と連続性を確認</p>
              </article>
            </div>
          </section>

          <section className="showcase-detail-section">
            <h3>3つの破棄位置</h3>
            <div className="showcase-condition-details">
              {DROP_POINTS.map(dropPoint => {
                const meta = CONDITION_META[dropPoint];
                return (
                  <article key={dropPoint}>
                    <span>{meta.order}</span>
                    <strong>{meta.plain}</strong>
                    <code>{meta.technical}</code>
                    <p>{meta.description}</p>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="showcase-detail-section showcase-notes">
            <article>
              <h3>実験の範囲</h3>
              <p>破棄対象をUDP portで事前に決められる場合だけを扱います。DDoS検知製品の評価ではありません。</p>
            </article>
            <article>
              <h3>解釈の注意</h3>
              <p>Pi、kernel、NIC、driver、payload、rate段階に依存します。native XDPとgeneric XDPは混ぜません。</p>
            </article>
          </section>

          <section className="showcase-environment">
            <h3>このrunの環境</h3>
            <dl>
              <div><dt>Receiver</dt><dd>{representative?.environment?.receiver_model ?? "unknown"}</dd></div>
              <div><dt>Kernel</dt><dd>{representative?.environment?.kernel_release ?? "unknown"}</dd></div>
              <div><dt>NIC / MTU</dt><dd>{representative?.environment?.network_interface ?? "unknown"} / {representative?.environment?.mtu ?? "unknown"}</dd></div>
              <div><dt>CPU governor</dt><dd>{representative?.environment?.cpu_governor ?? "unknown"}</dd></div>
              <div><dt>XDP attach</dt><dd>{xdpMode}</dd></div>
              <div><dt>Experiment</dt><dd>{representative?.experiment_id ?? "waiting"}</dd></div>
            </dl>
          </section>
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const demo = isWebDemo();
  const [streamStatus, setStreamStatus] = useState(demo ? "fixture" : "waiting");
  const [runs, setRuns] = useState<ExperimentRun[]>(demo ? FIXTURE_RUNS : []);
  const [health, setHealth] = useState<HealthState>(
    demo ? DEFAULT_HEALTH : { success: false, latencyMs: 0, statusCode: null },
  );
  const [selected, setSelected] = useState<DropPoint>(demo ? "xdp" : "application");
  const [showDetails, setShowDetails] = useState(false);
  const detailsButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const summaries = useMemo(() => summarizeRuns(runs), [runs]);
  const representative = runs.at(-1);
  const sweepSteps = representative?.sweep?.pps_steps ?? SAMPLE_PPS_STEPS;
  const repetitions = representative?.sweep?.repetitions ?? SAMPLE_REPETITIONS;
  const measured = summaries.filter(summary => summary.maxMaintainedPps != null);
  const best = measured.reduce<ConditionSummary | null>(
    (current, candidate) =>
      current == null || Number(candidate.maxMaintainedPps) > Number(current.maxMaintainedPps)
        ? candidate
        : current,
    null,
  );
  const baseline = summaries.find(item => item.dropPoint === "application");
  const ratio =
    best?.maxMaintainedPps && baseline?.maxMaintainedPps
      ? best.maxMaintainedPps / baseline.maxMaintainedPps
      : null;
  const complete = DROP_POINTS.every(dropPoint =>
    sweepSteps.every(
      targetPps =>
        runs.filter(
          run => run.drop_point === dropPoint && run.target_pps === targetPps,
        ).length >= repetitions,
    ),
  );
  const invalid = summaries.some(item => item.mixedAttachModes || item.nonMonotonic);
  const selectedSummary = summaries.find(item => item.dropPoint === selected);
  const selectedRun = [...runs].reverse().find(run => run.drop_point === selected);
  const displayedPps = complete
    ? selectedSummary?.maxMaintainedPps ?? null
    : selectedRun
      ? actualPps(selectedRun)
      : null;
  const rigModeLabel = demo
    ? "SAMPLE RESULT"
    : complete
      ? "MEASURED RESULT"
      : "LIVE EXPERIMENT";
  const loadLabel = complete ? "上限時の実送信" : "現在の実送信";

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
            statusCode: event.status_code == null ? null : Number(event.status_code),
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
          setSelected(run.drop_point);
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
    if (showDetails) closeButtonRef.current?.focus();
    else previousFocusRef.current?.focus();
  }, [showDetails]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && showDetails) closeDetails();
      if (event.key.toLowerCase() === "d" && !showDetails) {
        const target = event.target as HTMLElement | null;
        if (!target?.closest("input, textarea, select")) openDetails();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showDetails]);

  const bestMeta = best ? CONDITION_META[best.dropPoint] : null;

  return (
    <div className="showcase-shell">
      <header className="showcase-header">
        <a className="showcase-brand" href="#showcase-top" aria-label="パケットぽいぽい">
          <span><PacketMark /></span>
          <div>
            <strong>パケットぽいぽい</strong>
            <small>Raspberry Pi × Rust × eBPF/XDP</small>
          </div>
        </a>
        <div className="showcase-header__actions">
          <span className={`showcase-data ${demo ? "is-sample" : "is-live"}`}>
            {demo ? "SAMPLE" : `LIVE · ${streamStatus.toUpperCase()}`}
          </span>
          <button ref={detailsButtonRef} type="button" onClick={openDetails}>
            技術詳細 <kbd>D</kbd>
          </button>
        </div>
      </header>

      <main id="showcase-top" className="showcase-main">
        <section className="showcase-hero">
          <div>
            <span>PHYSICAL NETWORK EXPERIMENT</span>
            <h1>
              <strong>不要な通信は、どこで捨てる？</strong>
              <em>
                {complete && !invalid && ratio != null
                  ? `捨てる場所だけで、耐えられる負荷が${formatNumber(ratio, 1)}倍変わった。`
                  : "Webサービスが耐えた最大負荷を、実機で比べる。"}
              </em>
            </h1>
            <p>Pi Aから同じUDP負荷を送り、Pi Bで破棄位置だけを変えます。</p>
          </div>

          <aside className={`showcase-winner ${invalid ? "is-invalid" : ""}`} aria-live="polite">
            <span>{invalid ? "CHECK REQUIRED" : complete ? "RESULT" : "MEASURING"}</span>
            {invalid ? (
              <>
                <b className="showcase-winner__state">再測定</b>
                <strong>条件をそろえて確認</strong>
              </>
            ) : complete && best && bestMeta ? (
              <>
                <div className="showcase-winner__impact">
                  <b>{ratio != null ? formatNumber(ratio, 1) : formatPps(best.maxMaintainedPps)}</b>
                  <em>{ratio != null ? "× Application比" : "pps"}</em>
                </div>
                <strong>{bestMeta.plain}</strong>
                <code>{bestMeta.technical} · {formatPps(best.maxMaintainedPps)} pps</code>
              </>
            ) : (
              <>
                <b className="showcase-winner__state">計測中</b>
                <strong>{runs.length} run 受信</strong>
              </>
            )}
          </aside>
        </section>


        <RigView
          selected={selected}
          displayPps={displayedPps}
          modeLabel={rigModeLabel}
          loadLabel={loadLabel}
          health={health}
          payloadBytes={representative?.payload_bytes ?? 128}
          xdpAttachMode={summaries.find(item => item.dropPoint === "xdp")?.attachMode ?? "unknown"}
        />

        <ScoreCards summaries={summaries} selected={selected} onSelect={setSelected} />
      </main>

      <footer className="showcase-footer">
        <p>入口で捨てるほど速い。代わりに、URLやユーザー状態は見られない。</p>
      </footer>

      {showDetails && (
        <DetailsDialog
          onClose={closeDetails}
          closeButtonRef={closeButtonRef}
          representative={representative}
          summaries={summaries}
        />
      )}
    </div>
  );
}
