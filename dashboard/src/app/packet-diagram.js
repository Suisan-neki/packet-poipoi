/**
 * Packet path illustration. It does not send traffic or infer packet loss from
 * HTTP success rates. The two tracks distinguish traffic types in ONE receive
 * path; they are not separate physical networks. See docs/UI_DIAGRAM_RESEARCH.md.
 */
const SVG_NS = "http://www.w3.org/2000/svg";
const STAGES = [
  { id: "nic", x: 327, title: "NIC", sub: "受信の入口" },
  { id: "xdp", x: 502, title: "XDP", sub: "実行モード未取得" },
  { id: "stack", x: 677, title: "Linux", sub: "受信処理" },
  { id: "netfilter", x: 852, title: "Netfilter", sub: "input hook" },
  { id: "application", x: 1027, title: "アプリ", sub: "ソケット以降" },
];
const LABELS = {
  xdp: "入口で止める / XDP",
  netfilter: "途中で止める / Netfilter",
  application: "届いてから止める / Application",
};
const STOP_X = { xdp: 602, netfilter: 952, application: 1127 };
const START_X = 192;
const HTTP_END_X = 1307;
const RED_Y = 202;
const BLUE_Y = 266;
const SPEED = 132; // Illustration units/second, deliberately not measured pps.
const styles = `
  :host { display: block; min-width: 0; color: #17335f; }
  * { box-sizing: border-box; }
  .figure { margin: 0; overflow: hidden; border: 1px solid #cbd5e1; border-radius: 16px; background: #fff; }
  .viewport { overflow-x: auto; scrollbar-width: thin; }
  svg { display: block; width: 100%; min-width: 800px; height: auto; font-family: inherit; }
  text { fill: #17335f; }
  .heading { font-size: 21px; font-weight: 700; }
  .subtle { fill: #52647a; font-size: 16px; }
  .node-title { font-size: 21px; font-weight: 700; }
  .node-sub { font-size: 17px; fill: #52647a; }
  .node-body { fill: #fff; stroke: #8292a8; stroke-width: 1.25; }
  .node-header { fill: #f4f7fb; }
  .stage.is-selected .node-body { stroke: #17335f; stroke-width: 2; }
  .stage.is-selected .node-header { fill: #eaf1fa; }
  .node-separator { stroke: #d4dce6; stroke-width: 1; }
  .track-base { fill: none; stroke: #c6cfdb; stroke-width: 1.5; }
  .load-path { fill: none; stroke: #b42343; stroke-width: 2; }
  .service-path { fill: none; stroke: #0962bc; stroke-width: 2; }
  .red-label { fill: #a51e3c; font-size: 16px; font-weight: 700; }
  .blue-label { fill: #0757a8; font-size: 16px; font-weight: 700; }
  .gate-label { fill: #a51e3c; font-size: 17px; font-weight: 700; }
  .pass-label { fill: #0757a8; font-size: 17px; font-weight: 700; }
  .packet { pointer-events: none; }
  .load-packet rect { fill: #b42343; stroke: #fff; stroke-width: 1; }
  .load-packet path { stroke: #fff; stroke-width: 1.3; fill: none; }
  .http-packet circle { fill: #0962bc; stroke: #fff; stroke-width: 1.5; }
  .http-packet path { stroke: #fff; stroke-width: 1.5; fill: none; }
  .caption { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 18px; border-top: 1px solid #dce3ec; background: #fafbfd; }
  .caption-text { display: grid; gap: 4px; font-size: 14px; line-height: 1.5; color: #52647a; }
  .caption-text strong { color: #17335f; font-size: 17px; font-weight: 700; }
  button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 44px; padding: 8px 12px; border: 1px solid #7d8da1; border-radius: 6px; background: #fff; color: #17335f; font-size: 14px; font-weight: 600; line-height: 1.4; font-family: inherit; cursor: pointer; white-space: nowrap; }
  button:hover { background: #edf2f8; }
  button:focus-visible { outline: 3px solid #17335f; outline-offset: 3px; }
  button svg { width: 16px; min-width: 16px; height: 16px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  @media (max-width: 680px) { .caption { align-items: flex-start; flex-wrap: wrap; } }
`;

/** A dependency-free renderer so the actual animation can be browser-tested. */
export class PacketNetworkDiagram extends HTMLElement {
  static get observedAttributes() {
    return ["data-stop", "attach-mode", "health-text", "health-state", "sender-status", "sender-pps"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._time = 11500;
    this._last = null;
    this._raf = 0;
    this._paused = false;
    this._ready = false;
    this._packets = [];
    this._onFrame = this._onFrame.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._onMotionPreference = this._onMotionPreference.bind(this);
  }

  connectedCallback() {
    if (!this._ready) this._mount();
    this._observer = new ResizeObserver(() => {
      const compact = this.getBoundingClientRect().width < 1160;
      if (compact === this._compact) return;
      this._ready = false;
      this._packets = [];
      this._mount();
      this._updateStop();
      this._updateReadings();
      this._updatePauseButton();
    });
    this._observer.observe(this);
    this._preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    this._paused = this._preference.matches;
    this._preference.addEventListener("change", this._onMotionPreference);
    document.addEventListener("visibilitychange", this._onVisibility);
    this._updateStop();
    this._updateReadings();
    this._updatePauseButton();
    this._draw();
    this._schedule();
  }

  disconnectedCallback() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._last = null;
    this._observer?.disconnect();
    document.removeEventListener("visibilitychange", this._onVisibility);
    this._preference?.removeEventListener("change", this._onMotionPreference);
  }

  attributeChangedCallback(name, previous, next) {
    if (!this._ready || previous === next) return;
    if (name === "data-stop") this._updateStop();
    else this._updateReadings();
  }

  get selected() {
    const value = this.getAttribute("data-stop");
    return Object.hasOwn(STOP_X, value ?? "") ? value : "application";
  }

  _mount() {
    const compact = this.getBoundingClientRect().width < 1160;
    this._compact = compact;
    const width = compact ? 1000 : 1400;
    const receiverX = compact ? 176 : 308;
    const serviceX = compact ? 866 : 1225;
    const serviceWidth = compact ? 116 : 130;
    const serviceCenter = serviceX + serviceWidth / 2;
    this._startX = compact ? 168 : START_X;
    this._httpEnd = compact ? 950 : HTTP_END_X;
    this._stages = STAGES.map((stage, index) => ({
      ...stage,
      x: compact ? 196 + index * 132 : stage.x,
      width: compact ? 116 : 146,
    }));
    const nodes = this._stages.map(stage => `
      <g class="stage" data-stage="${stage.id}">
        <rect class="node-body" x="${stage.x}" y="97" width="${stage.width}" height="216" rx="8"/>
        <path class="node-header" d="M${stage.x + 2},164 V106 Q${stage.x + 2},99 ${stage.x + 9},99 H${stage.x + stage.width - 9} Q${stage.x + stage.width - 2},99 ${stage.x + stage.width - 2},106 V164 Z"/>
        <line class="node-separator" x1="${stage.x + 1}" x2="${stage.x + stage.width - 1}" y1="164" y2="164"/>
        <text class="node-title" text-anchor="middle" x="${stage.x + stage.width / 2}" y="132">${stage.title}</text>
        <text class="node-sub ${stage.id === "xdp" ? "mode-text" : ""}" text-anchor="middle" x="${stage.x + stage.width / 2}" y="153">${stage.sub}</text>
      </g>`).join("");
    this.shadowRoot.innerHTML = `
      <style>${styles}</style>
      <figure class="figure">
        <div class="viewport" role="region" tabindex="0" aria-label="通信の処理経路。狭い画面では横にスクロールできます。">
          <svg viewBox="0 0 ${width} 356" role="img" aria-labelledby="diagram-title diagram-desc">
            <title id="diagram-title">通信の処理経路と選択した破棄位置</title>
            <desc id="diagram-desc"></desc>
            <defs>
              <marker id="blue-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M1 1 L8 5 L1 9" fill="none" stroke="#0962bc" stroke-width="1.8"/>
              </marker>
            </defs>
            <rect x="${receiverX}" y="20" width="${width - receiverX - 24}" height="312" rx="12" fill="#f7f9fc" stroke="#d8e0eb"/>
            <text class="heading" x="24" y="48">送る側（Pi A）</text>
            <text class="subtle" x="24" y="73">パソコンのイメージ</text>
            <g transform="translate(${receiverX + 22} 34)" fill="none" stroke="#17335f" stroke-width="1.8" aria-hidden="true">
              <rect width="24" height="10" rx="2"/><rect y="13" width="24" height="10" rx="2"/>
              <circle cx="5" cy="5" r="1" fill="#17335f"/><circle cx="5" cy="18" r="1" fill="#17335f"/>
              <path d="M11 5h8M11 18h8"/>
            </g>
            <text class="heading" x="${receiverX + 61}" y="53">受ける側（Pi B）</text>
            <text class="subtle" x="${compact ? 450 : 616}" y="53">サーバー内の処理を左から右へ</text>
            <text class="subtle" text-anchor="end" x="${width - 47}" y="80">受信方向を抜粋</text>
            <g transform="${compact ? "translate(32 96) scale(.75)" : "translate(40 154)"}" aria-hidden="true">
              <rect x="8" y="0" width="96" height="63" rx="5" fill="#fff" stroke="#17335f" stroke-width="3"/>
              <rect x="16" y="8" width="80" height="46" rx="1" fill="#eaf1f9"/>
              <path d="M8 66 H104 L116 78 H-4 Z" fill="#d5e0ec" stroke="#17335f" stroke-width="2.5" stroke-linejoin="round"/>
              <path d="M43 70 H69" stroke="#17335f" stroke-width="2"/>
            </g>
            <text class="subtle sender-status" x="24" y="292">待機中</text>
            <text class="sender-pps" x="24" y="316" font-size="20" font-weight="700">— pps</text>
            <text class="red-label" x="${compact ? 20 : 185}" y="171">破棄対象</text>
            <text class="red-label" x="${compact ? 20 : 185}" y="190">UDP :4000</text>
            <text class="blue-label" x="${compact ? 20 : 185}" y="235">守りたい通信</text>
            <text class="blue-label" x="${compact ? 20 : 185}" y="254">HTTP :8080</text>
            ${nodes}
            <rect x="${serviceX}" y="97" width="${serviceWidth}" height="216" rx="8" fill="#fff" stroke="#8292a8" stroke-width="1.25"/>
            <text x="${serviceCenter}" y="132" text-anchor="middle" font-size="17" font-weight="700">Webサービス</text>
            <text x="${serviceCenter}" y="158" text-anchor="middle" class="subtle">HTTP観測</text>
            <text class="health-reading" x="${serviceCenter}" y="184" text-anchor="middle" font-size="16" font-weight="700">計測待ち</text>
            <text x="${serviceCenter}" y="304" text-anchor="middle" class="node-sub">HTTP :8080</text>
            <path class="track-base" d="M${this._startX} 202H${compact ? 838 : 1171}" stroke-dasharray="3 6"/>
            <path class="load-path"/>
            <path class="service-path" d="${compact ? "M126 159 C162 159 143 266 168 266" : "M154 223 C170 223 166 266 192 266"} H${this._httpEnd}"/>
            <path d="M${serviceX - 43} 266H${serviceX - 12}" class="service-path" marker-end="url(#blue-arrow)"/>
            <circle cx="${this._httpEnd}" cy="266" r="13" fill="#fff" stroke="#0962bc" stroke-width="2"/>
            <path d="M${this._httpEnd - 6} 266h11m-4-4 4 4-4 4" fill="none" stroke="#0962bc" stroke-width="1.8"/>
            <g class="packet-layer" aria-hidden="true"></g>
            <g class="gate" aria-hidden="true">
              <rect x="-4" y="183" width="8" height="38" rx="2" fill="#b42343"/>
              <path d="M-1 188v27" stroke="#fff" stroke-width="1.4"/>
            </g>
            <text class="gate-label" text-anchor="middle" y="236">一致 → 破棄</text>
            <text class="pass-label" text-anchor="middle" y="300">不一致 → 通過</text>
            <text class="subtle" x="24" y="340">■ UDP　● HTTP</text>
            <text class="subtle" x="${receiverX + 21}" y="351">2本の線は通信の種類を区別する表示です。通る受信処理は共通です。</text>
          </svg>
        </div>
        <figcaption class="caption">
          <div class="caption-text">
            <strong class="rule-text" aria-live="polite"></strong>
            <span>説明アニメーション：粒の数・速さは実測値ではありません。HTTPの通過と応答成功は別です。</span>
          </div>
          <button type="button" class="pause-button" aria-pressed="false">
            <span class="pause-icon" aria-hidden="true">Ⅱ</span>
            <span class="pause-label">一時停止</span>
          </button>
        </figcaption>
      </figure>`;
    const layer = this.shadowRoot.querySelector(".packet-layer");
    for (const kind of ["load", "http"]) {
      const count = kind === "load" ? 28 : 14;
      for (let index = 0; index < count; index += 1) {
        const node = document.createElementNS(SVG_NS, "g");
        node.classList.add("packet", `${kind}-packet`);
        node.innerHTML = kind === "load"
          ? '<rect x="-9" y="-6" width="18" height="12" rx="2"/><path d="M-4-2h8M-4 2h5"/>'
          : '<circle r="7"/><path d="M-3 0h6M0-3l3 3-3 3"/>';
        layer.appendChild(node);
        this._packets.push({ kind, index, count, node });
      }
    }
    this.shadowRoot.querySelector(".pause-button").addEventListener("click", () => {
      this._paused = !this._paused;
      this._last = null;
      this._updatePauseButton();
      if (this._paused) {
        cancelAnimationFrame(this._raf);
        this._raf = 0;
      } else this._schedule();
    });
    this._ready = true;
  }

  _updateStop() {
    const selected = this.selected;
    const active = this._stages.find(stage => stage.id === selected);
    const stop = active.x + active.width - 46;
    this._stop = stop;
    const labelX = active.x + active.width / 2;
    for (const stage of this.shadowRoot.querySelectorAll(".stage")) {
      stage.classList.toggle("is-selected", stage.dataset.stage === selected);
    }
    this.shadowRoot.querySelector(".load-path").setAttribute("d", `${this._compact ? "M126 155 C152 155 147 202 168 202" : "M154 216 C168 216 174 202 192 202"} H${stop}`);
    this.shadowRoot.querySelector(".gate").setAttribute("transform", `translate(${stop} 0)`);
    this.shadowRoot.querySelector(".gate-label").setAttribute("x", String(labelX));
    this.shadowRoot.querySelector(".pass-label").setAttribute("x", String(labelX));
    this.shadowRoot.querySelector(".rule-text").textContent = `${LABELS[selected]}：UDP :4000 だけを破棄。HTTP :8080 は通過。`;
    this.shadowRoot.querySelector("#diagram-desc").textContent =
      `NIC、XDP、Linuxの受信処理、Netfilter input、アプリの順に処理します。${LABELS[selected]}を選択中。四角いUDP :4000は選択地点で破棄され、下流へ進みません。丸いHTTP :8080は同じ処理の中を通過します。図の動きは実測に連動していません。`;
    this._draw();
  }

  _updateReadings() {
    const mode = this.getAttribute("attach-mode");
    this.shadowRoot.querySelector(".mode-text").textContent =
      mode === "generic" ? "generic XDP" : mode === "native" ? "native XDP" : "mode 未取得";
    const text = this.getAttribute("health-text") || "計測待ち";
    const reading = this.shadowRoot.querySelector(".health-reading");
    // Text supplied by React is inserted as text, never interpolated into markup.
    reading.replaceChildren();
    const lines = text.split(" · ", 2);
    lines.forEach((line, index) => {
      const tspan = document.createElementNS(SVG_NS, "tspan");
      tspan.setAttribute("x", this._compact ? "924" : "1290");
      tspan.setAttribute("dy", index === 0 ? "0" : "23");
      tspan.textContent = line;
      reading.appendChild(tspan);
    });
    const state = this.getAttribute("health-state");
    reading.style.fill = state === "down" ? "#a51e3c" : state === "ok" ? "#14633e" : "#52647a";
    this.shadowRoot.querySelector(".sender-status").textContent = this.getAttribute("sender-status") || "待機中";
    this.shadowRoot.querySelector(".sender-pps").textContent = this.getAttribute("sender-pps") || "— pps";
  }

  _draw() {
    if (!this._ready) return;
    for (const { kind, index, count, node } of this._packets) {
      const gap = kind === "load" ? 550 : 1050;
      const cycle = count * gap;
      const age = ((this._time - index * gap) % cycle + cycle) % cycle;
      const end = kind === "load" ? this._stop - 13 : this._httpEnd;
      const travel = (end - this._startX) / SPEED * 1000;
      const dwell = kind === "load" ? 170 : 0;
      const fade = kind === "load" ? 180 : 150;
      const visible = age <= travel + dwell + fade;
      node.style.display = visible ? "" : "none";
      if (!visible) continue;
      const x = Math.min(end, this._startX + age / 1000 * SPEED);
      const y = kind === "load" ? RED_Y : BLUE_Y;
      const opacity = age <= travel + dwell ? 1 : Math.max(0, 1 - (age - travel - dwell) / fade);
      node.setAttribute("transform", `translate(${x.toFixed(2)} ${y})`);
      node.setAttribute("opacity", opacity.toFixed(3));
      // Red packets stop and disappear in place. They do not fall, bounce,
      // turn into a queue, or continue beyond the selected rule.
    }
  }

  _schedule() {
    if (!this.isConnected || this._paused || document.hidden || this._raf) return;
    this._raf = requestAnimationFrame(this._onFrame);
  }

  _onFrame(timestamp) {
    this._raf = 0;
    if (!this.isConnected || this._paused || document.hidden) return;
    if (this._last != null) this._time += Math.min(timestamp - this._last, 64);
    this._last = timestamp;
    this._draw();
    this._schedule();
  }

  _onVisibility() {
    this._last = null;
    if (document.hidden) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    } else this._schedule();
  }

  _onMotionPreference(event) {
    this._paused = event.matches;
    this._last = null;
    this._updatePauseButton();
    if (this._paused) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    } else this._schedule();
  }

  _updatePauseButton() {
    this.shadowRoot.querySelector(".pause-button").setAttribute("aria-pressed", String(this._paused));
    this.shadowRoot.querySelector(".pause-label").textContent = this._paused ? "再生" : "一時停止";
    this.shadowRoot.querySelector(".pause-icon").textContent = this._paused ? "▷" : "Ⅱ";
  }
}

if (!customElements.get("packet-network-diagram")) {
  customElements.define("packet-network-diagram", PacketNetworkDiagram);
}
