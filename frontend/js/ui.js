/* VDPAI — small DOM helpers, transcript rendering and dialogs. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function toast(message, tone = "", timeout = 4200) {
  const host = $("#toasts");
  if (!host) return;
  const node = el("div", `toast ${tone}`.trim(), String(message || ""));
  host.appendChild(node);
  while (host.children.length > 4) host.removeChild(host.firstElementChild);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(6px)";
    setTimeout(() => node.remove(), 240);
  }, timeout);
}

export function timeLabel(value) {
  const date = value ? new Date(value) : new Date();
  try {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function relativeTime(value) {
  if (!value) return "—";
  const stamp = new Date(value).getTime();
  if (Number.isNaN(stamp)) return "—";
  const seconds = Math.round((Date.now() - stamp) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  try {
    return new Date(value).toLocaleDateString();
  } catch {
    return "—";
  }
}

export function formatUptime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${Math.floor(total)}s`;
}

export function setChip(target, tone, label) {
  const chip = typeof target === "string" ? document.getElementById(target) : target;
  if (!chip) return;
  chip.dataset.tone = tone;
  if (label) {
    const dot = chip.querySelector("i");
    chip.textContent = "";
    if (dot) chip.appendChild(dot);
    chip.appendChild(document.createTextNode(label));
  }
}

export function setMiniStatus(target, label, tone = "") {
  const node = typeof target === "string" ? document.getElementById(target) : target;
  if (!node) return;
  node.textContent = label;
  node.dataset.tone = tone;
}

export function fillFacts(host, pairs) {
  if (!host) return;
  host.textContent = "";
  for (const [label, value] of pairs) {
    const row = el("div");
    row.appendChild(el("dt", "", label));
    row.appendChild(el("dd", "", value === undefined || value === null || value === "" ? "—" : String(value)));
    host.appendChild(row);
  }
}

/* --------------------------------------------------------------- transcript */
export class Transcript {
  constructor(host) {
    this.host = host;
    this.limit = 60;
  }

  clear() {
    if (this.host) this.host.textContent = "";
  }

  add(role, text, meta = "") {
    if (!this.host) return null;
    const cleanText = String(text || "").trim();
    if (!cleanText && role !== "assistant") return null;

    // Deduplicate consecutive identical error or system messages
    const lastChild = this.host.lastElementChild;
    if (lastChild && (role === "error" || role === "system")) {
      const isSameRole = lastChild.classList.contains(role);
      const isSameText = (lastChild.firstChild?.nodeValue || "").trim() === cleanText;
      if (isSameRole && isSameText) {
        const metaEl = lastChild.querySelector(".meta");
        const footer = [meta, timeLabel()].filter(Boolean).join(" · ");
        if (metaEl && footer) metaEl.textContent = footer;
        this.scroll();
        return lastChild;
      }
      if (role === "error" && isSameRole) {
        if (lastChild.firstChild) lastChild.firstChild.nodeValue = cleanText;
        const metaEl = lastChild.querySelector(".meta");
        const footer = [meta, timeLabel()].filter(Boolean).join(" · ");
        if (metaEl && footer) metaEl.textContent = footer;
        this.scroll();
        return lastChild;
      }
    }

    const className =
      role === "user"
        ? "bubble user"
        : role === "assistant"
        ? "bubble assistant"
        : role === "error"
        ? "bubble error"
        : "bubble system";
    const bubble = el("div", className);
    bubble.appendChild(document.createTextNode(cleanText));
    const footer = [meta, timeLabel()].filter(Boolean).join(" · ");
    if (footer) bubble.appendChild(el("span", "meta", footer));
    this.host.appendChild(bubble);
    while (this.host.children.length > this.limit) this.host.removeChild(this.host.firstElementChild);
    this.scroll();
    return bubble;
  }

  scroll({ force = false } = {}) {
    const scroller = this.host?.closest(".chat-stream-panel") || this.host?.parentElement || this.host;
    if (!scroller) return;
    const isNearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
    if (force || isNearBottom) {
      scroller.scrollTop = scroller.scrollHeight;
    }
    if (this.host && this.host !== scroller) {
      this.host.scrollTop = this.host.scrollHeight;
    }
  }

  renderConversation(conversation, { announce = false } = {}) {
    this.clear();
    if (!conversation || !conversation.messages.length) {
      if (announce) {
        this.add("system", "VDPAI READY · configure a provider in Control Center → AI & API");
      }
      return;
    }
    const messages = conversation.messages.slice(-30);
    let lastMsg = null;
    for (const message of messages) {
      if (!message.content || !message.content.trim()) continue;
      if (lastMsg && lastMsg.role === message.role && lastMsg.content.trim() === message.content.trim()) {
        continue;
      }
      lastMsg = message;
      this.add(
        message.role,
        message.content,
        message.role === "assistant" ? `${conversation.providerId ? "AI" : "assistant"} · ${timeLabel(message.createdAt)}` : timeLabel(message.createdAt),
      );
    }
    this.scroll({ force: true });
  }
}

/* ------------------------------------------------------------------- dialogs */
let confirmResolve = null;

export function initConfirmDialog() {
  const modal = $("#confirmModal");
  if (!modal) return;
  modal.hidden = true;
  modal.style.display = "none";
  if (modal.dataset.wired === "1") return;
  modal.dataset.wired = "1";

  $("#confirmCancel")?.addEventListener("click", (e) => {
    e.preventDefault();
    closeConfirm(false);
  });
  $("#confirmOk")?.addEventListener("click", (e) => {
    e.preventDefault();
    closeConfirm(true);
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeConfirm(false);
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) {
      closeConfirm(false);
    }
  });
}

function closeConfirm(result) {
  const modal = $("#confirmModal");
  if (modal) {
    document.activeElement?.blur?.();
    modal.hidden = true;
    modal.style.display = "none";
  }
  document.body.style.overflow = "";
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(result);
}

let promptResolve = null;

export function promptAction({ title = "Edit", text = "", value = "", confirmLabel = "Save", cancelLabel = "Cancel", placeholder = "" } = {}) {
  initPromptDialog();
  const modal = $("#promptModal");
  const input = $("#promptInput");
  if (!modal || !input) return Promise.resolve(window.prompt(title, value));
  $("#promptTitle").textContent = title;
  $("#promptText").textContent = text;
  $("#promptOk").textContent = confirmLabel;
  $("#promptCancel").textContent = cancelLabel;
  input.value = value;
  input.placeholder = placeholder;
  modal.hidden = false;
  modal.style.display = "flex";
  document.body.style.overflow = "hidden";
  setTimeout(() => {
    input.focus({ preventScroll: true });
    input.select();
  }, 50);
  return new Promise((resolve) => {
    promptResolve = resolve;
  });
}

function closePrompt(result) {
  const modal = $("#promptModal");
  if (modal) {
    const input = $("#promptInput");
    input?.blur?.();
    document.activeElement?.blur?.();
    modal.hidden = true;
    modal.style.display = "none";
  }
  document.body.style.overflow = "";
  const resolve = promptResolve;
  promptResolve = null;
  resolve?.(result);
}

export function initPromptDialog() {
  const modal = $("#promptModal");
  if (!modal) return;
  modal.hidden = true;
  modal.style.display = "none";
  if (modal.dataset.wired === "1") return;
  modal.dataset.wired = "1";

  const cancelBtn = $("#promptCancel");
  const form = $("#promptForm");
  const input = $("#promptInput");
  const okBtn = $("#promptOk");

  cancelBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    closePrompt(null);
  });

  const submitValue = (e) => {
    if (e) e.preventDefault();
    const value = (input?.value || "").trim();
    if (!value) return;
    closePrompt(value);
  };

  form?.addEventListener("submit", submitValue);
  okBtn?.addEventListener("click", submitValue);

  modal.addEventListener("click", (event) => {
    if (event.target === modal) closePrompt(null);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) {
      closePrompt(null);
    }
  });
}

export function confirmAction({ title = "Are you sure?", text = "", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = true } = {}) {
  initConfirmDialog();
  const modal = $("#confirmModal");
  if (!modal) return Promise.resolve(window.confirm(`${title}\n\n${text}`));
  $("#confirmTitle").textContent = title;
  $("#confirmText").textContent = text;
  const ok = $("#confirmOk");
  ok.textContent = confirmLabel;
  ok.className = danger ? "btn danger" : "btn primary";
  $("#confirmCancel").textContent = cancelLabel;
  modal.hidden = false;
  modal.style.display = "flex";
  document.body.style.overflow = "hidden";
  ok.focus({ preventScroll: true });
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

export function confirm({ title = "Are you sure?", text = "", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = true, onConfirm = null } = {}) {
  return confirmAction({ title, text, confirmLabel, cancelLabel, danger }).then((ok) => {
    if (ok && typeof onConfirm === "function") {
      onConfirm();
    }
    return ok;
  });
}

export function openOverlay(id) {
  const node = document.getElementById(id);
  if (!node) return;
  node.hidden = false;
  node.style.display = "flex";
  document.body.style.overflow = "hidden";
  const scope = node.querySelector(".cc-page:not([hidden])") || node;
  const focusable = scope.querySelector("input:not([hidden]), button:not([hidden]), select, textarea");
  setTimeout(() => focusable?.focus({ preventScroll: true }), 60);
}

export function closeOverlay(id) {
  const node = document.getElementById(id);
  if (!node) return;
  node.hidden = true;
  node.style.display = "none";
  if (!$("#controlCenter") || $("#controlCenter").hidden) {
    if (!$("#historySheet") || $("#historySheet").hidden) document.body.style.overflow = "";
  }
}

export function openModal(id) {
  const node = document.getElementById(id);
  if (!node) return;
  node.hidden = false;
  node.style.display = "flex";
  document.body.style.overflow = "hidden";
  const field = node.querySelector("input:not([type=hidden]), select, textarea, button");
  setTimeout(() => field?.focus({ preventScroll: true }), 80);
}

export function closeModal(id) {
  const node = document.getElementById(id);
  if (!node) return;
  node.hidden = true;
  node.style.display = "none";
  if (
    (! $("#controlCenter") || $("#controlCenter").hidden) &&
    (! $("#historySheet") || $("#historySheet").hidden) &&
    (! $("#providerModal") || $("#providerModal").hidden) &&
    (! $("#confirmModal") || $("#confirmModal").hidden) &&
    (! $("#promptModal") || $("#promptModal").hidden)
  ) {
    document.body.style.overflow = "";
  }
}

// Auto-wire dialogs on module load if DOM is ready
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      initConfirmDialog();
      initPromptDialog();
    });
  } else {
    initConfirmDialog();
    initPromptDialog();
  }
}

export function copyText(value) {
  const text = String(value || "");
  if (!text) return Promise.resolve(false);
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return Promise.resolve(ok);
  } catch {
    return Promise.resolve(false);
  }
}

export function downloadJson(filename, content) {
  try {
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  } catch {
    return false;
  }
}
