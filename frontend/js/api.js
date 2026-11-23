/* JARVIS AI — API client, session/CSRF handling and live event stream. */

import { getBackendUrl, onBackendUrlChange } from "./settings.js";

export class ApiError extends Error {
  constructor(message, code = "http_error", status = 0, details = null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

let csrf = null;
export const session = { id: null, authRequired: false };

/* The base is resolved on every call: the owner can change it at runtime in
 * the APK's connection setting. An empty value keeps the browser's original
 * same-origin behaviour. */
function apiUrl(path) {
  const base = getBackendUrl();
  return base ? base + path : path;
}

function apiCredentials() {
  // A native build talks to a different origin; send the session cookies.
  return getBackendUrl() ? "include" : "same-origin";
}

function socketUrl() {
  const base = getBackendUrl();
  if (base) {
    const parsed = new URL(base);
    return `${parsed.protocol === "https:" ? "wss" : "ws"}://${parsed.host}/ws`;
  }
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}

// A different server means a different session and CSRF token.
onBackendUrlChange(() => {
  csrf = null;
  session.id = null;
  session.authRequired = false;
});

async function parse(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorFrom(payload, response) {
  const error = payload && payload.error ? payload.error : {};
  return new ApiError(
    error.message || `Request failed (HTTP ${response.status})`,
    error.code || "http_error",
    response.status,
    error.details || null,
  );
}

async function request(path, { method = "GET", body, signal } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrf) headers["X-Jarvis-CSRF"] = csrf;

  // Only retry safe idempotent reads; a POST may never be repeated blindly.
  const attempts = method === "GET" ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetch(apiUrl(path), {
        method,
        headers,
        credentials: apiCredentials(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (error.name === "AbortError") throw new ApiError("Request timed out.", "timeout", 0);
      if (attempt === attempts) {
        throw new ApiError("Cannot reach the JARVIS server. Is it still running?", "network", 0);
      }
      continue;
    }

    const payload = await parse(response);
    if (response.ok && !(payload && payload.ok === false)) return payload || {};
    if (attempt === attempts || response.status < 500) throw errorFrom(payload, response);
  }
  return {};
}

/** Start a session and keep the module-level CSRF token in sync. */
export async function startSession() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(apiUrl("/api/session"), {
      credentials: apiCredentials(),
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch {
    throw new ApiError("Cannot reach the JARVIS server.", "network", 0);
  } finally {
    clearTimeout(timer);
  }
  const payload = await parse(response);
  if (!response.ok || !payload) throw errorFrom(payload, response);
  if (payload.csrf) csrf = payload.csrf;
  if (payload.session_id) session.id = payload.session_id;
  if (typeof payload.auth_required === "boolean") session.authRequired = payload.auth_required;
  return payload;
}

export const api = {
  get: (path, options = {}) => request(path, { ...options, method: "GET" }),
  post: (path, body = {}, options = {}) => request(path, { ...options, method: "POST", body }),
  patch: (path, body = {}) => request(path, { method: "PATCH", body }),
  del: (path) => request(path, { method: "DELETE" }),
};

/** Chat has a longer budget than ordinary API calls. */
export async function chat(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 110000);
  try {
    return await request("/api/chat", { method: "POST", body, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function voiceTurn(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 110000);
  try {
    return await request("/api/voice", { method: "POST", body, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Server-push event stream with bounded exponential reconnect. */
export class EventStream {
  constructor({ onEvent, onStatus }) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.socket = null;
    this.attempt = 0;
    this.timer = null;
    this.closed = false;
    this.lastMessage = 0;
    this.watchdog = null;
    this.unsubscribe = onBackendUrlChange(() => this.restart());
  }

  /** Drop the old socket immediately when the owner changes servers. */
  restart() {
    clearTimeout(this.timer);
    this.stopWatchdog();
    if (this.socket) {
      this.socket.onclose = null;
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    this.attempt = 0;
    this.onStatus?.("offline");
    if (!this.closed) this.connect();
  }

  ensureConnected() {
    clearTimeout(this.timer);
    this.connect();
  }

  connect() {
    this.closed = false;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    try {
      this.socket = new WebSocket(socketUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      this.attempt = 0;
      this.lastMessage = Date.now();
      this.onStatus?.("online");
      this.startWatchdog();
    };
    this.socket.onmessage = (message) => {
      this.lastMessage = Date.now();
      let event = null;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (event && event.type) this.onEvent?.(event);
    };
    this.socket.onerror = () => this.onStatus?.("error");
    this.socket.onclose = () => {
      this.onStatus?.("offline");
      this.stopWatchdog();
      this.socket = null;
      if (!this.closed) this.scheduleReconnect();
    };
  }

  startWatchdog() {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      if (this.socket && Date.now() - this.lastMessage > 65000) {
        try {
          this.socket.close();
        } catch {
          /* ignore */
        }
      }
    }, 15000);
  }

  stopWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  scheduleReconnect() {
    if (this.closed) return;
    this.attempt = Math.min(this.attempt + 1, 6);
    const delay = Math.min(1000 * 2 ** this.attempt, 15000);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  close() {
    this.closed = true;
    this.unsubscribe?.();
    clearTimeout(this.timer);
    this.stopWatchdog();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
  }
}
