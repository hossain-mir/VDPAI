/* JARVIS AI — small DOM/UI helpers (all user text inserted via textContent). */

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
    node.style.transition = "0.25s ease";
    setTimeout(() => node.remove(), 280);
  }, timeout);
}

function timeLabel(date) {
  try {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function createBubble(role, text, meta = "") {
  const bubble = el("div", `bubble ${role}`);
  bubble.appendChild(document.createTextNode(text));
  const footer = [meta, timeLabel(new Date())].filter(Boolean).join(" · ");
  if (footer) bubble.appendChild(el("span", "meta", footer));
  return bubble;
}

export class Transcript {
  constructor(compact, full) {
    this.compact = compact;
    this.full = full;
    this.entries = [];
  }

  add(role, text, meta = "") {
    const entry = { role, text: String(text || ""), meta };
    this.entries.push(entry);
    if (this.entries.length > 100) this.entries.shift();
    this.append(entry);
  }

  append(entry) {
    for (const host of [this.compact, this.full]) {
      if (!host) continue;
      host.appendChild(createBubble(entry.role, entry.text, entry.meta));
      while (host.children.length > 40) host.removeChild(host.firstElementChild);
      host.scrollTop = host.scrollHeight;
    }
  }

  clear() {
    this.entries = [];
    if (this.compact) this.compact.textContent = "";
    if (this.full) this.full.textContent = "";
  }
}

export function setChip(id, tone, label) {
  const chip = typeof id === "string" ? document.getElementById(id) : id;
  if (!chip) return;
  chip.dataset.tone = tone;
  if (label) {
    const dot = chip.querySelector("i");
    chip.textContent = "";
    if (dot) chip.appendChild(dot);
    chip.appendChild(document.createTextNode(label));
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

export function relativeTime(iso) {
  if (!iso) return "—";
  const stamp = new Date(iso).getTime();
  if (Number.isNaN(stamp)) return "—";
  const seconds = Math.round((Date.now() - stamp) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const VIEW_TITLES = {
  chat: "Conversation",
  memory: "Memory core",
  tools: "Tool execution",
  vision: "Vision engine",
  system: "System configuration",
};

export function openSheet(view, title) {
  const sheet = $("#sheet");
  if (!sheet) return;
  const target = VIEW_TITLES[view] ? view : "chat";
  $$("#sheetBody > section").forEach((section) => {
    section.hidden = section.dataset.view !== target;
  });
  $("#sheetTitle").textContent = title || VIEW_TITLES[target];
  sheet.hidden = false;
  $$(".rail-btn").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.panel === target);
  });
  document.body.style.overflow = "hidden";
  const closeButton = $("#sheet .sheet-head .icon-btn");
  if (closeButton) closeButton.focus({ preventScroll: true });
}

export function closeSheet() {
  const sheet = $("#sheet");
  if (!sheet) return;
  sheet.hidden = true;
  document.body.style.overflow = "";
  $$(".rail-btn").forEach((button) => button.classList.remove("is-active"));
}

export function showApproval(action) {
  const modal = $("#approvalModal");
  if (!modal) return;
  $("#approvalTitle").textContent = `Run "${action.tool}"?`;
  $("#approvalBody").textContent =
    "This tool can modify data on this device. JARVIS will not run it until you approve. " +
    "Check the arguments below.";
  try {
    $("#approvalArgs").textContent = JSON.stringify(action.args || {}, null, 2);
  } catch {
    $("#approvalArgs").textContent = String(action.args);
  }
  modal.hidden = false;
  $("#approveBtn")?.focus({ preventScroll: true });
}

export function hideApproval() {
  const modal = $("#approvalModal");
  if (modal) modal.hidden = true;
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

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}
