/* VDPAI — App & Phone Integrations, Device Controls, Hardware Toggles,
 * Action Safety Confirmations, and Emergency Stop.
 */

import * as ui from "./ui.js";
import { addHudLogEntry, getSettings, updateSettings } from "./store.js";

const $ = ui.$;
const $$ = ui.$$;

let integrationsBound = false;
let torchStream = null;
let torchActive = false;

export function initIntegrations(context = {}) {
  if (integrationsBound) return;
  integrationsBound = true;

  bindAppShortcuts();
  bindDeviceControls();
  bindEmergencyStop(context.onEmergencyStop);
  bindBackgroundAssistant();
  bindBatteryAndNetwork();
}

/* ----------------------------------------------------------- app shortcuts */
function bindAppShortcuts() {
  // WhatsApp
  $("#shortcutWhatsapp")?.addEventListener("click", () => {
    confirmExternalAction(
      "Open WhatsApp",
      "VDPAI will open WhatsApp to prepare a message. Do you want to proceed?",
      () => {
        window.open("https://wa.me/", "_blank");
      },
    );
  });

  // Phone / Dialer
  $("#shortcutPhone")?.addEventListener("click", () => {
    confirmExternalAction(
      "Open Phone Dialer",
      "VDPAI will launch the system phone dialer. No call will be placed automatically.",
      () => {
        window.location.href = "tel:";
      },
    );
  });

  // SMS
  $("#shortcutSms")?.addEventListener("click", () => {
    confirmExternalAction(
      "Open SMS Composer",
      "VDPAI will open your default messaging application to compose an SMS.",
      () => {
        window.location.href = "sms:";
      },
    );
  });

  // Email
  $("#shortcutEmail")?.addEventListener("click", () => {
    confirmExternalAction(
      "Draft Email",
      "VDPAI will launch your email client with a new message draft.",
      () => {
        window.location.href = "mailto:?subject=VDPAI%20Intelligence%20Briefing";
      },
    );
  });

  // Camera
  $("#shortcutCamera")?.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.capture = "environment";
    input.addEventListener("change", () => {
      if (input.files?.[0]) {
        ui.toast(`Captured: ${input.files[0].name}`, "ok");
      }
    });
    input.click();
  });

  // Maps / Navigation
  $("#shortcutMaps")?.addEventListener("click", () => {
    window.open("https://maps.google.com", "_blank");
  });

  // YouTube
  $("#shortcutYoutube")?.addEventListener("click", () => {
    window.open("https://www.youtube.com", "_blank");
  });

  // Web Browser
  $("#shortcutBrowser")?.addEventListener("click", () => {
    window.open("https://duckduckgo.com", "_blank");
  });

  // Spotify / Music
  $("#shortcutMusic")?.addEventListener("click", () => {
    window.open("https://open.spotify.com", "_blank");
  });

  // Settings Shortcut
  $("#shortcutSettings")?.addEventListener("click", () => {
    ui.toast("Open Android Settings from notification shade or swipe.", "ok");
  });
}

/** Never perform external actions silently without user review. */
export function confirmExternalAction(title, message, onConfirmed) {
  ui.confirm({
    title,
    text: message,
    confirmLabel: "Proceed",
    onConfirm: onConfirmed,
  });
}

/* --------------------------------------------------------- device controls */
function bindDeviceControls() {
  // Volume Slider
  const volSlider = $("#controlVolume");
  const volOutput = $("#controlVolumeVal");
  if (volSlider) {
    volSlider.addEventListener("input", () => {
      const val = parseFloat(volSlider.value) || 1;
      if (volOutput) volOutput.textContent = `${Math.round(val * 100)}%`;
      updateSettings({ volume: val });
    });
  }

  // Screen Brightness Tint Slider
  const brightSlider = $("#controlBrightness");
  const brightOutput = $("#controlBrightnessVal");
  if (brightSlider) {
    brightSlider.addEventListener("input", () => {
      const val = parseFloat(brightSlider.value) || 100;
      if (brightOutput) brightOutput.textContent = `${val}%`;
      const overlay = $("#brightnessOverlay");
      if (overlay) {
        // Opacity of dimming layer
        const dim = Math.max(0, Math.min(0.8, (100 - val) / 100 * 0.8));
        overlay.style.backgroundColor = `rgba(0, 0, 0, ${dim})`;
      }
    });
  }

  // Torch / Flashlight Toggle
  const torchBtn = $("#toggleTorchBtn");
  torchBtn?.addEventListener("click", async () => {
    await toggleTorch();
  });

  // Ping Latency Test
  $("#pingTestBtn")?.addEventListener("click", async () => {
    const resultEl = $("#pingTestResult");
    if (resultEl) resultEl.textContent = "Pinging…";
    const start = Date.now();
    try {
      await fetch(window.location.origin + "/assets/favicon.svg", { method: "HEAD", cache: "no-store" });
      const latency = Date.now() - start;
      if (resultEl) resultEl.textContent = `${latency} ms`;
    } catch {
      if (resultEl) resultEl.textContent = "Offline / Error";
    }
  });
}

async function toggleTorch() {
  const torchBtn = $("#toggleTorchBtn");
  const torchStatus = $("#torchStatus");

  if (torchActive) {
    if (torchStream) {
      torchStream.getTracks().forEach((track) => track.stop());
      torchStream = null;
    }
    torchActive = false;
    if (torchBtn) torchBtn.classList.remove("active");
    if (torchStatus) torchStatus.textContent = "OFF";
    ui.toast("Torch deactivated", "ok");
    return;
  }

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      ui.toast("Camera torch API is unavailable in this environment.", "warn");
      return;
    }
    torchStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
    const track = torchStream.getVideoTracks()[0];
    const capabilities = track.getCapabilities?.();
    if (capabilities?.torch) {
      await track.applyConstraints({ advanced: [{ torch: true }] });
      torchActive = true;
      if (torchBtn) torchBtn.classList.add("active");
      if (torchStatus) torchStatus.textContent = "ON";
      ui.toast("Torch activated", "ok");
    } else {
      ui.toast("Hardware torch constraint not supported on this camera.", "warn");
      track.stop();
      torchStream = null;
    }
  } catch {
    ui.toast("Torch permission denied or device busy.", "warn");
    if (torchStream) {
      torchStream.getTracks().forEach((t) => t.stop());
      torchStream = null;
    }
  }
}

/* ---------------------------------------------------------- emergency stop */
function bindEmergencyStop(onEmergencyStop) {
  const stopBtn = $("#emergencyStopBtn");
  stopBtn?.addEventListener("click", () => {
    // 1. Immediately cancel all Web Speech synthesis
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    // 2. Stop torch if active
    if (torchActive && torchStream) {
      torchStream.getTracks().forEach((track) => track.stop());
      torchStream = null;
      torchActive = false;
      const torchBtn = $("#toggleTorchBtn");
      if (torchBtn) torchBtn.classList.remove("active");
      const torchStatus = $("#torchStatus");
      if (torchStatus) torchStatus.textContent = "OFF";
    }

    // 3. Callback to app.js for voice and stream abortion
    onEmergencyStop?.();

    ui.toast("EMERGENCY STOP: Speech halted, microphone muted, tasks paused.", "error", 6000);
  });
}

/* ---------------------------------------------------- background assistant */
function bindBackgroundAssistant() {
  const bgBtn = $("#activateBackgroundBtn");
  if (bgBtn) {
    bgBtn.disabled = true;
    bgBtn.setAttribute("aria-disabled", "true");
  }
  const badge = $("#bgAssistantStatus");
  if (badge) badge.textContent = "UNAVAILABLE";
  updateSettings({ backgroundAssistantEnabled: false });
  addHudLogEntry("Background assistant status: STANDBY (foreground only).");
}

/* ----------------------------------------------------- battery and network */
function bindBatteryAndNetwork() {
  // Battery
  if (typeof navigator !== "undefined" && typeof navigator.getBattery === "function") {
    navigator.getBattery().then((battery) => {
      updateBatteryInfo(battery);
      battery.addEventListener("levelchange", () => updateBatteryInfo(battery));
      battery.addEventListener("chargingchange", () => updateBatteryInfo(battery));
    }).catch(() => {});
  }

  // Network
  updateNetworkInfo();
  window.addEventListener("online", updateNetworkInfo);
  window.addEventListener("offline", updateNetworkInfo);
}

function updateBatteryInfo(battery) {
  const pct = Math.round(battery.level * 100);
  const isCharging = battery.charging;
  const el = $("#hudBatteryText");
  if (el) el.textContent = `${pct}%${isCharging ? " ⚡" : ""}`;

  const ccBattery = $("#ccBatteryText");
  if (ccBattery) ccBattery.textContent = `${pct}% (${isCharging ? "Charging" : "Discharging"})`;
}

function updateNetworkInfo() {
  const online = navigator.onLine;
  const chipNet = $("#hudNetworkStatus");
  if (chipNet) {
    chipNet.textContent = online ? "ONLINE" : "OFFLINE";
    chipNet.dataset.tone = online ? "ok" : "bad";
  }

  const ccNet = $("#ccNetworkText");
  if (ccNet) {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const type = conn?.effectiveType ? ` (${conn.effectiveType.toUpperCase()})` : "";
    ccNet.textContent = `${online ? "Connected" : "Disconnected"}${type}`;
  }
}
