/* JARVIS AI — runtime connection settings.
 *
 * The APK ships with the HUD bundled locally and no hard-coded server. The
 * owner enters the backend address later; it is kept in WebView localStorage
 * (a URL is not a credential). In the plain browser this stays empty, so the
 * existing same-origin behaviour is unchanged.
 */

const STORAGE_KEY = "jarvis.backendUrl";
const listeners = new Set();

function normalize(value) {
  return String(value || "")
    .trim()
    .replace(/[\u2028\u2029<>"'\\]/g, "")
    .replace(/\/+$/, "");
}

function initial() {
  let stored = "";
  try {
    stored = localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    /* storage disabled — fall back to the build-time value only */
  }
  const injected =
    typeof window !== "undefined" && typeof window.JARVIS_API_BASE === "string"
      ? window.JARVIS_API_BASE
      : "";
  return normalize(stored || injected);
}

let current = initial();

export function getBackendUrl() {
  return current;
}

export function setBackendUrl(value) {
  const next = normalize(value);
  if (next === current) return current;
  current = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
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
    return { ok: false, error: "Enter a full address, e.g. https://my-server:8000" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "Only https:// or http:// addresses are supported." };
  }
  const native =
    typeof window !== "undefined" && window.JARVIS_NATIVE_BUILD === true;
  if (native && parsed.protocol !== "https:") {
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
    parsed.protocol === "http:" && !local && !native
      ? "Plain HTTP works for chat on trusted networks, but browsers block microphone access. Use HTTPS for voice."
      : "";
  return { ok: true, url, warning };
}
