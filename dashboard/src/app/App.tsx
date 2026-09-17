import { useEffect, useMemo, useState } from "react";
import { isWebDemo, subscribeStream } from "../stream.js";
import PacketFlow from "./PacketFlow";

type DropPoint = "application" | "netfilter" | "xdp";

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
  service_health?: ServiceHealthSummary;
  sweep?: SweepPlan;
}

interface HarborEvent extends Partial<ExperimentRun> {
  type?: string;
  success?: boolean;
  latency_ms?: number;
  status_code?: number;
  pps?: number;
  attach_mode?: string;
}

interface HealthState {
  success: boolean;
  latencyMs: number;
  statusCode: number | null;
}

interface RateResult {
  targetPps: number;
  actualPps: number;
  successPercent: number;
  latencyP95Ms: number;
  maintained: boolean;
  valid: boolean;
}

interface ConditionSummary {
  dropPoint: DropPoint;
  maxMaintainedPps: number | null;
  limitResult: RateResult | null;
}

const DROP_POINTS: DropPoint[] = ["xdp", "netfilter", "application"];
const SAMPLE_PPS_STEPS = [500, 2_000, 5_000, 10_000, 20_000, 50_000];
const SAMPLE_REPETITIONS = 3;

const CONDITION_META: Record<DropPoint, {
  number: string;
  label: string;
  technical: string;
  stage: string;
  balanceLabel: string;
}> = {
  xdp: {
    number: "1",
    label: "入口で止める",
    technical: "XDP",
    stage: "xdp",
    balanceLabel: "安全性寄り",
  },
  netfilter: {
    number: "2",
    label: "途中で止める",
    technical: "Netfilter",
    stage: "netfilter",
    balanceLabel: "中間",
  },
  application: {
    number: "3",
    label: "届いてから止める",
    technical: "Application",
    stage: "application",
    balanceLabel: "通信可用性寄り",
  },
};

const SAMPLE_PROFILES: Record<DropPoint, { p95: number[]; success: number[] }> = {
  application: {
    p95: [18, 19, 27, 132, 310, 850],
    success: [100, 100, 100, 98, 84, 38],
  },
  netfilter: {
    p95: [17, 18, 20, 34, 125, 420],
    success: [100, 100, 100, 100, 98, 66],
  },
  xdp: {
    p95: [16, 16, 17, 19, 29, 146],
    success: [100, 100, 100, 100, 100, 98],
  },
};

const FIXTURE_RUNS: ExperimentRun[] = ["application", "netfilter", "xdp"].flatMap(rawDropPoint => {
  const dropPoint = rawDropPoint as DropPoint;
  return SAMPLE_PPS_STEPS.flatMap((targetPps, rateIndex) =>
    [1, 2, 3].map(repetition => {
      const profile = SAMPLE_PROFILES[dropPoint];
      const checks = 50;
      const success = profile.success[rateIndex];
      return {
        experiment_id: "sample-service-limit",
        run_id: `sample-${dropPoint}-${targetPps}-${repetition}`,
        repetition,
        drop_point: dropPoint,
        duration_ms: 10_000,
        target_pps: targetPps,
        payload_bytes: 128,
        packets_sent: targetPps * 10,
        packets_received_by_app: dropPoint === "application" ? targetPps * 10 : 0,
        cpu_busy_percent: 0,
        net_rx_softirq_delta: 0,
        xdp_attach_mode: dropPoint === "xdp" ? "generic" : "not_used",
        service_health: {
          checks,
          successes: Math.round(checks * success / 100),
          latency_p95_ms: profile.p95[rateIndex] + repetition - 2,
          latency_max_ms: profile.p95[rateIndex] * 2,
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
  );
});

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function actualPps(run: ExperimentRun) {
  if (run.duration_ms <= 0) return 0;
  return run.packets_sent * 1_000 / run.duration_ms;
}

function successPercent(health?: ServiceHealthSummary) {
  if (!health || health.checks === 0) return 0;
  return health.successes * 100 / health.checks;
}

function serviceMaintained(health?: ServiceHealthSummary) {
  if (!health || health.checks === 0) return false;
  return successPercent(health) >= health.min_success_percent
    && health.latency_p95_ms <= health.max_p95_latency_ms;
}

function loadRateAchieved(run: ExperimentRun) {
  if (run.target_pps <= 0) return false;
  const threshold = run.sweep?.min_load_delivery_percent ?? 90;
  return actualPps(run) * 100 / run.target_pps >= threshold;
}

function summarizeRuns(runs: ExperimentRun[]): ConditionSummary[] {
  return DROP_POINTS.map(dropPoint => {
    const conditionRuns = runs.filter(run => run.drop_point === dropPoint);
    const targets = [...new Set(conditionRuns.map(run => run.target_pps))].sort((a, b) => a - b);
    const rates = targets.map(targetPps => {
      const rateRuns = conditionRuns.filter(run => run.target_pps === targetPps);
      const validRuns = rateRuns.filter(loadRateAchieved);
      const maintainedRuns = validRuns.filter(run => serviceMaintained(run.service_health));
      const valid = rateRuns.length > 0 && validRuns.length === rateRuns.length;
      return {
        targetPps,
        actualPps: median(rateRuns.map(actualPps)),
        successPercent: median(rateRuns.map(run => successPercent(run.service_health))),
        latencyP95Ms: median(rateRuns.map(run => run.service_health?.latency_p95_ms ?? 0)),
        maintained: valid && maintainedRuns.length * 2 > validRuns.length,
        valid,
      };
    });

    const firstFailure = rates.findIndex(rate => !rate.valid || !rate.maintained);
    const maintainedPrefix = firstFailure === -1 ? rates : rates.slice(0, firstFailure);
    const limitResult = maintainedPrefix.at(-1) ?? null;

    return {
      dropPoint,
      maxMaintainedPps: limitResult?.actualPps ?? null,
      limitResult,
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

function ResultCard({
  summary,
  selected,
  onSelect,
}: {
  summary: ConditionSummary;
  selected: DropPoint;
  onSelect: (dropPoint: DropPoint) => void;
}) {
  const meta = CONDITION_META[summary.dropPoint];
  return (
    <button
      type="button"
      className={`result-card result-card--${summary.dropPoint} ${selected === summary.dropPoint ? "is-current" : ""}`}
      aria-pressed={selected === summary.dropPoint}
      onClick={() => onSelect(summary.dropPoint)}
    >
      <div className="result-card__title">
        <b>{meta.number}</b>
        <div>
          <strong>{meta.label}</strong>
          <small>{meta.technical}</small>
        </div>
      </div>
      <div className="result-card__metric">
        <strong>{formatPps(summary.maxMaintainedPps)}</strong>
        <span>pps</span>
      </div>
      <div className="result-card__detail">
        {summary.limitResult ? (
          <>
            <span>HTTP {formatNumber(summary.limitResult.successPercent, 0)}%</span>
            <span>p95 {formatNumber(summary.limitResult.latencyP95Ms, 0)} ms</span>
          </>
        ) : (
          <span>クリックしてこの条件を見る</span>
        )}
      </div>
    </button>
  );
}

export default function App() {
  const demo = isWebDemo();
  const [streamStatus, setStreamStatus] = useState(demo ? "sample" : "waiting");
  const [runs, setRuns] = useState<ExperimentRun[]>(demo ? FIXTURE_RUNS : []);
  const [health, setHealth] = useState<HealthState>({
    success: demo,
    latencyMs: demo ? 18 : 0,
    statusCode: demo ? 200 : null,
  });
  const [livePps, setLivePps] = useState(demo ? 20_000 : 0);
  const [attachMode, setAttachMode] = useState(demo ? "generic" : "unknown");
  const [selected, setSelected] = useState<DropPoint>(demo ? "xdp" : "application");

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

        if (event.type === "stats") {
          setLivePps(Number(event.pps ?? 0));
          if (event.attach_mode) setAttachMode(event.attach_mode);
          return;
        }

        if (
          event.type === "experiment_run"
          && event.experiment_id
          && event.run_id
          && event.drop_point
        ) {
          const run = event as ExperimentRun & { type: string };
          setRuns(current => {
            const sameExperiment = current.filter(item => item.experiment_id === run.experiment_id);
            return [
              ...sameExperiment.filter(item => item.run_id !== run.run_id),
              run,
            ];
          });
          setSelected(run.drop_point);
          if (run.xdp_attach_mode === "native" || run.xdp_attach_mode === "generic") {
            setAttachMode(run.xdp_attach_mode);
          }
        }
      },
    }).then(subscription => {
      if (disposed) subscription.unsubscribe();
      else unsubscribe = subscription.unsubscribe;
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  const summaries = useMemo(() => summarizeRuns(runs), [runs]);
  const latestRun = runs.at(-1);
  const selectedMeta = CONDITION_META[selected];
  const representative = latestRun;
  const ppsSteps = representative?.sweep?.pps_steps ?? SAMPLE_PPS_STEPS;
  const repetitions = representative?.sweep?.repetitions ?? SAMPLE_REPETITIONS;
  const expectedRuns = ppsSteps.length * repetitions * 3;
  const complete = runs.length >= expectedRuns;
  const currentPps = livePps > 0 ? livePps : representative ? actualPps(representative) : 0;
  const statusLabel = demo
    ? "サンプル表示"
    : complete
      ? "計測完了"
      : runs.length > 0 || livePps > 0
        ? "計測中"
        : "待機中";
  const healthWaiting = health.statusCode == null && health.latencyMs === 0;
  const healthText = healthWaiting
    ? "計測待ち"
    : health.success
      ? `${health.statusCode ?? 200} OK · ${formatNumber(health.latencyMs, 0)} ms`
      : "応答なし";


  return (
    <main className="exhibit-page">
      <section className="exhibit-intro">
        <div className="exhibit-intro__copy">
          <span className="exhibit-kicker">packet-poipoi</span>
          <h1>安全性 ↔︎ 通信可用性</h1>
          <p>不要な通信を止めやすい安全性と、必要な通信を残しやすい通信可用性。そのバランスを実機で比べる。</p>
        </div>
        <aside className="exhibit-guide">
          <strong>この展示でわかること</strong>
          <ol>
            <li><b>1</b><span>ネットワークのどこで通信を止められるのか</span></li>
            <li><b>2</b><span>早く止めることのメリット・デメリット</span></li>
            <li><b>3</b><span>止める場所で安全性と通信可用性がどう変わるのか</span></li>
          </ol>
        </aside>
      </section>

      <PacketFlow
        selected={selected}
        attachMode={attachMode}
        healthText={healthText}
        healthState={healthWaiting ? "waiting" : health.success ? "ok" : "down"}
        senderStatus={statusLabel}
        senderPps={currentPps > 0 ? `${formatPps(currentPps)} pps` : "— pps"}
      />

      <section className="tradeoff-board">
        <article className="tradeoff-card tradeoff-card--early">
          <h2>もっと早く止めると…</h2>
          <ul>
            <li className="good">処理の負荷が少ない</li>
            <li className="good">不要な通信を早く止めやすい</li>
            <li className="warn">判断材料が少なく、必要な通信まで止める可能性がある</li>
          </ul>
        </article>

        <div className={`balance balance--${selected}`} aria-label={`現在は${selectedMeta.balanceLabel}`}>
          <div className="balance-motion">
            <div className="balance-pan balance-pan--left">
              <span>安全性</span>
              <small>不要な通信を止めやすい</small>
            </div>
            <div className="balance-beam" />
            <div className="balance-pan balance-pan--right">
              <span>通信可用性</span>
              <small>必要な通信を残しやすい</small>
            </div>
          </div>
          <div className="balance-post" />
          <div className="balance-base" />
          <div className="balance-current">
            <strong>{selectedMeta.technical}</strong>
            <span>{selectedMeta.balanceLabel}</span>
          </div>
        </div>

        <article className="tradeoff-card tradeoff-card--late">
          <h2>もっと後で止めると…</h2>
          <ul>
            <li className="good">判断できる情報が多い</li>
            <li className="good">必要な通信を正しく残しやすい</li>
            <li className="warn">処理の負荷が大きい</li>
            <li className="warn">大量の通信に弱い</li>
          </ul>
        </article>
      </section>

      <section className="results-area" aria-label="停止位置を切り替える">
        <p className="results-area__hint">3パターンを押して、止める場所と天秤の変化を切り替えられます。</p>
        <div className="results-strip">
          {summaries.map(summary => (
            <ResultCard
              key={summary.dropPoint}
              summary={summary}
              selected={selected}
              onSelect={setSelected}
            />
          ))}
        </div>
      </section>

      <footer className="exhibit-footer">
        <span>{demo ? "SAMPLE DATA" : `LIVE · ${streamStatus.toUpperCase()}`}</span>
        <strong>やってみる。わかってくる。ちょうどよくする。</strong>
      </footer>
    </main>
  );
}
