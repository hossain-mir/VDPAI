/* VDPAI — HUD bootstrap, chat orchestration and interaction wiring. */

import "./native.js";

import {
  APP_ID,
  APP_NAME,
  APP_VERSION,
  createConversation,
  ensureConversation,
  getActiveConversation,
  getActiveProvider,
  getConversations,
  getSettings,
  initStore,
  saveNow,
  setActiveConversation,
  subscribe,
  updateSettings,
  usesNativeStorage,
  addCustomQuickCommand,
  addHudLogEntry,
  clearHudLog,
  getCustomQuickCommands,
  getHudLog,
} from "./store.js";
import { providerReady, sendChat } from "./ai.js";
import { testProvider } from "./providers.js";
import { testBackend } from "./backend.js";
import { CoreRenderer } from "./core.js";
import { Waveform } from "./wave.js";
import { VoiceEngine } from "./voice.js";
import { uiState } from "./state.js";
import * as ui from "./ui.js";
import {
  attachVoice,
  closeControlCenter,
  initControlCenter,
  isControlCenterOpen,
  openControlCenter,
  refreshControlCenter,
  setBackendStatus,
} from "./control.js";
import { closeHistory, initHistory, isHistoryOpen, openHistory, renderHistory } from "./history.js";
import { initAssistant, renderAllAssistant } from "./assistant.js";
import { initIntegrations } from "./integrations.js";
import { initMemory, renderMemories } from "./memory.js";
import { initProfiles } from "./profiles.js";

const $ = ui.$;
const $$ = ui.$$;

const app = {
  core: null,
  wave: null,
  voice: null,
  transcript: null,
  busy: false,
  controller: null,
  lastAnswer: "",
  lastMeta: "",
  liveBubble: null,
  booted: false,
  backendOnline: false,
};

/* ---------------------------------------------------------------- bootstrap */
async function boot() {
  await initStore();
  app.transcript = new ui.Transcript($("#transcript"));
  uiState.bind($("#stateText"), $("#stateDetail"));

  applyAppearance();
  app.core = new CoreRenderer($("#coreCanvas"));
  app.wave = new Waveform($("#waveCanvas"), { getLevel: () => micLevel() });
  uiState.on((state) => {
    app.core?.setState(state);
    app.wave?.setState(state);
    if (state === "LISTENING") {
      setResponseStatus("LISTENING", "busy");
    } else if (state === "THINKING") {
      setResponseStatus("THINKING", "busy");
    } else if (state === "SPEAKING") {
      setResponseStatus("SPEAKING", "busy");
    } else if (state === "ERROR") {
      setResponseStatus("ERROR", "error");
    } else if (state === "IDLE") {
      setResponseStatus(app.lastAnswer ? "ANSWER READY" : "IDLE");
    }
  });

  initVoice();
  initControlCenter({
    voice: app.voice,
    onSettingsChanged: () => {
      applyAppearance();
      syncVoiceButtons();
      renderResponseStatus();
    },
    onProviderChanged: () => {
      refreshProviderUi();
    },
    onHistoryCleared: () => {
      renderActiveConversation({ announce: true });
      renderHistory();
      refreshControlCenter();
    },
    onDataCleared: () => {
      resetAfterDataClear();
    },
    onBackendChanged: (state) => {
      app.backendOnline = state?.state === "online";
      updateBackendChip(state?.state === "online" ? "online" : "offline", state?.detail || "");
    },
  });
  attachVoice(app.voice);
  initHistory({
    onOpenConversation: (conversationId) => {
      setActiveConversation(conversationId);
      renderActiveConversation({ announce: false });
      refreshProviderUi();
    },
    onNewConversation: () => newConversation(),
    onChanged: () => {
      renderActiveConversation({ announce: false });
      renderHistory();
      refreshControlCenter();
      refreshProviderUi();
    },
  });

  wireHud();
  syncQuickToggles();
  refreshProviderUi();
  renderActiveConversation({ announce: true });
  renderVoiceCapabilities();

  initAssistant();
  initIntegrations({
    onEmergencyStop: () => handleEmergencyStop(),
  });
  initMemory();
  initProfiles({
    onProfileSwitched: () => {
      renderActiveConversation({ announce: false });
      renderHistory();
      refreshControlCenter();
      renderAllAssistant();
      renderMemories();
    },
  });

  wireNavigation();
  wireLaunchSequence();
  updateGreeting();
  renderQuickCommands();
  renderHudLog();
  window.addEventListener("vdpai:hudlog", () => renderHudLog());
  window.addEventListener("vdpai:quickcommands", () => renderQuickCommands());
  addHudLogEntry("App opened.");
  addHudLogEntry("VDPAI ready.");

  $("#app").hidden = false;
  app.booted = true;
  setBackendStatus({ state: getSettings().backendUrl ? "offline" : "offline", detail: getSettings().backendUrl ? "not checked" : "not configured" });
  updateBackendChip("offline", getSettings().backendUrl ? "not checked" : "not configured");

  // Optional and fully non-blocking.
  if (getSettings().backendUrl) probeBackend({ silent: true });

  window.HSAI_READY = true; // Backward-compatible hook for existing browser integrations.
  window.VDPAI_READY = true;
  const publicApi = {
    version: APP_VERSION,
    send,
    newConversation,
    openControlCenter,
    switchPage,
    emergencyStop: handleEmergencyStop,
    getState: () => ({
      busy: app.busy,
      lastAnswer: app.lastAnswer,
      settings: getSettings(),
      activeConversation: getActiveConversation(),
    }),
  };
  window.HSAI = publicApi;
  window.VDPAI = publicApi;
}

function resetAfterDataClear() {
  closeControlCenter();
  closeHistory();
  app.lastAnswer = "";
  app.lastMeta = "";
  uiState.set("IDLE", "local data cleared");
  app.transcript?.clear();
  $("#responseText").textContent = "All local VDPAI data was deleted. Add a provider in Control Center → AI & API.";
  $("#responseText").className = "response-text is-muted";
  $("#responseMeta").textContent = "Local HUD · fresh configuration";
  refreshProviderUi();
  applyAppearance();
  syncQuickToggles();
  renderVoiceCapabilities();
  refreshControlCenter();
  renderHistory();
}

/* -------------------------------------------------------------------- voice */
function initVoice() {
  const settings = getSettings();
  app.voice = new VoiceEngine({
    getLanguage: () => getSettings().language,
    getSettings: () => getSettings(),
    ttsEnabled: settings.ttsEnabled,
    onPartial: (text) => {
      const input = $("#chatInput");
      if (input && text) {
        input.value = text;
        autoGrow(input);
        syncSendButton();
      }
    },
    onFinal: (text) => {
      const input = $("#chatInput");
      if (input) {
        input.value = "";
        autoGrow(input);
        syncSendButton();
      }
      handleVoiceCommand(text);
    },
    onError: (message, code) => {
      ui.toast(message, code === "not-allowed" || code === "permission" ? "error" : "warn", 4500);
      if (code !== "no-speech" && code !== "timeout") {
        app.transcript?.add("error", message);
      }
      uiState.set(code === "not-allowed" || code === "permission" ? "ERROR" : "IDLE", message.slice(0, 100));
      updateMicChip();
      setTimeout(() => {
        if (!app.busy && !app.voice?.isSpeaking && uiState.current === "ERROR") uiState.set("IDLE", "awaiting command");
      }, 4200);
      if (code === "permission" || code === "not-allowed") renderVoiceCapabilities();
    },
    onState: (state, detail) => {
      if (state === "IDLE" && (app.busy || app.voice?.isSpeaking)) return;
      uiState.set(state, detail);
      if (state === "LISTENING") {
        updateMicChip("listening");
        setResponseStatus("LISTENING", "busy");
      }
      if (state === "SPEAKING") {
        updateMicChip("ready");
        setResponseStatus("SPEAKING", "busy");
      }
      if (state === "IDLE") {
        updateMicChip();
        if (!app.busy) setResponseStatus(app.lastAnswer ? "ANSWER READY" : "IDLE");
      }
    },
    onListening: (listening) => {
      $("#micBtn")?.setAttribute("aria-pressed", String(listening));
      $("#micLabel").textContent = listening ? "LISTENING" : "MIC";
      updateMicChip(listening ? "listening" : undefined);
    },
    onSpeaking: (speaking) => {
      const stop = $("#voiceStopBtn");
      if (stop) stop.hidden = !speaking;
      if (speaking) setResponseStatus("SPEAKING", "busy");
      else if (!app.busy) setResponseStatus(app.lastAnswer ? "ANSWER READY" : "IDLE");
      updateVoiceChip();
    },
    onVoices: () => {},
  });
  syncQuickToggles();
}

function renderVoiceCapabilities() {
  if (!app.voice) return;
  const input = app.voice.inputAvailable;
  const output = app.voice.outputAvailable;
  const chip = $("#chipMic");
  if (chip) {
    if (!input) {
      chip.dataset.tone = "bad";
      chip.textContent = "";
      chip.appendChild(document.createElement("i"));
      chip.appendChild(document.createTextNode("MIC N/A"));
      chip.title = app.voice.unsupportedInputReason() || "Voice input unavailable";
    } else {
      updateMicChip();
      chip.title = "Microphone ready";
    }
  }
  const mic = $("#micBtn");
  if (mic) mic.setAttribute("aria-disabled", input ? "false" : "true");
  const capabilities = $("#voiceCapabilities");
  if (capabilities) {
    capabilities.dataset.tone = input && output ? "ok" : "warn";
    capabilities.textContent = `${input ? "Speech input ready." : `Speech input unavailable: ${app.voice.unsupportedInputReason()}`} ${
      output ? "Voice output ready." : `Voice output unavailable: ${app.voice.unsupportedOutputReason()}`
    }`;
  }
}

function updateMicChip(mode) {
  if (!app.voice?.inputAvailable) return;
  const chip = $("#chipMic");
  if (!chip) return;
  const label = mode === "listening" ? "MIC LIVE" : app.voice.isListening ? "MIC LIVE" : "MIC";
  ui.setChip(chip, mode === "listening" ? "ok" : "ok", label);
  chip.title = mode === "listening" ? "Listening" : "Microphone ready";
}

function updateVoiceChip() {
  const settings = getSettings();
  const chip = $("#chipVoice");
  const output = app.voice?.outputAvailable;
  if (!chip) return;
  if (!output) ui.setChip(chip, "bad", "TTS N/A");
  else ui.setChip(chip, settings.ttsEnabled ? "ok" : "warn", settings.ttsEnabled ? "VOICE ON" : "VOICE OFF");
  const quick = $("#ttsQuickBtn");
  if (quick) {
    quick.setAttribute("aria-pressed", String(settings.ttsEnabled));
    quick.setAttribute("aria-label", settings.ttsEnabled ? "Spoken replies on" : "Spoken replies off");
    quick.title = settings.ttsEnabled ? "Spoken replies on" : "Spoken replies off";
  }
  const toggle = $("#ttsToggle");
  if (toggle) toggle.checked = settings.ttsEnabled;
}

function syncVoiceButtons() {
  updateVoiceChip();
  updateMicChip();
  renderResponseStatus();
}

async function handleVoiceCommand(text) {
  const command = String(text || "").trim();
  if (!command) return;
  if (/^(stop|stop speaking|cancel|quiet)[.,!?\s]*$/i.test(command)) {
    app.voice?.stopSpeaking();
    uiState.set("IDLE", "speech stopped");
    app.transcript?.add("system", "Speech stopped.");
    return;
  }
  if (/^(repeat|repeat that|say that again|replay)[.,!?\s]*$/i.test(command)) {
    if (!app.lastAnswer) {
      ui.toast("There is no previous answer to replay.", "warn");
      return;
    }
    replayAnswer();
    return;
  }
  if (/^(new chat|new conversation|start over)[.,!?\s]*$/i.test(command)) {
    newConversation();
    return;
  }
  await send(command, { source: "voice" });
}

let lastSentText = "";
let lastSentTime = 0;
let lastConfigToast = 0;

/* --------------------------------------------------------------------- chat */
async function send(raw, { source = "text" } = {}) {
  const message = String(raw || "").trim();
  if (!message) return;
  if (app.busy) {
    ui.toast("VDPAI is still answering. Stop the current response first.", "warn");
    return;
  }
  // Prevent duplicate messages sent in rapid succession
  if (message === lastSentText && Date.now() - lastSentTime < 2500) {
    return;
  }
  lastSentText = message;
  lastSentTime = Date.now();

  const ready = providerReady();
  if (!ready.ok) {
    showConfigError(ready.reason);
    return;
  }

  app.busy = true;
  app.lastAnswer = "";
  app.lastMeta = "";
  app.controller = new AbortController();
  const conversation = ensureConversation();
  const provider = ready.provider;

  const chatInput = $("#chatInput");
  if (chatInput) {
    chatInput.value = "";
    autoGrow(chatInput);
  }
  setComposerBusy(true);
  uiState.set("THINKING", source === "voice" ? "interpreting voice command" : "reasoning");
  setResponseStatus("THINKING", "busy");
  setResponseText("", { muted: true });
  $("#responseMeta").textContent = `${provider.name} · ${provider.model} · receiving response…`;
  $("#stopGenBtn").hidden = false;
  app.transcript?.add("user", message, source === "voice" ? "voice" : "");
  app.liveBubble = app.transcript?.add("assistant", "", `${provider.name} · ${provider.model}`);

  addHudLogEntry(`Command: "${message.slice(0, 32)}${message.length > 32 ? '…' : ''}"`);

  try {
    const result = await sendChat({
      text: message,
      conversationId: conversation.id,
      signal: app.controller.signal,
      onDelta: (_delta, full) => {
        setResponseText(full || "");
        if (app.liveBubble) {
          const textNode = app.liveBubble.firstChild;
          if (textNode) textNode.nodeValue = full || "…";
        }
        const panel = $("#responseText");
        if (panel) panel.scrollTop = panel.scrollHeight;
      },
    });

    app.lastAnswer = result.text;
    app.lastMeta = `${result.provider} · ${result.model}`;
    setResponseText(result.text);
    $("#responseMeta").textContent = result.stopped ? `${app.lastMeta} · stopped by user` : app.lastMeta;
    setResponseStatus(result.stopped ? "STOPPED" : "ANSWER READY", result.stopped ? "error" : "");
    if (app.liveBubble) {
      const textNode = app.liveBubble.firstChild;
      if (textNode) textNode.nodeValue = result.text;
      const meta = app.liveBubble.querySelector(".meta");
      if (meta) meta.textContent = `${app.lastMeta} · ${ui.timeLabel()}`;
    }
    uiState.set("IDLE", result.stopped ? "response stopped" : "answer ready");
    addHudLogEntry(result.stopped ? "Response stopped by user." : "Response generated.");
    refreshProviderUi();
    renderHistory();
    refreshControlCenter();
    saveNow().catch(() => {});

    if (!result.stopped && getSettings().ttsEnabled && app.voice?.outputAvailable) {
      speakAnswer(result.text);
    }
  } catch (error) {
    const aborted = app.controller?.signal.aborted || error?.code === "aborted";
    const message = aborted ? "Response generation stopped." : error?.message || "The AI request failed.";
    if (app.liveBubble?.parentNode) app.liveBubble.remove();
    app.liveBubble = null;
    setResponseText(message, { error: !aborted, muted: aborted });
    $("#responseMeta").textContent = aborted ? "Stopped by user" : "Request failed";
    setResponseStatus(aborted ? "STOPPED" : "ERROR", aborted ? "" : "error");
    app.transcript?.add(aborted ? "system" : "error", message);
    uiState.set(aborted ? "IDLE" : "ERROR", aborted ? "response stopped" : message.slice(0, 100));
    if (!aborted) ui.toast(message, "error", 5000);
    setTimeout(() => {
      if (!app.busy && !app.voice?.isSpeaking && uiState.current === "ERROR") uiState.set("IDLE", "awaiting command");
    }, 4200);
  } finally {
    app.busy = false;
    app.controller = null;
    setComposerBusy(false);
    $("#stopGenBtn").hidden = true;
    if (!app.voice?.isSpeaking) {
      updateMicChip();
      if (uiState.current !== "ERROR") uiState.set("IDLE", "awaiting command");
    }
    renderHistory();
    refreshControlCenter();
    renderVoiceCapabilities();
    syncSendButton();
  }
}

function showConfigError(reason) {
  const message = `${reason} Open Control Center → AI & API to configure a provider. The HUD stays available offline.`;
  setResponseText(message, { error: true });
  $("#responseMeta").textContent = "No usable AI provider";
  setResponseStatus("NO API", "error");
  app.transcript?.add("error", message);
  uiState.set("ERROR", "AI provider not configured");
  if (Date.now() - lastConfigToast > 3000) {
    ui.toast(reason, "warn", 5000);
    lastConfigToast = Date.now();
  }
}

function speakAnswer(text) {
  app.voice?.speak(text).then((result) => {
    if (!result.ok) {
      setResponseStatus("TEXT READY", "error");
      app.transcript?.add("error", result.error || "Voice output failed.", "");
      ui.toast(result.error || "Voice output failed. The answer is still on screen.", "warn", 6500);
    }
  });
}

function replayAnswer() {
  if (!app.lastAnswer) {
    ui.toast("There is no answer to replay yet.", "warn");
    return;
  }
  if (!app.voice?.outputAvailable) {
    ui.toast(app.voice?.unsupportedOutputReason() || "Voice output is unavailable.", "warn");
    return;
  }
  speakAnswer(app.lastAnswer);
}

function setResponseText(value, { error = false, muted = false } = {}) {
  const node = $("#responseText");
  if (!node) return;
  node.textContent = value;
  node.className = `response-text${error ? " is-error" : muted ? " is-muted" : ""}`;
}

function setResponseStatus(label, tone = "") {
  ui.setMiniStatus($("#responseStatus"), label, tone);
}

function renderResponseStatus() {
  if (app.voice?.isSpeaking) setResponseStatus("SPEAKING", "busy");
  else if (app.busy) setResponseStatus("THINKING", "busy");
  else if (app.lastAnswer) setResponseStatus("ANSWER READY");
  else setResponseStatus("IDLE");
}

function syncSendButton() {
  const send = $(".send-pill-btn") || $(".send");
  const input = $("#chatInput");
  if (send) {
    const hasText = Boolean(input?.value?.trim());
    send.disabled = !hasText || Boolean(app.busy);
  }
}

function setComposerBusy(busy) {
  const send = $(".send-pill-btn") || $(".send");
  const input = $("#chatInput");
  if (input) input.disabled = Boolean(busy);
  if (send) {
    const hasText = Boolean(input?.value?.trim());
    send.disabled = Boolean(busy) || !hasText;
  }
}

function newConversation() {
  if (app.busy) {
    ui.toast("Stop the current response before starting a new conversation.", "warn");
    return;
  }
  const input = $("#chatInput");
  if (input) {
    input.value = "";
    autoGrow(input);
  }
  syncSendButton();
  const current = getActiveConversation();
  if (current && current.messages.length === 0) {
    closeHistory();
    app.transcript?.clear();
    setResponseText("New conversation ready. Ask VDPAI anything.", { muted: true });
    $("#responseMeta").textContent = "Local HUD · no backend required";
    app.lastAnswer = "";
    setResponseStatus("IDLE");
    return;
  }
  const provider = getActiveProvider();
  createConversation({ providerId: provider?.id || null, model: provider?.model || "" });
  saveNow().catch(() => {});
  closeHistory();
  app.lastAnswer = "";
  app.lastMeta = "";
  renderActiveConversation({ announce: true });
  setResponseText("New conversation ready. Ask VDPAI anything.", { muted: true });
  $("#responseMeta").textContent = "Local HUD · no backend required";
  setResponseStatus("IDLE");
  renderHistory();
  refreshControlCenter();
}

function renderActiveConversation({ announce = false } = {}) {
  const conversation = getActiveConversation();
  if (!conversation || !conversation.messages.length) {
    app.transcript?.clear();
    if (announce) {
      app.transcript?.add("system", "VDPAI READY · local HUD · configure an AI provider in Control Center");
    }
    const lastAssistant = [...(conversation?.messages || [])].reverse().find((message) => message.role === "assistant");
    if (lastAssistant) {
      app.lastAnswer = lastAssistant.content;
      setResponseText(lastAssistant.content);
      $("#responseMeta").textContent = conversation?.model || "assistant";
    } else {
      app.lastAnswer = "";
      setResponseText("VDPAI is ready. Configure an AI provider, or use a quick command below.", { muted: true });
      $("#responseMeta").textContent = "Local HUD · no backend required";
    }
    setResponseStatus("IDLE");
    renderResponseStatus();
    return;
  }
  app.transcript?.renderConversation(conversation, { announce });
  const lastAssistant = [...conversation.messages].reverse().find((message) => message.role === "assistant");
  if (lastAssistant) {
    app.lastAnswer = lastAssistant.content.replace(/\n\n\[stopped\]$/, "");
    app.lastMeta = conversation.model || "assistant";
    setResponseText(app.lastAnswer);
    $("#responseMeta").textContent = conversation.model || "assistant";
    setResponseStatus("ANSWER READY");
  } else {
    app.lastAnswer = "";
    setResponseText("Conversation restored. Ask your next question.", { muted: true });
    $("#responseMeta").textContent = conversation.title;
    setResponseStatus("IDLE");
  }
}

/* ------------------------------------------------------------------- provider */
function refreshProviderUi() {
  const provider = getActiveProvider();
  const badge = $("#providerBadge");
  const model = $("#providerModel");
  const p4Title = $("#p4ActiveProviderTitle");
  const p4Model = $("#p4ActiveProviderModel");
  const p4Badge = $("#p4ProviderStatusBadge");
  if (provider) {
    ui.setChip("chipProvider", "ok", truncate(provider.name.toUpperCase(), 14));
    if (badge) badge.textContent = provider.name;
    if (model) model.textContent = `${provider.model} · ${provider.apiKey || provider.type === "custom" ? "credential ready" : "no key"}`;
    if (p4Title) p4Title.textContent = `Active Provider: ${provider.name}`;
    if (p4Model) p4Model.textContent = `Model: ${provider.model} · ${provider.endpoint || "Default Endpoint"}`;
    if (p4Badge) {
      const ready = provider.apiKey || provider.type === "custom";
      p4Badge.textContent = ready ? "READY" : "NO KEY";
      p4Badge.dataset.tone = ready ? "ok" : "warn";
    }
  } else {
    ui.setChip("chipProvider", "bad", "NO API");
    if (badge) badge.textContent = "Not configured";
    if (model) model.textContent = "Add a provider in Control Center";
    if (p4Title) p4Title.textContent = "Active Provider: None";
    if (p4Model) p4Model.textContent = "Add an AI provider to enable streaming intelligence.";
    if (p4Badge) {
      p4Badge.textContent = "NO API KEY";
      p4Badge.dataset.tone = "warn";
    }
  }
  updateVoiceChip();
}

function truncate(value, length) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/* --------------------------------------------------------------------- backend */
async function probeBackend({ silent = false } = {}) {
  const settings = getSettings();
  if (!settings.backendUrl) {
    app.backendOnline = false;
    setBackendStatus({ state: "offline", detail: "not configured" });
    updateBackendChip("offline", "not configured");
    if (!silent) ui.toast("No backend configured. VDPAI works locally.", "warn");
    return { ok: false, empty: true };
  }
  updateBackendChip("checking", "testing");
  setBackendStatus({ state: "offline", detail: "checking…" });
  const result = await testBackend(settings.backendUrl);
  app.backendOnline = Boolean(result.ok);
  setBackendStatus({
    state: result.ok ? "online" : "offline",
    detail: result.ok ? `${result.health} · ${result.url}` : result.error,
    latency: result.latency || 0,
    checkedAt: Date.now(),
  });
  updateBackendChip(result.ok ? "online" : "offline", result.ok ? result.url : result.error);
  if (!silent) ui.toast(result.ok ? "Backend replied successfully." : result.error, result.ok ? "ok" : "error", 5000);
  return result;
}

function updateBackendChip(state, detail) {
  const labels = { online: "BACKEND ON", offline: "OFFLINE", checking: "BACKEND…" };
  const tones = { online: "ok", offline: "warn", checking: "warn" };
  ui.setChip("chipBackend", tones[state] || "warn", labels[state] || "OFFLINE");
  const chip = $("#chipBackend");
  if (chip) chip.title = detail || labels[state] || "";
}

/* --------------------------------------------------------------- interactions */
function wireHud() {
  if ($("#app").dataset.wired === "1") return;
  $("#app").dataset.wired = "1";

  $("#chatForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#chatInput");
    const text = input.value.trim();
    if (!text) return;
    send(text);
  });

  const input = $("#chatInput");
  input.addEventListener("input", () => {
    autoGrow(input);
    syncSendButton();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $("#chatForm").requestSubmit();
    }
  });

  input.addEventListener("focus", () => {
    document.body.classList.add("input-focused");
    setTimeout(() => {
      input.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 100);
  });
  input.addEventListener("blur", () => {
    setTimeout(() => {
      const active = document.activeElement;
      if (!active || !["INPUT", "TEXTAREA"].includes(active.tagName)) {
        document.body.classList.remove("input-focused");
      }
    }, 100);
  });

  if (typeof window !== "undefined" && window.visualViewport) {
    const initialH = window.innerHeight;
    window.visualViewport.addEventListener("resize", () => {
      const isKeyboard = window.visualViewport.height < initialH * 0.8;
      document.body.classList.toggle("keyboard-open", isKeyboard);
      if (isKeyboard) {
        setTimeout(() => {
          const active = document.activeElement;
          if (active && ["INPUT", "TEXTAREA"].includes(active.tagName)) {
            active.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
        }, 80);
      }
    });
  }

  syncSendButton();

  let micPressTimer = null;
  let micLongPressed = false;
  const micBtn = $("#micBtn");

  micBtn.addEventListener("pointerdown", () => {
    micLongPressed = false;
    micPressTimer = setTimeout(() => {
      micLongPressed = true;
      openControlCenter("voice");
      ui.toast("Voice & Speech Settings", "", 1800);
    }, 500);
  });

  const clearMicPress = () => {
    if (micPressTimer) clearTimeout(micPressTimer);
    micPressTimer = null;
  };

  micBtn.addEventListener("pointerup", clearMicPress);
  micBtn.addEventListener("pointercancel", clearMicPress);

  micBtn.addEventListener("click", async (e) => {
    if (micLongPressed) {
      e.preventDefault();
      micLongPressed = false;
      return;
    }
    if (!app.voice) return;
    if (!app.voice.inputAvailable) {
      ui.toast(app.voice.unsupportedInputReason() || "Voice input is unavailable.", "warn", 7000);
      return;
    }
    await app.voice.toggleListening();
  });

  $("#themeQuickBtn")?.addEventListener("click", () => {
    const themes = ["cyan", "emerald", "violet", "blue", "gold", "crimson"];
    const current = document.body.dataset.theme || "cyan";
    const nextIdx = (themes.indexOf(current) + 1) % themes.length;
    const nextTheme = themes[nextIdx];
    document.body.dataset.theme = nextTheme;
    updateSettings({ theme: nextTheme });
    const select = $("#themeSelect");
    if (select) select.value = nextTheme;
    saveNow().catch(() => {});
    ui.toast(`Theme: ${nextTheme.toUpperCase()}`, "", 1600);
  });

  $("#ttsQuickBtn").addEventListener("click", () => {
    const enabled = !getSettings().ttsEnabled;
    updateSettings({ ttsEnabled: enabled });
    if (!enabled) app.voice?.stopSpeaking();
    syncVoiceButtons();
    refreshControlCenter();
    saveNow().catch(() => {});
    ui.toast(enabled ? "Spoken replies on." : "Spoken replies off.", "", 2200);
  });

  $("#stopGenBtn").addEventListener("click", () => {
    if (!app.controller) return;
    app.controller.abort();
    ui.toast("Stopping response…", "", 1600);
  });

  $("#voiceStopBtn").addEventListener("click", () => {
    app.voice?.stopSpeaking();
    updateMicChip();
    ui.toast("Speech stopped.", "", 1800);
  });

  $("#replayBtn").addEventListener("click", replayAnswer);

  $("#copyBtn").addEventListener("click", async () => {
    if (!app.lastAnswer) {
      ui.toast("There is no answer to copy yet.", "warn");
      return;
    }
    const ok = await ui.copyText(app.lastAnswer);
    ui.toast(ok ? "Answer copied." : "Could not access the clipboard.", ok ? "ok" : "warn", 2200);
  });

  $("#newChatBtn").addEventListener("click", () => newConversation());
  $("#openSystem")?.addEventListener("click", () => openControlCenter("ai"));
  $("#quickActions").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-quick]");
    if (!button) return;
    send(button.dataset.quick);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!$("#promptModal").hidden) {
      $("#promptCancel")?.click();
      return;
    }
    if (!$("#confirmModal").hidden) {
      $("#confirmCancel")?.click();
      return;
    }
    if (!$("#providerModal").hidden) {
      $("#providerCancelBtn")?.click();
      return;
    }
    if (isControlCenterOpen()) {
      closeControlCenter();
      return;
    }
    if (isHistoryOpen()) {
      closeHistory();
      return;
    }
    app.voice?.stopSpeaking();
  });

  window.addEventListener("online", () => {
    ui.setChip("chipBackend", getSettings().backendUrl ? "warn" : "warn", "OFFLINE");
    if (getSettings().backendUrl) probeBackend({ silent: true });
  });
  window.addEventListener("offline", () => {
    updateBackendChip("offline", "device offline");
    if (getSettings().backendUrl) setBackendStatus({ state: "offline", detail: "device offline" });
  });
  window.addEventListener("pagehide", () => {
    saveNow().catch(() => {});
    app.voice?.stopSpeaking();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) saveNow().catch(() => {});
  });

  $("#historyBtn").addEventListener("click", openHistory);
  $("#controlBtn").addEventListener("click", () => openControlCenter("ai"));

  $("#shareBtn")?.addEventListener("click", async () => {
    if (!app.lastAnswer) {
      ui.toast("No response to share.", "warn");
      return;
    }
    if (navigator.share) {
      try {
        await navigator.share({ title: "VDPAI Intelligence", text: app.lastAnswer });
        return;
      } catch {
        /* fallback to copy */
      }
    }
    const ok = await ui.copyText(app.lastAnswer);
    ui.toast(ok ? "Copied to clipboard." : "Could not copy.", ok ? "ok" : "warn");
  });

  $("#attachMediaBtn")?.addEventListener("click", () => {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = "image/*,.pdf,.txt,.md";
    picker.addEventListener("change", () => {
      if (picker.files?.[0]) {
        const file = picker.files[0];
        const chatInp = $("#chatInput");
        if (chatInp) {
          chatInp.value = `[Attached: ${file.name}] ${chatInp.value}`;
          chatInp.focus();
          syncSendButton();
        }
        ui.toast(`Attached ${file.name}`, "ok");
      }
    });
    picker.click();
  });

  const persSelect = $("#personalitySelect");
  if (persSelect) {
    persSelect.value = getSettings().personalityStyle || "jarvis";
    persSelect.addEventListener("change", () => {
      updateSettings({ personalityStyle: persSelect.value });
      ui.toast(`Personality updated to: ${persSelect.options[persSelect.selectedIndex]?.text}`, "ok");
    });
  }

  const userInp = $("#userNameInput");
  if (userInp) {
    userInp.value = getSettings().userName || "Sir";
    userInp.addEventListener("change", () => {
      updateSettings({ userName: userInp.value.trim() || "Sir" });
      updateGreeting();
      ui.toast(`Preferred name updated to: ${userInp.value.trim()}`, "ok");
    });
  }

  const launchAnimToggle = $("#launchAnimToggle");
  if (launchAnimToggle) {
    launchAnimToggle.checked = getSettings().launchAnimationEnabled !== false;
    launchAnimToggle.addEventListener("change", () => {
      updateSettings({ launchAnimationEnabled: launchAnimToggle.checked });
    });
  }

  $("#hudClearLogBtn")?.addEventListener("click", async () => {
    const confirmed = await ui.confirmAction({
      title: "Clear Activity Log?",
      text: "This will remove all recent activity entries from your local HUD log.",
      confirmLabel: "Clear Log",
    });
    if (confirmed) {
      clearHudLog();
      renderHudLog();
      ui.toast("Activity log cleared.", "ok");
    }
  });

  $("#hudViewAllLogBtn")?.addEventListener("click", () => {
    hudLogViewAll = !hudLogViewAll;
    renderHudLog();
  });

  $("#p4ManageProviderBtn")?.addEventListener("click", () => {
    openControlCenter("ai");
  });

  $("#p4TestProviderBtn")?.addEventListener("click", async () => {
    const provider = getActiveProvider();
    if (!provider) {
      ui.toast("No active provider configured.", "warn");
      return;
    }
    ui.toast(`Testing connection to ${provider.name}…`, "", 2500);
    const result = await testProvider(provider);
    if (result.ok) {
      ui.toast(`Provider test passed: ${provider.name} (${provider.model}) is operational.`, "ok", 4000);
    } else {
      ui.toast(`Provider test failed: ${result.error || "Connection error"}`, "error", 6000);
    }
  });

  setInterval(tickClock, 1000);
  tickClock();
}

let activePageIndex = 0;
const PAGES = ["home", "assistant", "control", "settings"];

function switchPage(pageId) {
  const index = PAGES.indexOf(pageId);
  if (index < 0) return;
  activePageIndex = index;

  const slider = $("#pagesSlider");
  if (slider) {
    slider.style.transform = `translateX(-${index * 25}%)`;
  }

  $$(".page-view").forEach((view) => {
    view.classList.toggle("is-active", view.dataset.page === pageId);
  });

  $$(".nav-pill-btn").forEach((btn) => {
    const isCurrent = btn.dataset.page === pageId;
    btn.classList.toggle("is-active", isCurrent);
    btn.setAttribute("aria-selected", isCurrent ? "true" : "false");
  });
}

function handleEmergencyStop() {
  if (app.controller) {
    app.controller.abort();
    app.controller = null;
  }
  if (app.voice) {
    app.voice.stopSpeaking();
    app.voice.stopListening();
  }
  if (typeof window !== "undefined" && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  app.busy = false;
  uiState.set("IDLE", "ready");
  const stopGen = $("#stopGenBtn");
  if (stopGen) stopGen.hidden = true;
  const stopVoice = $("#voiceStopBtn");
  if (stopVoice) stopVoice.hidden = true;
  ui.toast("EMERGENCY STOP: Active processes terminated.", "error", 4000);
}

function renderQuickCommands() {
  const container = $("#quickActions");
  if (!container) return;
  const commands = getCustomQuickCommands();
  container.replaceChildren();
  for (const cmd of commands) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.quick = cmd.prompt;
    btn.textContent = cmd.label;
    container.appendChild(btn);
  }
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "btn-add-quick";
  addBtn.id = "addQuickCmdBtn";
  addBtn.title = "Customize quick commands";
  addBtn.textContent = "+ Add";
  addBtn.addEventListener("click", async () => {
    const label = await ui.promptAction({
      title: "New Quick Command",
      text: "Enter a button label for your quick command:",
      placeholder: "e.g. Status Briefing",
    });
    if (!label?.trim()) return;
    const prompt = await ui.promptAction({
      title: "Command Instruction",
      text: `Enter the prompt to send when "${label.trim()}" is tapped:`,
      placeholder: "e.g. Give me a short status briefing.",
    });
    if (!prompt?.trim()) return;
    addCustomQuickCommand({ label: label.trim(), prompt: prompt.trim() });
    renderQuickCommands();
    ui.toast("Quick command added.", "ok", 2000);
  });
  container.appendChild(addBtn);
}

let hudLogViewAll = false;

function renderHudLog() {
  const list = $("#hudLogList");
  if (!list) return;
  const entries = getHudLog();
  list.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hud-log-entry empty";
    empty.textContent = "All systems nominal. No recent activity.";
    list.appendChild(empty);
    const countBadge = $("#hudLogCount");
    if (countBadge) countBadge.textContent = "0 EVENTS";
    const viewAllBtn = $("#hudViewAllLogBtn");
    if (viewAllBtn) viewAllBtn.textContent = "View All";
    return;
  }
  const sliceEntries = hudLogViewAll ? entries : entries.slice(0, 5);
  for (const entry of sliceEntries) {
    const row = document.createElement("div");
    row.className = "hud-log-entry";
    const time = document.createElement("time");
    time.textContent = entry.time || "--:--:--";
    const msg = document.createElement("span");
    msg.className = "log-msg";
    msg.textContent = entry.text;
    row.appendChild(time);
    row.appendChild(msg);
    list.appendChild(row);
  }
  const countBadge = $("#hudLogCount");
  if (countBadge) countBadge.textContent = `${entries.length} EVENTS`;
  const viewAllBtn = $("#hudViewAllLogBtn");
  if (viewAllBtn) viewAllBtn.textContent = hudLogViewAll ? "Show Recent" : "View All";
}

function updateGreeting() {
  const settings = getSettings();
  const hour = new Date().getHours();
  let salute = "Good evening";
  if (hour < 12) salute = "Good morning";
  else if (hour < 17) salute = "Good afternoon";

  const user = settings.userName || "Sir";
  const saluteEl = $("#greetingSalute");
  if (saluteEl) saluteEl.textContent = `${salute}, ${user}.`;
}

function wireNavigation() {
  $$("#bottomNavBar .nav-pill-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.page) {
        switchPage(btn.dataset.page);
      }
    });
  });

  $("#navVoiceBtn")?.addEventListener("click", () => {
    $("#micBtn")?.click();
  });

  $("#navMoreBtn")?.addEventListener("click", () => {
    openControlCenter("ai");
  });

  const viewport = $("#pagesViewport");
  let startX = 0;
  let startY = 0;
  viewport?.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }
  }, { passive: true });

  viewport?.addEventListener("touchend", (e) => {
    if (e.changedTouches.length === 1) {
      const diffX = e.changedTouches[0].clientX - startX;
      const diffY = e.changedTouches[0].clientY - startY;
      if (Math.abs(diffX) > 60 && Math.abs(diffX) > Math.abs(diffY) * 1.5) {
        if (diffX < 0 && activePageIndex < PAGES.length - 1) {
          switchPage(PAGES[activePageIndex + 1]);
        } else if (diffX > 0 && activePageIndex > 0) {
          switchPage(PAGES[activePageIndex - 1]);
        }
      }
    }
  }, { passive: true });

  window.addEventListener("keydown", (e) => {
    if (e.target && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) {
      if (e.key === "Escape") handleEmergencyStop();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "1") { e.preventDefault(); switchPage("home"); }
      else if (e.key === "2") { e.preventDefault(); switchPage("assistant"); }
      else if (e.key === "3") { e.preventDefault(); switchPage("control"); }
      else if (e.key === "4") { e.preventDefault(); switchPage("settings"); }
      else if (e.key === "n" || e.key === "N") { e.preventDefault(); newConversation(); }
      else if (e.key === "k" || e.key === "K") { e.preventDefault(); openHistory(); }
    } else if (e.key === "Escape") {
      handleEmergencyStop();
    }
  });
}

function wireLaunchSequence() {
  const splash = $("#splashScreen");
  if (!splash) return;

  const settings = getSettings();
  if (settings.launchAnimationEnabled === false || typeof window === "undefined" || window.HSAI_TEST) {
    splash.hidden = true;
    return;
  }

  const fill = $("#splashProgress");
  const status = $("#splashStatusText");
  const skip = $("#splashSkipBtn");

  const dismiss = () => {
    splash.classList.add("fade-out");
    setTimeout(() => { splash.hidden = true; }, 400);
  };

  skip?.addEventListener("click", dismiss);
  splash.addEventListener("click", dismiss);

  if (fill) fill.style.width = "40%";
  setTimeout(() => {
    if (fill) fill.style.width = "75%";
    if (status) status.textContent = "SYNCHRONIZING PERSONAL MEMORY…";
  }, 350);

  setTimeout(() => {
    if (fill) fill.style.width = "100%";
    if (status) status.textContent = "VDPAI CORE ONLINE";
  }, 750);

  setTimeout(dismiss, 1200);
}

function autoGrow(input) {
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(120, Math.max(42, input.scrollHeight))}px`;
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

/* ----------------------------------------------------------------- appearance */
function applyAppearance() {
  const settings = getSettings();
  document.body.dataset.theme = settings.theme;
  document.body.classList.toggle("low-glow", settings.lowGlow);
  document.body.classList.toggle("reduce-motion", settings.reduceMotion);
  document.body.classList.toggle("no-grid", !settings.showGrid);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", "#02070a");
  if (!app.core) return;
  const reduced = settings.reduceMotion || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  app.core.reduced = Boolean(reduced);
  if (reduced) {
    app.core.stop();
    app.core.draw();
  } else {
    app.core.start();
  }
}

function syncQuickToggles() {
  updateVoiceChip();
  updateMicChip();
  refreshProviderUi();
}

function micLevel() {
  if (!app.voice) return 0;
  if (app.voice.isSpeaking) return 0.55;
  if (app.voice.isListening) return 0.38;
  if (app.busy) return 0.16;
  return 0;
}

/* ---------------------------------------------------------------------- start */
function start() {
  tickClock();
  boot().catch((error) => {
    const appNode = $("#app");
    if (appNode) appNode.hidden = false;
    const response = $("#responseText");
    if (response) {
      response.textContent = `VDPAI could not finish starting: ${error?.message || error}`;
      response.className = "response-text is-error";
    }
    ui.toast(`Startup error: ${error?.message || error}`, "error", 9000);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}

export { app };
