#!/usr/bin/env node
/* JARVIS AI — offline startup smoke test.
 *
 * Loads the real HUD with a fetch stub that always fails. The app must still
 * open, render the Liquid Glass HUD and show an OFFLINE backend indicator.
 */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = pathToFileURL(path.join(ROOT, "frontend/js/app.js")).href;
const results = [];
const errors = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

class DeadWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor() {
    this.readyState = DeadWebSocket.CLOSED;
  }
  close() {}
}

let dom = null;
async function main() {
  const html = readFileSync(path.join(ROOT, "frontend/index.html"), "utf8");
  dom = new JSDOM(html, { url: "https://offline.test/", pretendToBeVisual: true });
  const window = dom.window;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  window.HTMLCanvasElement.prototype.getContext = () => fakeContext();
  window.confirm = () => false;
  window.addEventListener("error", (event) => errors.push(event.message));
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
  process.on("unhandledRejection", (reason) => errors.push(String(reason)));
  process.on("uncaughtException", (error) => errors.push(error.stack || String(error)));

  // Simulate the Capacitor bridge injected into the Android WebView.
  const nativeCalls = [];
  window.JARVIS_NATIVE_BUILD = true;
  window.Capacitor = {
    isNativePlatform: () => true,
    nativeCallback: () => {},
    nativePromise: async (plugin, method) => {
      nativeCalls.push(`${plugin}.${method}`);
      if (plugin === "Preferences" && method === "get") {
        return { value: "https://native.example:8443" };
      }
      return {};
    },
  };

  for (const key of ["window", "document", "navigator", "location", "localStorage", "HTMLElement", "Event", "CustomEvent", "Node"]) {
    try {
      globalThis[key] = window[key] ?? globalThis[key];
    } catch {
      Object.defineProperty(globalThis, key, { value: window[key] ?? globalThis[key], configurable: true });
    }
  }
  globalThis.WebSocket = DeadWebSocket;
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame;

  await import(APP);
  await wait(1200);

  const doc = window.document;
  check("HUD opens without a backend", doc.querySelector("#app").hidden === false);
  check("no mandatory backend form", doc.querySelector("#bootBackendForm") === null);
  check("backend indicator shows OFFLINE", doc.querySelector("#backendStatusText")?.textContent === "OFFLINE");
  check("core is rendered", doc.querySelector("#stateText")?.textContent === "IDLE");
  check("offline guidance is shown", doc.querySelector("#transcript")?.textContent.includes("CORE ONLINE"));
  check("settings remain accessible", !!doc.querySelector('[data-panel="system"]'));
  check(
    "backend settings usable offline",
    !!doc.getElementById("backendForm") && !!doc.getElementById("backendDisconnect") && !!doc.getElementById("backendUrl"),
  );

  const settings = await import(pathToFileURL(path.join(ROOT, "frontend/js/settings.js")).href);
  check("native backend URL is loaded", settings.getBackendUrl() === "https://native.example:8443");
  check(
    "native Preferences is used through the bridge",
    settings.usesNativeStorage() && nativeCalls.includes("Preferences.get"),
  );
  settings.setBackendUrl("https://native.example:9443");
  await wait(30);
  check(
    "native Preferences saves the URL",
    nativeCalls.includes("Preferences.set") && settings.getBackendUrl() === "https://native.example:9443",
  );
  await settings.clearBackendUrl();
  check("native Preferences clears the URL", nativeCalls.includes("Preferences.remove"));

  check("no uncaught errors", errors.length === 0, errors.join(" | ").slice(0, 500));
}

try {
  await main();
} catch (error) {
  check("harness completed", false, error.stack || String(error));
} finally {
  await wait(200);
  dom?.window.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\nRESULT: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
