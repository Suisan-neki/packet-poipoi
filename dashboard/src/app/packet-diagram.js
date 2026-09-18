/**
 * Illustrative particle streams, not a packet capture or a traffic generator.
 * Measurement attributes are displayed verbatim; animation never creates metrics.
 * The exhibit layout follows the user's 2026-09-18 screenshot. App.tsx, the
 * experiment aggregation and the React/custom-element interface stay unchanged.
 */
const STAGES = [
  { id: "nic", title: "NIC", sub: "ネットワークの入口" },
  { id: "xdp", title: "XDP", sub: "最前線の検問所" },
  { id: "stack", title: "TCP/IPスタック", sub: "データの仕分け" },
  { id: "netfilter", title: "Netfilter", sub: "ファイアウォール" },
  { id: "application", title: "アプリケーション", sub: "最終目的地" },
];
const CONDITIONS = {
  xdp: ["入口で捨てる", "XDP"],
  netfilter: ["途中で捨てる", "Netfilter"],
  application: ["届いてから捨てる", "Application"],
};
const COLORS = { load: "233,64,99", http: "51,139,239" };
const TAU = Math.PI * 2;
const SPEED = 110; // CSS pixels per second; independent of measured pps.
const PERIOD = 310;
const css = `
packet-network-diagram { display:block; min-width:0; }
.packet-stream-viewport { overflow-x:auto; scrollbar-width:thin; border-radius:19px; }
.network-board--stream { position:relative; isolation:isolate; }
.network-board--stream .receiver-body { position:relative; padding-top:48px; padding-bottom:48px; }
.network-board--stream .receiver-body::before,
.network-board--stream .receiver-body::after,
.network-board--stream .pipeline-node::before { content:none !important; animation:none !important; }
.network-board--stream .pipeline-link { color:#9ab0c4; opacity:.65; }
.network-board--stream .network-arrow i { visibility:hidden; }
.network-board--stream .stream-canvas { position:absolute; inset:0; width:100%; height:100%; z-index:3; pointer-events:none; }
.network-board--stream .pipeline-node strong,
.network-board--stream .pipeline-node small,
.network-board--stream .pipeline-node em { position:relative; z-index:4; }
.network-board--stream .pipeline-node em { position:absolute; }
.network-board--stream .stream-blocked { position:absolute; z-index:5; color:#cf2d4b; font-size:13px; font-weight:800; letter-spacing:.025em; transform:translateX(-50%); pointer-events:none; white-space:nowrap; }
.network-board--stream .stream-tools { position:absolute; bottom:9px; right:18px; z-index:6; display:flex; align-items:center; gap:10px; color:#59718b; }
.network-board--stream .stream-note { font-size:10px; line-height:1.3; }
.packet-stream-description { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
@media(max-width:1100px) {
  .network-board--stream .receiver-body { padding-top:42px; padding-bottom:42px; }
}
@media(max-width:920px) {
  /* Scroll the diagram as one unit instead of separating streams from nodes. */
  .network-board--stream { min-width:960px; grid-template-columns:180px 160px minmax(0,1fr); }
  .network-board--stream .network-device--sender { grid-template-columns:initial; grid-template-rows:auto 1fr auto; border-right:1px solid #dbe8f1; border-bottom:0; align-items:normal; }
  .network-board--stream .computer-illustration { display:block; width:118px; height:84px; transform:none; }
  .network-board--stream .network-arrows { grid-template-columns:initial; gap:38px; padding:28px 14px; }
  .network-board--stream .receiver-topline { display:flex; }
  .network-board--stream .current-stop { min-width:180px; }
  .network-board--stream .receiver-body { overflow:visible; }
  .network-board--stream .pipeline { min-width:0; }
  .network-board--stream .service-check { display:grid; }
}
`;

// Fixed seeds make screenshots repeatable and avoid allocating particle objects
// or randomising the entire stream on every frame.
function seed(n) { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); }
function rgba(rgb, alpha) { return `rgba(${rgb},${Math.max(0, Math.min(1, alpha))})`; }
function pathFrom(points) {
  const samples = [{ x: points[0].x, y: points[0].y, d: 0 }];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], mid = (a.x + b.x) / 2;
    const steps = Math.max(12, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 5));
    for (let j = 1; j <= steps; j++) {
      const t = j / steps, u = 1 - t;
      const x = u ** 3 * a.x + 3 * u * u * t * mid + 3 * u * t * t * mid + t ** 3 * b.x;
      const y = (u ** 3 + 3 * u * u * t) * a.y + (3 * u * t * t + t ** 3) * b.y;
      const prev = samples.at(-1);
      total += Math.hypot(x - prev.x, y - prev.y);
      samples.push({ x, y, d: total });
    }
  }
  const shape = new Path2D();
  samples.forEach((p, i) => i ? shape.lineTo(p.x, p.y) : shape.moveTo(p.x, p.y));
  return { samples, total, shape };
}
function pointAt(path, distance) {
  const list = path.samples;
  let lo = 0, hi = list.length - 1;
  while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (list[m].d < distance) lo = m; else hi = m; }
  const a = list[lo], b = list[hi], f = Math.max(0, Math.min(1, (distance - a.d) / (b.d - a.d || 1)));
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

export class PacketNetworkDiagram extends HTMLElement {
  static get observedAttributes() {
    return ["data-stop", "attach-mode", "health-text", "health-state", "sender-status", "sender-pps"];
  }
  constructor() {
    super();
    this._time = 8;
    this._raf = 0;
    this._last = null;
    this._ready = false;
    this._dirty = true;
    this._particles = Array.from({ length: 600 }, (_, i) => ({
      phase: seed(i), jitter: seed(i + 700), size: .55 + seed(i + 1300) * 1.1,
    }));
    this._frame = this._frame.bind(this);
    this._visibility = this._visibility.bind(this);
    this._resize = () => { this._dirty = true; this._refresh(); };
    this._motion = () => { this._refresh(); };
  }
  get selected() { const s = this.getAttribute("data-stop"); return Object.hasOwn(CONDITIONS, s ?? "") ? s : "application"; }
  get paused() { return this._preference?.matches ?? false; }
  connectedCallback() {
    if (!this._ready) this._mount();
    this._preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    this._preference.addEventListener("change", this._motion);
    document.addEventListener("visibilitychange", this._visibility);
    window.addEventListener("resize", this._resize);
    this._observer = new ResizeObserver(this._resize);
    this._observer.observe(this._board);
    [...this._nodes, this._service].forEach(n => this._observer.observe(n));
    this._update();
    document.fonts?.ready.then(() => { if (this.isConnected) this._resize(); });
  }
  disconnectedCallback() {
    cancelAnimationFrame(this._raf);
    clearTimeout(this._settle);
    this._raf = 0;
    this._last = null;
    this._observer?.disconnect();
    this._preference?.removeEventListener("change", this._motion);
    document.removeEventListener("visibilitychange", this._visibility);
    window.removeEventListener("resize", this._resize);
  }
  attributeChangedCallback(name, previous, next) {
    if (this._ready && previous !== next) this._update();
  }
  _mount() {
    // Only static strings are templated. All external readings use textContent.
    this.innerHTML = `<style>${css}</style>
      <div class="packet-stream-viewport" role="region" tabindex="0" aria-label="通信図。狭い画面では横にスクロールできます。">
      <section class="network-board network-board--stream" aria-label="Pi AからPi Bへの通信と破棄位置">
        <article class="network-device network-device--sender">
          <div class="network-device__heading"><strong>送る側（Pi A）</strong><small>クライアント（送信元）</small></div>
          <div class="computer-illustration" aria-hidden="true"><span class="computer-illustration__screen"><i></i></span><span class="computer-illustration__hinge"></span><span class="computer-illustration__base"></span></div>
          <div class="sender-live"><span class="sender-status"></span><strong class="sender-pps"></strong></div>
        </article>
        <div class="network-arrows" aria-hidden="true">
          <div class="network-arrow network-arrow--load"><span>いらない通信<br><b>UDP :4000</b></span><i></i></div>
          <div class="network-arrow network-arrow--service"><span>守りたい通信<br><b>HTTP GET :8080</b></span><i></i></div>
        </div>
        <article class="network-device network-device--receiver">
          <div class="receiver-topline"><div><strong>受ける側（Pi B）</strong><small>エッジサーバー</small></div>
            <div class="current-stop"><span>いま見ている場所</span><strong class="stop-title"></strong><small class="stop-technical"></small></div>
          </div>
          <div class="receiver-body">
            <div class="pipeline">${STAGES.map((s, i) => `<div class="pipeline-step">${i ? '<span class="pipeline-link">→</span>' : ''}<div class="pipeline-node pipeline-node--${s.id}" data-stage="${s.id}"><strong>${s.title}</strong><small>${s.sub}</small><em style="display:none">ここで捨てる</em></div></div>`).join("")}</div>
            <div class="service-check"><span>HTTP処理完了</span><strong class="health-reading"></strong></div>
          </div>
        </article>
        <canvas class="stream-canvas" aria-hidden="true"></canvas>
        <span class="stream-blocked" aria-hidden="true">BLOCKED</span>
        <div class="stream-tools"><span class="stream-note">模式表示 · 粒の数と速さは実測値ではありません</span></div>
        <span class="packet-stream-description" aria-live="polite"></span>
      </section></div>`;
    this._board = this.querySelector(".network-board");
    this._canvas = this.querySelector("canvas");
    this._ctx = this._canvas.getContext("2d");
    this._nodes = [...this.querySelectorAll(".pipeline-node")];
    this._service = this.querySelector(".service-check");
    this._blocked = this.querySelector(".stream-blocked");
    this._ready = true;
  }
  _update() {
    const selected = this.selected, [label, technical] = CONDITIONS[selected];
    for (const n of this._nodes) {
      const active = n.dataset.stage === selected;
      n.classList.toggle("is-active", active);
      // The existing global em rule specifies display:grid, so set display
      // explicitly rather than relying on the user-agent [hidden] rule.
      n.querySelector("em").style.display = active ? "grid" : "none";
    }
    const mode = this.getAttribute("attach-mode");
    this.querySelector(".stop-title").textContent = label;
    this.querySelector(".stop-technical").textContent = technical + (selected === "xdp" && ["native", "generic"].includes(mode) ? ` · ${mode}` : "");
    this.querySelector(".sender-status").textContent = this.getAttribute("sender-status") || "待機中";
    this.querySelector(".sender-pps").textContent = this.getAttribute("sender-pps") || "— pps";
    this.querySelector(".health-reading").textContent = this.getAttribute("health-text") || "計測待ち";
    const health = this.getAttribute("health-state");
    this._service.className = "service-check " + (health === "ok" ? "is-ok" : health === "down" ? "is-down" : "is-waiting");
    this.querySelector(".packet-stream-description").textContent = `${technical}を選択中。赤いUDP :4000は選択地点で破棄されます。青いHTTP :8080は各処理層を通過します。二色は同じ受信経路を通る通信の種類を区別する模式表現です。フィルタの通過とHTTP応答の成功は別です。`;
    this._dirty = true;
    clearTimeout(this._settle);
    // Re-measure after the existing selected-node transform has settled.
    this._settle = setTimeout(() => { if (this.isConnected) this._resize(); }, 220);
    this._refresh();
  }
  _measure() {
    const root = this._board.getBoundingClientRect();
    if (!root.width || !root.height) return false;
    const box = el => {
      const r = el.getBoundingClientRect();
      return { x: r.left - root.left, y: r.top - root.top, w: r.width, h: r.height, right: r.right - root.left, bottom: r.bottom - root.top };
    };
    this._width = root.width; this._height = root.height;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(root.width * ratio), h = Math.round(root.height * ratio);
    if (this._canvas.width !== w || this._canvas.height !== h) { this._canvas.width = w; this._canvas.height = h; }
    this._ratio = ratio;
    const screen = box(this.querySelector(".computer-illustration__screen"));
    const redArrow = box(this.querySelector(".network-arrow--load i"));
    const blueArrow = box(this.querySelector(".network-arrow--service i"));
    const nodes = this._nodes.map(n => ({ ...box(n), id: n.dataset.stage }));
    const service = box(this._service);
    const active = nodes.find(n => n.id === this.selected);
    const redY = Math.min(...nodes.map(n => n.y)) - 28;
    this._gate = { x: active.x + active.w / 2, y: redY };
    const startX = screen.right - 2;
    this._red = pathFrom([
      { x: startX, y: screen.y + screen.h * .44 },
      { x: redArrow.x, y: redArrow.y + redArrow.h / 2 },
      { x: redArrow.right, y: redArrow.y + redArrow.h / 2 },
      { x: nodes[0].x, y: redY }, { x: this._gate.x, y: redY },
    ]);
    // Use the clear top band INSIDE each original node, not a bypass underneath
    // the pipeline. This preserves every text position and avoids covering it.
    const bluePoints = [
      { x: startX, y: screen.y + screen.h * .70 },
      { x: blueArrow.x, y: blueArrow.y + blueArrow.h / 2 },
      { x: blueArrow.right, y: blueArrow.y + blueArrow.h / 2 },
    ];
    for (const n of nodes) bluePoints.push({ x: n.x + 3, y: n.y + 9 }, { x: n.right - 3, y: n.y + 9 });
    bluePoints.push({ x: service.x + 3, y: service.y + 9 }, { x: service.right - 11, y: service.y + 9 });
    this._blue = pathFrom(bluePoints);
    this._nodeBoxes = nodes.map(n => {
      const x = n.x + n.w / 2;
      const p = this._blue.samples.reduce((best, p) => Math.abs(p.x - x) < Math.abs(best.x - x) ? p : best);
      return { ...n, distance: p.d };
    });
    const blockedX = this.selected === "application" ? this._gate.x - 62 : this._gate.x;
    const blockedY = this.selected === "application" ? redY - 28 : redY - 46;
    this._blocked.style.left = `${blockedX}px`;
    this._blocked.style.top = `${blockedY}px`;
    this._dirty = false;
    return true;
  }
  _refresh() {
    if (!this.isConnected) return;
    if (this.paused || document.hidden) {
      cancelAnimationFrame(this._raf); this._raf = 0; this._last = null;
      if (this._dirty) this._measure();
      this._draw();
    } else this._schedule();
  }
  _schedule() {
    if (this.isConnected && !this.paused && !document.hidden && !this._raf) this._raf = requestAnimationFrame(this._frame);
  }
  _frame(now) {
    this._raf = 0;
    if (!this.isConnected || document.hidden || this.paused) return;
    if (this._last != null) this._time += Math.min(now - this._last, 50) / 1000;
    this._last = now;
    if (this._dirty || this._ratio !== Math.min(window.devicePixelRatio || 1, 2)) this._measure();
    this._draw(); this._schedule();
  }
  _visibility() {
    this._last = null;
    if (document.hidden) { cancelAnimationFrame(this._raf); this._raf = 0; } else this._refresh();
  }
  _stroke(path, rgb) {
    const c = this._ctx;
    for (const [width, alpha] of [[21,.035],[12,.08],[5,.19],[1.4,.65]]) {
      c.strokeStyle = rgba(rgb, alpha); c.lineWidth = width; c.stroke(path.shape);
    }
  }
  _stream(path, rgb, count, isRed) {
    const c = this._ctx, travel = this._time * SPEED;
    this._stroke(path, rgb);
    for (let i = 0; i < count; i++) {
      const p = this._particles[i];
      const d = (p.phase * path.total + travel * (isRed ? 1.07 : 1)) % path.total;
      const pos = pointAt(path, d);
      const wave = Math.sin(d * .036 - this._time * 1.8 + p.jitter * 3);
      const spread = (p.jitter - .5) * (isRed ? 11 : 5);
      const y = pos.y + spread + wave * (isRed ? 3.4 : 1.1);
      const envelope = .52 + .48 * Math.pow(.5 + .5 * Math.cos((d - travel) / PERIOD * TAU), 3);
      c.fillStyle = rgba(rgb, .35 + envelope * .60);
      c.beginPath(); c.arc(pos.x, y, p.size, 0, TAU); c.fill();
      if (i % 5 === 0) {
        c.fillStyle = rgba(rgb, .07); c.beginPath(); c.arc(pos.x, y, p.size * 3.7, 0, TAU); c.fill();
        c.fillStyle = "rgba(255,255,255,.88)"; c.beginPath(); c.arc(pos.x, y, p.size * .46, 0, TAU); c.fill();
      }
    }
  }
  _glowNodes() {
    const c = this._ctx, travel = this._time * SPEED;
    for (const n of this._nodeBoxes) {
      const phase = (n.distance - travel) / PERIOD * TAU;
      const pulse = Math.pow(.5 + .5 * Math.cos(phase), 9);
      for (const [expand, alpha] of [[6,.025],[3,.06],[0,.40]]) {
        roundRect(c, n.x - expand, n.y - expand, n.w + expand * 2, n.h + expand * 2, 11 + expand);
        c.lineWidth = expand ? 4 : 1.6;
        c.strokeStyle = rgba(COLORS.http, alpha * pulse); c.stroke();
      }
    }
  }
  _barrier() {
    const c = this._ctx, g = this._gate;
    const pulse = .5 + .5 * Math.sin(this._time * 2.3);
    const halo = c.createRadialGradient(g.x - 1, g.y, 0, g.x, g.y, 37);
    halo.addColorStop(0, rgba(COLORS.load, .30 + pulse * .08)); halo.addColorStop(1, rgba(COLORS.load, 0));
    c.fillStyle = halo; c.fillRect(g.x - 40, g.y - 40, 80, 80);
    // A local barrier on the unwanted-traffic lane. It does not cover HTTP.
    c.beginPath(); c.moveTo(g.x + 2, g.y - 24); c.bezierCurveTo(g.x - 8, g.y - 10, g.x - 8, g.y + 10, g.x + 2, g.y + 24);
    c.strokeStyle = rgba(COLORS.load, .16); c.lineWidth = 10; c.stroke();
    c.strokeStyle = rgba(COLORS.load, .80); c.lineWidth = 2.3; c.stroke();
    c.strokeStyle = "rgba(255,255,255,.88)"; c.lineWidth = .9; c.stroke();
    // Burst fragments disperse UPSTREAM and fade; never fall into a fake queue
    // or continue through the blocked stage. No per-frame allocation/growth.
    for (let i = 0; i < 72; i++) {
      const p = this._particles[i + 500];
      const age = (this._time * .90 + p.phase) % 1;
      const x = g.x - 5 - (10 + p.jitter * 54) * age;
      const y = g.y + (seed(i + 3000) * 74 - 54) * age;
      const a = (1 - age) ** 1.65;
      c.fillStyle = rgba(COLORS.load, a * .84);
      c.beginPath(); c.arc(x, y, p.size * (1.7 - age * .60), 0, TAU); c.fill();
    }
    c.fillStyle = "rgba(255,255,255,.92)"; c.beginPath(); c.arc(g.x - 4, g.y, 2.1 + pulse, 0, TAU); c.fill();
  }
  _draw() {
    if (!this._ctx || !this._red || !this._blue) return;
    const c = this._ctx;
    c.setTransform(this._ratio, 0, 0, this._ratio, 0, 0);
    c.clearRect(0, 0, this._width, this._height);
    c.lineCap = "round"; c.lineJoin = "round";
    this._glowNodes();
    this._stream(this._red, COLORS.load, 370, true);
    this._stream(this._blue, COLORS.http, 600, false);
    this._barrier();
    const end = this._blue.samples.at(-1);
    c.beginPath(); c.moveTo(end.x - 6, end.y - 4); c.lineTo(end.x, end.y); c.lineTo(end.x - 6, end.y + 4);
    c.strokeStyle = rgba(COLORS.http, .85); c.lineWidth = 1.8; c.stroke();
  }
}
if (!customElements.get("packet-network-diagram")) customElements.define("packet-network-diagram", PacketNetworkDiagram);
