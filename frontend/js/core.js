/* VDPAI — animated core (Canvas 2D, ~30fps, cheap on Android). */

const PALETTE = {
  IDLE: ["#1d68f0", "#3b82f6"],
  LISTENING: ["#10b981", "#1d68f0"],
  THINKING: ["#1d68f0", "#6366f1"],
  SPEAKING: ["#2563eb", "#38bdf8"],
  EXECUTING: ["#f59e0b", "#1d68f0"],
  ERROR: ["#ef4444", "#dc2626"],
};

function alpha(hex, value) {
  const number = parseInt(hex.slice(1), 16);
  return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${value})`;
}

function hexPath(ctx, radius) {
  ctx.beginPath();
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export class CoreRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.reduced = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    this.state = "IDLE";
    this.level = 0;
    this.smooth = 0;
    this.time = 0;
    this.lastFrame = 0;
    this.raf = null;
    this.visible = !document.hidden;
    this.particles = Array.from({ length: 26 }, (_, index) => ({
      angle: Math.random() * Math.PI * 2,
      speed: 0.07 + Math.random() * 0.2,
      radius: 1.02 + Math.random() * 0.42,
      size: 0.7 + Math.random() * 1.5,
      direction: index % 2 === 0 ? 1 : -1,
      phase: Math.random() * Math.PI * 2,
    }));

    this.resize = this.resize.bind(this);
    this.resize();
    const RO = typeof ResizeObserver !== "undefined" ? ResizeObserver : (typeof window !== "undefined" ? window.ResizeObserver : null);
    if (RO) {
      this.observer = new RO(this.resize);
      this.observer.observe(canvas.parentElement || canvas);
    }
    window.addEventListener("resize", this.resize, { passive: true });
    document.addEventListener("visibilitychange", () => {
      this.visible = !document.hidden;
      if (this.visible && !this.reduced) this.start();
      else this.stop();
    });

    if (this.reduced) this.draw();
    else this.start();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    if (typeof this.ctx?.setTransform === "function") {
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (this.reduced) this.draw();
  }

  setState(state) {
    this.state = PALETTE[state] ? state : "IDLE";
    if (this.reduced) this.draw();
  }

  setLevel(value) {
    this.level = Math.max(0, Math.min(1, Number(value) || 0));
  }

  start() {
    if (this.raf) return;
    const loop = (timestamp) => {
      this.raf = requestAnimationFrame(loop);
      if (!this.visible) return;
      if (timestamp - this.lastFrame < 33) return;
      const delta = Math.min(0.06, (timestamp - this.lastFrame) / 1000 || 0.016);
      this.lastFrame = timestamp;
      this.time += delta;
      this.smooth += (this.level - this.smooth) * 0.14;
      this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  draw() {
    const ctx = this.ctx;
    const width = this.width;
    const height = this.height;
    if (!width || !height) return;
    ctx.clearRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;
    const base = Math.min(width, height) * 0.29;
    const [primary, secondary] = PALETTE[this.state] || PALETTE.IDLE;
    const t = this.time;
    const energy = this.smooth;
    const speed = this.state === "THINKING" ? 1.7 : this.state === "EXECUTING" ? 2.3 : 1.0;
    const alive = this.state !== "IDLE";

    // outer measurement ticks
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.05 * speed);
    ctx.strokeStyle = alpha(primary, 0.16);
    ctx.lineWidth = 1;
    const tickRadius = base * 1.63;
    for (let index = 0; index < 72; index += 1) {
      const angle = (index / 72) * Math.PI * 2;
      const length = index % 6 === 0 ? 8 : 3;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * tickRadius, Math.sin(angle) * tickRadius);
      ctx.lineTo(Math.cos(angle) * (tickRadius + length), Math.sin(angle) * (tickRadius + length));
      ctx.stroke();
    }
    ctx.restore();

    // dashed orbit
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-t * 0.12 * speed);
    ctx.setLineDash([2, 9]);
    ctx.strokeStyle = alpha(secondary, 0.24);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, base * 1.45, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // segmented arc ring
    const segments = 6;
    for (let index = 0; index < segments; index += 1) {
      const start = t * 0.24 * speed + index * ((Math.PI * 2) / segments);
      ctx.strokeStyle = alpha(primary, index === 0 ? 0.72 : 0.26);
      ctx.lineWidth = index === 0 ? 1.8 : 1.1;
      ctx.beginPath();
      ctx.arc(cx, cy, base * 1.16, start, start + Math.PI * 0.34);
      ctx.stroke();
    }

    // rotating hexagonal frame
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-t * 0.07 * speed);
    ctx.strokeStyle = alpha(primary, 0.5);
    ctx.lineWidth = 1.1;
    hexPath(ctx, base * 0.99);
    ctx.stroke();
    ctx.rotate(t * 0.16);
    ctx.strokeStyle = alpha(secondary, 0.16);
    hexPath(ctx, base * 0.8);
    ctx.stroke();
    ctx.restore();

    // bracket arcs
    const bracketRadius = base * 1.3;
    for (let index = 0; index < 2; index += 1) {
      const start = -t * 0.35 * speed + index * Math.PI;
      ctx.strokeStyle = alpha(primary, 0.34);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, bracketRadius, start, start + Math.PI * 0.16);
      ctx.stroke();
    }

    // core glow
    const pulse = 1 + Math.sin(t * (alive ? 2.2 : 1.2)) * 0.025 + energy * 0.09;
    const coreRadius = base * 0.5 * pulse;
    const glow = ctx.createRadialGradient(cx, cy, coreRadius * 0.1, cx, cy, coreRadius * 1.9);
    glow.addColorStop(0, alpha(primary, 0.5 + energy * 0.25));
    glow.addColorStop(0.45, alpha(secondary, 0.16 + energy * 0.1));
    glow.addColorStop(1, alpha(secondary, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, coreRadius * 1.9, 0, Math.PI * 2);
    ctx.fill();

    const disc = ctx.createRadialGradient(cx, cy, coreRadius * 0.1, cx, cy, coreRadius);
    disc.addColorStop(0, alpha(primary, 0.85));
    disc.addColorStop(0.55, alpha(secondary, 0.28));
    disc.addColorStop(1, alpha(secondary, 0.02));
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(cx, cy, coreRadius, 0, Math.PI * 2);
    ctx.fill();

    // core rings
    ctx.strokeStyle = alpha(primary, 0.72);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, coreRadius * 0.72, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = alpha(primary, 0.9);
    ctx.lineWidth = 2;
    const sweep = -t * 1.1 * speed;
    ctx.beginPath();
    ctx.arc(cx, cy, coreRadius * 0.9, sweep, sweep + Math.PI * 0.5);
    ctx.stroke();

    // core nanodot
    ctx.fillStyle = alpha(primary, 0.95);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(2, base * 0.022 + energy * base * 0.012), 0, Math.PI * 2);
    ctx.fill();

    // crosshair ticks
    ctx.strokeStyle = alpha(primary, 0.22);
    ctx.lineWidth = 1;
    const reach = base * 1.52;
    const gap = base * 0.12;
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
      ctx.beginPath();
      ctx.moveTo(cx + dx * (reach + gap), cy + dy * (reach + gap));
      ctx.lineTo(cx + dx * (reach + gap + 10), cy + dy * (reach + gap + 10));
      ctx.stroke();
    });

    // orbiting particles
    for (const particle of this.particles) {
      const angle = particle.angle + t * particle.speed * particle.direction * speed;
      const radius = base * (particle.radius + 0.04 * Math.sin(t * 1.3 + particle.phase));
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      const visibility = 0.18 + 0.52 * Math.abs(Math.sin(t * 1.4 + particle.phase));
      ctx.fillStyle = alpha(particle.phase > Math.PI ? secondary : primary, visibility);
      ctx.beginPath();
      ctx.arc(x, y, particle.size, 0, Math.PI * 2);
      ctx.fill();
    }

    if (this.state === "ERROR") {
      ctx.strokeStyle = alpha(primary, 0.7);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(cx, cy, base * 1.08, t * 1.6, t * 1.6 + Math.PI * 0.4);
      ctx.stroke();
    }
  }
}
