/* VDPAI — Personal Memory System:
 * Remember user-approved information (name, preferences, important facts, custom rules).
 */

import {
  addMemory,
  clearMemories,
  deleteMemory,
  getMemories,
  getSettings,
  searchMemories,
  subscribe,
  updateMemory,
  updateSettings,
} from "./store.js";
import * as ui from "./ui.js";

const $ = ui.$;
const $$ = ui.$$;

let memoryBound = false;
let memorySearchQuery = "";

export function initMemory() {
  if (memoryBound) {
    renderMemories();
    return;
  }
  memoryBound = true;

  bindMemoryControls();
  subscribe(() => {
    renderMemories();
  });
  renderMemories();
}

function bindMemoryControls() {
  const form = $("#memoryForm");
  const keyInput = $("#memoryKeyInput");
  const valueInput = $("#memoryValueInput");
  const catSelect = $("#memoryCategorySelect");
  const searchInput = $("#memorySearchInput");
  const toggle = $("#memoryEnabledToggle");
  const privateToggle = $("#privateModeToggle");
  const clearBtn = $("#clearMemoriesBtn");

  const settings = getSettings();
  if (toggle) toggle.checked = settings.memoryEnabled !== false;
  if (privateToggle) privateToggle.checked = Boolean(settings.privateMode);

  toggle?.addEventListener("change", () => {
    updateSettings({ memoryEnabled: toggle.checked });
    ui.toast(`Personal Memory ${toggle.checked ? "enabled" : "disabled"}`, "ok");
  });

  privateToggle?.addEventListener("change", () => {
    updateSettings({ privateMode: privateToggle.checked });
    ui.toast(`Private conversation mode ${privateToggle.checked ? "ON (memory bypassed)" : "OFF"}`, "ok");
  });

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const key = String(keyInput?.value || "").trim();
    const value = String(valueInput?.value || "").trim();
    const category = catSelect?.value || "preference";
    if (!key || !value) return;

    addMemory(key, value, category);
    if (keyInput) keyInput.value = "";
    if (valueInput) valueInput.value = "";
    renderMemories();
    ui.toast("Memory saved", "ok");
  });

  searchInput?.addEventListener("input", () => {
    memorySearchQuery = searchInput.value;
    renderMemories();
  });

  clearBtn?.addEventListener("click", () => {
    ui.confirm({
      title: "Clear All Personal Memories?",
      text: "This will remove all saved user preferences, custom instructions, and personal facts from VDPAI's memory on this device.",
      confirmLabel: "Clear Memories",
      onConfirm: () => {
        clearMemories();
        renderMemories();
        ui.toast("All memories cleared", "ok");
      },
    });
  });
}

export function renderMemories() {
  const list = $("#memoryList");
  const countEl = $("#memoryCountBadge");
  if (!list) return;

  const memories = memorySearchQuery ? searchMemories(memorySearchQuery) : getMemories();
  if (countEl) countEl.textContent = String(memories.length);

  while (list.firstChild) list.removeChild(list.firstChild);

  if (memories.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint text-center";
    empty.textContent = memorySearchQuery
      ? "No memories match your query."
      : "No personal memories recorded yet. Add preferences or facts above.";
    list.appendChild(empty);
    return;
  }

  for (const mem of memories) {
    const item = document.createElement("div");
    item.className = "memory-item glass-soft";

    const head = document.createElement("div");
    head.className = "memory-item-head";

    const key = document.createElement("strong");
    key.className = "memory-key";
    key.textContent = mem.key;

    const cat = document.createElement("span");
    cat.className = "memory-badge";
    cat.textContent = mem.category.toUpperCase();

    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn tiny danger-ghost";
    del.setAttribute("aria-label", `Delete memory ${mem.key}`);
    del.textContent = "×";
    del.addEventListener("click", () => {
      deleteMemory(mem.id);
      renderMemories();
      ui.toast("Memory removed", "ok");
    });

    head.appendChild(key);
    head.appendChild(cat);
    head.appendChild(del);

    const val = document.createElement("p");
    val.className = "memory-value";
    val.textContent = mem.value;

    item.appendChild(head);
    item.appendChild(val);
    list.appendChild(item);
  }
}
