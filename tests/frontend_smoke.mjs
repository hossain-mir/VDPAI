#!/usr/bin/env node
/* JARVIS AI — optional frontend runtime smoke test.
 *
 * Requires Node.js and jsdom (`cd tests && npm install`). This is a development
 * check only; JARVIS itself never needs Node.js.
 *
 * The test starts an isolated demo-mode server on a random loopback port with a
 * throwaway database, loads frontend/index.html into jsdom, imports the real ES
 * modules, and drives the real DOM event handlers.
 *
 * It uses jsdom's lack of SpeechRecognition/speechSynthesis to verify the honest
 * voice fallback. It does not prove microphone, canvas rendering or visual layout.
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
const SETTINGS = pathToFileURL(path.join(ROOT, "frontend/js/settings.js")).href;
const PREFERRED_TMP = "/data/user/0/com.termux/files/usr/tmp/opencode";
const TMP_BASE = existsSync(PREFERRED_TMP) ? PREFERRED_TMP : os.tmpdir();
const KEEP = process.argv.includes("--keep");
const nativeFetch = globalThis.fetch.bind(globalThis);

const errors = [];
const consoleErrors = [];
const results = [];
const cookies = new Map();

function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : ` — ${detail}`}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startServer(work, port, logPath) {
  const log = createWriteStream(logPath);
  const env = {
    ...process.env,
    JARVIS_DB_PATH: path.join(work, "db", "frontend.db"),
    JARVIS_WORKSPACE: path.join(work, "workspace"),
    JARVIS_LOG_DIR: path.join(work, "logs"),
    JARVIS_ACCESS_TOKEN: "",
    JARVIS_DEFAULT_PROVIDER: "demo",
    JARVIS_FALLBACK_PROVIDER: "",
    JARVIS_RATE_LIMIT: "100000",
    JARVIS_CHAT_RATE_LIMIT: "100000",
    JARVIS_ALLOW_PRIVATE_URLS: "0",
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "",
    GROQ_API_KEY: "",
    OPENROUTER_API_KEY: "",
    OLLAMA_API_KEY: "",
    OLLAMA_BASE_URL: "",
    OLLAMA_MODEL: "",
    CUSTOM_API_KEY: "",
    CUSTOM_BASE_URL: "",
    CUSTOM_MODEL: "",
  };
  const child = spawn(
    process.env.PYTHON || "python",
    ["main.py", "--host", "127.0.0.1", "--port", String(port)],
    { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      if ((await nativeFetch(`http://127.0.0.1:${port}/api/health`)).ok) return child;
    } catch {
      /* not up yet */
    }
    await wait(200);
  }
  const tail = await readFile(logPath, "utf8").catch(() => "");
  child.kill("SIGTERM");
  throw new Error(`server failed to start:\n${tail.slice(-2500)}`);
}

function cookieHeader() {
  return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function storeCookies(response) {
  for (const raw of response.headers.getSetCookie?.() || []) {
    const [pair] = raw.split(";");
    const index = pair.indexOf("=");
    if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

async function browserFetch(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url, BASE).toString();
  const headers = new Headers(init.headers || {});
  const jar = cookieHeader();
  if (jar) headers.set("cookie", jar);
  const response = await nativeFetch(url, { ...init, headers, redirect: "manual" });
  storeCookies(response);
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

let BASE = "";
let dom = null;
let server = null;
let work = "";

async function waitFor(label, predicate, timeout = 9000) {
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
  work = await mkdtemp(path.join(TMP_BASE, "jarvis-frontend-"));
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  console.log("JARVIS frontend smoke test");
  console.log(`  server: ${BASE}`);
  console.log(`  work:   ${work}\n`);
  server = await startServer(work, port, path.join(work, "server.log"));

  const html = await (await nativeFetch(`${BASE}/`)).text();
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

  for (const key of ["window", "document", "navigator", "location", "localStorage", "WebSocket", "HTMLElement", "Event", "CustomEvent", "Node"]) {
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
  await waitFor("app shell", () => doc.querySelector("#app")?.hidden === false);
  check("app shell visible after boot", doc.querySelector("#app").hidden === false);
  check("no lock screen in DOM", doc.querySelector("#lockScreen") === null);
  check("state readout is IDLE", doc.querySelector("#stateText").textContent === "IDLE");
  check("DEMO chip is shown", doc.querySelector("#chipAi").textContent.includes("DEMO"));
  check("provider fact populated", doc.querySelector("#factProvider").textContent.toLowerCase().includes("demo"));
  check("transcript has CORE ONLINE", doc.querySelector("#transcript").textContent.includes("CORE ONLINE"));
  await waitFor("mic fallback", () => doc.querySelector("#micBtn").disabled === true);
  check("mic disabled without the speech API", doc.querySelector("#micBtn").disabled === true);
  check("voice limitation explained", doc.querySelector("#transcript").textContent.includes("speech recognition"));

  await waitFor("panels", () => doc.querySelectorAll("#providerSelect option").length > 1);
  check("provider panel populated", doc.querySelectorAll("#providerSelect option").length > 1);
  check("provider panel selects demo", doc.querySelector("#providerSelect").value === "demo");
  check("tools panel populated", doc.querySelectorAll("#toolSelect option").length >= 5);
  check("URL list populated", doc.querySelectorAll("#urlList li").length >= 1);
  check("system facts populated", doc.querySelectorAll("#sysFacts div").length >= 5);
  check("security facts populated", doc.querySelectorAll("#secFacts div").length >= 4);
  check("vision panel explains limitation", doc.querySelector("#visionNote").textContent.includes("Configure a vision-capable provider"));

  await waitFor("websocket link", () => doc.querySelector("#factLink").textContent === "live");
  check("live WebSocket link", doc.querySelector("#factLink").textContent === "live");
  check("LINK chip is ok", doc.querySelector("#chipWs").dataset.tone === "ok");

  doc.querySelector("#chatInput").value = "hello";
  doc.querySelector(".send").click();
  await waitFor("chat reply", () => [...doc.querySelectorAll(".bubble.jarvis")].some((node) => node.textContent.includes("DEMO MODE")), 12000);
  check("chat form renders a labelled demo reply", [...doc.querySelectorAll(".bubble.jarvis")].some((node) => node.textContent.includes("DEMO MODE")));

  const toolSelect = doc.querySelector("#toolSelect");
  toolSelect.value = "calculator";
  toolSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
  doc.querySelector("#toolArgs").value = JSON.stringify({ expression: "6*7" });
  doc.querySelector("#toolRun").click();
  await waitFor("calculator output", () => {
    const node = doc.querySelector("#toolResult");
    return !node.hidden && node.textContent.includes("42");
  });
  check("tools panel executes calculator", doc.querySelector("#toolResult").textContent.includes("42"));

  doc.querySelector("#noteTitle").value = "Frontend smoke note";
  doc.querySelector("#noteContent").value = "Created by the jsdom smoke test";
  doc.querySelector("#noteTags").value = "smoke";
  doc.querySelector("#noteForm").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor("note list", () => doc.querySelector("#noteList").textContent.includes("Frontend smoke note"));
  check("memory panel creates a note", doc.querySelector("#noteList").textContent.includes("Frontend smoke note"));
  const noteItem = [...doc.querySelectorAll("#noteList .list-item")].find((node) => node.textContent.includes("Frontend smoke note"));
  noteItem.querySelector("button").click();
  await waitFor("note deletion", () => !doc.querySelector("#noteList").textContent.includes("Frontend smoke note"));
  check("memory panel deletes a note", !doc.querySelector("#noteList").textContent.includes("Frontend smoke note"));

  for (const view of ["memory", "tools", "vision", "system", "chat"]) {
    doc.querySelector(`.rail-btn[data-panel="${view}"]`).click();
    await wait(150);
    check(`panel opens: ${view}`, doc.querySelector(`#sheetBody > section[data-view="${view}"]`).hidden === false);
  }
  doc.querySelector("#sheet .sheet-head .icon-btn").click();
  check("sheet closes", doc.querySelector("#sheet").hidden === true);

  const settings = await import(SETTINGS);
  check("browser backend default is same origin", settings.getBackendUrl() === "");
  const valid = settings.validateBackendUrl("https://jarvis.example:8443/base/");
  check("HTTPS backend URL is accepted and normalised", valid.ok && valid.url === "https://jarvis.example:8443/base");
  check("invalid backend URL is refused", !settings.validateBackendUrl("not a url").ok);
  const previousNative = window.JARVIS_NATIVE_BUILD;
  window.JARVIS_NATIVE_BUILD = true;
  const nativeHttp = settings.validateBackendUrl("http://192.168.1.10:8000");
  const nativeHttps = settings.validateBackendUrl("https://jarvis.example:8000");
  if (previousNative === undefined) delete window.JARVIS_NATIVE_BUILD;
  else window.JARVIS_NATIVE_BUILD = previousNative;
  check("APK refuses plaintext backend URLs", !nativeHttp.ok && /HTTPS/i.test(nativeHttp.error));
  check("APK accepts HTTPS backend URLs", nativeHttps.ok && nativeHttps.url === "https://jarvis.example:8000");
} catch (error) {
  errors.push(error.stack || String(error));
  console.error("HARNESS ERROR:", error);
} finally {
  await wait(300);
  const relevantConsole = consoleErrors.filter((line) => !line.includes("Not implemented"));
  check("no uncaught frontend errors", errors.length === 0, errors.join(" | ").slice(0, 600));
  check("no console errors", relevantConsole.length === 0, relevantConsole.join(" | ").slice(0, 600));
  dom?.window.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await wait(500);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  if (!KEEP && work) await rm(work, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\nRESULT: ${results.length - failed.length} passed, ${failed.length} failed`);
if (KEEP && work) console.log(`Temporary environment kept: ${work}`);
process.exit(failed.length ? 1 : 0);
