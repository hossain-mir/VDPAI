/* VDPAI — Authentication, Local Mode & Session Management.
 *
 * VDPAI is offline-first. By default, it operates in Local Mode with 100%
 * device-private storage. When an optional real backend server is configured,
 * authentication is performed securely against that real backend.
 */

import { $ } from "./ui.js";
import { getSettings, updateSettings, saveNow } from "./store.js";
import { toast, confirm } from "./ui.js";
import {
  testBackend,
  unlockBackend,
  revokeBackend,
  checkBackendSession,
  validateBackendUrl,
} from "./backend.js";

let authInitialized = false;

function showAlert(message, tone = "error") {
  const banner = $("#authAlertBanner");
  if (!banner) return;
  if (!message) {
    banner.style.display = "none";
    banner.textContent = "";
    banner.className = "auth-alert-banner";
    return;
  }
  banner.textContent = message;
  banner.className = `auth-alert-banner ${tone}`;
  banner.style.display = "block";
}

export function openAuthModal(defaultTab = "login") {
  const modal = $("#authModal");
  if (!modal) return;
  modal.hidden = false;
  modal.classList.add("is-active");
  showAlert("");

  const settings = getSettings();
  const serverInput = $("#authLoginServerUrl");
  if (serverInput && !serverInput.value && settings.backendUrl) {
    serverInput.value = settings.backendUrl;
  }
  const signupServerInput = $("#authSignupServerUrl");
  if (signupServerInput && !signupServerInput.value && settings.backendUrl) {
    signupServerInput.value = settings.backendUrl;
  }

  switchAuthTab(defaultTab);
}

export function closeAuthModal() {
  const modal = $("#authModal");
  if (!modal) return;
  modal.hidden = true;
  modal.classList.remove("is-active");
  showAlert("");
}

export function openPrivacyTerms() {
  const modal = $("#privacyTermsModal");
  if (!modal) return;
  modal.hidden = false;
  modal.classList.add("is-active");
}

export function closePrivacyTerms() {
  const modal = $("#privacyTermsModal");
  if (!modal) return;
  modal.hidden = true;
  modal.classList.remove("is-active");
}

export function switchAuthTab(tabName) {
  const tabs = document.querySelectorAll("#authTabs .auth-tab-btn");
  tabs.forEach((tab) => {
    const isActive = tab.getAttribute("data-tab") === tabName;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  const panels = document.querySelectorAll(".auth-tab-panel");
  panels.forEach((panel) => {
    const isTarget = panel.getAttribute("data-panel") === tabName;
    panel.style.display = isTarget ? (panel.tagName === "FORM" ? "flex" : "block") : "none";
    panel.classList.toggle("is-active", isTarget);
  });

  showAlert("");
}

export function updateAuthDisplay() {
  const settings = getSettings();
  const isServer = settings.authMode === "server" && Boolean(settings.backendUrl);

  const title = $("#authAccountModeTitle");
  const desc = $("#authAccountModeDesc");
  const badge = $("#authAccountBadge");
  const logoutBtn = $("#authLogoutBtn");

  if (title) {
    title.textContent = isServer ? "Active Mode: Remote Backend" : "Active Mode: Local (Guest)";
  }

  if (desc) {
    desc.textContent = isServer
      ? `Connected to ${settings.backendUrl} with authenticated session.`
      : "100% private on-device storage. No cloud tracking or remote account required.";
  }

  if (badge) {
    badge.textContent = isServer ? "SERVER CONNECTED" : "LOCAL MODE";
    badge.setAttribute("data-tone", isServer ? "ok" : "ok");
  }

  if (logoutBtn) {
    logoutBtn.style.display = isServer ? "inline-flex" : "none";
  }

  // Check session expiry if connected to server
  if (isServer && settings.sessionExpiresAt && Date.now() > settings.sessionExpiresAt) {
    toast("Server session expired. Please sign in again.", "warn", 4000);
    updateSettings({ authMode: "local", sessionExpiresAt: null });
    saveNow().catch(() => {});
    updateAuthDisplay();
  }
}

export async function handleLogout() {
  const settings = getSettings();
  if (settings.backendUrl) {
    await revokeBackend(settings.backendUrl);
  }
  updateSettings({
    authMode: "local",
    accountUser: "",
    sessionExpiresAt: null,
  });
  await saveNow().catch(() => {});
  updateAuthDisplay();
  toast("Signed out. Switched to Local Mode.", "ok", 2500);
}

function validateSignupPassword() {
  const pwdInput = $("#authSignupPassword");
  const confirmInput = $("#authSignupConfirmPassword");
  if (!pwdInput || !confirmInput) return false;

  const pwd = pwdInput.value || "";
  const conf = confirmInput.value || "";

  const ruleLen = $("#ruleLength");
  const ruleContent = $("#ruleContent");
  const ruleMatch = $("#ruleMatch");

  const isLen = pwd.length >= 8;
  const isContent = /[a-zA-Z]/.test(pwd) && /[0-9]/.test(pwd);
  const isMatch = pwd.length > 0 && pwd === conf;

  if (ruleLen) ruleLen.classList.toggle("valid", isLen);
  if (ruleContent) ruleContent.classList.toggle("valid", isContent);
  if (ruleMatch) ruleMatch.classList.toggle("valid", isMatch);

  return isLen && isContent && isMatch;
}

export function initAuth() {
  if (authInitialized) return;
  authInitialized = true;

  // Tab switching
  const tabBtns = document.querySelectorAll("#authTabs .auth-tab-btn");
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");
      if (tab) switchAuthTab(tab);
    });
  });

  // Modal close buttons
  $("#authCloseBtn")?.addEventListener("click", closeAuthModal);
  $("#privacyTermsCloseBtn")?.addEventListener("click", closePrivacyTerms);
  $("#privacyTermsDoneBtn")?.addEventListener("click", closePrivacyTerms);
  $("#openPrivacyTermsBtn")?.addEventListener("click", openPrivacyTerms);
  $("#authOpenTermsLink")?.addEventListener("click", openPrivacyTerms);
  $("#authOpenPrivacyLink")?.addEventListener("click", openPrivacyTerms);

  // Trigger buttons on Page 5
  $("#openAuthModalBtn")?.addEventListener("click", () => openAuthModal("login"));
  $("#authSwitchGuestBtn")?.addEventListener("click", () => {
    updateSettings({ authMode: "local" });
    saveNow().catch(() => {});
    updateAuthDisplay();
    toast("Local Mode Active (100% Private)", "ok", 2000);
  });
  $("#authLogoutBtn")?.addEventListener("click", handleLogout);

  // Link to recovery from login tab
  $("#authGoToRecoveryLink")?.addEventListener("click", () => switchAuthTab("recovery"));
  $("#authRecoveryBackToLoginBtn")?.addEventListener("click", () => switchAuthTab("login"));

  // Continue / Switch in Local Mode buttons
  const localModeActions = [
    $("#authLoginUseLocalBtn"),
    $("#authSignupUseLocalBtn"),
    $("#authRecoveryUseLocalBtn"),
    $("#authActivateLocalBtn"),
  ];
  localModeActions.forEach((btn) => {
    btn?.addEventListener("click", () => {
      updateSettings({ authMode: "local" });
      saveNow().catch(() => {});
      updateAuthDisplay();
      closeAuthModal();
      toast("Local Mode Active — Your Data Stays On Device", "ok", 2500);
    });
  });

  // Password visibility toggles
  const toggleButtons = [
    { btn: $("#authToggleLoginPasswordBtn"), input: $("#authLoginPassword") },
    { btn: $("#authToggleSignupPasswordBtn"), input: $("#authSignupPassword") },
    { btn: $("#authToggleSignupConfirmBtn"), input: $("#authSignupConfirmPassword") },
  ];
  toggleButtons.forEach(({ btn, input }) => {
    if (!btn || !input) return;
    btn.addEventListener("click", () => {
      const isPwd = input.type === "password";
      input.type = isPwd ? "text" : "password";
      btn.textContent = isPwd ? "Hide" : "Show";
    });
  });

  // Real-time password validation listeners
  $("#authSignupPassword")?.addEventListener("input", validateSignupPassword);
  $("#authSignupConfirmPassword")?.addEventListener("input", validateSignupPassword);

  // Handle Login submission
  $("#authLoginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    showAlert("");

    const serverUrl = ($("#authLoginServerUrl")?.value || "").trim();
    const username = ($("#authLoginUser")?.value || "").trim();
    const secret = ($("#authLoginPassword")?.value || "").trim();
    const remember = $("#authRememberSession")?.checked ?? true;

    if (!serverUrl) {
      showAlert(
        "Enter a backend server URL to sign in, or click 'Continue in Local Mode' to use VDPAI offline.",
        "warn",
      );
      return;
    }

    const checked = validateBackendUrl(serverUrl);
    if (!checked.ok) {
      showAlert(checked.error, "error");
      return;
    }

    if (!secret && !username) {
      showAlert("Enter your username / access token and password.", "warn");
      return;
    }

    const tokenToUse = secret || username;
    const submitBtn = $("#authLoginSubmitBtn");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Verifying…";
    }

    try {
      const result = await unlockBackend(checked.url, tokenToUse);
      if (!result.ok) {
        showAlert(result.error || "Authentication failed. Check your access token or server URL.", "error");
        return;
      }

      const expiresInSeconds = result.data?.expires_in || 86400;
      updateSettings({
        authMode: "server",
        backendUrl: checked.url,
        accountUser: username || "authenticated_user",
        rememberSession: remember,
        sessionExpiresAt: Date.now() + expiresInSeconds * 1000,
      });
      await saveNow().catch(() => {});
      updateAuthDisplay();
      closeAuthModal();
      toast("Server Authenticated Successfully!", "ok", 2500);
    } catch (err) {
      showAlert(String(err?.message || "Connection failed."), "error");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Sign In to Server";
      }
    }
  });

  // Handle Sign Up submission
  $("#authSignupForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    showAlert("");

    const serverUrl = ($("#authSignupServerUrl")?.value || "").trim();
    const username = ($("#authSignupUser")?.value || "").trim();
    const isValidPwd = validateSignupPassword();

    if (!isValidPwd) {
      showAlert("Password does not meet requirements or passwords do not match.", "warn");
      return;
    }

    if (!serverUrl) {
      showAlert(
        "VDPAI has no central tracking cloud. Enter your dedicated or self-hosted server URL, or tap 'Skip & Use Local Mode'.",
        "warn",
      );
      return;
    }

    const checked = validateBackendUrl(serverUrl);
    if (!checked.ok) {
      showAlert(checked.error, "error");
      return;
    }

    const submitBtn = $("#authSignupSubmitBtn");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Connecting…";
    }

    try {
      const probe = await testBackend(checked.url);
      if (!probe.ok) {
        showAlert(`Server is not responding: ${probe.error}`, "error");
        return;
      }

      const session = await checkBackendSession(checked.url);
      if (session.ok) {
        updateSettings({
          authMode: "server",
          backendUrl: checked.url,
          accountUser: username || "user",
          rememberSession: true,
        });
        await saveNow().catch(() => {});
        updateAuthDisplay();
        closeAuthModal();
        toast("Connected to backend server!", "ok", 2500);
      } else {
        showAlert(`Server replied: ${session.error}. Please sign in with your access token.`, "warn");
        switchAuthTab("login");
      }
    } catch (err) {
      showAlert(String(err?.message || "Registration connection failed."), "error");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Connect & Register";
      }
    }
  });

  // Wipe profile data handler
  $("#authWipeAccountBtn")?.addEventListener("click", async () => {
    const ok = await confirm(
      "Are you sure you want to reset your local profile data? This will clear all stored memories and conversations on this device.",
    );
    if (!ok) return;

    try {
      if (typeof localStorage !== "undefined") {
        localStorage.clear();
      }
      toast("Local profile data cleared.", "ok", 2000);
      closeAuthModal();
      setTimeout(() => window.location.reload(), 300);
    } catch {
      toast("Could not clear storage.", "warn", 2000);
    }
  });

  updateAuthDisplay();
}
