#!/usr/bin/env node
/* JARVIS AI — no-lock HUD smoke test (jsdom, development only).
 *
 * Verifies the HUD opens directly with no Secure Access screen on a trusted
 * local/LAN address, even when an access token exists on the server.  JARVIS
 * itself does not need Node.js; run `cd tests && npm install` first.
 */

import { JSDOM } from "jsdom";
import { spawn } from "node:child_process";
import { existsSync, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = pathToFileURL(path.join(ROOT, "frontend/js/app.js")).href;
const TMP_BASE = existsSync("/data/user/0/com.termux/files/usr/tmp/opencode")
  ? "/data/user/0/com.termux/files/usr/tmp/opencode"
  : os.tmpdir();
const TOKEN = "trusted-lan-token-1234567890";
const results = [];
const errors = [];
const consoleErrors = [];
const cookies = new Map();
let BASE = "";
let dom = null;
let server = null;
let work = "";
let port = 0;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nativeFetch = globalThis.fetch.bind(globalThis);

function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : ` — ${detail}`}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.on("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

async function startServer(logPath) {
  const log = createWriteStream(logPath);
  const env = {
    ...process.env,
    JARVIS_DB_PATH: path.join(work, "db", "nolock.db"),
    JARVIS_WORKSPACE: path.join(work, "workspace"),
    JARVIS_LOG_DIR: path.join(work, "logs"),
    JARVIS_ACCESS_TOKEN: TOKEN,
    JARVIS_LOCAL_AUTO_UNLOCK: "1",
    JARVIS_DEFAULT_PROVIDER: "demo",
    JARVIS_RATE_LIMIT: "100000",
    JARVIS_CHAT_RATE_LIMIT: "100000",
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "",
    GROQ_API_KEY: "",
    OPENROUTER_API_KEY: "",
  };
  const child = spawn(process.env.PYTHON || "python", ["main.py", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      if ((await nativeFetch(`${BASE}/api/health`)).ok) return child;
    } catch {
      /* starting */
    }
    await wait(200);
  }
  throw new Error("no-lock server failed to start");
}

function cookieHeader() {
  return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

async function browserFetch(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url, BASE).toString();
  const headers = new Headers(init.headers || {});
  const jar = cookieHeader();
  if (jar) headers.set("cookie", jar);
  const response = await nativeFetch(url, { ...init, headers, redirect: "manual" });
  for (const raw of response.headers.getSetCookie?.() || []) {
    const [pair] = raw.split(";");
    const at = pair.indexOf("=");
    if (at > 0) {
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      cookies.set(name, value);
      if (dom?.cookieJar) {
        try {
          dom.cookieJar.setCookieSync(`${name}=${value}`, BASE);
        } catch {
          /* harness only */
        }
      }
    }
  }
  return response;
}

function fakeContext() {
  const gradient = () => ({ addColorStop() {} });
  return new Proxy(
    {},
    {
      get(target, prop) {
        if (prop === "createLinearGradient" || prop === "createRadialGradient") return gradient;
        if (prop === "measureText") return () => ({ width: 10 });
        if (prop in target) return target[prop];
        return () => {};
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    },
  );
}

async function waitFor(label, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return true;
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
    }
    await wait(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

try {
  work = await mkdtemp(path.join(TMP_BASE, "jarvis-nolock-"));
  port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  console.log("JARVIS no-lock HUD smoke test");
  console.log(`  server: ${BASE}\n`);
  server = await startServer(path.join(work, "server.log"));

  const html = await (await nativeFetch(`${BASE}/`)).text();
  check("token absent from served HTML", !html.includes(TOKEN));
  check("no Secure Access / lock screen markup", !/lockScreen|lockForm|lockToken|SECURE ACCESS|Unlock core/i.test(html));
  for (const asset of ["/js/api.js", "/js/app.js", "/js/panels.js", "/js/state.js", "/js/ui.js"]) {
    const source = await (await nativeFetch(`${BASE}${asset}`)).text();
    check(`no auth handlers in ${asset}`, !/lockScreen|lockForm|lockToken|bindLockForm|\bunlock\(|logoutBtn/.test(source));
  }

  const handshake = await (await browserFetch(`${BASE}/api/session`)).json();
  check("trusted handshake reports unlocked", handshake.unlocked === true, JSON.stringify(handshake));
  check("status works without any login", (await browserFetch(`${BASE}/api/status`)).status === 200);

  dom = new JSDOM(html, { url: `${BASE}/`, pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  window.fetch = browserFetch;
  window.matchMedia = () => ({
    matches: true,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  window.isSecureContext = true;
  window.devicePixelRatio = 2;
  window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 16);
  window.cancelAnimationFrame = (handle) => clearTimeout(handle);
  window.HTMLCanvasElement.prototype.getContext = () => fakeContext();
  window.confirm = () => true;
  window.console.error = (...args) => consoleErrors.push(args.join(" "));
  window.addEventListener("error", (event) => errors.push(event.message));
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
  Object.defineProperty(window, "SpeechRecognition", { value: undefined, configurable: true });
  Object.defineProperty(window, "webkitSpeechRecognition", { value: undefined, configurable: true });
  Object.defineProperty(window, "speechSynthesis", { value: undefined, configurable: true });

  for (const key of [
    "window",
    "document",
    "navigator",
    "location",
    "localStorage",
    "WebSocket",
    "HTMLElement",
    "Event",
    "CustomEvent",
    "Node",
  ]) {
    try {
      globalThis[key] = window[key] ?? globalThis[key];
    } catch {
      Object.defineProperty(globalThis, key, { value: window[key] ?? globalThis[key], configurable: true });
    }
  }
  globalThis.fetch = browserFetch;
  globalThis.confirm = () => true;
  process.on("unhandledRejection", (reason) => errors.push(String(reason)));
  process.on("uncaughtException", (error) => errors.push(error.stack || String(error)));

  await import(APP);
  const doc = window.document;
  await waitFor("HUD visible without login", () => doc.querySelector("#app")?.hidden === false, 15000);
  check("no lock screen element in DOM", doc.querySelector("#lockScreen") === null);
  check("HUD opens directly", doc.querySelector("#app").hidden === false);
  check("no token input in DOM", doc.querySelector("#lockToken") === null);
  check("no unlock button in DOM", !/Unlock core/i.test(doc.body.textContent));
  check("HUD boots core", doc.querySelector("#transcript").textContent.includes("CORE ONLINE"));
  await waitFor("live link", () => doc.querySelector("#factLink").textContent === "live");
  check("WebSocket connects without login", doc.querySelector("#factLink").textContent === "live");

  const sessionBody = await (await browserFetch(`${BASE}/api/session`)).json();
  const posted = await browserFetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Jarvis-CSRF": sessionBody.csrf },
    body: JSON.stringify({ message: "hello" }),
  });
  check("chat works without login", posted.status === 200, String(posted.status));
} catch (error) {
  errors.push(error.stack || String(error));
  console.error("HARNESS ERROR:", error);
} finally {
  await wait(300);
  check("no uncaught frontend errors", errors.length === 0, errors.join(" | ").slice(0, 600));
  const relevant = consoleErrors.filter((line) => !line.includes("Not implemented") && !line.includes("WebSocket"));
  check("no console errors", relevant.length === 0, relevant.join(" | ").slice(0, 600));
  if (work) {
    const log = await readFile(path.join(work, "server.log"), "utf8").catch(() => "");
    check("token absent from server logs", !log.includes(TOKEN));
  }
  dom?.window.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await wait(500);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  if (work) await rm(work, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\nRESULT: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
