#!/usr/bin/env node
/* HSAI 2.0 — real HUD smoke test in jsdom.
 *
 * It loads frontend/index.html, imports the actual app modules, and drives the
 * actual DOM handlers. Fetch is mocked only at the network boundary, so the
 * provider request, SSE parsing, persistence and UI updates are all real code.
 *
 * Verified here: immediate HUD boot, provider add/test/select, masked key,
 * conversation send/stream/persist, history rename/search/delete, appearance,
 * optional backend test/disconnect/clear, and honest voice-unavailable states.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STORE_MODULE = pathToFileURL(join(ROOT, "frontend/js/store.js")).href;
const APP_MODULE = pathToFileURL(join(ROOT, "frontend/js/app.js")).href;

const failures = [];
let passed = 0;
const domErrors = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function waitFor(predicate, label, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function submit(form, window) {
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/* ------------------------------------------------------------ browser harness */
const html = readFileSync(join(ROOT, "frontend/index.html"), "utf8");
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => domErrors.push(error?.message || String(error)));
const dom = new JSDOM(html, {
  url: "http://localhost/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;
const { document } = window;

window.matchMedia = () => ({
  matches: false,
  media: "",
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const gradient = { addColorStop() {} };
const context2d = new Proxy(
  {},
  {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return () => ({ width: 10 });
      return () => gradient;
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  },
);
window.HTMLCanvasElement.prototype.getContext = () => context2d;
window.HSAI_DEFAULT_BACKEND_URL = "";
window.HSAI_NATIVE_BUILD = false;

const trackedIntervals = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (callback, ms) => {
  const timer = realSetInterval(callback, ms);
  timer.unref?.();
  trackedIntervals.push(timer);
  return timer;
};

globalThis.window = window;
globalThis.document = document;
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Event = window.Event;
globalThis.requestAnimationFrame = (callback) => window.requestAnimationFrame(callback);
globalThis.cancelAnimationFrame = (handle) => window.cancelAnimationFrame(handle);

process.on("unhandledRejection", (error) => {
  domErrors.push(`unhandled rejection: ${error?.message || error}`);
});
process.on("uncaughtException", (error) => {
  domErrors.push(`uncaught exception: ${error?.message || error}`);
});

/* --------------------------------------------------------------- fetch router */
const requests = [];
let healthCalls = 0;

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(init.body) : null;
  requests.push({ url, init, body });

  if (url.endsWith("/api/health")) {
    healthCalls += 1;
    return jsonResponse({ status: "healthy", app: "HSAI 2.0" });
  }
  if (url === "https://api.openai.com/v1/chat/completions") {
    if (body?.stream) {
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"from the real HUD."}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    }
    return jsonResponse({ choices: [{ message: { content: "OK" } }] });
  }
  throw new Error(`Unexpected fetch in smoke test: ${url}`);
};
window.fetch = globalThis.fetch;

/* ------------------------------------------------------------------- app boot */
await import(APP_MODULE);
if (document.readyState === "loading") {
  document.dispatchEvent(new window.Event("DOMContentLoaded"));
}
await waitFor(() => window.HSAI_READY === true, "HSAI boot");

check("HUD opens directly without a startup screen", !document.getElementById("app").hidden && !document.getElementById("bootBackendForm"));
check("provider starts unconfigured", document.getElementById("chipProvider").textContent.includes("NO API"));
check("voice is reported unavailable, not faked", document.getElementById("chipVoice").textContent.includes("TTS N/A"));
check("backend starts optional/offline", document.getElementById("chipBackend").textContent.includes("OFFLINE"));
check("empty conversation state renders", document.getElementById("responseText").textContent.includes("VDPAI is ready") || document.getElementById("responseText").textContent.includes("HSAI 2.0 is ready"));

/* -------------------------------------------------------- provider add/edit/test */
document.getElementById("controlBtn").click();
check("Control Center opens", !document.getElementById("controlCenter").hidden);
document.getElementById("addProviderBtn").click();
check("provider editor opens", !document.getElementById("providerModal").hidden);

const typeSelect = document.getElementById("providerType");
typeSelect.value = "openai";
typeSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
check("provider type fills real defaults", document.getElementById("providerBase").value === "https://api.openai.com/v1");
check("API key field is masked by default", document.getElementById("providerKey").type === "password");

document.getElementById("providerName").value = "Test OpenAI";
document.getElementById("providerKey").value = "sk-test-secret-123";
document.getElementById("providerModel").value = "gpt-4o-mini";
submit(document.getElementById("providerForm"), window);
await waitFor(() => document.getElementById("providerModal").hidden, "provider save");

const storedAfterAdd = JSON.parse(window.localStorage.getItem("hsai.store.v2") || "{}");
check("provider persists locally", storedAfterAdd.providers?.[0]?.name === "Test OpenAI");
check("API key is stored app-side, never in the UI list", storedAfterAdd.providers?.[0]?.apiKey === "sk-test-secret-123");
check("provider appears in the provider list", document.getElementById("providerList").textContent.includes("Test OpenAI"));
check("active provider chip updates", document.getElementById("chipProvider").textContent.includes("TEST OPENAI"));

const testButton = [...document.querySelectorAll("#providerList .provider-actions button")].find(
  (button) => button.textContent === "Test",
);
testButton.click();
await waitFor(
  () => document.querySelector("#providerList .provider-status")?.textContent.includes("Connected"),
  "provider connection test",
);
const testRequest = requests.find((request) => request.url === "https://api.openai.com/v1/chat/completions");
check("provider test performs a real request", Boolean(testRequest));
check("provider test sends the saved key", testRequest?.init?.headers?.Authorization === "Bearer sk-test-secret-123");
check("provider test uses the configured model", testRequest?.body?.model === "gpt-4o-mini");
check("provider test reports the actual sample", document.querySelector("#providerList .provider-status").textContent.includes("OK"));

document.getElementById("ccClose").click();
check("Control Center closes back to the HUD", document.getElementById("controlCenter").hidden);

/* ------------------------------------------------------------------ chat + SSE */
const chatInput = document.getElementById("chatInput");
chatInput.value = "Hello HSAI";
submit(document.getElementById("chatForm"), window);
await waitFor(() => window.HSAI.getState().busy === false && document.getElementById("responseText").textContent.includes("real HUD"), "streamed answer");

check("assistant answer is rendered", document.getElementById("responseText").textContent === "Hello from the real HUD.");
check("answer metadata names provider and model", document.getElementById("responseMeta").textContent.includes("Test OpenAI"));
check("user and assistant bubbles are present", document.querySelectorAll("#transcript .bubble.user").length === 1 && document.querySelectorAll("#transcript .bubble.assistant").length === 1);
check("no fake TTS error is added to the transcript", document.querySelectorAll("#transcript .bubble.error").length === 0);
check("response status becomes ready", document.getElementById("responseStatus").textContent.includes("ANSWER READY"));

const storedAfterChat = JSON.parse(window.localStorage.getItem("hsai.store.v2") || "{}");
const savedConversation = storedAfterChat.conversations?.[0];
check("conversation is persisted", Boolean(savedConversation));
check("auto title comes from the first message", savedConversation?.title === "Hello HSAI");
check("both messages are persisted in order", savedConversation?.messages?.map((message) => message.role).join(",") === "user,assistant");
const streamRequest = requests.filter((request) => request.url === "https://api.openai.com/v1/chat/completions" && request.body?.stream).at(-1);
check("chat request enables real SSE streaming", streamRequest?.body?.stream === true);
check("chat request includes the system prompt", streamRequest?.body?.messages?.[0]?.role === "system");

/* ------------------------------------------------------- persistence after reload */
function restoreChild(mode, raw) {
  const code = [
    "const document = { addEventListener() {}, hidden: false };",
    "globalThis.document = document;",
    `const initial = ${JSON.stringify(raw)};`,
    "let saved = initial;",
    `if (${JSON.stringify(mode)} === "native") {`,
    "  globalThis.window = {",
    "    HSAI_NATIVE_BUILD: true,",
    '    HSAI_DEFAULT_BACKEND_URL: "",',
    "    addEventListener() {},",
    "    Capacitor: {",
    "      nativePromise: async (_plugin, method, options) => {",
    '        if (method === "get") return { value: saved || "" };',
    "        if (method === \"set\") { saved = options.value; return {}; }",
    "        if (method === \"remove\") { saved = \"\"; return {}; }",
    '        throw new Error("Unexpected Preferences method " + method);',
    "      },",
    "    },",
    "  };",
    "} else {",
    "  globalThis.window = { HSAI_NATIVE_BUILD: false, HSAI_DEFAULT_BACKEND_URL: \"\", addEventListener() {} };",
    "  globalThis.localStorage = {",
    "    getItem(key) { return key === 'hsai.store.v2' ? saved : null; },",
    "    setItem(key, value) { if (key === 'hsai.store.v2') saved = value; },",
    "    removeItem(key) { if (key === 'hsai.store.v2') saved = ''; },",
    "  };",
    "}",
    `const store = await import(${JSON.stringify(STORE_MODULE)});`,
    "await store.initStore();",
    "const provider = store.getActiveProvider();",
    "const conversation = store.getConversations()[0];",
    "store.updateSettings({ theme: 'violet' });",
    "await store.saveNow();",
    "console.log(JSON.stringify({",
    "  native: store.usesNativeStorage(),",
    "  provider: provider?.name || '',",
    "  title: conversation?.title || '',",
    "  messages: conversation?.messages?.length || 0,",
    "  saved: saved.includes('\"theme\":\"violet\"'),",
    "}));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 15000,
  });
  if (result.status !== 0) throw new Error(result.stderr || "restore child failed");
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

const localRestore = restoreChild("local", storedAfterChat && JSON.stringify(storedAfterChat));
check("local storage restores provider and conversation", localRestore.provider === "Test OpenAI" && localRestore.title === "Hello HSAI" && localRestore.messages === 2);
check("local storage save path works", localRestore.saved === true);
const nativeRestore = restoreChild("native", JSON.stringify(storedAfterChat));
check("native Preferences restore works", nativeRestore.native === true && nativeRestore.provider === "Test OpenAI" && nativeRestore.messages === 2);
check("native Preferences save works", nativeRestore.saved === true);

/* ---------------------------------------------------------------- voice honesty */
document.getElementById("replayBtn").click();
await waitFor(
  () => [...document.querySelectorAll("#toasts .toast")].some((toast) => toast.textContent.includes("Voice output is unavailable")),
  "voice unavailable toast",
);
check("replay never fakes speech", document.getElementById("responseStatus").textContent !== "SPEAKING");
document.getElementById("micBtn").click();
await waitFor(() => [...document.querySelectorAll("#toasts .toast")].some((toast) => /Speech recognition is not available|Voice input is unavailable/.test(toast.textContent)), "mic unavailable toast");
check("microphone failure is surfaced honestly", document.getElementById("chipMic").textContent.includes("MIC N/A"));

/* -------------------------------------------------------------------- history */
document.getElementById("historyBtn").click();
await waitFor(() => !document.getElementById("historySheet").hidden, "history sheet");
check("history lists the saved conversation", document.querySelectorAll("#historyList .history-item").length === 1);

const renameButton = [...document.querySelectorAll("#historyList .history-actions button")].find((button) => button.textContent === "Rename");
renameButton.click();
await waitFor(() => !document.getElementById("promptModal").hidden, "rename prompt");
document.getElementById("promptInput").value = "Renamed conversation";
submit(document.getElementById("promptForm"), window);
await waitFor(() => document.getElementById("promptModal").hidden, "rename save");
check("conversation rename persists", document.getElementById("historyList").textContent.includes("Renamed conversation"));

const search = document.getElementById("historySearch");
search.value = "Renamed";
search.dispatchEvent(new window.Event("input", { bubbles: true }));
check("history search matches the title", document.querySelectorAll("#historyList .history-item").length === 1);
search.value = "no-such-conversation";
search.dispatchEvent(new window.Event("input", { bubbles: true }));
check("empty search result is shown", document.querySelector("#historyList .history-empty")?.textContent.includes("No conversation"));
search.value = "";
search.dispatchEvent(new window.Event("input", { bubbles: true }));

const deleteButton = [...document.querySelectorAll("#historyList .history-actions button")].find((button) => button.textContent === "Delete");
deleteButton.click();
await waitFor(() => !document.getElementById("confirmModal").hidden, "delete confirmation");
check("destructive delete asks for confirmation", document.getElementById("confirmText").textContent.includes("permanently"));
document.getElementById("confirmOk").click();
await waitFor(() => document.getElementById("confirmModal").hidden, "delete completion");
await waitFor(() => document.querySelector("#historyList .history-empty"), "empty history");
const storedAfterDelete = JSON.parse(window.localStorage.getItem("hsai.store.v2") || "{}");
check("conversation deletion persists", storedAfterDelete.conversations.length === 0);
check("HUD clears the deleted active conversation", document.getElementById("responseText").textContent.includes("VDPAI is ready") || document.getElementById("responseText").textContent.includes("HSAI 2.0 is ready"));
document.getElementById("historyClose").click();

/* ----------------------------------------------------------------- appearance */
document.getElementById("controlBtn").click();
document.querySelector('#ccTabs [data-tab="appearance"]').click();
const glow = document.getElementById("lowGlowToggle");
glow.checked = true;
glow.dispatchEvent(new window.Event("change", { bubbles: true }));
check("low-glow mode applies and persists", document.body.classList.contains("low-glow") && window.HSAI.getState().settings.lowGlow === true);

const theme = document.getElementById("themeSelect");
theme.value = "violet";
theme.dispatchEvent(new window.Event("change", { bubbles: true }));
check("accent theme applies", document.body.dataset.theme === "violet");

const motion = document.getElementById("reduceMotionToggle");
motion.checked = true;
motion.dispatchEvent(new window.Event("change", { bubbles: true }));
const grid = document.getElementById("gridToggle");
grid.checked = false;
grid.dispatchEvent(new window.Event("change", { bubbles: true }));
check("reduced motion and grid controls apply", document.body.classList.contains("reduce-motion") && document.body.classList.contains("no-grid"));

/* -------------------------------------------------------------------- backend */
document.querySelector('#ccTabs [data-tab="backend"]').click();
const backendUrl = document.getElementById("backendUrl");
backendUrl.value = "http://localhost:8000";
const beforeInvalid = healthCalls;
submit(document.getElementById("backendForm"), window);
await waitFor(() => document.getElementById("backendResult").textContent.includes("localhost"), "localhost rejection");
check("localhost backend is rejected with an explanation", healthCalls === beforeInvalid);

backendUrl.value = "https://server.example.test";
document.getElementById("backendTestBtn").click();
await waitFor(() => document.getElementById("backendResult").textContent.includes("Connected"), "optional backend test");
check("optional backend test uses the real health endpoint", requests.some((request) => request.url === "https://server.example.test/api/health"));
check("backend online state is real", document.getElementById("chipBackend").textContent.includes("BACKEND ON"));

document.getElementById("backendDisconnectBtn").click();
check("disconnect updates the HUD without deleting the URL", document.getElementById("chipBackend").textContent.includes("OFFLINE") && window.HSAI.getState().settings.backendUrl === "https://server.example.test");

document.getElementById("backendClearBtn").click();
await waitFor(() => !document.getElementById("confirmModal").hidden, "clear URL confirmation");
document.getElementById("confirmOk").click();
await waitFor(() => window.HSAI.getState().settings.backendUrl === "", "backend URL cleared");
check("clear URL persists an empty backend", document.getElementById("backendUrl").value === "");

/* ----------------------------------------------------------------- voice setting */
document.querySelector('#ccTabs [data-tab="voice"]').click();
const tts = document.getElementById("ttsToggle");
tts.checked = false;
tts.dispatchEvent(new window.Event("change", { bubbles: true }));
check("spoken replies toggle persists", window.HSAI.getState().settings.ttsEnabled === false && document.getElementById("chipVoice").textContent.includes("VOICE OFF"));
tts.checked = true;
tts.dispatchEvent(new window.Event("change", { bubbles: true }));
document.getElementById("ccClose").click();

/* ------------------------------------------------------------- new conversation */
document.getElementById("newChatBtn").click();
await waitFor(() => document.getElementById("responseText").textContent.includes("New conversation ready"), "new conversation");
const storedNew = JSON.parse(window.localStorage.getItem("hsai.store.v2") || "{}");
check("new conversation is empty and persistent", storedNew.conversations.length === 1 && storedNew.conversations[0].messages.length === 0);

/* ---------------------------------------------------------------------- finish */
await delay(220);
check("runtime produced no uncaught errors", domErrors.length === 0, domErrors.join(" | "));
for (const timer of trackedIntervals) clearInterval(timer);
window.close();

console.log();
if (failures.length) {
  console.error(`RESULT: ${passed} passed, ${failures.length} failed.`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`RESULT: all ${passed} HUD smoke checks passed.`);
process.exit(0);
