/* VDPAI — Security, PIN Lock, Biometrics & Privacy Dashboard (Part 7).
 *
 * Implements optional 4 or 6-digit application PIN lock with SHA-256
 * hashing, auto-lock timeouts, keypad interaction, and privacy controls.
 */

import { $ } from "./ui.js";
import { getSettings, updateSettings, saveNow } from "./store.js";
import { toast, confirm } from "./ui.js";

let securityInitialized = false;
let enteredPin = "";
let setupStep = 1; // 1 = enter new PIN, 2 = confirm new PIN
let firstEnteredPin = "";
let setupLength = 4;
let lastBackgroundTimestamp = 0;
let isLocked = false;

export async function hashPin(pin) {
  const encoder = new TextEncoder();
  const data = encoder.encode(String(pin));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isAppLocked() {
  return isLocked;
}

export function openPinLock() {
  const settings = getSettings();
  if (!settings.pinLockEnabled || !settings.pinHash) return;

  const overlay = $("#pinLockScreen");
  if (!overlay) return;

  isLocked = true;
  enteredPin = "";
  overlay.hidden = false;
  overlay.style.display = "flex";
  overlay.classList.remove("fade-out");

  renderPinDots("#lockPinDots", 0, settings.pinLength || 4);
  const statusEl = $("#pinLockStatus");
  if (statusEl) {
    statusEl.textContent = "Enter your PIN to unlock";
    statusEl.className = "pin-status-text";
  }
}

export function closePinLock() {
  const overlay = $("#pinLockScreen");
  if (!overlay) return;

  isLocked = false;
  enteredPin = "";
  overlay.classList.add("fade-out");
  setTimeout(() => {
    overlay.hidden = true;
    overlay.style.display = "none";
    overlay.classList.remove("fade-out");
  }, 300);
}

function renderPinDots(containerSelector, filledCount, totalCount) {
  const container = $(containerSelector);
  if (!container) return;
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }
  for (let i = 0; i < totalCount; i++) {
    const dot = document.createElement("span");
    dot.className = `pin-dot ${i < filledCount ? "filled" : ""}`;
    container.appendChild(dot);
  }
}

async function handleKeypadDigit(digit) {
  const settings = getSettings();
  const maxLen = settings.pinLength || 4;

  if (enteredPin.length < maxLen) {
    enteredPin += digit;
    renderPinDots("#lockPinDots", enteredPin.length, maxLen);
  }

  if (enteredPin.length === maxLen) {
    const hashed = await hashPin(enteredPin);
    if (hashed === settings.pinHash) {
      const statusEl = $("#pinLockStatus");
      if (statusEl) {
        statusEl.textContent = "Unlocked";
        statusEl.className = "pin-status-text success";
      }
      setTimeout(() => {
        closePinLock();
      }, 150);
    } else {
      const statusEl = $("#pinLockStatus");
      if (statusEl) {
        statusEl.textContent = "Incorrect PIN. Try again.";
        statusEl.className = "pin-status-text error";
      }
      const dotsContainer = $("#lockPinDots");
      dotsContainer?.classList.add("shake");
      setTimeout(() => {
        dotsContainer?.classList.remove("shake");
        enteredPin = "";
        renderPinDots("#lockPinDots", 0, maxLen);
      }, 500);
    }
  }
}

function handleKeypadBackspace() {
  const settings = getSettings();
  const maxLen = settings.pinLength || 4;
  if (enteredPin.length > 0) {
    enteredPin = enteredPin.slice(0, -1);
    renderPinDots("#lockPinDots", enteredPin.length, maxLen);
  }
}

/* ------------------------------------------------------------- Setup Modal */
export function openPinSetupModal() {
  const modal = $("#pinSetupModal");
  if (!modal) return;
  modal.hidden = false;
  modal.classList.add("is-active");

  const settings = getSettings();
  setupLength = settings.pinLength || 4;
  setupStep = 1;
  firstEnteredPin = "";
  enteredPin = "";

  const lenSelect = $("#pinSetupLengthSelect");
  if (lenSelect) lenSelect.value = String(setupLength);

  updateSetupUi();
}

export function closePinSetupModal() {
  const modal = $("#pinSetupModal");
  if (!modal) return;
  modal.hidden = true;
  modal.classList.remove("is-active");
  enteredPin = "";
  firstEnteredPin = "";
  setupStep = 1;
}

function updateSetupUi() {
  const promptEl = $("#pinSetupPrompt");
  if (promptEl) {
    promptEl.textContent = setupStep === 1
      ? `Enter a new ${setupLength}-digit PIN`
      : `Re-enter your ${setupLength}-digit PIN to confirm`;
  }
  renderPinDots("#setupPinDots", enteredPin.length, setupLength);
  const statusEl = $("#pinSetupStatus");
  if (statusEl) {
    statusEl.textContent = "";
    statusEl.className = "pin-status-text";
  }
}

async function handleSetupDigit(digit) {
  if (enteredPin.length < setupLength) {
    enteredPin += digit;
    renderPinDots("#setupPinDots", enteredPin.length, setupLength);
  }

  if (enteredPin.length === setupLength) {
    if (setupStep === 1) {
      firstEnteredPin = enteredPin;
      enteredPin = "";
      setupStep = 2;
      setTimeout(() => updateSetupUi(), 200);
    } else {
      if (enteredPin === firstEnteredPin) {
        const hashed = await hashPin(enteredPin);
        updateSettings({
          pinLockEnabled: true,
          pinHash: hashed,
          pinLength: setupLength,
        });
        await saveNow().catch(() => {});
        updateSecuritySettingsUi();
        toast("PIN Lock Enabled Successfully!", "ok", 2500);
        closePinSetupModal();
      } else {
        const statusEl = $("#pinSetupStatus");
        if (statusEl) {
          statusEl.textContent = "PINs do not match. Start over.";
          statusEl.className = "pin-status-text error";
        }
        const dotsContainer = $("#setupPinDots");
        dotsContainer?.classList.add("shake");
        setTimeout(() => {
          dotsContainer?.classList.remove("shake");
          setupStep = 1;
          firstEnteredPin = "";
          enteredPin = "";
          updateSetupUi();
        }, 600);
      }
    }
  }
}

function handleSetupBackspace() {
  if (enteredPin.length > 0) {
    enteredPin = enteredPin.slice(0, -1);
    renderPinDots("#setupPinDots", enteredPin.length, setupLength);
  }
}

/* ------------------------------------------------------------- UI Synchronization */
export function updateSecuritySettingsUi() {
  const settings = getSettings();
  const toggle = $("#pinLockToggle");
  if (toggle) toggle.checked = Boolean(settings.pinLockEnabled);

  const statusBadge = $("#pinLockStatusBadge");
  if (statusBadge) {
    statusBadge.textContent = settings.pinLockEnabled ? "ENABLED" : "DISABLED";
    statusBadge.setAttribute("data-tone", settings.pinLockEnabled ? "ok" : "warn");
  }

  const changeBtn = $("#changePinBtn");
  if (changeBtn) changeBtn.style.display = settings.pinLockEnabled ? "inline-flex" : "none";

  const autoLockSelect = $("#autoLockTimeoutSelect");
  if (autoLockSelect) autoLockSelect.value = String(settings.autoLockTimeout ?? 60);
}

export function initSecurity() {
  if (securityInitialized) return;
  securityInitialized = true;

  // Keypad numbers on Pin Lock Screen
  document.querySelectorAll("#lockKeypad .keypad-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = btn.getAttribute("data-val");
      if (val === "back") {
        handleKeypadBackspace();
      } else if (val === "clear") {
        enteredPin = "";
        const settings = getSettings();
        renderPinDots("#lockPinDots", 0, settings.pinLength || 4);
      } else if (val) {
        handleKeypadDigit(val);
      }
    });
  });

  // Keypad numbers on Pin Setup Modal
  document.querySelectorAll("#setupKeypad .keypad-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = btn.getAttribute("data-val");
      if (val === "back") {
        handleSetupBackspace();
      } else if (val === "clear") {
        enteredPin = "";
        renderPinDots("#setupPinDots", 0, setupLength);
      } else if (val) {
        handleSetupDigit(val);
      }
    });
  });

  $("#pinSetupCloseBtn")?.addEventListener("click", closePinSetupModal);
  $("#pinSetupCancelBtn")?.addEventListener("click", closePinSetupModal);

  $("#pinSetupLengthSelect")?.addEventListener("change", (e) => {
    setupLength = parseInt(e.target.value, 10) || 4;
    setupStep = 1;
    firstEnteredPin = "";
    enteredPin = "";
    updateSetupUi();
  });

  // Settings Toggles & Buttons
  $("#pinLockToggle")?.addEventListener("change", async (e) => {
    const isChecked = e.target.checked;
    const settings = getSettings();
    if (isChecked) {
      if (!settings.pinHash) {
        e.target.checked = false;
        openPinSetupModal();
      } else {
        updateSettings({ pinLockEnabled: true });
        await saveNow().catch(() => {});
        updateSecuritySettingsUi();
        toast("PIN Lock Enabled", "ok");
      }
    } else {
      const ok = await confirm("Disable PIN Lock for VDPAI?");
      if (ok) {
        updateSettings({ pinLockEnabled: false });
        await saveNow().catch(() => {});
        updateSecuritySettingsUi();
        toast("PIN Lock Disabled", "warn");
      } else {
        e.target.checked = true;
      }
    }
  });

  $("#changePinBtn")?.addEventListener("click", () => {
    openPinSetupModal();
  });

  $("#openSecuritySettingsBtn")?.addEventListener("click", () => {
    const cc = $("#controlCenter");
    if (cc) {
      document.querySelector('#ccTabs [data-tab="privacy"]')?.click();
      cc.hidden = false;
    }
  });

  $("#autoLockTimeoutSelect")?.addEventListener("change", (e) => {
    const val = parseInt(e.target.value, 10);
    updateSettings({ autoLockTimeout: val });
    saveNow().catch(() => {});
    toast("Auto-Lock timeout updated.", "ok", 1500);
  });

  // Auto-lock on app minimize / backgrounding
  document.addEventListener("visibilitychange", () => {
    const settings = getSettings();
    if (!settings.pinLockEnabled || !settings.pinHash) return;

    if (document.hidden) {
      lastBackgroundTimestamp = Date.now();
    } else {
      if (lastBackgroundTimestamp > 0 && settings.autoLockTimeout !== -1) {
        const elapsed = (Date.now() - lastBackgroundTimestamp) / 1000;
        if (elapsed >= (settings.autoLockTimeout || 60)) {
          openPinLock();
        }
      }
    }
  });

  // Check if app should be locked on fresh launch
  const currentSettings = getSettings();
  if (currentSettings.pinLockEnabled && currentSettings.pinHash) {
    if (typeof window !== "undefined" && !window.HSAI_TEST) {
      openPinLock();
    }
  }

  updateSecuritySettingsUi();
}
