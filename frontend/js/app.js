/* JARVIS AI — application bootstrap and interaction wiring. */

// No-op in the browser; registers Android back-button handling in the APK.
import "./native.js";

import { startSession, api, chat, voiceTurn, EventStream, session } from "./api.js";
import { initSettings, getBackendUrl, clearBackendUrl } from "./settings.js";
import { uiState } from "./state.js";
import { CoreRenderer } from "./core.js";
import { Waveform } from "./wave.js";
import { VoiceEngine } from "./voice.js";
import { initPanels, loadPanels, applyStatus } from "./panels.js";
import * as ui from "./ui.js";

const $ = ui.$;
const $$ = ui.$$;

const LS = {
  lang: "jarvis.lang",
  tts: "jarvis.tts",
  wake: "jarvis.wake",
  motion: "jarvis.reduceMotion",
  glow: "jarvis.lowGlow",
};
const DEFAULT_STATUS = {
  provider: { label: "demo", model: "demo", demo: true },
  runtime: {},
  memory: {},
  security: {},
  browser: {},
  voice: {},
  urls: [],
};
const app = {
  config: null,
  status: DEFAULT_STATUS,
  busy: false,
  entered: false,
  attached: null,
  approval: null,
  approvals: new Set(),
  stream: null,
  lastResponse: null,
  retryTimer: null,
  retryDelay: 4000,
  paused: false,
};

let core = null;
let wave = null;
let voice = null;
let transcript = null;
const approvalQueue = [];

function stored(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

function language() {
  return $("#langSelect")?.value || stored(LS.lang, "en-US");
}

/* ------------------------------------------------------------------ bootstrap */
function nativeBuild() {
  return typeof window !== "undefined" && window.JARVIS_NATIVE_BUILD === true;
}

/** Small, always-visible backend indicator inside the HUD. */
function setBackendState(state, detail = "") {
  const labels = { checking: "CONNECTING", online: "ONLINE", local: "LOCAL", offline: "OFFLINE" };
  const tones = { checking: "warn", online: "ok", local: "ok", offline: "bad" };
  const label = labels[state] || "OFFLINE";
  const pill = $("#backendStatus");
  if (pill) {
    pill.dataset.tone = tones[state] || "bad";
    const text = $("#backendStatusText");
    if (text) text.textContent = label;
    pill.title = detail || label;
  }
  ui.setChip("chipBackend", tones[state] || "bad", label);
}

function scheduleBackendRetry() {
  if (app.paused || app.retryTimer) return;
  app.retryTimer = setTimeout(async () => {
    app.retryTimer = null;
    if (app.paused || !app.entered || document.hidden) {
      app.retryDelay = 4000;
      return;
    }
    await connectBackend({ silent: true });
    app.retryDelay = Math.min(app.retryDelay * 1.8, 30000);
  }, app.retryDelay);
}

/** Handshake + status refresh. The HUD is already visible when this runs. */
async function connectBackend({ silent = false, force = false } = {}) {
  if (app.paused && !force) return false;
  app.paused = false;
  try {
    await startSession();
    const [configResponse, statusResponse] = await Promise.all([api.get("/api/config"), api.get("/api/status")]);
    app.config = configResponse.config || {};
    app.status = statusResponse || DEFAULT_STATUS;
    applyStatus(app.status);
    updateChips(app.status);
    applyFacts(app.status);
    setBackendState(getBackendUrl() ? "online" : "local", getBackendUrl() || "same origin");
    connectStream();
    await loadPanels();
    if (app.retryTimer) {
      clearTimeout(app.retryTimer);
      app.retryTimer = null;
    }
    app.retryDelay = 4000;
    if (!silent) ui.toast("Backend connected.", "ok", 2200);
    return true;
  } catch (error) {
    setBackendState("offline", error?.message || "backend unavailable");
    if (!silent) handleError(error);
    scheduleBackendRetry();
    return false;
  }
}

/** Rebind after the owner changes the server in System → Backend server. */
async function reconnectBackend() {
  const ok = await connectBackend({ silent: true, force: true });
  if (!ok) throw new Error("The backend did not respond. The address was saved; try again when it is online.");
  transcript?.add("system", `BACKEND RECONNECTED · ${getBackendUrl() || "same origin"}`);
}

/** Stop talking to the backend without deleting the saved address. */
function disconnectBackend() {
  app.paused = true;
  if (app.retryTimer) {
    clearTimeout(app.retryTimer);
    app.retryTimer = null;
  }
  app.stream?.close();
  app.stream = null;
  setBackendState("offline", "disconnected — press Connect to resume");
  uiState.set("IDLE", "backend disconnected");
  transcript?.add("system", "BACKEND DISCONNECTED · HUD stays available; press Connect in System → Backend server.");
  return true;
}

/** Restore local preferences (non-secret UI choices) and the backend URL. */
async function resetLocalSettings() {
  for (const key of Object.values(LS)) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
  await clearBackendUrl();
  app.paused = false;
  document.body.classList.remove("reduce-motion", "low-glow");
  applyAppearance();
  syncPreferenceUi();
  return connectBackend({ silent: true });
}

async function boot() {
  await initSettings();
  await enter();
  await connectBackend({ silent: true });
}

function hideBoot() {
  // Kept for callers/tests; the startup overlay no longer exists.
}

async function enter() {
  if (app.entered || app.entering) return;
  app.entering = true;
  try {
    app.status = DEFAULT_STATUS;
    $("#app").hidden = false;
    uiState.bind($("#stateText"), $("#stateDetail"));
    core = new CoreRenderer($("#coreCanvas"));
    wave = new Waveform($("#waveCanvas"), { getLevel: () => (voice ? voice.level() : 0) });
    transcript = new ui.Transcript($("#transcript"), $("#fullTranscript"));
    uiState.on((state) => {
      core?.setState(state);
      wave?.setState(state);
    });

    initVoice();
    initPanels({
      transcript,
      voice,
      requestApproval,
      refreshStatus: (options) => refreshStatus(options),
      reconnectBackend: () => reconnectBackend(),
      disconnectBackend: () => disconnectBackend(),
      clearLocalSettings: () => resetLocalSettings(),
      getLanguage: language,
      setState: (state, detail) => uiState.set(state, detail),
    });
    wireInteractive();
    syncPreferenceUi();
    setBackendState(getBackendUrl() ? "checking" : "offline");

    applyStatus(app.status);
    updateChips(app.status);
    applyFacts(app.status);
    transcript.add(
      "system",
      "CORE ONLINE · HUD ready offline · configure a backend in System when available",
    );

    bootStatus();

    if (!voice.available) {
      const button = $("#micBtn");
      if (button) {
        button.disabled = true;
        button.title = voice.unsupportedReason();
      }
      transcript.add("system", voice.unsupportedReason());
    }
    app.entered = true;
    hideBoot();
  } finally {
    app.entering = false;
  }
}

function bootStatus() {
  refreshStatus({ silent: true });
  setInterval(() => {
    if (!document.hidden) refreshStatus({ silent: true });
  }, 30000);
}

/* ---------------------------------------------------------------- voice wiring */
function initVoice() {
  const ttsEnabled = stored(LS.tts, "1") === "1";
  voice = new VoiceEngine({
    getLanguage: language,
    ttsEnabled,
    onPartial: (text) => {
      const input = $("#chatInput");
      if (input) input.value = text;
    },
    onFinal: (text) => {
      const input = $("#chatInput");
      if (input) input.value = "";
      handleVoiceCommand(text);
    },
    onError: (message) => {
      ui.toast(message, "error", 8000);
      transcript?.add("system", message);
      uiState.set("ERROR", message.slice(0, 90));
      setTimeout(() => {
        if (!app.busy && !voice?.isSpeaking) uiState.set("IDLE", "awaiting command");
      }, 3500);
    },
    onState: (state, detail) => {
      if (state === "IDLE" && (app.busy || voice?.isSpeaking)) return;
      uiState.set(state, detail);
    },
    onListening: (listening) => {
      const button = $("#micBtn");
      button?.setAttribute("aria-pressed", String(listening));
    },
  });
  voice.setTtsEnabled(ttsEnabled);
}

async function handleVoiceCommand(text) {
  if (!text) return;
  const command = text.trim();
  // Local commands work even when the backend is offline.
  if (/^(stop|stop speaking|cancel|shut up)[.,!?\s]*$/i.test(command)) {
    voice?.cancelSpeech();
    voice?.stopListening({ keepWake: true });
    uiState.set("IDLE", "speech stopped");
    transcript.add("system", "Speech stopped.");
    return;
  }
  if (/^(repeat|repeat that|say that again)[.,!?\s]*$/i.test(command)) {
    if (app.lastResponse && voice?.ttsAvailable && stored(LS.tts, "1") === "1") {
      voice.speak(app.lastResponse, language());
    } else {
      ui.toast("No previous reply to repeat.", "warn");
    }
    return;
  }
  if (app.busy) {
    ui.toast("Core is busy — voice command ignored.", "warn");
    return;
  }
  await send(command, { source: "voice" });
}

/* ----------------------------------------------------------------------- send */
async function send(raw, { source = "text" } = {}) {
  const message = String(raw || "").trim();
  if (!message) return;
  if (app.busy) {
    ui.toast("Wait for the current response to finish.", "warn");
    return;
  }
  app.busy = true;
  transcript.add("user", message, source === "voice" ? "voice" : "");
  uiState.set("THINKING", source === "voice" ? "interpreting voice command" : "reasoning");

  const images = source === "text" && app.attached ? [app.attached.dataUrl] : null;
  clearAttachment();

  try {
    const response =
      source === "voice"
        ? await voiceTurn({ transcript: message, language: language() })
        : await chat(images ? { message, language: language(), images } : { message, language: language() });
    renderResponse(response);
  } catch (error) {
    handleError(error);
  } finally {
    app.busy = false;
    if (!voice?.isSpeaking && uiState.current === "THINKING") uiState.set("IDLE", "awaiting command");
    refreshStatus({ silent: true });
    loadPanels().catch(() => {});
    if (voice?.wakeEnabled && !voice?.isSpeaking) {
      setTimeout(() => voice?.resumeWake?.(), 500);
    }
  }
}

function renderResponse(response) {
  const meta = `${response.provider_label || response.provider} · ${response.model}${response.demo ? " · demo" : ""}`;
  app.lastResponse = response.reply || "";
  transcript.add("jarvis", response.reply, meta);

  if (Array.isArray(response.actions) && response.actions.length) {
    const summary = response.actions
      .map((action) => `${action.ok ? "✓" : "✕"} ${action.tool}${action.summary ? `: ${action.summary}` : ""}`)
      .join("\n");
    transcript.add("system", summary);
  }

  for (const action of response.pending_approvals || []) requestApproval(action);

  if (response.reply && stored(LS.tts, "1") === "1" && voice?.ttsAvailable) {
    voice.speak(response.reply, response.language || language());
  }
}

/* ----------------------------------------------------------------- approvals */
function requestApproval(action) {
  if (!action || !action.token || app.approvals.has(action.token)) return;
  app.approvals.add(action.token);
  approvalQueue.push(action);
  if (!app.approval) showNextApproval();
}

function showNextApproval() {
  const next = approvalQueue.shift();
  if (!next) {
    app.approval = null;
    return;
  }
  app.approval = next;
  ui.showApproval(next);
}

async function resolveApproval(approve) {
  const action = app.approval;
  if (!action) return;
  const approveButton = $("#approveBtn");
  const rejectButton = $("#rejectBtn");
  approveButton.disabled = true;
  rejectButton.disabled = true;
  ui.hideApproval();
  uiState.set("EXECUTING", `tool: ${action.tool}`);
  try {
    if (approve) {
      const data = await api.post(`/api/tools/approve/${action.token}`, {});
      transcript.add("system", `APPROVED · ${action.tool}\n${data.summary || "completed"}`);
      ui.toast(`${action.tool} completed.`, "ok");
    } else {
      await api.post(`/api/tools/reject/${action.token}`, {});
      transcript.add("system", `CANCELLED · ${action.tool}`);
      ui.toast("Action cancelled.", "");
    }
  } catch (error) {
    handleError(error);
  } finally {
    approveButton.disabled = false;
    rejectButton.disabled = false;
    app.approvals.delete(action.token);
    uiState.set("IDLE", "awaiting command");
    loadPanels().catch(() => {});
    showNextApproval();
  }
}

/* ---------------------------------------------------------------------- state */
function handleError(error) {
  const message = error?.message || "Unknown error";
  ui.toast(message, error?.status === 429 ? "warn" : "error", 7500);
  if (error?.code === "auth_required") {
    ui.toast("This network requires an access token. Use the local/LAN URL or contact the owner.", "warn", 8000);
    return;
  }
  transcript?.add("system", message);
  uiState.set("ERROR", message.slice(0, 90));
  setTimeout(() => {
    if (!app.busy && !voice?.isSpeaking && uiState.current === "ERROR") uiState.set("IDLE", "awaiting command");
  }, 3500);
}

async function refreshStatus({ silent = false, manual = false } = {}) {
  if (app.paused) {
    if (manual) ui.toast("Backend is disconnected. Press Connect in System → Backend server.", "warn", 5000);
    return null;
  }
  try {
    const status = await api.get("/api/status");
    app.status = status;
    applyStatus(status);
    updateChips(status);
    applyFacts(status);
    setBackendState(getBackendUrl() ? "online" : "local", getBackendUrl() || "same origin");
    if (app.retryTimer) {
      clearTimeout(app.retryTimer);
      app.retryTimer = null;
    }
    app.retryDelay = 4000;
    if (manual) ui.toast("Status refreshed.", "ok", 2200);
    return status;
  } catch (error) {
    setBackendState("offline", error?.message || "backend unavailable");
    ui.setChip("chipNet", navigator.onLine ? "ok" : "bad", "NET");
    if (!silent) handleError(error);
    scheduleBackendRetry();
    return null;
  }
}

function applyFacts(status) {
  if (!status) return;
  const provider = status.provider || {};
  const runtime = status.runtime || {};
  const memory = status.memory || {};
  $("#factProvider").textContent = provider.label || "demo";
  $("#factModel").textContent = provider.model || "demo";
  $("#factMemory").textContent = `${memory.messages || 0} msgs · ${memory.notes || 0} notes`;
  $("#factUptime").textContent = ui.formatUptime(runtime.uptime_seconds);
  $("#factSession").textContent = session.id ? `${session.id.slice(0, 10)}…` : "—";
  const meter = $("#meterFill");
  if (meter) {
    const activity = Math.min(100, 8 + (runtime.messages_handled || 0) * 6);
    meter.style.width = `${activity}%`;
  }
}

function updateChips(status) {
  ui.setChip("chipCore", "ok", "CORE");
  const provider = status?.provider || {};
  if (provider.demo) ui.setChip("chipAi", "warn", "DEMO");
  else ui.setChip("chipAi", "ok", String(provider.provider || "AI").toUpperCase());
  ui.setChip("chipNet", navigator.onLine ? "ok" : "bad", "NET");
  const open = app.stream?.socket?.readyState === WebSocket.OPEN;
  ui.setChip("chipWs", open ? "ok" : "warn", "LINK");
}

/* ----------------------------------------------------------------------- live */
function connectStream() {
  if (app.stream) {
    app.stream.ensureConnected();
    return;
  }
  app.stream = new EventStream({
    onStatus: (status) => {
      if (status === "online") {
        ui.setChip("chipWs", "ok", "LINK");
        $("#factLink").textContent = "live";
      } else if (status === "error") {
        ui.setChip("chipWs", "bad", "LINK");
        $("#factLink").textContent = "error";
      } else {
        ui.setChip("chipWs", "warn", "LINK");
        $("#factLink").textContent = "offline";
      }
    },
    onEvent: handleEvent,
  });
  app.stream.connect();
}

function handleEvent(event) {
  const data = event.data || {};
  switch (event.type) {
    case "state":
      if (data.state === "THINKING" || data.state === "EXECUTING") {
        uiState.set(data.state, data.detail || "");
      } else if (data.state === "IDLE") {
        if (!app.busy && !voice?.isSpeaking && uiState.current !== "ERROR") {
          uiState.set("IDLE", data.detail || "awaiting command");
        }
      }
      break;
    case "tool.start":
      uiState.set("EXECUTING", `tool: ${data.tool}`);
      break;
    case "tool.done":
      if (!data.ok) ui.toast(`Tool ${data.tool} failed: ${data.summary || "error"}`, "error", 6000);
      break;
    case "approval":
      if (data.action) requestApproval(data.action);
      break;
    case "provider.fallback":
      ui.toast(`Fallback provider engaged: ${data.to || "backup"}`, "warn", 6000);
      break;
    case "vision.start":
      uiState.set("THINKING", "vision model processing image");
      break;
    case "hello":
      refreshStatus({ silent: true });
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------- static wiring */
function wireInteractive() {
  if ($("#app").dataset.wired === "1") return;
  $("#app").dataset.wired = "1";

  $("#chatForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#chatInput");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    send(text);
  });

  $("#micBtn").addEventListener("click", async () => {
    if (!voice) return;
    if (!voice.available) {
      ui.toast(voice.unsupportedReason(), "warn", 8000);
      transcript.add("system", voice.unsupportedReason());
      return;
    }
    await voice.toggleMic();
  });

  $("#voiceToggle").addEventListener("click", () => {
    const enabled = stored(LS.tts, "1") !== "1";
    store(LS.tts, enabled ? "1" : "0");
    voice?.setTtsEnabled(enabled);
    $("#voiceToggle").setAttribute("aria-pressed", String(enabled));
    $("#voiceToggle").setAttribute("aria-label", enabled ? "Spoken replies on" : "Spoken replies off");
    if (!enabled) voice?.cancelSpeech();
    const settingToggle = $("#ttsToggle");
    if (settingToggle) settingToggle.checked = enabled;
    ui.toast(enabled ? "Spoken replies on." : "Spoken replies off.", "", 2000);
  });

  $("#ttsToggle")?.addEventListener("change", (event) => {
    const enabled = event.target.checked;
    store(LS.tts, enabled ? "1" : "0");
    voice?.setTtsEnabled(enabled);
    if (!enabled) voice?.cancelSpeech();
    $("#voiceToggle")?.setAttribute("aria-pressed", String(enabled));
    ui.toast(enabled ? "Spoken replies on." : "Spoken replies off.", "", 2000);
  });

  $("#reduceMotionToggle")?.addEventListener("change", (event) => {
    const reduced = event.target.checked;
    store(LS.motion, reduced ? "1" : "0");
    applyAppearance();
    ui.toast(reduced ? "Reduced motion enabled." : "Full motion enabled.", "", 2000);
  });

  $("#lowGlowToggle")?.addEventListener("change", (event) => {
    const lowGlow = event.target.checked;
    store(LS.glow, lowGlow ? "1" : "0");
    applyAppearance();
    ui.toast(lowGlow ? "Low-glow HUD enabled." : "Full HUD lighting restored.", "", 2000);
  });

  $("#langSelect").addEventListener("change", (event) => {
    store(LS.lang, event.target.value);
    if (voice?.isListening) {
      voice.stopListening({ keepWake: voice.wakeEnabled });
      ui.toast("Language changed. Tap the mic to speak again.", "", 3000);
    }
  });

  $$(".rail-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const panel = button.dataset.panel || "chat";
      openPanel(panel);
    });
  });
  $("#openSystem").addEventListener("click", () => openPanel("system"));

  $$("[data-close]").forEach((node) => node.addEventListener("click", () => ui.closeSheet()));
  $("#approveBtn").addEventListener("click", () => resolveApproval(true));
  $("#rejectBtn").addEventListener("click", () => resolveApproval(false));

  $("#quickActions").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-quick]");
    if (!button) return;
    send(button.dataset.quick);
  });

  $("#attachBtn").addEventListener("click", () => {
    if (!app.status?.vision?.available) {
      ui.toast(
        "Image input needs a vision-capable provider (OpenAI, Gemini or OpenRouter) selected in Settings.",
        "warn",
        7000,
      );
      return;
    }
    const input = $("#imageInput");
    input.removeAttribute("capture");
    input.value = "";
    input.click();
  });

  $("#imageInput").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const maxMb = Number(app.config?.max_image_mb) || 8;
    if (!file.type.startsWith("image/")) {
      ui.toast("Choose an image file.", "warn");
      return;
    }
    if (file.size > maxMb * 1024 * 1024) {
      ui.toast(`Image is larger than ${maxMb} MB.`, "warn");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      app.attached = { dataUrl: String(reader.result || ""), name: file.name };
      const chip = $("#attachment");
      const preview = $("#attachmentPreview");
      const label = $("#attachmentName");
      if (preview) preview.src = app.attached.dataUrl;
      if (label) label.textContent = file.name;
      if (chip) chip.hidden = false;
    };
    reader.onerror = () => ui.toast("Could not read that image.", "error");
    reader.readAsDataURL(file);
  });

  $("#attachmentClear").addEventListener("click", clearAttachment);

  $("#wakeToggle").addEventListener("change", async (event) => {
    const enabled = event.target.checked;
    if (enabled && !voice?.available) {
      event.target.checked = false;
      ui.toast(voice?.unsupportedReason() || "Voice input is unavailable.", "warn", 8000);
      return;
    }
    store(LS.wake, enabled ? "1" : "0");
    if (enabled) {
      const started = await voice.setWakeEnabled(true);
      if (!started) {
        event.target.checked = false;
        store(LS.wake, "0");
        return;
      }
      ui.toast('Wake phrase armed. Keep this tab open; Android pauses the mic in the background.', "ok", 6000);
    } else {
      await voice.setWakeEnabled(false);
      ui.toast("Wake phrase disabled.", "", 2500);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!$("#approvalModal").hidden) {
        ui.hideApproval();
        return;
      }
      ui.closeSheet();
      voice?.cancelSpeech();
    }
  });

  window.addEventListener("online", () => {
    ui.setChip("chipNet", "ok", "NET");
    if (!app.paused) connectBackend({ silent: true });
  });
  window.addEventListener("offline", () => {
    ui.setChip("chipNet", "bad", "NET");
    setBackendState("offline", "device is offline");
  });
  window.addEventListener("beforeunload", () => {
    app.stream?.close();
    voice?.stopListening();
    voice?.cancelSpeech();
  });

  setInterval(tickClock, 1000);
  tickClock();
}

function openPanel(view) {
  ui.openSheet(view);
  if (view !== "chat") {
    loadPanels().catch((error) => ui.toast(error.message, "warn"));
  }
}

function clearAttachment() {
  app.attached = null;
  const chip = $("#attachment");
  if (chip) chip.hidden = true;
  const input = $("#imageInput");
  if (input) input.value = "";
}

function applyAppearance() {
  const reduced = stored(LS.motion, "0") === "1";
  const lowGlow = stored(LS.glow, "0") === "1";
  document.body.classList.toggle("reduce-motion", reduced);
  document.body.classList.toggle("low-glow", lowGlow);
  if (!core) return;
  core.reduced = reduced || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (core.reduced) {
    core.stop();
    core.draw();
  } else {
    core.start();
  }
}

function syncPreferenceUi() {
  const lang = stored(LS.lang, app.config?.default_language || "en-US");
  const select = $("#langSelect");
  if (select) select.value = lang;
  const ttsEnabled = stored(LS.tts, "1") === "1";
  $("#voiceToggle")?.setAttribute("aria-pressed", String(ttsEnabled));
  $("#voiceToggle")?.setAttribute("aria-label", ttsEnabled ? "Spoken replies on" : "Spoken replies off");
  const ttsToggle = $("#ttsToggle");
  if (ttsToggle) ttsToggle.checked = ttsEnabled;
  if (voice) voice.setTtsEnabled(ttsEnabled);
  const wake = $("#wakeToggle");
  if (wake) wake.checked = stored(LS.wake, "0") === "1";
  const reduced = stored(LS.motion, "0") === "1";
  const motionToggle = $("#reduceMotionToggle");
  if (motionToggle) motionToggle.checked = reduced;
  const lowGlow = stored(LS.glow, "0") === "1";
  const glowToggle = $("#lowGlowToggle");
  if (glowToggle) glowToggle.checked = lowGlow;
  applyAppearance();
}

function tickClock() {
  const now = new Date();
  const time = $("#clock");
  const date = $("#dateLabel");
  if (time) time.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date) {
    date.textContent = now
      .toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short" })
      .toUpperCase();
  }
}

/* ------------------------------------------------------------------ start-up */
function start() {
  tickClock();
  boot();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
