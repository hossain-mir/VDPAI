/* VDPAI — lightweight waveform driven by the real microphone analyser
   (or the real speaking/listening state when audio analysis is unavailable). */

export class Waveform {
  constructor(canvas, { getLevel } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.getLevel = getLevel || (() => 0);
    this.state = "IDLE";
    this.time = 0;
    this.last = 0;
    this.raf = null;
    this.visible = !document.hidden;
    this.reduced = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);

    this.resize = this.resize.bind(this);
    this.resize();
    const RO = typeof ResizeObserver !== "undefined" ? ResizeObserver : (typeof window !== "undefined" ? window.ResizeObserver : null);
    if (RO) {
      this.observer = new RO(this.resize);
      this.observer.observe(canvas);
    }
    window.addEventListener("resize", this.resize, { passive: true });
    document.addEventListener("visibilitychange", () => {
      this.visible = !document.hidden;
      if (this.visible) this.start();
      else this.stop();
    });
    if (this.reduced) this.draw();
    else this.start();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || 320));
    const height = Math.max(1, Math.round(rect.height || 46));
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
    this.state = state;
    if (this.reduced) this.draw();
  }

  start() {
    if (this.raf) return;
    const loop = (timestamp) => {
      this.raf = requestAnimationFrame(loop);
      if (!this.visible) return;
      if (timestamp - this.last < 33) return;
      this.time += Math.min(0.06, (timestamp - this.last) / 1000 || 0.016);
      this.last = timestamp;
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

    const speaking = this.state === "SPEAKING";
    const listening = this.state === "LISTENING";
    const thinking = this.state === "THINKING";
    const error = this.state === "ERROR";
    const active = speaking || listening;

    let level = 0;
    try {
      level = Number(this.getLevel()) || 0;
    } catch {
      level = 0;
    }
    level = Math.max(0, Math.min(1, level));

    const bars = Math.max(18, Math.min(64, Math.floor(width / 11)));
    const gap = 3;
    const barWidth = Math.max(2, (width - gap * (bars - 1)) / bars);
    const mid = height / 2;
    const primary = error ? "#ef4444" : speaking || listening ? "#10b981" : "#1d68f0";
    const secondary = error ? "#f87171" : "#3b82f6";

    for (let index = 0; index < bars; index += 1) {
      const x = index * (barWidth + gap);
      const position = index / Math.max(1, bars - 1);
      const envelope = Math.sin(Math.PI * position);
      let amplitude;
      if (active) {
        const base = listening ? 0.08 : 0.06;
        const noise = 0.5 + 0.5 * Math.sin(this.time * (speaking ? 7.5 : 4.2) + index * 0.65);
        amplitude = (base + level * 0.9 * noise) * envelope;
      } else if (thinking) {
        amplitude = (0.05 + 0.05 * Math.abs(Math.sin(this.time * 2.4 + index * 0.5))) * envelope;
      } else {
        amplitude = 0.018 * envelope * (0.6 + 0.4 * Math.sin(this.time * 1.1 + index * 0.35));
      }
      const barHeight = Math.max(1.2, height * 0.92 * amplitude);
      const gradient = ctx.createLinearGradient(0, mid - barHeight, 0, mid + barHeight);
      gradient.addColorStop(0, primary);
      gradient.addColorStop(0.5, secondary);
      gradient.addColorStop(1, primary);
      ctx.fillStyle = gradient;
      ctx.globalAlpha = 0.5 + (active ? 0.4 * envelope : 0.18);
      ctx.beginPath();
      ctx.roundRect
        ? ctx.roundRect(x, mid - barHeight / 2, barWidth, barHeight, barWidth / 2)
        : ctx.rect(x, mid - barHeight / 2, barWidth, barHeight);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
