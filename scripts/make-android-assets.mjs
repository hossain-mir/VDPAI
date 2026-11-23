#!/usr/bin/env node
/* Generate JARVIS-branded Android launcher icons and splash screens.
 *
 * Pure Node (zlib only) — no image library, no sharp, no native binaries.
 * The mark mirrors frontend/assets/favicon.svg so the APK and the browser HUD
 * share the same visual identity.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RES = join(ROOT, "android", "app", "src", "main", "res");

const CYAN = [88, 231, 255];
const GREEN = [61, 255, 176];
const DARK = [2, 7, 10];

/* ---------------------------------------------------------------- PNG encoder */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function writePNG(file, width, height, shade) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = shade(x, y, width, height);
      const p = row + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png);
}

/* ------------------------------------------------------------------- artwork */
const TAU = Math.PI * 2;

function blend(base, top, alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  return [
    Math.round(base[0] * (1 - a) + top[0] * a),
    Math.round(base[1] * (1 - a) + top[1] * a),
    Math.round(base[2] * (1 - a) + top[2] * a),
  ];
}

function hexagonDistance(radius, angle, size) {
  const sector = ((angle % (TAU / 6)) + TAU / 6) % (TAU / 6);
  const edge = (size * Math.cos(Math.PI / 6)) / Math.cos(sector - Math.PI / 6);
  return Math.abs(radius - edge);
}

function marker(u, v, scale, inset) {
  const radius = Math.hypot(u, v);
  const angle = Math.atan2(v, u);
  const stroke = 0.014 * scale;
  let color = [...DARK];

  const glow = Math.max(0, 1 - radius / (0.62 * scale)) ** 2 * 0.32;
  color = blend(color, CYAN, glow);

  if (hexagonDistance(radius, angle, 0.34 * scale) < stroke) {
    color = blend(color, CYAN, 0.9);
  }
  if (Math.abs(radius - 0.17 * scale) < stroke * 0.8) {
    color = blend(color, GREEN, 0.9);
  }
  if (Math.abs(radius - 0.075 * scale) < stroke) {
    color = blend(color, CYAN, 0.95);
  }
  if (radius < 0.03 * scale) {
    color = blend(color, GREEN, 1);
  }
  const arm = Math.abs(u) < stroke || Math.abs(v) < stroke;
  if (arm && radius > 0.22 * scale && radius < 0.29 * scale) {
    color = blend(color, CYAN, 0.85);
  }
  return color;
}

function launcher(round) {
  return (x, y, w, h) => {
    const s = Math.min(w, h);
    const u = (x - w / 2) / s;
    const v = (y - h / 2) / s;
    const radius = Math.hypot(u, v);
    if (round && radius > 0.5) return [0, 0, 0, 0];
    const [r, g, b] = marker(u, v, 1, 0);
    return [r, g, b, 255];
  };
}

function foreground() {
  return (x, y, w, h) => {
    const s = Math.min(w, h);
    const u = (x - w / 2) / s;
    const v = (y - h / 2) / s;
    const radius = Math.hypot(u, v);
    if (radius > 0.48) return [0, 0, 0, 0];
    const [r, g, b] = marker(u, v, 0.92, 0);
    return [r, g, b, Math.round(255 * Math.min(1, (0.5 - radius) / 0.04))];
  };
}

function splash(scale) {
  return (x, y, w, h) => {
    const s = Math.min(w, h);
    const u = (x - w / 2) / s;
    const v = (y - h / 2) / s;
    const [r, g, b] = marker(u, v, scale, 0);
    return [r, g, b, 255];
  };
}

/* ---------------------------------------------------------------------- emit */
const DENSITIES = [
  ["mdpi", 48],
  ["hdpi", 72],
  ["xhdpi", 96],
  ["xxhdpi", 144],
  ["xxxhdpi", 192],
];

for (const [density, size] of DENSITIES) {
  const dir = join(RES, `mipmap-${density}`);
  writePNG(join(dir, "ic_launcher.png"), size, size, launcher(false));
  writePNG(join(dir, "ic_launcher_round.png"), size, size, launcher(true));
  const fgSize = Math.round(size * (108 / 48));
  writePNG(join(dir, "ic_launcher_foreground.png"), fgSize, fgSize, foreground());
}

const SPLASHES = [
  ["drawable", 480, 320],
  ["drawable-port-mdpi", 320, 480],
  ["drawable-port-hdpi", 480, 800],
  ["drawable-port-xhdpi", 720, 1280],
  ["drawable-port-xxhdpi", 960, 1600],
  ["drawable-port-xxxhdpi", 1280, 1920],
  ["drawable-land-mdpi", 480, 320],
  ["drawable-land-hdpi", 800, 480],
  ["drawable-land-xhdpi", 1280, 720],
  ["drawable-land-xxhdpi", 1600, 960],
  ["drawable-land-xxxhdpi", 1920, 1280],
];

for (const [dir, width, height] of SPLASHES) {
  writePNG(join(RES, dir, "splash.png"), width, height, splash(0.36));
}

console.log("[jarvis] Android launcher icons and splash screens generated.");
