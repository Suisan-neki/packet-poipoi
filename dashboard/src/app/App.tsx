import { useEffect, useMemo, useState } from "react";
import { EXHIBIT_DATA, LOAD_STEPS, type DropPoint } from "./exhibitData";

type Scene = "idle" | "running" | "result" | "question" | "context" | "ending";

const CONDITION_META: Record<DropPoint, {
  key: string;
  label: string;
  technical: string;
  stopIndex: number;
  accent: string;
}> = {
  xdp: {
    key: "1",
    label: "入口で止める",
    technical: "XDP",
    stopIndex: 1,
    accent: "blue",
  },
  netfilter: {
    key: "2",
    label: "途中で止める",
    technical: "Netfilter",
    stopIndex: 3,
    accent: "green",
  },
  application: {
    key: "3",
    label: "届いてから止める",
    technical: "Application",
    stopIndex: 4,
    accent: "amber",
  },
};

const PATH = [
  { id: "nic", label: "NIC", sub: "ネットワークの入口" },
  { id: "xdp", label: "XDP", sub: "generic XDP" },
  { id: "linux", label: "Linux", sub: "ネットワーク処理" },
  { id: "netfilter", label: "Netfilter", sub: "nftablesで設定" },
  { id: "application", label: "Application", sub: "サービスの手前" },
] as const;

function formatPps(value: number | null) {
  if (value == null) return "—";
  return new Intl.NumberFormat("ja-JP").format(value);
}

function ResultTable({ selected }: { selected: DropPoint }) {
  return (
    <div className="result-table">
      {(["xdp", "netfilter", "application"] as DropPoint[]).map(dropPoint => {
        const meta = CONDITION_META[dropPoint];
        const result = EXHIBIT_DATA.results[dropPoint];
        return (
          <div
            key={dropPoint}
            className={`result-row result-row--${meta.accent} ${selected === dropPoint ? "is-selected" : ""}`}
          >
            <div className="result-row__name">
              <span>{meta.key}</span>
              <div>
                <strong>{meta.label}</strong>
                <small>{meta.technical}</small>
              </div>
            </div>
            <div className="result-row__metric">
              <strong>{formatPps(result.maxMaintainedPps)}</strong>
              <small>ppsまで維持</small>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Pipeline({ selected, running }: { selected: DropPoint; running: boolean }) {
  const stopIndex = CONDITION_META[selected].stopIndex;
  return (
    <div className={`pipeline-demo pipeline-demo--${selected} ${running ? "is-running" : ""}`}>
      <div className="pipeline-demo__sender">
        <div className="computer-icon" aria-hidden="true">
          <span className="computer-icon__screen" />
          <span className="computer-icon__base" />
        </div>
        <strong>送る側</strong>
        <small>UDP :4000</small>
      </div>

      <div className="pipeline-demo__path">
        {PATH.map((stage, index) => {
          const reached = index <= stopIndex;
          const stop = index === stopIndex;
          return (
            <div className="pipeline-stage" key={stage.id}>
              {index > 0 && (
                <div className={`pipeline-segment ${reached ? "is-reached" : ""}`}>
                  {running && reached && (
                    <>
                      <i className="packet-dot packet-dot--1" />
                      <i className="packet-dot packet-dot--2" />
                      <i className="packet-dot packet-dot--3" />
                    </>
                  )}
                </div>
              )}
              <div className={`pipeline-node ${reached ? "is-reached" : ""} ${stop ? "is-stop" : ""}`}>
                <strong>{stage.label}</strong>
                <small>{stage.sub}</small>
                {stop && <em>DROP</em>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="pipeline-demo__service">
        <span>Webサービス</span>
        <strong>HTTP :8080</strong>
        <small>守りたい通信</small>
      </div>
    </div>
  );
}

function App() {
  const [scene, setScene] = useState<Scene>("idle");
  const [selected, setSelected] = useState<DropPoint>("xdp");
  const [loadIndex, setLoadIndex] = useState(0);

  const result = EXHIBIT_DATA.results[selected];
  const currentLoad = LOAD_STEPS[loadIndex] ?? LOAD_STEPS[0];
  const serviceMaintained = result.maxMaintainedPps != null && currentLoad <= result.maxMaintainedPps;

  const sourceLabel = EXHIBIT_DATA.source === "measured" ? "Raspberry Pi 実測データ" : "SAMPLE DATA";

  function startDemo(dropPoint: DropPoint) {
    setSelected(dropPoint);
    setLoadIndex(0);
    setScene("running");
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "1") startDemo("xdp");
      if (event.key === "2") startDemo("netfilter");
      if (event.key === "3") startDemo("application");
      if (event.key === "Escape") {
        setLoadIndex(0);
        setScene("idle");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (scene !== "running") return;
    if (loadIndex >= LOAD_STEPS.length - 1) {
      const done = window.setTimeout(() => setScene("result"), 850);
      return () => window.clearTimeout(done);
    }
    const timer = window.setTimeout(() => setLoadIndex(index => index + 1), 760);
    return () => window.clearTimeout(timer);
  }, [scene, loadIndex]);

  useEffect(() => {
    if (scene !== "result") return;
    const timer = window.setTimeout(() => setScene("question"), 3200);
    return () => window.clearTimeout(timer);
  }, [scene]);

  useEffect(() => {
    if (scene !== "question") return;
    const timer = window.setTimeout(() => setScene("context"), 3000);
    return () => window.clearTimeout(timer);
  }, [scene]);

  useEffect(() => {
    if (scene !== "context") return;
    const timer = window.setTimeout(() => setScene("ending"), 5600);
    return () => window.clearTimeout(timer);
  }, [scene]);

  useEffect(() => {
    if (scene !== "ending") return;
    const timer = window.setTimeout(() => {
      setLoadIndex(0);
      setScene("idle");
    }, 6200);
    return () => window.clearTimeout(timer);
  }, [scene]);

  const loadProgress = useMemo(
    () => `${loadIndex + 1} / ${LOAD_STEPS.length}`,
    [loadIndex],
  );

  return (
    <main className={`story-shell story-shell--${scene}`}>
      {scene === "idle" && (
        <section className="scene scene--idle">
          <div className="story-heading">
            <span className={`data-source ${EXHIBIT_DATA.source === "measured" ? "is-measured" : "is-sample"}`}>
              {sourceLabel}
            </span>
            <h1>同じ不要通信、どこで止める？</h1>
            <p>止める場所だけを変えて、同じRaspberry PiでWebサービスがどこまで耐えられるか比べました。</p>
          </div>

          <Pipeline selected={selected} running={false} />

          <div className="choice-area">
            <p>3つのボタンから1つ選んでください</p>
            <div className="choice-buttons">
              {(["xdp", "netfilter", "application"] as DropPoint[]).map(dropPoint => {
                const meta = CONDITION_META[dropPoint];
                return (
                  <button
                    key={dropPoint}
                    type="button"
                    className={`choice-button choice-button--${meta.accent}`}
                    onClick={() => startDemo(dropPoint)}
                  >
                    <span className="choice-button__key">{meta.key}</span>
                    <span>
                      <strong>{meta.label}</strong>
                      <small>{meta.technical}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {scene === "running" && (
        <section className="scene scene--running">
          <div className="running-heading">
            <div>
              <span>実測結果を再生中</span>
              <h1>{CONDITION_META[selected].label}</h1>
              <p>{CONDITION_META[selected].technical}で不要通信を止めます。</p>
            </div>
            <div className="load-counter">
              <span>負荷を上げています</span>
              <strong>{formatPps(currentLoad)} <small>pps</small></strong>
              <em>{loadProgress}</em>
            </div>
          </div>

          <Pipeline selected={selected} running />

          <div className={`service-state ${serviceMaintained ? "is-ok" : "is-over"}`}>
            <div>
              <span>Webサービス</span>
              <strong>{serviceMaintained ? "維持できている" : "限界を超えた"}</strong>
            </div>
            <div className="service-state__bar">
              <i style={{ width: `${Math.min(100, (currentLoad / 50_000) * 100)}%` }} />
            </div>
          </div>
        </section>
      )}

      {scene === "result" && (
        <section className="scene scene--result">
          <div className="result-hero">
            <span>{CONDITION_META[selected].technical} の結果</span>
            <h1>{formatPps(result.maxMaintainedPps)} <small>pps</small></h1>
            <p>HTTP成功率99%以上・p95 100ms以下を維持できた最大の実送信量。</p>
          </div>

          <div className="result-metrics">
            <div>
              <span>CPU busy</span>
              <strong>{result.cpuBusyPercent == null ? "—" : `${result.cpuBusyPercent}%`}</strong>
            </div>
            <div>
              <span>HTTP p95</span>
              <strong>{result.httpP95Ms == null ? "—" : `${result.httpP95Ms} ms`}</strong>
            </div>
            <div>
              <span>HTTP success</span>
              <strong>{result.httpSuccessPercent == null ? "—" : `${result.httpSuccessPercent}%`}</strong>
            </div>
          </div>

          <ResultTable selected={selected} />

          <div className="result-next">
            <span>早く止めるほど、処理を省きやすい。</span>
            <strong>でも……</strong>
          </div>
        </section>
      )}

      {scene === "question" && (
        <section className="scene scene--question">
          <div className="question-copy">
            <span>ここで1つ疑問</span>
            <h1>じゃあ、全部XDPで止めればいい？</h1>
          </div>

          <div className="https-stage">
            <div className="https-flow">
              <span>通信A</span>
              <strong>HTTPS / TCP :443</strong>
              <small>暗号化されたデータ</small>
            </div>
            <div className="xdp-gate">
              <strong>XDP</strong>
              <small>packetやheaderは見られる</small>
            </div>
            <div className="https-flow">
              <span>通信B</span>
              <strong>HTTPS / TCP :443</strong>
              <small>暗号化されたデータ</small>
            </div>
          </div>

          <p className="question-note">入口では、URL・認証状態・sessionなどをそのまま使えない。</p>
        </section>
      )}

      {scene === "context" && (
        <section className="scene scene--context">
          <div className="context-heading">
            <span>Applicationまで来ると</span>
            <h1>判断できる「意味」が増える。</h1>
            <p>XDPでもpacketや独自状態は見られる。違うのは、使える文脈の種類。</p>
          </div>

          <div className="context-grid">
            <article className="context-card context-card--needed">
              <span>必要な通信</span>
              <strong>ログイン済みユーザー</strong>
              <dl>
                <div><dt>URL</dt><dd>GET /payment</dd></div>
                <div><dt>認証</dt><dd>authenticated</dd></div>
                <div><dt>session</dt><dd>valid</dd></div>
              </dl>
              <b>残したい</b>
            </article>

            <div className="context-arrow">
              <span>TLS終端後</span>
              <strong>Application</strong>
              <i>→</i>
            </div>

            <article className="context-card context-card--unwanted">
              <span>止めたい通信</span>
              <strong>認証失敗が連続</strong>
              <dl>
                <div><dt>URL</dt><dd>POST /login</dd></div>
                <div><dt>認証</dt><dd>failed</dd></div>
                <div><dt>状態</dt><dd>異常な反復</dd></div>
              </dl>
              <b>止めたい</b>
            </article>
          </div>

          <div className="context-takeaway">
            <span>早く止めれば軽い。</span>
            <strong>でも、後ろまで通さないと分からないこともある。</strong>
          </div>
        </section>
      )}

      {scene === "ending" && (
        <section className="scene scene--ending">
          <div className="ending-balance">
            <div className="ending-side ending-side--early">
              <span>早い場所で止める</span>
              <strong>処理コストが小さい</strong>
              <small>早期遮断</small>
            </div>
            <div className="ending-line"><i /></div>
            <div className="ending-side ending-side--late">
              <span>後ろまで通す</span>
              <strong>判断材料が増える</strong>
              <small>高レイヤの文脈</small>
            </div>
          </div>

          <div className="ending-copy">
            <h1>どこで見るかで、できる判断が変わる。</h1>
            <p>性能だけではなく、何を判断したいかまで考えて「止める場所」を選ぶ。</p>
            <strong>だから、ネットワークって面白い。</strong>
          </div>
        </section>
      )}
    </main>
  );
}

export default App;
