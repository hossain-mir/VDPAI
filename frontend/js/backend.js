/* VDPAI — optional backend connection helpers.
 *
 * A backend is never required to launch or use VDPAI.  When the owner supplies
 * one, the only thing the HUD does is call its health endpoint and display the
 * real result.  No address is hardcoded and no fake "online" state exists.
 */

export function validateBackendUrl(value) {
  const raw = String(value || "").trim().replace(/[\u2028\u2029<>"'\\]/g, "");
  if (!raw) return { ok: true, url: "", warning: "Backend disabled — the HUD is fully local." };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "Enter a full address such as https://server.example.com" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "Only http:// or https:// addresses are supported." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "Do not put a username or password in the URL." };
  }
  if (!parsed.hostname) return { ok: false, error: "The address has no host." };
  if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
    return {
      ok: false,
      error: "Do not hardcode localhost/127.0.0.1. Use the real HTTPS address of your server, or leave this empty.",
    };
  }
  const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  const url = `${parsed.origin}${path}`;
  const warning =
    parsed.protocol === "http:"
      ? "Plain HTTP is blocked by the Android network security policy. Use HTTPS for the APK."
      : "";
  return { ok: true, url, warning };
}

export function joinUrl(base, path) {
  const cleanBase = String(base || "").replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
}

export async function testBackend(baseUrl, { timeoutMs = 12000 } = {}) {
  const checked = validateBackendUrl(baseUrl);
  if (!checked.ok) return { ok: false, error: checked.error, status: 0 };
  if (!checked.url) return { ok: false, error: "No backend URL is configured.", status: 0, empty: true };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(joinUrl(checked.url, "/api/health"), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      credentials: "include",
    });
    const latency = Math.round(performance.now() - started);
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        latency,
        error: `Backend replied HTTP ${response.status}${payload?.error?.message ? `: ${payload.error.message}` : ""}`,
        detail: text.slice(0, 400),
      };
    }
    return {
      ok: true,
      status: response.status,
      latency,
      url: checked.url,
      health: payload?.status || payload?.health || "healthy",
      warning: checked.warning,
    };
  } catch (error) {
    const latency = Math.round(performance.now() - started);
    if (controller.signal.aborted) {
      return { ok: false, status: 0, latency, error: "The backend did not respond before the timeout." };
    }
    return {
      ok: false,
      status: 0,
      latency,
      error:
        "Cannot reach the backend. Check the URL, HTTPS certificate, CORS configuration and that the server is running.",
      detail: String(error?.message || "").slice(0, 300),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function unlockBackend(baseUrl, token) {
  const checked = validateBackendUrl(baseUrl);
  if (!checked.ok || !checked.url) return { ok: false, error: checked.error || "No backend configured." };
  try {
    const res = await fetch(joinUrl(checked.url, "/api/unlock"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ token: String(token || "").trim() }),
      credentials: "include",
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!res.ok) {
      return {
        ok: false,
        error: data?.error?.message || `Authentication failed (HTTP ${res.status}).`,
        status: res.status,
      };
    }
    return { ok: true, data, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err?.message || "Cannot connect to authentication server.") };
  }
}

export async function revokeBackend(baseUrl) {
  const checked = validateBackendUrl(baseUrl);
  if (!checked.ok || !checked.url) return { ok: true };
  try {
    await fetch(joinUrl(checked.url, "/api/revoke"), {
      method: "POST",
      credentials: "include",
    });
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

export async function checkBackendSession(baseUrl) {
  const checked = validateBackendUrl(baseUrl);
  if (!checked.ok || !checked.url) return { ok: false, error: "No backend configured." };
  try {
    const res = await fetch(joinUrl(checked.url, "/api/session"), {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!res.ok) return { ok: false, error: `Server error (HTTP ${res.status}).`, status: res.status };
    return { ok: true, data, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err?.message || "Cannot reach server.") };
  }
}
