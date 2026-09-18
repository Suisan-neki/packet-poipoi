import { useEffect, useState } from "react";
import PacketFlow from "./PacketFlow";

type DropPoint = "application" | "netfilter" | "xdp";

const CONDITIONS: Array<{
  dropPoint: DropPoint;
  number: string;
  label: string;
  technical: string;
  description: string;
}> = [
  {
    dropPoint: "xdp",
    number: "1",
    label: "入口で止める",
    technical: "XDP",
    description: "後ろの処理を通らない",
  },
  {
    dropPoint: "netfilter",
    number: "2",
    label: "途中で止める",
    technical: "nftables",
    description: "アプリには届かない",
  },
  {
    dropPoint: "application",
    number: "3",
    label: "届いてから止める",
    technical: "Application",
    description: "アプリまで運んでから捨てる",
  },
];

export default function App() {
  const [selected, setSelected] = useState<DropPoint>("application");

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;

      if (event.key === "1") {
        setSelected("xdp");
        return;
      }

      if (event.key === "2") {
        setSelected("netfilter");
        return;
      }

      if (event.key === "3") {
        setSelected("application");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <main className="exhibit-page exhibit-page--compact">
      <section className="exhibit-intro exhibit-intro--compact">
        <div className="exhibit-intro__copy">
          <h1>どこで通信を止める？</h1>
          <p>
            赤い通信を止める位置を切り替えると、どこまで処理されてから捨てられるかが変わります。
            青いHTTPはWebサービスまで届きます。
          </p>
        </div>
      </section>

      <section className="mode-switch" aria-label="通信を止める位置を選ぶ">
        {CONDITIONS.map(condition => (
          <button
            key={condition.dropPoint}
            type="button"
            className={`mode-switch__button mode-switch__button--${condition.dropPoint} ${
              selected === condition.dropPoint ? "is-current" : ""
            }`}
            aria-pressed={selected === condition.dropPoint}
            onClick={() => setSelected(condition.dropPoint)}
          >
            <b>{condition.number}</b>
            <span className="mode-switch__copy">
              <strong>{condition.label}</strong>
              <small>{condition.technical}</small>
            </span>
            <span className="mode-switch__description">{condition.description}</span>
          </button>
        ))}
      </section>

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
