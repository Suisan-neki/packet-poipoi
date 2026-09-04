import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { isWebDemo, subscribeStream } from "../stream.js";

type DropPoint = "application" | "netfilter" | "xdp";
type ViewId = DropPoint | "compare";

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
  loadDeliveryPercent: number;
  cpuPercent: number;
  softirqPer10k: number;
  appReceivePercent: number;
  successPercent: number;
  latencyP95Ms: number;
  runs: number;
  maintained: boolean;
  status: RateStatus;
}

interface ConditionSummary {
  dropPoint: DropPoint;
  rates: RateSummary[];
  maxMaintainedPps: number | null;
  limitResult: RateSummary | null;
  totalRuns: number;
  attachMode: string;
  nonMonotonic: boolean;
  mixedAttachModes: boolean;
}

interface HealthState {
  success: boolean;
  latencyMs: number;
  statusCode: number | null;
}

interface ConditionMeta {
  order: string;
  tabLabel: string;
  title: string;
  technicalLabel: string;
  description: string;
  savedWork: string;
}

const DROP_POINTS: DropPoint[] = ["application", "netfilter", "xdp"];
const VIEWS: ViewId[] = ["application", "netfilter", "xdp", "compare"];
const SAMPLE_PPS_STEPS = [500, 2_000, 5_000, 10_000, 20_000, 50_000];
const SAMPLE_REPETITIONS = 3;

const CONDITION_META: Record<DropPoint, ConditionMeta> = {
  application: {
    order: "01",
    tabLabel: "アプリで捨てる",
    title: "アプリに届いてから捨てる",
    technicalLabel: "Application / UDP socket",
    description:
      "UDPパケットを通常の受信経路でソケットまで届け、受信数を数えた後に破棄します。ほかの2条件と比べるための基準です。",
    savedWork: "省ける受信処理はありません。NICからUDP socketまで、通常の経路を通ります。",
  },
  netfilter: {
    order: "02",
    tabLabel: "途中で捨てる",
    title: "Linuxの受信処理の途中で捨てる",
    technicalLabel: "nftables → Netfilter input hook",
    description:
      "nftablesでUDP宛先ポート4000のdrop ruleを入れ、Netfilterのinput hookで破棄します。UDP socketには届きません。",
    savedWork: "アプリへの配送と、UDP socketで受信する処理を省きます。",
  },
  xdp: {
    order: "03",
    tabLabel: "入口で捨てる",
    title: "XDPフックで早い段階に捨てる",
    technicalLabel: "eBPF / XDP_DROP",
    description:
      "AyaでロードしたeBPFプログラムがUDP宛先ポート4000を判定し、XDP_DROPを返します。実際の位置はattach modeで変わります。",
    savedWork: "native XDPなら、通常のLinux network stackへ進ませず、アプリへの配送も行いません。",
  },
};

const PATH_LAYERS = [
  { id: "nic", plain: "LANから受信", technical: "NIC" },
  { id: "xdp", plain: "入口の判定", technical: "XDP" },
  { id: "stack", plain: "Linuxの受信処理", technical: "network stack" },
  { id: "netfilter", plain: "ルールで判定", technical: "Netfilter input" },
  { id: "application", plain: "アプリへ配送", technical: "UDP socket" },
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

// 公開ページは画面説明用のfixture。実測値ではない。
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

function loadDeliveryPercent(run: ExperimentRun) {
  if (run.target_pps <= 0) return 0;
  return actualPps(run) * 100 / run.target_pps;
}

function loadRateAchieved(run: ExperimentRun) {
  const threshold = run.sweep?.min_load_delivery_percent ?? 90;
  return loadDeliveryPercent(run) >= threshold;
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
      const loadValid =
        !mixedAttachModes &&
        rateRuns.length > 0 &&
        validRuns.length === rateRuns.length;
      const maintained =
        loadValid &&
        validRuns.length > 0 &&
        maintainedRuns * 2 > validRuns.length;

      return {
        targetPps,
        actualPps: median(rateRuns.map(actualPps)),
        loadDeliveryPercent: median(rateRuns.map(loadDeliveryPercent)),
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
        maintained,
        status: !loadValid
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
      totalRuns: conditionRuns.length,
      attachMode:
        mixedAttachModes
          ? `${observedAttachModes.join(" / ")}（混在）`
          : observedAttachModes.at(0) ??
            conditionRuns.at(-1)?.xdp_attach_mode ??
            "unknown",
      nonMonotonic,
      mixedAttachModes,
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

function viewLabel(view: ViewId) {
  if (view === "compare") return "結果を比べる";
  return CONDITION_META[view].tabLabel;
}

function statusLabel(status: RateStatus) {
  if (status === "maintained") return "サービス維持";
  if (status === "failed") return "基準外";
  return "測定不成立";
}

function xdpModeDescription(mode: string) {
  if (mode.includes("混在")) {
    return "native XDPとgeneric XDPが混在しています。実行位置とコストが違うため、この状態では上限値を集計しません。";
  }
  if (mode === "native") {
    return "native XDP：NIC driverの受信処理内で実行され、通常はskbを作る前に破棄します。";
  }
  if (mode === "generic") {
    return "generic XDP：互換経路で実行されます。skb生成後のため、native XDPとは結果を分けて扱います。";
  }
  return "XDP attach modeを確認できていません。native / genericを確定してから結果を解釈します。";
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

function ProbeStatus({ health }: { health: HealthState }) {
  const waiting =
    !health.success && health.statusCode == null && health.latencyMs === 0;
  const stateClass = waiting ? "is-waiting" : health.success ? "is-ok" : "is-down";
  const label = waiting
    ? "計測待ち"
    : health.success
      ? `HTTP ${health.statusCode ?? "OK"} · ${health.latencyMs || "—"} ms`
      : "応答なし";

  return (
    <div className={`probe-status ${stateClass}`}>
      <span aria-hidden="true" />
      <div>
        <small>守る対象のHTTP</small>
        <strong>{label}</strong>
      </div>
    </div>
  );
}

function ExperimentTabs({
  activeView,
  onSelect,
}: {
  activeView: ViewId;
  onSelect: (view: ViewId) => void;
}) {
  return (
    <nav className="experiment-tabs" aria-label="比較する条件">
      {VIEWS.map((view, index) => {
        const active = view === activeView;
        const technical =
          view === "compare" ? "Summary" : CONDITION_META[view].technicalLabel;
        return (
          <button
            key={view}
            type="button"
            className={active ? "is-active" : ""}
            aria-current={active ? "step" : undefined}
            onClick={() => onSelect(view)}
          >
            <b>{String(index + 1).padStart(2, "0")}</b>
            <span>
              <strong>{viewLabel(view)}</strong>
              <small>{technical}</small>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function ReceptionPath({
  dropPoint,
  attachMode,
  payloadBytes,
}: {
  dropPoint: DropPoint;
  attachMode: string;
  payloadBytes: number;
}) {
  const stopIndex =
    dropPoint === "xdp" ? 1 : dropPoint === "netfilter" ? 3 : 4;

  return (
    <div className="path-wrap">
      <div className="path-source">
        <small>Pi Aから送る実験用負荷</small>
        <strong>IPv4 / UDP :4000</strong>
        <span>{payloadBytes} byte payload</span>
      </div>
      <div className="path-arrow" aria-hidden="true">→</div>
      <div className="path-flow" aria-label="Raspberry Pi Bの受信経路">
        {PATH_LAYERS.map((layer, index) => {
          const reached = index <= stopIndex;
          const stopped = index === stopIndex;
          return (
            <div className="path-step" key={layer.id}>
              {index > 0 && (
                <span
                  className={`path-connector ${reached ? "is-reached" : ""}`}
                  aria-hidden="true"
                />
              )}
              <div
                className={`path-node ${reached ? "is-reached" : "is-skipped"} ${
                  stopped ? "is-stop" : ""
                }`}
              >
                <small>{layer.plain}</small>
                <strong>{layer.technical}</strong>
                {stopped && <em>{dropPoint === "application" ? "受信後に破棄" : "ここで破棄"}</em>}
              </div>
            </div>
          );
        })}
      </div>
      {dropPoint === "xdp" && (
        <p className="path-mode-note">この計測のattach mode：<strong>{attachMode}</strong></p>
      )}
    </div>
  );
}

function LoadSweep({ summary }: { summary: ConditionSummary }) {
  return (
    <div className="sweep-grid">
      {summary.rates.map(rate => (
        <div
          className={`sweep-step is-${rate.status}`}
          key={rate.targetPps}
          aria-label={`目標${formatNumber(rate.targetPps)}pps、${statusLabel(rate.status)}。実送信${formatNumber(rate.actualPps)}pps、HTTP成功率${formatNumber(rate.successPercent)}%、p95 ${formatNumber(rate.latencyP95Ms)}ms`}
        >
          <small>目標</small>
          <strong>{formatPps(rate.targetPps)}<em> pps</em></strong>
          <span><i aria-hidden="true" />{statusLabel(rate.status)}</span>
        </div>
      ))}
    </div>
  );
}

function LimitMetrics({
  summary,
  minSuccessPercent,
  maxP95LatencyMs,
}: {
  summary: ConditionSummary;
  minSuccessPercent: number;
  maxP95LatencyMs: number;
}) {
  const limit = summary.limitResult;

  return (
    <dl className="limit-metrics">
      <div>
        <dt>実送信量</dt>
        <dd>{limit ? `${formatPps(limit.actualPps)} pps` : "—"}</dd>
        <small>送信数 ÷ 実計測時間</small>
      </div>
      <div>
        <dt>HTTP成功率</dt>
        <dd>{limit ? `${formatNumber(limit.successPercent)}%` : "—"}</dd>
        <small>合格は{formatNumber(minSuccessPercent)}%以上</small>
      </div>
      <div>
        <dt>HTTP p95</dt>
        <dd>{limit ? `${formatNumber(limit.latencyP95Ms)} ms` : "—"}</dd>
        <small>合格は{formatNumber(maxP95LatencyMs)}ms以下</small>
      </div>
      <div>
        <dt>CPU busy</dt>
        <dd>{limit ? `${formatNumber(limit.cpuPercent, 1)}%` : "—"}</dd>
        <small>原因を読む補助指標</small>
      </div>
    </dl>
  );
}

function ConditionStage({
  summary,
  minSuccessPercent,
  maxP95LatencyMs,
  minLoadDeliveryPercent,
  payloadBytes,
}: {
  summary: ConditionSummary;
  minSuccessPercent: number;
  maxP95LatencyMs: number;
  minLoadDeliveryPercent: number;
  payloadBytes: number;
}) {
  const meta = CONDITION_META[summary.dropPoint];
  const technicalNote =
    summary.dropPoint === "xdp"
      ? xdpModeDescription(summary.attachMode)
      : meta.savedWork;

  return (
    <section className="stage-card" aria-labelledby={`condition-${summary.dropPoint}`}>
      <header className="condition-heading">
        <div className="condition-copy">
          <span className="section-kicker">条件 {meta.order}</span>
          <h2 id={`condition-${summary.dropPoint}`}>{meta.title}</h2>
          <code>{meta.technicalLabel}</code>
          <p>{meta.description}</p>
        </div>
        <div className="primary-result">
          <span>HTTP基準を保てた最大の実送信量</span>
          <strong>{formatPps(summary.maxMaintainedPps)}<em> pps</em></strong>
          <p>低い負荷から連続して合格した最後の段階</p>
        </div>
      </header>

      <section className="stage-section path-section" aria-labelledby="path-title">
        <div className="section-heading">
          <div>
            <span className="section-kicker">何を変えたか</span>
            <h3 id="path-title">UDPパケットが止まる場所</h3>
          </div>
          <p>{technicalNote}</p>
        </div>
        <ReceptionPath
          dropPoint={summary.dropPoint}
          attachMode={summary.attachMode}
          payloadBytes={payloadBytes}
        />
      </section>

      <section className="stage-section sweep-section" aria-labelledby="sweep-title">
        <div className="section-heading">
          <div>
            <span className="section-kicker">何を測ったか</span>
            <h3 id="sweep-title">送信量を段階的に上げたときのHTTP</h3>
          </div>
          <p>
            各段階を{summary.rates.at(0)?.runs ?? 0}回計測。成功率{formatNumber(minSuccessPercent)}%以上、
            p95 {formatNumber(maxP95LatencyMs)}ms以下、実送信量が目標の
            {formatNumber(minLoadDeliveryPercent)}%以上なら有効です。
          </p>
        </div>
        <LoadSweep summary={summary} />
        <div className="sweep-legend" aria-label="判定の凡例">
          <span className="is-maintained"><i />サービス維持</span>
          <span className="is-failed"><i />HTTPが基準外</span>
          <span className="is-unverified"><i />送信量不足などで測定不成立</span>
        </div>
        <LimitMetrics
          summary={summary}
          minSuccessPercent={minSuccessPercent}
          maxP95LatencyMs={maxP95LatencyMs}
        />
        {summary.mixedAttachModes && (
          <div className="measurement-warning" role="status">
            native XDPとgeneric XDPが同じ集計に含まれています。実行位置とコストが異なるため、XDP条件の上限値から除外しました。attach modeをそろえて再測定してください。
          </div>
        )}
        {summary.nonMonotonic && (
          <div className="measurement-warning" role="status">
            低い負荷で不合格になった後、高い負荷で再び合格しています。上限値として断定せず、再測定が必要です。
          </div>
        )}
      </section>
    </section>
  );
}

function ComparisonStage({ summaries }: { summaries: ConditionSummary[] }) {
  const measured = summaries.filter(summary => summary.maxMaintainedPps != null);
  const best = measured.reduce<ConditionSummary | null>(
    (currentBest, candidate) =>
      currentBest == null ||
      Number(candidate.maxMaintainedPps) > Number(currentBest.maxMaintainedPps)
        ? candidate
        : currentBest,
    null,
  );
  const baseline = summaries.find(summary => summary.dropPoint === "application");
  const ratio =
    best?.maxMaintainedPps && baseline?.maxMaintainedPps
      ? best.maxMaintainedPps / baseline.maxMaintainedPps
      : null;
  const maxValue = Math.max(
    ...summaries.map(summary => summary.maxMaintainedPps ?? 0),
    1,
  );

  return (
    <section className="stage-card comparison-stage" aria-labelledby="comparison-title">
      <header className="comparison-heading">
        <div>
          <span className="section-kicker">主結果</span>
          <h2 id="comparison-title">HTTPが基準内だった最大の実送信pps</h2>
          <p>
            CPU使用率の低さではなく、守りたいWebサービスが応答を保てた負荷の上限を比べます。
          </p>
        </div>
        <div className="comparison-callout">
          <small>この条件で最大</small>
          <strong>{best ? CONDITION_META[best.dropPoint].tabLabel : "未計測"}</strong>
          <span>{best ? CONDITION_META[best.dropPoint].technicalLabel : "—"}</span>
        </div>
      </header>

      <div className="result-bars" role="list" aria-label="破棄位置ごとの最大維持負荷">
        {summaries.map(summary => {
          const meta = CONDITION_META[summary.dropPoint];
          const limit = summary.limitResult;
          const width = (summary.maxMaintainedPps ?? 0) * 100 / maxValue;
          return (
            <article
              className={`result-row ${best?.dropPoint === summary.dropPoint ? "is-best" : ""}`}
              key={summary.dropPoint}
              role="listitem"
            >
              <div className="result-label">
                <b>{meta.order}</b>
                <span>
                  <strong>{meta.tabLabel}</strong>
                  <small>{meta.technicalLabel}</small>
                </span>
              </div>
              <div className="result-bar-cell">
                <div className="result-bar-track">
                  <span
                    style={{ "--bar-width": `${width}%` } as CSSProperties}
                  />
                </div>
                <small>
                  {limit
                    ? `HTTP ${formatNumber(limit.successPercent)}% · p95 ${formatNumber(limit.latencyP95Ms)}ms · CPU ${formatNumber(limit.cpuPercent, 1)}%`
                    : "有効な上限を未計測"}
                </small>
              </div>
              <div className="result-value">
                <strong>{formatPps(summary.maxMaintainedPps)}</strong>
                <span>pps</span>
              </div>
            </article>
          );
        })}
      </div>

      <div className="result-reading">
        <article>
          <span className="section-kicker">結果の読み方</span>
          <h3>
            {best && ratio
              ? `${CONDITION_META[best.dropPoint].technicalLabel}は、Applicationの約${formatNumber(ratio, 1)}倍までHTTP基準を維持`
              : "全条件の計測がそろうと、ここに比較結果を表示します"}
          </h3>
          <p>
            これは「入口で捨てれば常に正解」という意味ではありません。早い段階ほど省ける処理は増えますが、URLや認証状態などアプリ固有の情報は使えなくなります。
          </p>
        </article>
        <aside>
          <strong>この結果を一般化しない</strong>
          <p>
            Piの型、kernel、NIC、driver、XDP attach mode、payload、rate段階に依存します。未計測の中間ppsも補間していません。
          </p>
        </aside>
      </div>
    </section>
  );
}

function DetailsDialog({
  onClose,
  closeButtonRef,
  representative,
  minSuccessPercent,
  maxP95LatencyMs,
  minLoadDeliveryPercent,
  durationSeconds,
  repetitions,
  xdpAttachMode,
}: {
  onClose: () => void;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  representative?: ExperimentRun;
  minSuccessPercent: number;
  maxP95LatencyMs: number;
  minLoadDeliveryPercent: number;
  durationSeconds: number;
  repetitions: number;
  xdpAttachMode: string;
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="details-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="details-title"
        onMouseDown={(event: { stopPropagation: () => void }) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="section-kicker">Technical notes</span>
            <h2 id="details-title">用語・判定方法・実験の限界</h2>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose}>
            閉じる <kbd>Esc</kbd>
          </button>
        </header>

        <div className="details-body">
          <section className="details-lead">
            <h3>この実験で役割が違う2種類の通信</h3>
            <div>
              <article>
                <span>増やす通信</span>
                <strong>UDP :4000</strong>
                <p>量を制御しやすい実験用負荷。防御対象のサービスではありません。</p>
              </article>
              <article>
                <span>守る通信</span>
                <strong>HTTP GET /api/ping</strong>
                <p>同じ受信側Pi上のWebサービス。成功率と応答時間で状態を測ります。</p>
              </article>
            </div>
          </section>

          <section className="details-section">
            <h3>主結果を決める手順</h3>
            <ol className="method-steps">
              <li>
                <b>1</b>
                <div>
                  <strong>実際に送れた負荷を確認</strong>
                  <p><code>actual pps = packets sent ÷ measured duration</code></p>
                  <p>目標ppsの{formatNumber(minLoadDeliveryPercent)}%未満なら、送信側の限界かもしれないため測定不成立です。</p>
                </div>
              </li>
              <li>
                <b>2</b>
                <div>
                  <strong>Webサービスを維持できたか判定</strong>
                  <p>HTTP成功率{formatNumber(minSuccessPercent)}%以上、かつp95応答時間{formatNumber(maxP95LatencyMs)}ms以下なら、そのrunは合格です。</p>
                </div>
              </li>
              <li>
                <b>3</b>
                <div>
                  <strong>反復の多数決と連続性を確認</strong>
                  <p>各rateを{repetitions}回計測し、多数決で合否を決めます。低いrateから連続して合格した最後の実送信pps中央値を上限にします。</p>
                </div>
              </li>
            </ol>
          </section>

          <section className="details-section">
            <h3>画面に出てくる用語</h3>
            <dl className="glossary-grid">
              <div>
                <dt>pps</dt>
                <dd>packets per second。1秒間に送ったパケット数です。目標値ではなく実送信ppsを主結果に使います。</dd>
              </div>
              <div>
                <dt>p95 latency</dt>
                <dd>応答時間の95パーセンタイル。全リクエストの95%がこの値以下で、遅い側5%との境目です。</dd>
              </div>
              <div>
                <dt>nftables / Netfilter</dt>
                <dd>nftablesはルールを設定する仕組み、Netfilterはkernel内のpacket処理フレームワークです。この実験ではinput hookへdrop ruleを入れます。</dd>
              </div>
              <div>
                <dt>XDP</dt>
                <dd>Linuxの早い受信段階でeBPF programを実行するhook。nativeとgenericでは実行位置とコストが違うため、結果を混ぜません。</dd>
              </div>
              <div>
                <dt>CPU busy</dt>
                <dd><code>/proc/stat</code>の差分から、idle以外だった割合を算出します。主結果ではなく原因を読む補助指標です。</dd>
              </div>
              <div>
                <dt>NET_RX softirq</dt>
                <dd>Linuxがネットワーク受信処理を行った量の手掛かりです。画面では1万送信packetあたりに正規化します。</dd>
              </div>
            </dl>
          </section>

          <section className="details-section details-columns">
            <article>
              <h3>固定している条件</h3>
              <ul>
                <li>IPv4 / UDP、宛先port 4000、payload {representative?.payload_bytes ?? 128} byte</li>
                <li>1 run {formatNumber(durationSeconds, 1)}秒、各rate・各破棄位置を{repetitions}回</li>
                <li>HTTP probeは約200ms間隔</li>
                <li>rateの昇順・降順を交互にし、破棄位置の開始順も回す</li>
              </ul>
            </article>
            <article>
              <h3>この実験からは言えないこと</h3>
              <ul>
                <li>DDoSを検知・防御する製品の性能評価ではない</li>
                <li>破棄対象を事前にUDP portで特定できる場合だけを扱う</li>
                <li>URLやユーザー状態など、アプリの文脈が必要な判定はXDPへ移せない</li>
                <li>1台のPiの結果を、別のmachineやworkloadへ一般化しない</li>
              </ul>
            </article>
          </section>

          <section className="environment-panel">
            <h3>このrunの環境</h3>
            <dl>
              <div>
                <dt>Experiment ID</dt>
                <dd>{representative?.experiment_id ?? "waiting"}</dd>
              </div>
              <div>
                <dt>Receiver</dt>
                <dd>{representative?.environment?.receiver_model ?? "unknown"}</dd>
              </div>
              <div>
                <dt>Kernel</dt>
                <dd>{representative?.environment?.kernel_release ?? "unknown"}</dd>
              </div>
              <div>
                <dt>NIC / MTU</dt>
                <dd>{representative?.environment?.network_interface ?? "unknown"} / {representative?.environment?.mtu ?? "unknown"}</dd>
              </div>
              <div>
                <dt>CPU governor</dt>
                <dd>{representative?.environment?.cpu_governor ?? "unknown"}</dd>
              </div>
              <div>
                <dt>XDP attach mode</dt>
                <dd>{xdpAttachMode}</dd>
              </div>
            </dl>
          </section>
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const demo = isWebDemo();
  const [activeView, setActiveView] = useState<ViewId>("application");
  const [streamStatus, setStreamStatus] = useState(demo ? "fixture" : "waiting");
  const [runs, setRuns] = useState<ExperimentRun[]>(demo ? FIXTURE_RUNS : []);
  const [health, setHealth] = useState<HealthState>(
    demo ? DEFAULT_HEALTH : { success: false, latencyMs: 0, statusCode: null },
  );
  const [showDetails, setShowDetails] = useState(false);
  const detailsButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const summaries = useMemo(() => summarizeRuns(runs), [runs]);
  const representative = runs.at(-1);
  const sweepSteps = representative?.sweep?.pps_steps ?? SAMPLE_PPS_STEPS;
  const repetitions = representative?.sweep?.repetitions ?? SAMPLE_REPETITIONS;
  const payloadBytes = representative?.payload_bytes ?? 128;
  const durationSeconds = (representative?.duration_ms ?? 10_000) / 1_000;
  const minSuccessPercent = representative?.service_health?.min_success_percent ?? 99;
  const maxP95LatencyMs = representative?.service_health?.max_p95_latency_ms ?? 100;
  const minLoadDeliveryPercent = representative?.sweep?.min_load_delivery_percent ?? 90;
  const firstSweepRate = sweepSteps.at(0) ?? SAMPLE_PPS_STEPS[0];
  const lastSweepRate = sweepSteps.at(-1) ?? SAMPLE_PPS_STEPS.at(-1) ?? firstSweepRate;

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
          setActiveView(run.drop_point);
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
    if (demo) return;
    const hasEveryRun = DROP_POINTS.every(dropPoint =>
      sweepSteps.every(
        targetPps =>
          runs.filter(
            run => run.drop_point === dropPoint && run.target_pps === targetPps,
          ).length >= repetitions,
      ),
    );
    if (hasEveryRun) setActiveView("compare");
  }, [demo, repetitions, runs, sweepSteps]);

  useEffect(() => {
    if (showDetails) {
      closeButtonRef.current?.focus();
    } else {
      previousFocusRef.current?.focus();
    }
  }, [showDetails]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && showDetails) {
        closeDetails();
      }
      if (event.key.toLowerCase() === "d" && !showDetails) {
        const target = event.target as HTMLElement | null;
        if (!target?.closest("input, textarea, select")) openDetails();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showDetails]);

  const activeSummary =
    activeView === "compare"
      ? undefined
      : summaries.find(summary => summary.dropPoint === activeView);

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="#top" aria-label="パケットぽいぽい トップへ">
          <span className="brand-mark"><PacketMark /></span>
          <span>
            <strong>パケットぽいぽい</strong>
            <small>drop point × service limit</small>
          </span>
        </a>

        <div className="header-actions">
          <span className={`data-badge ${demo ? "is-sample" : "is-live"}`}>
            {demo ? "SAMPLE DATA" : streamStatus.toUpperCase()}
          </span>
          <ProbeStatus health={health} />
          <button ref={detailsButtonRef} type="button" onClick={openDetails}>
            用語と計測方法 <kbd>D</kbd>
          </button>
        </div>
      </header>

      <main id="top" className="app-main">
        <section className="hero">
          <div>
            <span className="hero-kicker">破棄位置だけを変える比較実験</span>
            <h1>
              不要なUDPをどこで捨てると、
              <strong>同じPi上のWebサービスは最も高い負荷まで応答を保てるか。</strong>
            </h1>
            <p>
              UDPは増やす実験用負荷、HTTPは守るサービスです。主結果は、HTTP成功率と応答時間の基準を保てた<strong>最大の実送信pps</strong>です。
            </p>
          </div>
          <dl className="fixed-conditions">
            <div>
              <dt>負荷</dt>
              <dd>UDP {payloadBytes} byte</dd>
            </div>
            <div>
              <dt>段階</dt>
              <dd>{formatPps(firstSweepRate)} → {formatPps(lastSweepRate)} pps</dd>
            </div>
            <div>
              <dt>反復</dt>
              <dd>{formatNumber(durationSeconds, 1)}秒 × {repetitions}回</dd>
            </div>
          </dl>
        </section>

        {demo && (
          <p className="sample-note">
            公開ページの数値は画面説明用のサンプルです。展示版ではRaspberry Piから届く実測値を表示します。
          </p>
        )}

        <ExperimentTabs activeView={activeView} onSelect={setActiveView} />

        {activeView === "compare" ? (
          <ComparisonStage summaries={summaries} />
        ) : activeSummary ? (
          <ConditionStage
            summary={activeSummary}
            minSuccessPercent={minSuccessPercent}
            maxP95LatencyMs={maxP95LatencyMs}
            minLoadDeliveryPercent={minLoadDeliveryPercent}
            payloadBytes={payloadBytes}
          />
        ) : (
          <section className="stage-card empty-stage">
            <strong>計測データを待っています</strong>
            <p>experiment_runを受信すると、破棄位置ごとの結果を表示します。</p>
          </section>
        )}
      </main>

      <footer className="app-footer">
        <p>
          入口ほど省ける処理は増えます。ただし、入口ほどアプリの文脈を使えません。
        </p>
        <button type="button" onClick={openDetails}>実験の前提と限界を確認</button>
      </footer>

      {showDetails && (
        <DetailsDialog
          onClose={closeDetails}
          closeButtonRef={closeButtonRef}
          representative={representative}
          minSuccessPercent={minSuccessPercent}
          maxP95LatencyMs={maxP95LatencyMs}
          minLoadDeliveryPercent={minLoadDeliveryPercent}
          durationSeconds={durationSeconds}
          repetitions={repetitions}
          xdpAttachMode={summaries.find(summary => summary.dropPoint === "xdp")?.attachMode ?? "unknown"}
        />
      )}
    </div>
  );
}
