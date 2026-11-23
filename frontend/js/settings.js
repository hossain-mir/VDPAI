/* JARVIS AI — runtime connection settings.
 *
 * The APK ships with the HUD bundled locally and no hard-coded server. The
 * owner configures the backend later from System → Backend server. The URL is
 * not a credential, but it is stored through Capacitor Preferences (app-private
 * native storage) with a localStorage fallback for the browser. API keys and
 * access tokens are never stored here.
 */

import { Preferences } from "@capacitor/preferences";

const STORAGE_KEY = "jarvis.backendUrl";
const listeners = new Set();
let nativeStore = false;
let ready = false;

function normalize(value) {
  return String(value || "")
    .trim()
    .replace(/[\u2028\u2029<>"'\\]/g, "")
    .replace(/\/+$/, "");
}

function injectedBase() {
  return typeof window !== "undefined" && typeof window.JARVIS_API_BASE === "string"
    ? normalize(window.JARVIS_API_BASE)
    : "";
}

function isNative() {
  return typeof window !== "undefined" && window.JARVIS_NATIVE_BUILD === true;
}

/** Load the persisted value before the app boots. Safe to call more than once. */
export async function initSettings() {
  if (ready) return current;
  ready = true;
  let stored = "";
  try {
    if (isNative()) {
      const result = await Preferences.get({ key: STORAGE_KEY });
      stored = result?.value || "";
      nativeStore = true;
    } else {
      stored = localStorage.getItem(STORAGE_KEY) || "";
    }
  } catch {
    /* storage unavailable — fall back to the injected value only */
  }
  current = normalize(stored || injectedBase());
  return current;
}

let current = injectedBase();

export function getBackendUrl() {
  return current;
}

export function usesNativeStorage() {
  return nativeStore;
}

export function setBackendUrl(value) {
  const next = normalize(value);
  if (next === current) return current;
  current = next;
  try {
    if (isNative()) {
      nativeStore = true;
      if (next) Preferences.set({ key: STORAGE_KEY, value: next }).catch(() => {});
      else Preferences.remove({ key: STORAGE_KEY }).catch(() => {});
    } else {
      if (next) localStorage.setItem(STORAGE_KEY, next);
      else localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* ignore storage failures; the in-memory value still applies */
  }
  if (typeof window !== "undefined") window.JARVIS_API_BASE = next;
  for (const listener of [...listeners]) {
    try {
      listener(next);
    } catch {
      /* a broken listener must not stop the app */
    }
  }
  return next;
}

/** Async clear used by the privacy panel; updates memory immediately. */
export async function clearBackendUrl() {
  setBackendUrl("");
  try {
    if (isNative()) await Preferences.remove({ key: STORAGE_KEY });
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return current;
}

export function onBackendUrlChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Validate without side effects. Never returns a fake/placeholder URL. */
export function validateBackendUrl(raw) {
  const value = normalize(raw);
  if (!value) return { ok: true, url: "", warning: "Uses this app's own origin." };

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: "Enter a full address starting with https://" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "Only https:// or http:// addresses are supported." };
  }
  if (isNative() && parsed.protocol !== "https:") {
    return { ok: false, error: "The APK requires an HTTPS address. Publish your backend behind HTTPS, then enter that URL." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "Do not put a username or password in the URL." };
  }
  if (!parsed.hostname) return { ok: false, error: "The address has no host." };

  const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  const url = `${parsed.origin}${path}`;
  if (!url) return { ok: false, error: "The address has no host." };
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.toLowerCase());
  const warning =
    parsed.protocol === "http:" && !local && !isNative()
      ? "Plain HTTP works for chat on trusted networks, but browsers block microphone access. Use HTTPS for voice."
      : "";
  return { ok: true, url, warning };
}
