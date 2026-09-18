import { useEffect, useState } from "react";
import PacketFlow from "./PacketFlow";
import "../cpu-exhibit.css";

type DropPoint = "application" | "netfilter" | "xdp";

// Pi B, service-limit-1789725533, target 50,000 pps, 10 seconds per run.
// These are whole-machine CPU busy readings, not per-layer measurements.
const CPU_SAMPLES: Record<DropPoint, number[]> = {
  xdp: [7.2, 5.0, 5.3],
  netfilter: [6.9, 6.7, 4.6],
  application: [9.8, 11.6, 7.2],
};
const median = (values: number[]) => [...values].sort((a, b) => a - b)[1];
const CPU = {
  xdp: median(CPU_SAMPLES.xdp),
  netfilter: median(CPU_SAMPLES.netfilter),
  application: median(CPU_SAMPLES.application),
};
// A shared zero-based scale: 9.8% must not look like 100% CPU utilisation.
const CPU_AXIS_MAX = 12;

const CONDITIONS: Array<{
  dropPoint: DropPoint;
  number: string;
  label: string;
  technical: string;
  description: string;
}> = [
  { dropPoint: "xdp", number: "1", label: "入口で止める", technical: "XDP", description: "後段へ運ばない" },
  { dropPoint: "netfilter", number: "2", label: "途中で止める", technical: "nftables", description: "アプリには届けない" },
  { dropPoint: "application", number: "3", label: "届いてから止める", technical: "Application", description: "アプリまで運んで捨てる" },
];

function CpuComparison({ selected, onSelect }: {
  selected: DropPoint;
  onSelect: (mode: DropPoint) => void;
}) {
  return (
    <section className="cpu-comparison" aria-labelledby="cpu-result-title">
      <div className="cpu-comparison__lead">
        <span className="cpu-comparison__eyebrow">今回の実測</span>
        <h2 id="cpu-result-title">アプリケーションに<br />不要な仕事をさせるコスト</h2>
        <p className="cpu-comparison__evidence">同じ通信を破棄する場合でも、奥の層（アプリケーション）まで運んでから処理すると、より多くのCPUリソースを消費した。</p>
      </div>
      <figure className="cpu-chart">
        <figcaption>不要通信を処理したときのCPU負荷 <small>Pi B全体・3回の中央値</small></figcaption>
        <div className="cpu-chart__axis" aria-hidden="true">
          <span>0</span><span>4</span><span>8</span><span>12%</span>
        </div>
        <div className="cpu-chart__rows">
          {CONDITIONS.map(condition => {
            const mode = condition.dropPoint;
            const current = selected === mode;
            return (
              <button
                key={mode}
                type="button"
                className={`cpu-chart__row ${current ? "is-current" : ""}`}
                aria-pressed={current}
                aria-label={`${mode === "application" ? "アプリ層" : condition.technical}${mode === "xdp" ? "（generic）" : ""}で止める条件。Pi B全体のCPU使用率の中央値 ${CPU[mode].toFixed(1)}%。この停止位置を表示`}
                title={`各回のCPU使用率：${CPU_SAMPLES[mode].map(value => `${value.toFixed(1)}%`).join(" / ")}`}
                onClick={() => onSelect(mode)}
              >
                <span className="cpu-chart__label">{mode === "application" ? "アプリ層" : condition.technical}{mode === "xdp" && <small>（generic）</small>}で止める</span>
                <span className="cpu-chart__track" aria-hidden="true">
                  <span className="cpu-chart__fill" style={{ width: `${CPU[mode] / CPU_AXIS_MAX * 100}%` }} />
                </span>
                <strong className="cpu-chart__value">{CPU[mode].toFixed(1)}<small>%</small></strong>
              </button>
            );
          })}
        </div>
        <p className="cpu-chart__conditions">同じ不要通信を送信 · 毎秒約5万パケット · 10秒 × 3回</p>
      </figure>
    </section>
  );
}

export default function App() {
  const [selected, setSelected] = useState<DropPoint>("application");

  useEffect(() => { window.scrollTo(0, 0); }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const condition = CONDITIONS.find(item => item.number === event.key);
      if (condition) {
        event.preventDefault();
        setSelected(condition.dropPoint);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <main className="exhibit-page exhibit-page--compact cpu-exhibit" data-mode={selected}>
      <section className="exhibit-intro exhibit-intro--compact">
        <div className="exhibit-intro__copy">
          <h1>どこで通信を止める？</h1>
          <p>不要な通信の処理を、どの層の責務にするか。停止位置によるリソース消費の違いを比較します。</p>
        </div>
      </section>
      <section className="mode-switch" aria-label="通信を止める位置を選ぶ">
        {CONDITIONS.map(condition => (
          <button
            key={condition.dropPoint}
            type="button"
            className={`mode-switch__button mode-switch__button--${condition.dropPoint} ${selected === condition.dropPoint ? "is-current" : ""}`}
            aria-pressed={selected === condition.dropPoint}
            onClick={() => setSelected(condition.dropPoint)}
          >
            <b>{condition.number}</b>
            <span className="mode-switch__copy"><strong>{condition.label}</strong><small>{condition.technical}</small></span>
            <span className="mode-switch__description">{condition.description}</span>
          </button>
        ))}
      </section>
      <CpuComparison selected={selected} onSelect={setSelected} />
      <PacketFlow
        selected={selected}
        attachMode="generic"
        healthText="HTTP 到達"
        healthState="ok"
        senderStatus="模式表示"
        senderPps="—"
      />
    </main>
  );
}
