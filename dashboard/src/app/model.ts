/** 展示の表示と実測値を分ける。受信ppsをPi Aの実送信ppsとして扱わない。 */
export type DropPoint = "xdp" | "netfilter" | "application";
export type AttachMode = "native" | "generic" | "unknown";
export const DROP_POINTS: DropPoint[] = ["xdp", "netfilter", "application"];
export const LABELS = {
  xdp: { number: 1, label: "入口で止める", technical: "XDP" },
  netfilter: { number: 2, label: "途中で止める", technical: "Netfilter" },
  application: { number: 3, label: "届いてから止める", technical: "Application" },
} as const;

export interface Health {
  checks: number; successes: number; latency_p95_ms: number; latency_max_ms: number;
  min_success_percent: number; max_p95_latency_ms: number;
}
export interface Plan { pps_steps: number[]; repetitions: number; min_load_delivery_percent?: number }
export interface ExperimentRun {
  experiment_id: string; run_id: string; repetition: number; drop_point: DropPoint;
  duration_ms: number; target_pps: number; payload_bytes: number;
  packets_sent: number; packets_received_by_app: number; cpu_busy_percent: number;
  net_rx_softirq_delta: number;
  xdp_attach_mode: AttachMode | "not_used";
  service_health?: Health; sweep?: Plan;
}
export interface RateResult {
  targetPps: number; actualPps: number; success: number; latency: number;
  status: "waiting" | "maintained" | "failed" | "invalid";
}
export interface Summary {
  dropPoint: DropPoint; count: number; expected: number; complete: boolean;
  rates: RateResult[]; result: RateResult | null; invalid: boolean;
  lowerBound: boolean; reason: string | null;
}
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export const isDropPoint = (value: unknown): value is DropPoint => DROP_POINTS.includes(value as DropPoint);
export function isRun(value: unknown): value is ExperimentRun {
  if (value == null || typeof value !== "object") return false;
  const r = value as ExperimentRun;
  const h = r.service_health;
  return typeof r.experiment_id === "string" && r.experiment_id.length > 0
    && typeof r.run_id === "string" && r.run_id.length > 0 && isDropPoint(r.drop_point)
    && Number.isInteger(r.repetition) && r.repetition > 0
    && nonnegative(r.duration_ms) && r.duration_ms > 0 && nonnegative(r.target_pps) && r.target_pps > 0
    && nonnegative(r.packets_sent) && nonnegative(r.payload_bytes) && r.payload_bytes > 0
    && !!h && nonnegative(h.checks) && h.checks > 0 && nonnegative(h.successes) && h.successes <= h.checks
    && nonnegative(h.latency_p95_ms) && nonnegative(h.max_p95_latency_ms)
    && nonnegative(h.min_success_percent) && h.min_success_percent <= 100
    && (!r.sweep || (Array.isArray(r.sweep.pps_steps) && r.sweep.pps_steps.length > 0 && r.sweep.pps_steps.every((n, i, a) => nonnegative(n) && n > 0 && (i === 0 || a[i - 1] < n))
      && r.sweep.pps_steps.includes(r.target_pps) && Number.isInteger(r.sweep.repetitions) && r.sweep.repetitions > 0
      && r.repetition <= r.sweep.repetitions));
}
export function upsertRun(runs: ExperimentRun[], incoming: ExperimentRun): ExperimentRun[] {
  // 異なる実験、または同じ条件・反復の再送を重ねない。
  return [...runs.filter(r => r.experiment_id === incoming.experiment_id && r.run_id !== incoming.run_id
    && !(r.drop_point === incoming.drop_point && r.target_pps === incoming.target_pps && r.repetition === incoming.repetition)), incoming];
}
export function actualPps(run: ExperimentRun): number { return run.packets_sent * 1000 / run.duration_ms; }
export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}
export function summarize(runs: ExperimentRun[]): Summary[] {
  const current = runs.at(-1)?.experiment_id;
  const all = runs.filter(r => r.experiment_id === current);
  const plan = all.at(-1)?.sweep;
  const targets = plan?.pps_steps ?? [...new Set(all.map(r => r.target_pps))].sort((a, b) => a - b);
  const repetitions = plan?.repetitions ?? 1;
  const inconsistent = all.some(r => plan && (!r.sweep || r.sweep.repetitions !== plan.repetitions
    || (r.sweep.min_load_delivery_percent ?? 90) !== (plan.min_load_delivery_percent ?? 90)
    || r.sweep.pps_steps.join(",") !== plan.pps_steps.join(",")));
  return DROP_POINTS.map(dropPoint => {
    const condition = all.filter(r => r.drop_point === dropPoint);
    const modes = new Set(condition.map(r => r.xdp_attach_mode));
    const wrongMode = dropPoint === "xdp" && (modes.size > 1 || [...modes].some(m => m !== "native" && m !== "generic"));
    const rates: RateResult[] = targets.map(targetPps => {
      const selected = condition.filter(r => r.target_pps === targetPps);
      const complete = Array.from({ length: repetitions }, (_, i) => i + 1).every(i => selected.some(r => r.repetition === i));
      const valid = selected.every(r => actualPps(r) * 100 / r.target_pps >= (r.sweep?.min_load_delivery_percent ?? 90));
      const maintained = selected.filter(r => {
        const h = r.service_health;
        return h && h.successes * 100 / h.checks >= h.min_success_percent && h.latency_p95_ms <= h.max_p95_latency_ms;
      }).length;
      return {
        targetPps, actualPps: median(selected.map(actualPps)),
        success: median(selected.map(r => r.service_health!.successes * 100 / r.service_health!.checks)),
        latency: median(selected.map(r => r.service_health!.latency_p95_ms)),
        status: !complete ? "waiting" : !valid || wrongMode || inconsistent ? "invalid" : maintained * 2 > selected.length ? "maintained" : "failed",
      };
    });
    const complete = rates.length > 0 && rates.every(r => r.status !== "waiting");
    const firstStop = rates.findIndex(r => r.status !== "maintained");
    const prefix = firstStop < 0 ? rates : rates.slice(0, firstStop);
    const nonMonotonic = rates.some((r, i) => r.status === "failed" && rates.slice(i + 1).some(next => next.status === "maintained"));
    const invalid = wrongMode || inconsistent || nonMonotonic || rates.some(r => r.status === "invalid");
    return {
      dropPoint, count: condition.length, expected: targets.length * repetitions, complete, rates,
      result: complete && !invalid ? prefix.at(-1) ?? null : null,
      invalid, lowerBound: complete && !invalid && firstStop < 0,
      reason: wrongMode ? "XDPの実行モードをそろえて再測定" : inconsistent ? "実験条件が一致していません"
        : nonMonotonic ? "負荷と結果の関係を再確認" : invalid ? "目標負荷に届かず測定不成立" : null,
    };
  });
}

/** genericではskb生成後。nativeだけをNICドライバ内の位置に描く。 */
export function stagesFor(mode: AttachMode) {
  const nic = { id: "nic", title: "ネットワークの入口", technical: "NIC" };
  const xdp = { id: "xdp", title: "XDP", technical: mode === "unknown" ? "モード確認待ち" : mode };
  const stack = { id: "stack", title: "Linuxの受信処理", technical: mode === "native" ? "ネットワーク処理" : "skb生成" };
  return [nic, ...(mode === "native" ? [xdp, stack] : [stack, xdp]),
    { id: "netfilter", title: "Netfilter", technical: "input" },
    { id: "socket", title: "受け取り口", technical: "ソケット" },
    { id: "application", title: "実験用アプリ", technical: "Application" }];
}

/** Web版だけで使用する説明用データ。実測とは混ぜない。 */
export function sampleRuns(): ExperimentRun[] {
  const plan = { pps_steps: [500, 5000, 20000], repetitions: 1, min_load_delivery_percent: 90 };
  const runs: ExperimentRun[] = [];
  for (const target of plan.pps_steps) for (const point of ["application", "netfilter", "xdp"] as DropPoint[]) {
    const latency = point === "application" ? (target === 20000 ? 150 : 30) : point === "netfilter" ? 26 : 19;
    runs.push({ experiment_id: "sample-not-measured", run_id: `sample-${point}-${target}`, repetition: 1,
      drop_point: point, target_pps: target, duration_ms: 10000, payload_bytes: 128, packets_sent: target * 10,
      packets_received_by_app: point === "application" ? target * 10 : 0, cpu_busy_percent: 0, net_rx_softirq_delta: 0,
      xdp_attach_mode: point === "xdp" ? "generic" : "not_used", sweep: plan,
      service_health: { checks: 50, successes: 50, latency_p95_ms: latency, latency_max_ms: latency,
        min_success_percent: 99, max_p95_latency_ms: 100 } });
  }
  return runs;
}
