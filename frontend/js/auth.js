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
  dbSaveUser,
  dbGetUser,
  dbDeleteUser,
  hashPassword,
  generateSalt,
} from "./db.js";
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
  const hasUser = Boolean(settings.accountUser && settings.isLoggedIn);

  const title = $("#authAccountModeTitle");
  const desc = $("#authAccountModeDesc");
  const badge = $("#authAccountBadge");
  const logoutBtn = $("#authLogoutBtn");
  const deleteBtn = $("#authDeleteAccountBtn");
  const heroName = $("#profileHeroName");
  const heroRole = $("#profileHeroRole");

  if (heroName) {
    heroName.textContent = settings.accountUser || settings.userName || "Sir";
  }
  if (heroRole) {
    heroRole.textContent = hasUser
      ? (isServer ? "VERIFIED ACCOUNT · SERVER" : "VERIFIED ACCOUNT · ON-DEVICE")
      : "PRIMARY PROFILE · GUEST";
  }

  if (title) {
    if (isServer) {
      title.textContent = `Active Mode: Remote Backend (${settings.accountUser || "User"})`;
    } else if (hasUser) {
      title.textContent = `Active Account: ${settings.accountUser}`;
    } else {
      title.textContent = "Active Mode: Local (Guest)";
    }
  }

  if (desc) {
    if (isServer) {
      desc.textContent = `Connected to ${settings.backendUrl} with authenticated session.`;
    } else if (hasUser) {
      desc.textContent = "Authenticated with private on-device IndexedDB database. 100% offline & secure.";
    } else {
      desc.textContent = "100% private on-device storage. No cloud tracking or remote account required.";
    }
  }

  if (badge) {
    badge.textContent = isServer ? "SERVER CONNECTED" : (hasUser ? "LOCAL ACCOUNT" : "LOCAL MODE");
    badge.setAttribute("data-tone", "ok");
  }

  if (logoutBtn) {
    logoutBtn.style.display = (isServer || hasUser) ? "inline-flex" : "none";
  }
  if (deleteBtn) {
    deleteBtn.style.display = (!isServer && hasUser) ? "inline-flex" : "none";
  }

  // Check session expiry if set
  if (settings.sessionExpiresAt && Date.now() > settings.sessionExpiresAt) {
    toast("Session expired. Please sign in again.", "warn", 4000);
    updateSettings({ isLoggedIn: false, sessionExpiresAt: null });
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
    isLoggedIn: false,
    authMode: "local",
    accountUser: "",
    sessionExpiresAt: null,
  });
  await saveNow().catch(() => {});
  updateAuthDisplay();
  toast("Signed out. Switched to Local Mode.", "ok", 2500);
}

export async function handleDeleteAccount() {
  const settings = getSettings();
  const user = settings.accountUser;
  if (!user) {
    toast("No active account to delete.", "warn", 2000);
    return;
  }
  const ok = await confirm(`Are you sure you want to delete account "${user}"? All associated local data will be removed.`);
  if (!ok) return;

  await dbDeleteUser(user);
  updateSettings({
    isLoggedIn: false,
    accountUser: "",
    authMode: "local",
    sessionExpiresAt: null,
  });
  await saveNow().catch(() => {});
  updateAuthDisplay();
  toast(`Account "${user}" has been deleted.`, "ok", 2500);
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
    updateSettings({ authMode: "local", isLoggedIn: true });
    saveNow().catch(() => {});
    updateAuthDisplay();
    toast("Local Mode Active (100% Private)", "ok", 2000);
  });
  $("#authLogoutBtn")?.addEventListener("click", handleLogout);
  $("#authDeleteAccountBtn")?.addEventListener("click", handleDeleteAccount);

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
      updateSettings({ authMode: "local", isLoggedIn: true });
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
    { btn: $("#authToggleResetPasswordBtn"), input: $("#authResetNewPassword") },
    { btn: $("#authToggleResetConfirmBtn"), input: $("#authResetConfirmPassword") },
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

    if (!username) {
      showAlert("Enter your username or email.", "warn");
      return;
    }
    if (!secret) {
      showAlert("Enter your password.", "warn");
      return;
    }

    const submitBtn = $("#authLoginSubmitBtn");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Verifying…";
    }

    try {
      if (serverUrl) {
        // Remote Backend Server Authentication
        const checked = validateBackendUrl(serverUrl);
        if (!checked.ok) {
          showAlert(checked.error, "error");
          return;
        }

        const result = await unlockBackend(checked.url, secret || username);
        if (!result.ok) {
          showAlert(result.error || "Authentication failed. Check your access token or server URL.", "error");
          return;
        }

        const expiresInSeconds = result.data?.expires_in || 86400;
        updateSettings({
          authMode: "server",
          backendUrl: checked.url,
          accountUser: username,
          isLoggedIn: true,
          rememberSession: remember,
          sessionExpiresAt: Date.now() + expiresInSeconds * 1000,
        });
        await saveNow().catch(() => {});
        updateAuthDisplay();
        closeAuthModal();
        toast(`Signed in to server as ${username}!`, "ok", 2500);
      } else {
        // Local Persistent IndexedDB Authentication
        const existing = await dbGetUser(username);
        if (!existing) {
          showAlert("Account not found. Please Sign Up or use Local Mode.", "error");
          return;
        }

        const computedHash = await hashPassword(secret, existing.salt);
        if (computedHash !== existing.passwordHash) {
          showAlert("Incorrect password. Please try again.", "error");
          return;
        }

        updateSettings({
          authMode: "local",
          accountUser: existing.username,
          isLoggedIn: true,
          rememberSession: remember,
          sessionExpiresAt: Date.now() + 30 * 86400 * 1000,
        });
        await saveNow().catch(() => {});
        updateAuthDisplay();
        closeAuthModal();
        toast(`Welcome back, ${existing.username}!`, "ok", 2500);
      }
    } catch (err) {
      showAlert(String(err?.message || "Sign in failed."), "error");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Sign In";
      }
    }
  });

  // Handle Sign Up submission
  $("#authSignupForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    showAlert("");

    const serverUrl = ($("#authSignupServerUrl")?.value || "").trim();
    const username = ($("#authSignupUser")?.value || "").trim();
    const pwdInput = $("#authSignupPassword");
    const secret = (pwdInput?.value || "").trim();
    const isValidPwd = validateSignupPassword();

    if (!username) {
      showAlert("Enter an email or username.", "warn");
      return;
    }

    if (!isValidPwd) {
      showAlert("Password does not meet requirements or passwords do not match.", "warn");
      return;
    }

    const submitBtn = $("#authSignupSubmitBtn");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Creating Account…";
    }

    try {
      if (serverUrl) {
        const checked = validateBackendUrl(serverUrl);
        if (!checked.ok) {
          showAlert(checked.error, "error");
          return;
        }
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
            isLoggedIn: true,
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
      } else {
        // Local Persistent IndexedDB Registration
        const existing = await dbGetUser(username);
        if (existing) {
          showAlert("An account with this username or email already exists.", "error");
          return;
        }

        const salt = generateSalt();
        const passwordHash = await hashPassword(secret, salt);
        const user = {
          username,
          email: username.includes("@") ? username.toLowerCase() : "",
          passwordHash,
          salt,
          createdAt: Date.now(),
        };

        const saved = await dbSaveUser(user);
        if (!saved) {
          showAlert("Could not save account to local database.", "error");
          return;
        }

        updateSettings({
          authMode: "local",
          accountUser: username,
          isLoggedIn: true,
          rememberSession: true,
          sessionExpiresAt: Date.now() + 30 * 86400 * 1000,
        });
        await saveNow().catch(() => {});
        updateAuthDisplay();
        closeAuthModal();
        toast(`Account "${username}" created successfully!`, "ok", 2500);
      }
    } catch (err) {
      showAlert(String(err?.message || "Registration failed."), "error");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Connect & Register";
      }
    }
  });

  // Handle Password Reset submission
  $("#authResetPasswordForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    showAlert("");

    const targetUser = ($("#authResetUser")?.value || "").trim();
    const newPwd = ($("#authResetNewPassword")?.value || "").trim();
    const confirmPwd = ($("#authResetConfirmPassword")?.value || "").trim();

    if (!targetUser) {
      showAlert("Enter your registered username or email.", "warn");
      return;
    }
    if (newPwd.length < 8 || !/[a-zA-Z]/.test(newPwd) || !/[0-9]/.test(newPwd)) {
      showAlert("New password must be at least 8 characters and contain letters and numbers.", "warn");
      return;
    }
    if (newPwd !== confirmPwd) {
      showAlert("Passwords do not match.", "warn");
      return;
    }

    const submitBtn = $("#authResetSubmitBtn");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Updating Password…";
    }

    try {
      const existing = await dbGetUser(targetUser);
      if (!existing) {
        showAlert("No account found matching this username or email.", "error");
        return;
      }

      const salt = generateSalt();
      const passwordHash = await hashPassword(newPwd, salt);
      existing.salt = salt;
      existing.passwordHash = passwordHash;
      existing.updatedAt = Date.now();

      await dbSaveUser(existing);
      toast("Password reset successfully! Please sign in.", "ok", 3000);
      switchAuthTab("login");
      const loginUser = $("#authLoginUser");
      if (loginUser) loginUser.value = existing.username;
    } catch (err) {
      showAlert(String(err?.message || "Password reset failed."), "error");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Save New Password";
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
