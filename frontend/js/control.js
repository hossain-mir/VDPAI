/* VDPAI — Control Center: AI providers, voice, backend, privacy,
 * appearance and app information.  Every control writes real persistent
 * settings; every provider test performs a real network request.
 */

import {
  APP_ID,
  APP_NAME,
  APP_VERSION,
  addProvider,
  clearAllData,
  clearConversations,
  getActiveProvider,
  getConversations,
  getProvider,
  getProviders,
  getSettings,
  removeProvider,
  setActiveProvider,
  subscribe,
  updateProvider,
  updateSettings,
  usesNativeStorage,
  exportData,
  saveNow,
} from "./store.js";
import { PROVIDER_TYPES, providerType, resolveEndpoint, testProvider } from "./providers.js";
import { testBackend, validateBackendUrl } from "./backend.js";
import * as ui from "./ui.js";

const $ = ui.$;
const $$ = ui.$$;

let ctx = {
  voice: null,
  onSettingsChanged: () => {},
  onProviderChanged: () => {},
  onHistoryCleared: () => {},
  onDataCleared: () => {},
  openHistory: () => {},
};
let bound = false;
let editingProviderId = null;
let lastBackendResult = "No backend configured.";

const backendState = {
  state: "offline",
  detail: "not configured",
  latency: 0,
  checkedAt: 0,
};

/* ------------------------------------------------------------------- wiring */
export function initControlCenter(context = {}) {
  ctx = { ...ctx, ...context };
  ui.initConfirmDialog();
  if (bound) {
    refreshControlCenter();
    return;
  }
  bound = true;

  bindTabs();
  bindProviderEditor();
  bindSystemPrompt();
  bindVoiceControls();
  bindBackendControls();
  bindPrivacyControls();
  bindAppearanceControls();
  bindAbout();

  $("#controlBtn")?.addEventListener("click", () => openControlCenter("ai"));
  $("#ccClose")?.addEventListener("click", closeControlCenter);
  const ccOverlay = $("#controlCenter");
  ccOverlay?.addEventListener("click", (e) => {
    if (e.target === ccOverlay) closeControlCenter();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isControlCenterOpen()) closeControlCenter();
  });
  $$("#ccTabs [data-tab]").forEach((button) => {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  });

  subscribe(() => refreshControlCenter());
  refreshControlCenter();
}

export function attachVoice(voice) {
  ctx.voice = voice;
  voice.onVoices = (voices) => renderVoices(voices || []);
  voice.loadVoices?.().then((voices) => renderVoices(voices || [])).catch(() => {});
}

export function openControlCenter(tab = "ai") {
  ui.openOverlay("controlCenter");
  activateTab(tab);
  refreshControlCenter();
  if (tab === "voice") {
    ctx.voice?.loadVoices?.().then((voices) => renderVoices(voices || [])).catch(() => {});
  }
}

export function closeControlCenter() {
  ui.closeOverlay("controlCenter");
}

export function isControlCenterOpen() {
  return !$("#controlCenter")?.hidden;
}

function activateTab(tab) {
  const target = ["ai", "voice", "backend", "privacy", "appearance", "about"].includes(tab) ? tab : "ai";
  $$("#ccTabs [data-tab]").forEach((button) => {
    const active = button.dataset.tab === target;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  $$(".cc-page").forEach((page) => {
    const active = page.dataset.page === target;
    page.hidden = !active;
    page.classList.toggle("is-active", active);
  });
  if (target === "backend") refreshBackendUi();
  if (target === "privacy") refreshPrivacy();
  if (target === "about") refreshAbout();
  if (target === "voice") refreshVoice();
}

function bindTabs() {
  // keyboard support: left/right moves between tabs
  $("#ccTabs")?.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const buttons = $$("#ccTabs [data-tab]");
    const index = buttons.findIndex((button) => button.classList.contains("is-active"));
    const next = (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
    activateTab(buttons[next]?.dataset.tab);
  });
}

/* ---------------------------------------------------------------- providers */
function bindProviderEditor() {
  $("#addProviderBtn")?.addEventListener("click", () => openProviderEditor());
  $("#providerType")?.addEventListener("change", () => applyTypeDefaults(true));
  $("#toggleKeyBtn")?.addEventListener("click", toggleKeyVisibility);
  $("#providerForm")?.addEventListener("submit", saveProviderForm);
  $("#providerTestBtn")?.addEventListener("click", testDraftProvider);
  $("#providerCancelBtn")?.addEventListener("click", closeProviderEditor);
  $("#providerCancelBtn2")?.addEventListener("click", closeProviderEditor);

  const modal = $("#providerModal");
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) closeProviderEditor();
  });

  const select = $("#providerType");
  if (select) {
    for (const [value, spec] of Object.entries(PROVIDER_TYPES)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = spec.label;
      select.appendChild(option);
    }
  }
}

function openProviderEditor(providerId = null) {
  editingProviderId = providerId;
  const provider = providerId ? getProvider(providerId) : null;
  $("#providerForm")?.reset();
  $("#providerError").textContent = "";
  $("#providerTestOutput").hidden = true;
  $("#providerTestOutput").textContent = "";
  $("#providerKey").type = "password";
  $("#toggleKeyBtn").textContent = "Show";
  $("#toggleKeyBtn").setAttribute("aria-label", "Show API key");
  $("#providerId").value = provider?.id || "";
  $("#providerFormTitle").textContent = provider ? "Edit API" : "Add API";
  $("#providerFormKicker").textContent = provider ? "EDIT CONFIGURATION" : "NEW CONFIGURATION";
  $("#providerSaveBtn").textContent = provider ? "Save changes" : "Save API";

  const type = provider?.type || "openai";
  $("#providerType").value = type;
  $("#providerName").value = provider?.name || providerType(type).label;
  $("#providerKey").value = provider?.apiKey || "";
  $("#providerModel").value = provider?.model || providerType(type).defaultModel;
  $("#providerBase").value = provider?.baseUrl || "";
  $("#providerEndpoint").value = provider?.endpoint || "";
  applyTypeDefaults(false);
  ui.openModal("providerModal");
}

function closeProviderEditor() {
  editingProviderId = null;
  ui.closeModal("providerModal");
}

function applyTypeDefaults(force) {
  const type = $("#providerType")?.value || "openai";
  const spec = providerType(type);
  const base = $("#providerBase");
  const model = $("#providerModel");
  const endpoint = $("#providerEndpoint");
  const list = $("#providerModelList");
  const hint = $("#providerHint");
  if (force || !base.value) base.value = spec.baseUrl || "";
  if (force || !model.value) model.value = spec.defaultModel || "";
  if (force || !endpoint.value) endpoint.value = spec.endpoint || "";
  base.placeholder = spec.baseUrl || "https://your-endpoint.example/v1";
  endpoint.placeholder = spec.endpoint || "/chat/completions";
  model.placeholder = spec.defaultModel || "model-id";
  if (list) {
    list.textContent = "";
    for (const item of spec.models || []) {
      const option = document.createElement("option");
      option.value = item;
      list.appendChild(option);
    }
  }
  if (hint) {
    hint.textContent = spec.requiresKey
      ? "This provider requires an API key. It is stored only in this app's private storage."
      : "A custom OpenAI-compatible endpoint. Leave the key empty for local servers that do not require one.";
  }
  if (force) $("#providerTestOutput").hidden = true;
}

function toggleKeyVisibility() {
  const input = $("#providerKey");
  const button = $("#toggleKeyBtn");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  button.textContent = show ? "Hide" : "Show";
  button.setAttribute("aria-label", show ? "Hide API key" : "Show API key");
}

function readProviderForm() {
  const type = $("#providerType").value;
  const spec = providerType(type);
  return {
    id: editingProviderId || undefined,
    name: $("#providerName").value.trim(),
    type,
    apiKey: $("#providerKey").value.trim(),
    model: $("#providerModel").value.trim(),
    baseUrl: $("#providerBase").value.trim(),
    endpoint: $("#providerEndpoint").value.trim(),
    requiresKey: spec.requiresKey,
  };
}

function formError(message) {
  const node = $("#providerError");
  if (node) node.textContent = message || "";
  return !message;
}

function validateDraft(provider) {
  if (!provider.name) return formError("Enter a display name for this provider.");
  if (!provider.model) return formError("Enter the model ID, for example gpt-4o-mini.");
  if (provider.requiresKey && !provider.apiKey) return formError("Enter the API key for this provider.");
  if (provider.type === "custom" && !provider.baseUrl) return formError("Enter the Base URL for the custom endpoint.");
  if (provider.baseUrl && !/^https?:\/\//i.test(provider.baseUrl)) {
    return formError("The Base URL must start with https:// (http:// is only for local development).");
  }
  try {
    resolveEndpoint(provider);
  } catch (error) {
    return formError(error.message);
  }
  return formError("");
}

async function testDraftProvider() {
  const draft = readProviderForm();
  if (!validateDraft(draft)) return;
  const button = $("#providerTestBtn");
  const output = $("#providerTestOutput");
  button.disabled = true;
  output.hidden = false;
  output.textContent = `Testing ${draft.name} with a real request…`;
  try {
    const result = await testProvider(draft);
    if (result.ok) {
      output.textContent =
        `Connected · ${result.latency} ms\n` +
        `Model: ${draft.model}\nSample: ${result.sample}`;
      ui.toast(`${draft.name} connected in ${result.latency} ms.`, "ok", 5000);
    } else {
      output.textContent =
        `FAILED · ${result.status}${result.httpStatus ? ` · HTTP ${result.httpStatus}` : ""}\n` +
        `${result.error}${result.detail ? `\n${result.detail}` : ""}`;
      ui.toast(result.error || "Provider test failed.", "error", 7000);
    }
  } finally {
    button.disabled = false;
  }
}

function saveProviderForm(event) {
  event.preventDefault();
  const draft = readProviderForm();
  if (!validateDraft(draft)) return;
  try {
    let provider;
    if (editingProviderId) {
      provider = updateProvider(editingProviderId, draft);
    } else {
      provider = addProvider(draft);
      if (!getActiveProvider()) setActiveProvider(provider.id);
    }
    ui.toast(editingProviderId ? "Provider configuration updated." : "Provider added.", "ok");
    closeProviderEditor();
    refreshControlCenter();
    ctx.onProviderChanged?.();
    saveNow().catch(() => {});
  } catch (error) {
    formError(error.message);
  }
}

function renderProviders(providers) {
  const host = $("#providerList");
  if (!host) return;
  host.textContent = "";
  if (!providers.length) {
    host.appendChild(
      ui.el(
        "div",
        "provider-empty",
        "No AI provider configured. Add one to start chatting. The HUD works offline without one.",
      ),
    );
    return;
  }
  const active = getActiveProvider();
  for (const provider of providers) {
    const card = ui.el("article", `provider-card${active?.id === provider.id ? " is-active" : ""}`);
    const header = ui.el("header");
    const titleWrap = ui.el("div");
    titleWrap.appendChild(ui.el("h3", "", provider.name));
    titleWrap.appendChild(ui.el("span", "provider-type", providerType(provider.type).label));
    header.appendChild(titleWrap);
    if (active?.id === provider.id) {
      const badge = ui.el("span", "chip", "ACTIVE");
      badge.dataset.tone = "ok";
      header.appendChild(badge);
    }
    card.appendChild(header);

    const meta = ui.el("div", "provider-meta");
    meta.appendChild(ui.el("span", "", `Model: ${provider.model}`));
    let endpoint = "not configured";
    try {
      endpoint = resolveEndpoint(provider);
    } catch {
      /* keep honest label */
    }
    meta.appendChild(ui.el("span", "", `Endpoint: ${endpoint}`));
    meta.appendChild(ui.el("span", "", `Credential: ${provider.apiKey ? "saved" : "not set"}`));
    card.appendChild(meta);

    const actions = ui.el("div", "provider-actions");
    if (active?.id !== provider.id) {
      const select = ui.el("button", "btn tiny primary", "Select");
      select.type = "button";
      select.addEventListener("click", () => {
        try {
          setActiveProvider(provider.id);
          ui.toast(`${provider.name} is now the active provider.`, "ok");
          refreshControlCenter();
          ctx.onProviderChanged?.();
        } catch (error) {
          ui.toast(error.message, "error");
        }
      });
      actions.appendChild(select);
    }
    const edit = ui.el("button", "btn tiny", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => openProviderEditor(provider.id));
    actions.appendChild(edit);

    const test = ui.el("button", "btn tiny", "Test");
    test.type = "button";
    actions.appendChild(test);

    const remove = ui.el("button", "btn tiny danger-ghost", "Delete");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      const ok = await ui.confirmAction({
        title: `Delete ${provider.name}?`,
        text: `This removes the saved API key and configuration from this device. Conversations are kept.`,
        confirmLabel: "Delete API",
      });
      if (!ok) return;
      removeProvider(provider.id);
      ui.toast("Provider configuration deleted.", "ok");
      refreshControlCenter();
      ctx.onProviderChanged?.();
      saveNow().catch(() => {});
    });
    actions.appendChild(remove);
    card.appendChild(actions);

    const status = ui.el("div", "provider-status", "Not tested on this device.");
    card.appendChild(status);
    test.addEventListener("click", async () => {
      test.disabled = true;
      status.dataset.tone = "";
      status.textContent = "Testing with a real request…";
      try {
        const result = await testProvider(provider);
        if (result.ok) {
          status.dataset.tone = "ok";
          status.textContent = `Connected · ${result.latency} ms · "${result.sample}"`;
          ui.toast(`${provider.name} is reachable.`, "ok", 4000);
        } else {
          status.dataset.tone = "error";
          status.textContent = `Failed${result.httpStatus ? ` · HTTP ${result.httpStatus}` : ""} · ${result.error}`;
          ui.toast(result.error || "Provider test failed.", "error", 6000);
        }
      } finally {
        test.disabled = false;
      }
    });

    host.appendChild(card);
  }
}

function refreshActiveProvider() {
  const provider = getActiveProvider();
  const summary = $("#activeProviderSummary");
  if (summary) {
    summary.textContent = "";
    summary.appendChild(ui.el("span", "kicker", "ACTIVE PROVIDER"));
    if (provider) {
      summary.appendChild(ui.el("strong", "", provider.name));
      summary.appendChild(ui.el("small", "", `${providerType(provider.type).label} · ${provider.model}`));
    } else {
      summary.appendChild(ui.el("strong", "", "Not configured"));
      summary.appendChild(ui.el("small", "", "Add a provider to start chatting."));
    }
  }
}

function bindSystemPrompt() {
  $("#saveSystemPrompt")?.addEventListener("click", () => {
    const value = $("#systemPrompt").value.trim();
    if (!value) {
      ui.toast("System instructions cannot be empty.", "warn");
      return;
    }
    updateSettings({ systemPrompt: value });
    const note = $("#systemPromptNote");
    if (note) note.textContent = "Saved.";
    ui.toast("System instructions saved.", "ok", 2500);
    saveNow().catch(() => {});
    setTimeout(() => {
      if (note) note.textContent = "";
    }, 2500);
  });
}

/* -------------------------------------------------------------------- voice */
function bindVoiceControls() {
  $("#ttsToggle")?.addEventListener("change", (event) => {
    updateSettings({ ttsEnabled: event.target.checked });
    ctx.voice?.setTtsEnabled?.(event.target.checked);
    if (!event.target.checked) ctx.voice?.stopSpeaking();
    ctx.onSettingsChanged?.();
    saveNow().catch(() => {});
  });

  $("#languageSelect")?.addEventListener("change", (event) => {
    updateSettings({ language: event.target.value });
    ctx.onSettingsChanged?.();
    saveNow().catch(() => {});
  });

  $("#voiceSelect")?.addEventListener("change", (event) => {
    updateSettings({ voiceName: event.target.value });
    saveNow().catch(() => {});
  });

  $("#speechRate")?.addEventListener("input", (event) => {
    const value = Number(event.target.value);
    updateSettings({ speechRate: value });
    const out = $("#speechRateValue");
    if (out) out.textContent = `${value.toFixed(2).replace(/0$/, "")}×`;
  });

  $("#speechVolume")?.addEventListener("input", (event) => {
    const value = Number(event.target.value);
    updateSettings({ volume: value });
    const out = $("#speechVolumeValue");
    if (out) out.textContent = `${Math.round(value * 100)}%`;
  });

  $("#testVoiceBtn")?.addEventListener("click", async () => {
    if (!ctx.voice) return;
    const note = $("#voiceStatus");
    if (note) {
      note.dataset.tone = "";
      note.textContent = "Requesting speech output…";
    }
    const result = await ctx.voice.speak(
      "VDPAI voice check. Android text to speech is working with the selected settings.",
    );
    if (note) {
      note.dataset.tone = result.ok ? "ok" : "error";
      note.textContent = result.ok ? "Test phrase finished." : result.error;
    }
  });

  $("#stopVoiceBtn2")?.addEventListener("click", () => {
    ctx.voice?.stopSpeaking();
    const note = $("#voiceStatus");
    if (note) note.textContent = "Speech stopped.";
  });

  $("#micPermissionBtn")?.addEventListener("click", () => checkMic($("#voiceCapabilities")));
  $("#privacyPermissionBtn")?.addEventListener("click", () => checkMic($("#privacyPermissionResult")));
}

function checkMic(target) {
  if (!ctx.voice) return;
  const note = target || $("#voiceCapabilities");
  if (note) note.textContent = "Requesting microphone permission…";
  ctx.voice.requestMic().then((result) => {
    if (note) {
      note.dataset.tone = result.ok ? "ok" : "error";
      note.textContent = result.ok
        ? "Microphone permission granted."
        : `Microphone permission not granted: ${result.error}`;
    }
  });
}

function renderVoices(voices) {
  const select = $("#voiceSelect");
  const count = $("#voiceCount");
  if (!select) return;
  const settings = getSettings();
  const current = settings.voiceName || "";
  select.textContent = "";
  const system = document.createElement("option");
  system.value = "";
  system.textContent = "System default";
  select.appendChild(system);
  const grouped = [...voices].sort((a, b) => String(a.lang).localeCompare(String(b.lang)));
  for (const voice of grouped) {
    const option = document.createElement("option");
    option.value = voice.uri || voice.name;
    option.textContent = `${voice.name} (${voice.lang || "unknown"})`;
    select.appendChild(option);
  }
  select.value = grouped.some((voice) => (voice.uri || voice.name) === current) ? current : "";
  if (count) count.textContent = grouped.length ? `${grouped.length} available` : "no extra voices reported";
}

function refreshVoice() {
  const settings = getSettings();
  const tts = $("#ttsToggle");
  if (tts) tts.checked = settings.ttsEnabled;
  const language = $("#languageSelect");
  if (language) language.value = settings.language;
  const rate = $("#speechRate");
  if (rate) rate.value = String(settings.speechRate);
  const rateOut = $("#speechRateValue");
  if (rateOut) rateOut.textContent = `${Number(settings.speechRate).toFixed(2).replace(/0$/, "")}×`;
  const volume = $("#speechVolume");
  if (volume) volume.value = String(settings.volume);
  const volumeOut = $("#speechVolumeValue");
  if (volumeOut) volumeOut.textContent = `${Math.round(Number(settings.volume) * 100)}%`;
  renderVoices(ctx.voice?.voices || []);

  const capabilities = $("#voiceCapabilities");
  if (capabilities && ctx.voice) {
    const input = ctx.voice.inputAvailable;
    const output = ctx.voice.outputAvailable;
    capabilities.dataset.tone = input && output ? "ok" : "warn";
    capabilities.textContent = `${input ? "Speech input available" : `Speech input unavailable: ${ctx.voice.unsupportedInputReason()}`} · ${
      output ? "voice output available" : `voice output unavailable: ${ctx.voice.unsupportedOutputReason()}`
    }`;
  }
  ui.fillFacts($("#voiceFacts"), [
    ["Recognition", ctx.voice?.hasNative ? "Android SpeechRecognizer (native)" : ctx.voice?.inputAvailable ? "Web Speech API" : "unavailable"],
    ["Text-to-speech", ctx.voice?.hasNative ? "Android TextToSpeech (native)" : ctx.voice?.outputAvailable ? "Web Speech API" : "unavailable"],
    ["Spoken replies", settings.ttsEnabled ? "enabled" : "disabled"],
    ["Recognition language", settings.language],
    ["Selected voice", settings.voiceName || "system default"],
    ["Speech rate", `${settings.speechRate}×`],
  ]);
}

/* ------------------------------------------------------------------ backend */
function bindBackendControls() {
  $("#backendForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const checked = validateBackendUrl($("#backendUrl").value);
    if (!checked.ok) {
      setBackendResult(checked.error, "error");
      return;
    }
    updateSettings({ backendUrl: checked.url });
    saveNow().catch(() => {});
    setBackendResult("Saved. Testing the real connection…");
    const result = await testBackend(checked.url);
    applyBackendResult(result);
    if (checked.url) lastBackendResult = result.ok ? `Connected in ${result.latency} ms.` : result.error;
    ctx.onSettingsChanged?.();
  });

  $("#backendTestBtn")?.addEventListener("click", async () => {
    const checked = validateBackendUrl($("#backendUrl").value);
    if (!checked.ok) {
      setBackendResult(checked.error, "error");
      return;
    }
    if (!checked.url) {
      setBackendResult("No backend URL entered. The HUD works locally.", "warn");
      return;
    }
    setBackendResult("Testing with a real HTTP request…");
    const result = await testBackend(checked.url);
    lastBackendResult = result.ok ? `Connected in ${result.latency} ms.` : result.error;
    applyBackendResult(result);
  });

  $("#backendDisconnectBtn")?.addEventListener("click", () => {
    backendState.state = "offline";
    backendState.detail = "disconnected by user";
    lastBackendResult = "Disconnected. Saved URL kept; press Test or Save & connect to resume.";
    refreshBackendUi();
    setBackendResult(lastBackendResult, "warn");
    ctx.onBackendChanged?.({ state: "offline", detail: "disconnected" });
  });

  $("#backendClearBtn")?.addEventListener("click", async () => {
    const ok = await ui.confirmAction({
      title: "Clear backend URL?",
      text: "The HUD continues to work offline. Only the saved backend address is removed.",
      confirmLabel: "Clear URL",
    });
    if (!ok) return;
    updateSettings({ backendUrl: "" });
    saveNow().catch(() => {});
    const input = $("#backendUrl");
    if (input) input.value = "";
    backendState.state = "offline";
    backendState.detail = "not configured";
    lastBackendResult = "Backend URL cleared. The HUD works offline.";
    refreshBackendUi();
    setBackendResult(lastBackendResult, "warn");
    ctx.onBackendChanged?.({ state: "offline", detail: "not configured" });
  });
}

function setBackendResult(message, tone = "") {
  const node = $("#backendResult");
  if (!node) return;
  node.textContent = message || "";
  node.dataset.tone = tone;
}

function applyBackendResult(result) {
  if (result.ok) {
    backendState.state = "online";
    backendState.detail = `${result.health} · ${result.url}`;
    backendState.latency = result.latency;
    backendState.checkedAt = Date.now();
    setBackendResult(`Connected · ${result.health} · ${result.latency} ms${result.warning ? ` · ${result.warning}` : ""}`, "ok");
    ui.toast("Backend replied successfully.", "ok", 3500);
  } else {
    backendState.state = "offline";
    backendState.detail = result.error || "connection failed";
    backendState.latency = result.latency || 0;
    backendState.checkedAt = Date.now();
    setBackendResult(`Not connected: ${result.error}${result.detail ? ` (${result.detail})` : ""}`, "error");
    ui.toast(result.error || "Backend connection failed.", "error", 6000);
  }
  refreshBackendUi();
  ctx.onBackendChanged?.(backendState);
}

export function setBackendStatus(patch = {}) {
  Object.assign(backendState, patch);
  refreshBackendUi();
}

function refreshBackendUi() {
  const settings = getSettings();
  const input = $("#backendUrl");
  if (input && document.activeElement !== input) input.value = settings.backendUrl;
  ui.fillFacts($("#backendFacts"), [
    ["Configured URL", settings.backendUrl || "none"],
    ["Status", backendState.state === "online" ? "online" : "offline"],
    ["Detail", backendState.detail],
    ["Last latency", backendState.latency ? `${backendState.latency} ms` : "—"],
    ["Last checked", backendState.checkedAt ? ui.relativeTime(backendState.checkedAt) : "never"],
  ]);
  const node = $("#backendResult");
  if (node && !node.textContent) node.textContent = lastBackendResult;
}

/* ------------------------------------------------------------------ privacy */
function bindPrivacyControls() {
  $("#clearHistoryBtn")?.addEventListener("click", async () => {
    const ok = await ui.confirmAction({
      title: "Clear all conversations?",
      text: "Every locally stored conversation and message will be permanently deleted. AI provider configurations are kept.",
      confirmLabel: "Clear conversations",
    });
    if (!ok) return;
    clearConversations();
    await saveNow().catch(() => {});
    refreshPrivacy();
    ctx.onHistoryCleared?.();
    ui.toast("Conversation history cleared.", "ok");
  });

  $("#exportHistoryBtn")?.addEventListener("click", () => {
    const ok = ui.downloadJson(`hsai-2.0-export-${new Date().toISOString().slice(0, 10)}.json`, exportData());
    ui.toast(ok ? "Export created. API keys are redacted." : "Export is not supported in this WebView.", ok ? "ok" : "error");
  });

  $("#clearAllDataBtn")?.addEventListener("click", async () => {
    const ok = await ui.confirmAction({
      title: "Delete all local data?",
      text: "This permanently removes API keys, provider configurations, settings and every conversation from this device. This cannot be undone.",
      confirmLabel: "Delete everything",
    });
    if (!ok) return;
    await clearAllData();
    ui.toast("All local VDPAI data deleted.", "ok", 4000);
    ctx.onDataCleared?.();
  });
}

function refreshPrivacy() {
  const providers = getProviders();
  const conversations = getConversations();
  const messages = conversations.reduce((sum, conversation) => sum + conversation.messages.length, 0);
  const settings = getSettings();
  ui.fillFacts($("#privacyFacts"), [
    ["Storage", usesNativeStorage() ? "Android app-private Preferences" : "browser localStorage"],
    ["Conversations", String(conversations.length)],
    ["Messages", String(messages)],
    ["Providers", String(providers.length)],
    ["Stored API keys", String(providers.filter((provider) => provider.apiKey).length)],
    ["Backend", settings.backendUrl ? "configured" : "not configured"],
  ]);
  const stats = $("#historyStats");
  if (stats) {
    stats.textContent = conversations.length
      ? `${conversations.length} conversation${conversations.length === 1 ? "" : "s"} · ${messages} message${messages === 1 ? "" : "s"} stored locally.`
      : "No conversations stored yet.";
  }
  const note = $("#privacyStorageNote");
  if (note) {
    note.textContent = usesNativeStorage()
      ? "The Android build stores data in the app's private directory. It is not uploaded anywhere by VDPAI."
      : "This browser stores data in localStorage for this site. Clearing browser data removes it.";
  }
  const permission = $("#privacyPermissionResult");
  if (permission && !permission.textContent) permission.textContent = "Not checked yet.";
}

/* --------------------------------------------------------------- appearance */
function bindAppearanceControls() {
  $("#themeModeSelect")?.addEventListener("change", (event) => {
    updateSettings({ themeMode: event.target.value });
    ctx.onSettingsChanged?.();
    saveNow().catch(() => {});
  });
  $("#themeSelect")?.addEventListener("change", (event) => {
    updateSettings({ theme: event.target.value });
    ctx.onSettingsChanged?.();
    saveNow().catch(() => {});
  });
  $("#fontSizeSelect")?.addEventListener("change", (event) => {
    updateSettings({ fontSize: event.target.value });
    ctx.onSettingsChanged?.();
    saveNow().catch(() => {});
  });
  $("#bubbleStyleSelect")?.addEventListener("change", (event) => {
    updateSettings({ bubbleStyle: event.target.value });
    ctx.onSettingsChanged?.();
    saveNow().catch(() => {});
  });
  $("#glowSelect")?.addEventListener("change", (event) => {
    const val = event.target.value;
    updateSettings({ glowIntensity: val, lowGlow: val === "off" });
    ctx.onSettingsChanged?.();
    saveNow().catch(() => {});
  });
  $("#lowGlowToggle")?.addEventListener("change", (event) => {
    updateSettings({ lowGlow: event.target.checked });
    ctx.onSettingsChanged?.();
    saveNow().catch(() => {});
  });
  $("#reduceMotionToggle")?.addEventListener("change", (event) => {
    updateSettings({ reduceMotion: event.target.checked });
    ctx.onSettingsChanged?.();
    saveNow().catch(() => {});
  });
  $("#gridToggle")?.addEventListener("change", (event) => {
    updateSettings({ showGrid: event.target.checked });
    ctx.onSettingsChanged?.();
    saveNow().catch(() => {});
  });
  $("#glassToggle")?.addEventListener("change", (event) => {
    updateSettings({ glassEffect: event.target.checked });
    ctx.onSettingsChanged?.();
    saveNow().catch(() => {});
  });
  $("#launchAnimToggle")?.addEventListener("change", (event) => {
    updateSettings({ launchAnimationEnabled: event.target.checked });
    ctx.onSettingsChanged?.();
    saveNow().catch(() => {});
  });
}

function refreshAppearance() {
  const settings = getSettings();
  const themeMode = $("#themeModeSelect");
  if (themeMode) themeMode.value = settings.themeMode || "light";
  const theme = $("#themeSelect");
  if (theme) theme.value = settings.theme || "cyan";
  const fontSize = $("#fontSizeSelect");
  if (fontSize) fontSize.value = settings.fontSize || "medium";
  const bubbleStyle = $("#bubbleStyleSelect");
  if (bubbleStyle) bubbleStyle.value = settings.bubbleStyle || "comfortable";
  const glow = $("#glowSelect");
  if (glow) glow.value = settings.lowGlow ? "off" : (settings.glowIntensity || "medium");
  const lowGlow = $("#lowGlowToggle");
  if (lowGlow) lowGlow.checked = Boolean(settings.lowGlow);
  const motion = $("#reduceMotionToggle");
  if (motion) motion.checked = Boolean(settings.reduceMotion);
  const grid = $("#gridToggle");
  if (grid) grid.checked = Boolean(settings.showGrid);
  const glass = $("#glassToggle");
  if (glass) glass.checked = settings.glassEffect !== false;
  const anim = $("#launchAnimToggle");
  if (anim) anim.checked = settings.launchAnimationEnabled !== false;
}

/* -------------------------------------------------------------------- about */
function bindAbout() {}

function refreshAbout() {
  const settings = getSettings();
  ui.fillFacts($("#aboutFacts"), [
    ["Application", APP_NAME],
    ["Version", APP_VERSION],
    ["Build", "GitHub Actions debug"],
    ["Application ID", APP_ID],
    ["Platform", window.Capacitor?.isNativePlatform?.() ? "Android (Capacitor)" : "Browser"],
    ["Providers supported", "OpenAI · Gemini · Groq · OpenRouter · Anthropic · DeepSeek · Mistral · custom"],
    ["Active provider", getActiveProvider()?.name || "none"],
    ["Storage", usesNativeStorage() ? "app-private Preferences" : "browser localStorage"],
    ["Backend", settings.backendUrl || "optional / not configured"],
  ]);
}

/* ------------------------------------------------------------------ refresh */
export function refreshControlCenter() {
  const settings = getSettings();
  renderProviders(getProviders());
  refreshActiveProvider();
  if ($("#systemPrompt") && document.activeElement !== $("#systemPrompt")) {
    $("#systemPrompt").value = settings.systemPrompt;
  }
  refreshVoice();
  refreshBackendUi();
  refreshPrivacy();
  refreshAppearance();
  refreshAbout();
}
