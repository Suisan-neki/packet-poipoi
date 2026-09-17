export type DropPoint = "xdp" | "netfilter" | "application";

export interface ExhibitResult {
  maxMaintainedPps: number | null;
  cpuBusyPercent: number | null;
  httpP95Ms: number | null;
  httpSuccessPercent: number | null;
}

export interface ExhibitData {
  source: "sample" | "measured";
  measuredAt: string | null;
  note: string;
  results: Record<DropPoint, ExhibitResult>;
}

/**
 * 展示で再生する実測結果。
 *
 * 明日の Raspberry Pi A / B 実験が終わったら、source を measured に変更し、
 * 3条件の値だけをここへ転記すれば展示UIは完成する。
 *
 * 現在の値はUI確認用の SAMPLE であり、展示で実測値として扱わない。
 */
export const EXHIBIT_DATA: ExhibitData = {
  source: "sample",
  measuredAt: null,
  note: "UI確認用サンプル。実機測定後に差し替える。",
  results: {
    xdp: {
      maxMaintainedPps: 20_000,
      cpuBusyPercent: 28,
      httpP95Ms: 29,
      httpSuccessPercent: 100,
    },
    netfilter: {
      maxMaintainedPps: 10_000,
      cpuBusyPercent: 31,
      httpP95Ms: 34,
      httpSuccessPercent: 100,
    },
    application: {
      maxMaintainedPps: 5_000,
      cpuBusyPercent: 31,
      httpP95Ms: 27,
      httpSuccessPercent: 100,
    },
  },
};

export const LOAD_STEPS = [500, 2_000, 5_000, 10_000, 20_000, 50_000] as const;
