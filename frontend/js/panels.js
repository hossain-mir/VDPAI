/* JARVIS AI — sheet panels: memory, tools, vision, system/provider setup. */

import { api, startSession } from "./api.js";
import { getBackendUrl, onBackendUrlChange, setBackendUrl, validateBackendUrl, usesNativeStorage } from "./settings.js";
import * as ui from "./ui.js";

const $ = ui.$;
let ctx = {
  transcript: null,
  voice: null,
  requestApproval: () => {},
  refreshStatus: async () => {},
  reconnectBackend: async () => {},
  disconnectBackend: async () => {},
  clearLocalSettings: async () => {},
  getLanguage: () => "en-US",
  setState: () => {},
};
let providersCache = [];
let toolsCache = [];
let activeProviderId = "demo";
let visionImage = null;
let visionAvailable = false;
let visionMaxMb = 8;
let bound = false;

export function initPanels(context) {
  ctx = { ...ctx, ...context };
  if (bound) return;
  bound = true;
  bindMemory();
  bindTools();
  bindVision();
  bindSystem();
  onBackendUrlChange(syncBackendForm);
  syncBackendForm();
  fillNativeInfo();
  fillAboutInfo();
}

export async function loadPanels() {
  const tasks = [loadMemory(), loadTools(), loadVision(), loadSystem()];
  const results = await Promise.allSettled(tasks);
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length) {
    ui.toast(`Some panels failed to load: ${failed[0].reason?.message || "unknown error"}`, "warn", 6000);
  }
}

/* ------------------------------------------------------------------- memory */
function bindMemory() {
  $("#noteForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = $("#noteTitle").value.trim();
    if (!title) {
      ui.toast("A note needs a title.", "warn");
      return;
    }
    try {
      await api.post("/api/memory/notes", {
        title,
        content: $("#noteContent").value,
        tags: $("#noteTags").value,
      });
      $("#noteForm").reset();
      ui.toast("Note saved to SQLite memory.", "ok");
      await loadMemory();
    } catch (error) {
      ui.toast(error.message, "error");
    }
  });

  $("#memorySearchForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await loadMemory($("#memorySearch").value.trim()).catch((error) => ui.toast(error.message, "error"));
  });

  $("#memoryBackup")?.addEventListener("click", async () => {
    try {
      const data = await api.post("/api/memory/backup");
      ui.toast(`Backup written: ${data.backup}`, "ok", 7000);
    } catch (error) {
      ui.toast(error.message, "error");
    }
  });

  $("#clearHistory")?.addEventListener("click", async () => {
    if (!window.confirm("Delete this conversation from the local database?")) return;
    try {
      await api.del("/api/memory/messages?confirm=yes");
      ctx.transcript?.clear();
      ui.toast("Conversation cleared.", "ok");
      await loadMemory();
    } catch (error) {
      ui.toast(error.message, "error");
    }
  });
}

async function loadMemory(query = "") {
  const params = new URLSearchParams({ limit: "40" });
  if (query) params.set("q", query);
  const data = await api.get(`/api/memory?${params.toString()}`);
  const stats = data.stats || {};
  const size = stats.db_bytes ? `${(stats.db_bytes / 1024).toFixed(0)} KB` : "0 KB";
  const statsNode = $("#memoryStats");
  if (statsNode) {
    statsNode.textContent = `${stats.messages || 0} messages · ${stats.notes || 0} notes · ${size} · ${stats.sessions || 0} sessions`;
  }
  renderNotes(data.notes || []);
  renderMessages(data.messages || []);
}

function renderNotes(notes) {
  const host = $("#noteList");
  if (!host) return;
  host.textContent = "";
  if (!notes.length) {
    host.appendChild(ui.el("p", "hint", "No notes stored yet."));
    return;
  }
  for (const note of notes) {
    const item = ui.el("div", "list-item");
    const head = ui.el("header");
    head.appendChild(ui.el("strong", "", note.title));
    head.appendChild(ui.el("small", "", ui.relativeTime(note.updated_at)));
    item.appendChild(head);
    if (note.content) item.appendChild(ui.el("p", "", note.content));
    if (note.tags) item.appendChild(ui.el("small", "", `#${note.tags}`));
    const actions = ui.el("div", "actions");
    const remove = ui.el("button", "", "Delete");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Delete note "${note.title}"?`)) return;
      try {
        await api.del(`/api/memory/notes/${note.id}`);
        ui.toast("Note deleted.", "ok");
        await loadMemory();
      } catch (error) {
        ui.toast(error.message, "error");
      }
    });
    actions.appendChild(remove);
    item.appendChild(actions);
    host.appendChild(item);
  }
}

function renderMessages(messages) {
  const host = $("#memoryMessages");
  if (!host) return;
  host.textContent = "";
  if (!messages.length) return;
  for (const message of messages) {
    const item = ui.el("div", "list-item");
    const head = ui.el("header");
    head.appendChild(ui.el("strong", "", message.role));
    head.appendChild(ui.el("small", "", ui.relativeTime(message.created_at)));
    item.appendChild(head);
    const body = String(message.content || "");
    item.appendChild(ui.el("p", "", body.length > 420 ? `${body.slice(0, 420)}…` : body));
    host.appendChild(item);
  }
}

/* -------------------------------------------------------------------- tools */
function bindTools() {
  $("#toolRefresh")?.addEventListener("click", () => loadTools().catch((error) => ui.toast(error.message, "error")));
  $("#toolSelect")?.addEventListener("change", onToolChange);
  $("#toolRun")?.addEventListener("click", runTool);
}

function onToolChange() {
  const name = $("#toolSelect")?.value;
  const tool = toolsCache.find((item) => item.name === name);
  if (!tool) return;
  $("#toolArgs").value = argsTemplate(tool);
}

function argsTemplate(tool) {
  const properties = tool.parameters?.properties || {};
  const required = tool.parameters?.required || [];
  const args = {};
  for (const key of required) {
    const spec = properties[key] || {};
    if (spec.type === "string") args[key] = "";
    else if (spec.type === "integer" || spec.type === "number") args[key] = spec.minimum ?? 0;
    else if (spec.type === "boolean") args[key] = false;
    else if (spec.type === "array") args[key] = [];
    else args[key] = "";
  }
  return JSON.stringify(args, null, 2);
}

async function loadTools() {
  const data = await api.get("/api/tools");
  toolsCache = data.tools || [];
  const select = $("#toolSelect");
  if (!select) return;
  const previous = select.value;
  select.textContent = "";
  for (const tool of toolsCache) {
    const option = document.createElement("option");
    option.value = tool.name;
    option.textContent = `${tool.name}${tool.requires_approval ? "  ⚠ approval" : ""}`;
    select.appendChild(option);
  }
  if (previous && toolsCache.some((tool) => tool.name === previous)) select.value = previous;
  else if (toolsCache.length) select.value = toolsCache[0].name;
  onToolChange();
  renderPending(data.pending || []);
}

function renderPending(pending) {
  const host = $("#pendingList");
  if (!host) return;
  host.textContent = "";
  if (!pending.length) {
    host.appendChild(ui.el("p", "hint", "No actions waiting for approval."));
    return;
  }
  for (const action of pending) {
    const item = ui.el("div", "list-item");
    item.appendChild(ui.el("strong", "", action.tool));
    item.appendChild(ui.el("p", "mono small", JSON.stringify(action.args || {})));
    const row = ui.el("div", "actions");
    const review = ui.el("button", "", "Review & approve");
    review.type = "button";
    review.addEventListener("click", () => ctx.requestApproval(action));
    const reject = ui.el("button", "", "Reject");
    reject.type = "button";
    reject.addEventListener("click", async () => {
      try {
        await api.post(`/api/tools/reject/${action.token}`);
        ui.toast("Action rejected.", "ok");
        await loadTools();
      } catch (error) {
        ui.toast(error.message, "error");
      }
    });
    row.append(review, reject);
    item.appendChild(row);
    host.appendChild(item);
  }
}

async function runTool() {
  const tool = $("#toolSelect")?.value;
  if (!tool) return;
  let args;
  try {
    args = JSON.parse($("#toolArgs").value || "{}");
  } catch {
    ui.toast("Arguments must be valid JSON.", "warn");
    return;
  }
  const output = $("#toolResult");
  if (output) {
    output.hidden = false;
    output.textContent = "Executing…";
  }
  ctx.setState("EXECUTING", `tool: ${tool}`);
  try {
    const data = await api.post("/api/tools/execute", { tool, args });
    if (output) output.textContent = JSON.stringify(data.result, null, 2);
    ui.toast(`${tool} finished in ${data.elapsed_ms} ms`, "ok");
  } catch (error) {
    if (output) {
      output.textContent = error.details ? JSON.stringify(error.details, null, 2) : error.message;
    }
    if (error.code === "approval_required" && error.details?.action) ctx.requestApproval(error.details.action);
    else ui.toast(error.message, "error");
  } finally {
    ctx.setState("IDLE", "awaiting command");
    loadTools().catch(() => {});
  }
}

/* ------------------------------------------------------------------- vision */
function bindVision() {
  $("#visionPick")?.addEventListener("click", () => pickImage(false));
  $("#visionCamera")?.addEventListener("click", () => pickImage(true));
  $("#visionAnalyze")?.addEventListener("click", analyzeImage);
}

function pickImage(camera) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  if (camera) input.setAttribute("capture", "environment");
  input.style.display = "none";
  document.body.appendChild(input);
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.remove();
    if (file) handleImageFile(file);
  });
  input.click();
}

function handleImageFile(file) {
  if (!file.type.startsWith("image/")) {
    ui.toast("Choose an image file.", "warn");
    return;
  }
  if (file.size > visionMaxMb * 1024 * 1024) {
    ui.toast(`Image is larger than ${visionMaxMb} MB.`, "warn");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    visionImage = String(reader.result || "");
    const preview = $("#visionPreview");
    if (preview) {
      preview.src = visionImage;
      preview.hidden = false;
      preview.alt = `Selected image: ${file.name}`;
    }
    const button = $("#visionAnalyze");
    if (button) button.disabled = !visionAvailable;
    ui.toast(visionAvailable ? "Image ready for analysis." : "Image loaded, but vision is unavailable.", visionAvailable ? "ok" : "warn");
  };
  reader.onerror = () => ui.toast("Could not read that image.", "error");
  reader.readAsDataURL(file);
}

async function loadVision() {
  const status = await api.get("/api/vision/status");
  visionAvailable = Boolean(status.available);
  visionMaxMb = Number(status.max_image_mb) || 8;
  const note = $("#visionNote");
  if (note) {
    note.textContent = `${status.note} Provider: ${status.provider_label} · ${status.model}. Limit: ${visionMaxMb} MB.`;
  }
  const button = $("#visionAnalyze");
  if (button) button.disabled = !visionAvailable || !visionImage;
}

async function analyzeImage() {
  if (!visionImage) {
    ui.toast("Choose an image first.", "warn");
    return;
  }
  const button = $("#visionAnalyze");
  const output = $("#visionResult");
  if (button) button.disabled = true;
  if (output) {
    output.hidden = false;
    output.textContent = "Analysing image…";
  }
  ctx.setState("THINKING", "vision model processing image");
  try {
    const data = await api.post("/api/vision/analyze", {
      image: visionImage,
      prompt: $("#visionPrompt").value,
      language: ctx.getLanguage(),
    });
    if (output) output.textContent = data.analysis;
    ui.toast(`Vision answered via ${data.model}.`, "ok");
  } catch (error) {
    if (output) output.textContent = error.message;
    ui.toast(error.message, error.status === 501 ? "warn" : "error", 7000);
  } finally {
    if (button) button.disabled = !visionAvailable;
    ctx.setState("IDLE", "awaiting command");
  }
}

/* ------------------------------------------------------------------- system */
/* ------------------------------------------------------- backend connection */
function syncBackendForm() {
  const input = $("#backendUrl");
  if (input && input.value !== getBackendUrl()) input.value = getBackendUrl();
  const hint = $("#backendHint");
  if (hint) {
    hint.textContent = getBackendUrl()
      ? `Saved: ${getBackendUrl()} · stored ${usesNativeStorage() ? "in app-private Android storage" : "in this browser"}.`
      : "No backend configured — the HUD still opens. Same-origin mode is used in a browser.";
  }
}

function backendResult(message, tone = "") {
  const el = $("#backendResult");
  if (!el) return;
  el.textContent = message || "";
  el.dataset.tone = tone;
}

async function saveBackend(event) {
  event?.preventDefault();
  const input = $("#backendUrl");
  const checked = validateBackendUrl(input?.value || "");
  if (!checked.ok) {
    backendResult(checked.error, "warn");
    ui.toast(checked.error, "warn");
    return;
  }
  const changed = checked.url !== getBackendUrl();
  setBackendUrl(checked.url);
  syncBackendForm();
  try {
    await ctx.reconnectBackend();
    const okText = changed ? "Server saved and connected." : "Connection is active.";
    backendResult(checked.warning ? `${okText} ${checked.warning}` : okText, checked.warning ? "warn" : "ok");
    if (checked.warning) ui.toast(checked.warning, "warn", 7000);
    else ui.toast("JARVIS server connected.", "ok");
  } catch (error) {
    backendResult(error.message, "warn");
    ui.toast(error.message, "error", 7000);
  }
}

async function testBackend() {
  const input = $("#backendUrl");
  const checked = validateBackendUrl(input?.value || "");
  if (!checked.ok) {
    backendResult(checked.error, "warn");
    return;
  }
  const previous = getBackendUrl();
  const button = $("#backendTest");
  if (button) button.disabled = true;
  backendResult("Testing connection…");
  try {
    setBackendUrl(checked.url);
    await startSession();
    const status = await api.get("/api/status");
    const label = status?.provider?.label || "demo";
    backendResult(`Connected: ${label} · Python ${status?.runtime?.python || "?"}`, "ok");
    ui.toast("Server replied successfully.", "ok");
  } catch (error) {
    backendResult(`Cannot connect: ${error.message}`, "warn");
    ui.toast(error.message, "error", 7000);
  } finally {
    if (getBackendUrl() !== previous) {
      setBackendUrl(previous);
      if (previous) await startSession().catch(() => {});
      syncBackendForm();
    }
    if (button) button.disabled = false;
  }
}

async function disconnectBackend() {
  await ctx.disconnectBackend();
  backendResult("Disconnected. The saved address is kept; press Connect to resume.", "warn");
}

function clearBackend() {
  setBackendUrl("");
  syncBackendForm();
  backendResult("Saved server cleared. The HUD works offline.");
  ctx.reconnectBackend().catch(() => {});
}

/* ---------------------------------------------------------- device settings */
function permissionResult(message) {
  const el = $("#permissionResult");
  if (el) el.textContent = message;
}

async function checkPermission(kind) {
  const name = kind === "camera" ? "camera" : "microphone";
  try {
    const status = navigator.permissions?.query ? await navigator.permissions.query({ name }) : null;
    permissionResult(`${name}: ${status ? status.state : "permission API unavailable"}.`);
  } catch {
    permissionResult(`${name}: permission status unavailable on this browser.`);
  }
}

async function requestPermission(kind) {
  const constraints = kind === "camera" ? { video: true } : { audio: true };
  const name = kind === "camera" ? "Camera" : "Microphone";
  try {
    const stream = await navigator.mediaDevices?.getUserMedia?.(constraints);
    if (!stream) throw new Error("getUserMedia is not available");
    for (const track of stream.getTracks()) track.stop();
    permissionResult(`${name} access granted.`);
    ui.toast(`${name} permission granted.`, "ok", 2200);
  } catch (error) {
    permissionResult(`${name} access was not granted: ${error.message}`);
    ui.toast(error.message, "warn", 5000);
  }
}

function fillNativeInfo() {
  const cap = window.Capacitor;
  const native = typeof window !== "undefined" && window.JARVIS_NATIVE_BUILD === true;
  ui.fillFacts($("#nativeInfo"), [
    ["Platform", cap?.getPlatform?.() || (native ? "android (bridge)" : "browser")],
    ["Packaged HUD", native ? "yes" : "no"],
    ["Back button", window.JARVIS_NATIVE_BRIDGE ? "native handler active" : "browser default"],
    ["Backend storage", usesNativeStorage() ? "app-private preferences" : "browser local storage"],
    ["Quick tile", native ? "com.jarvis.ai/.JarvisTileService" : "available in APK"],
  ]);
}

async function testNativeBridge() {
  const result = $("#nativeResult");
  const cap = window.Capacitor;
  if (!cap || typeof cap.nativePromise !== "function") {
    if (result) result.textContent = "No native bridge in this browser — expected outside the APK.";
    return;
  }
  if (result) result.textContent = "Contacting native bridge…";
  try {
    const info = await cap.nativePromise("App", "getInfo", {});
    if (result) result.textContent = `Native OK · ${info.platform || "android"} · ${info.osVersion || "?"}`;
    ui.toast("Native bridge responded.", "ok", 2000);
  } catch (error) {
    if (result) result.textContent = `Native bridge error: ${error.message}`;
  }
}

function fillAboutInfo() {
  ui.fillFacts($("#aboutInfo"), [
    ["Name", "J.A.R.V.I.S."],
    ["Version", "1.0 (debug build)"],
    ["Providers", "OpenAI · Gemini · Groq · OpenRouter · Ollama"],
    ["Languages", "English · বাংলা · हिन्दी"],
    ["Interface", "Liquid Glass HUD"],
  ]);
}

async function clearAllLocal() {
  if (!window.confirm("Clear backend URL and all local preferences on this device?")) return;
  await ctx.clearLocalSettings();
  syncBackendForm();
  backendResult("Local settings cleared. The HUD remains open.");
  ui.toast("Local settings cleared.", "ok", 2400);
}

function bindSystem() {
  $("#backendForm")?.addEventListener("submit", saveBackend);
  $("#backendTest")?.addEventListener("click", testBackend);
  $("#backendDisconnect")?.addEventListener("click", disconnectBackend);
  $("#backendClear")?.addEventListener("click", clearBackend);
  $("#providerSelect")?.addEventListener("change", () => syncModelInput(true));
  $("#providerTest")?.addEventListener("click", testProvider);
  $("#providerUse")?.addEventListener("click", useProvider);
  $("#keyForm")?.addEventListener("submit", saveKey);
  $("#keyProvider")?.addEventListener("change", () => fillKeyPlaceholders());
  $("#auditToggle")?.addEventListener("click", toggleAudit);
  $("#statusRefresh")?.addEventListener("click", () => ctx.refreshStatus({ manual: true }));
  $("#permissionMic")?.addEventListener("click", () => requestPermission("microphone"));
  $("#permissionCamera")?.addEventListener("click", () => requestPermission("camera"));
  $("#nativeTest")?.addEventListener("click", testNativeBridge);
  $("#clearLocalData")?.addEventListener("click", clearAllLocal);
}

async function loadSystem() {
  syncBackendForm();
  fillNativeInfo();
  fillAboutInfo();
  try {
    const [status, providers] = await Promise.all([api.get("/api/status"), api.get("/api/providers")]);
    applyStatus(status);
    applyProviders(providers);
    return { status, providers };
  } catch {
    ui.fillFacts($("#sysFacts"), [
      ["Backend", getBackendUrl() || "this page's own origin"],
      ["Status", "offline — configure a reachable HTTPS server"],
    ]);
    return { status: null, providers: null };
  }
}

export function applyStatus(status) {
  if (!status) return;
  const runtime = status.runtime || {};
  const memory = status.memory || {};
  const security = status.security || {};
  const browser = status.browser || {};
  const voice = status.voice || {};

  ui.fillFacts($("#sysFacts"), [
    ["Backend", getBackendUrl() || "this page's own origin"],
    ["Platform", runtime.platform],
    ["Python", runtime.python],
    ["Machine", runtime.machine],
    ["Uptime", ui.formatUptime(runtime.uptime_seconds)],
    ["Active provider", `${(status.provider || {}).label || "demo"} · ${(status.provider || {}).model || "demo"}`],
    ["Fallback", status.provider?.fallback || "none"],
    ["Messages", memory.messages],
    ["Notes", memory.notes],
    ["Tool calls", memory.tool_calls],
    ["Database", memory.db_path],
    ["Playwright", browser.playwright?.available ? "available" : "not installed"],
    ["SSRF private URLs", browser.ssrf_private_allowed ? "allowed" : "blocked"],
  ]);

  ui.fillFacts($("#secFacts"), [
    ["Access token", security.access_token ? "enabled" : "disabled (local only)"],
    ["API rate limit", `${security.rate_limit_per_minute || "—"}/min`],
    ["Chat rate limit", `${security.chat_rate_limit_per_minute || "—"}/min`],
    ["Session TTL", `${security.session_ttl_hours || "—"} h`],
    ["CSRF guard", security.csrf ? "active" : "off"],
    ["Active sessions", security.sessions],
    ["Allowed origins", (security.cors_origins || []).join(", ") || "same origin + private LAN"],
    ["Workspace jail", "workspace/ only"],
  ]);

  const hint = $("#securityHint");
  if (hint) {
    hint.textContent = "Trusted local/LAN access · do not expose publicly without authentication.";
  }

  const urlList = $("#urlList");
  if (urlList) {
    urlList.textContent = "";
    for (const url of status.urls || []) {
      const item = document.createElement("li");
      item.textContent = url;
      urlList.appendChild(item);
    }
  }

  const voiceNote = $("#voiceNote");
  if (voiceNote) {
    const lines = voice.limitations || [];
    voiceNote.textContent = lines.length ? lines.join(" ") : "Microphone requires a secure context (localhost or HTTPS).";
  }

  if (typeof status.vision?.available === "boolean") {
    visionAvailable = Boolean(status.vision.available);
    const button = $("#visionAnalyze");
    if (button) button.disabled = !visionAvailable || !visionImage;
  }

  const wakeToggle = $("#wakeToggle");
  if (wakeToggle && ctx.voice) wakeToggle.checked = Boolean(ctx.voice.wakeEnabled);
}

export function applyProviders(data) {
  if (!data) return;
  providersCache = data.providers || [];
  activeProviderId = data.active?.provider || "demo";
  const select = $("#providerSelect");
  const keySelect = $("#keyProvider");
  if (select) {
    select.textContent = "";
    for (const provider of providersCache) {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = `${provider.label}${provider.configured ? "" : " — not configured"}`;
      select.appendChild(option);
    }
    select.value = activeProviderId;
  }
  if (keySelect) {
    keySelect.textContent = "";
    for (const provider of providersCache) {
      if (provider.id === "demo") continue;
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.label;
      keySelect.appendChild(option);
    }
    keySelect.value = activeProviderId === "demo" ? "openai" : activeProviderId;
  }
  syncModelInput(false);
}

function currentProvider() {
  const id = $("#providerSelect")?.value || activeProviderId;
  return providersCache.find((provider) => provider.id === id) || null;
}

function syncModelInput(userChanged) {
  const provider = currentProvider();
  const modelInput = $("#modelInput");
  const suggestions = $("#modelSuggestions");
  if (!provider || !modelInput) return;
  if (userChanged || !modelInput.value) {
    modelInput.value = provider.id === activeProviderId && provider.active_model ? provider.active_model : provider.default_model || "";
  }
  if (suggestions) {
    suggestions.textContent = "";
    for (const model of provider.models || []) {
      const option = document.createElement("option");
      option.value = model;
      suggestions.appendChild(option);
    }
  }
  fillKeyPlaceholders();
}

function fillKeyPlaceholders() {
  const id = $("#keyProvider")?.value || "openai";
  const provider = providersCache.find((item) => item.id === id);
  if (!provider) return;
  const base = $("#keyBaseUrl");
  const model = $("#keyModel");
  if (base) base.placeholder = provider.base_url || "https://";
  if (model) model.placeholder = provider.default_model || "model name";
}

async function testProvider() {
  const provider = $("#providerSelect")?.value;
  const model = $("#modelInput")?.value.trim();
  const output = $("#providerTestResult");
  if (!provider) return;
  if (output) output.textContent = "Testing connection…";
  try {
    const data = await api.post("/api/providers/test", { provider, model: model || "" });
    const test = data.test || {};
    if (output) {
      output.textContent = test.ok
        ? `OK · ${test.latency_ms} ms · "${test.sample || ""}"`
        : `Failed: ${test.error || "unknown error"}`;
    }
    ui.toast(test.ok ? `${provider} responded in ${test.latency_ms} ms.` : `${provider} failed: ${test.error}`, test.ok ? "ok" : "error", 6000);
  } catch (error) {
    if (output) output.textContent = error.message;
    ui.toast(error.message, "error");
  }
}

async function useProvider() {
  const provider = $("#providerSelect")?.value;
  const model = $("#modelInput")?.value.trim();
  if (!provider) return;
  try {
    const data = await api.post("/api/providers/select", { provider, model: model || "" });
    ui.toast(`Active provider: ${data.selection.label} · ${data.selection.model}`, "ok");
    await loadSystem();
    await ctx.refreshStatus();
  } catch (error) {
    ui.toast(error.message, "error");
  }
}

async function saveKey(event) {
  event.preventDefault();
  const provider = $("#keyProvider")?.value;
  const payload = { provider };
  const key = $("#keyValue")?.value.trim();
  const base = $("#keyBaseUrl")?.value.trim();
  const model = $("#keyModel")?.value.trim();
  if (key) payload.api_key = key;
  if (base) payload.base_url = base;
  if (model) payload.model = model;
  if (Object.keys(payload).length === 1) {
    ui.toast("Enter a key, base URL or model first.", "warn");
    return;
  }
  try {
    const data = await api.post("/api/providers/config", payload);
    const result = $("#keyResult");
    if (result) {
      result.textContent = `Saved ${provider}. Key stored: ${data.saved.key_set ? "yes" : "no"}. Test the connection, then press "Use provider".`;
    }
    $("#keyValue").value = "";
    ui.toast("Configuration saved to the server .env.", "ok");
    await loadSystem();
  } catch (error) {
    ui.toast(error.message, "error");
  }
}

let auditOpen = false;

async function toggleAudit() {
  const output = $("#auditLog");
  const button = $("#auditToggle");
  auditOpen = !auditOpen;
  if (!auditOpen) {
    if (output) output.hidden = true;
    if (button) button.textContent = "Show audit log";
    return;
  }
  if (button) button.textContent = "Hide audit log";
  try {
    const data = await api.get("/api/audit?limit=50");
    if (output) {
      output.hidden = false;
      output.textContent = (data.entries || [])
        .map((entry) => `${entry.ts}  ${entry.ok ? "OK  " : "FAIL"}  ${entry.action}${entry.tool ? ` [${entry.tool}]` : ""}  ${entry.ip || ""}\n  ${JSON.stringify(entry.detail || {})}`)
        .join("\n");
    }
  } catch (error) {
    ui.toast(error.message, "error");
    auditOpen = false;
    if (button) button.textContent = "Show audit log";
  }
}
