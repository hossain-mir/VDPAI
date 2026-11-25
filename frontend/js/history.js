/* VDPAI — local conversation history browser. */

import {
  deleteConversation,
  getActiveConversation,
  getConversations,
  renameConversation,
  saveNow,
  searchConversations,
  setActiveConversation,
} from "./store.js";
import * as ui from "./ui.js";

const $ = ui.$;
let ctx = {
  onOpenConversation: () => {},
  onNewConversation: () => {},
  onChanged: () => {},
};
let bound = false;

export function initHistory(context = {}) {
  ctx = { ...ctx, ...context };
  if (bound) {
    renderHistory();
    return;
  }
  bound = true;
  $("#historyBtn")?.addEventListener("click", openHistory);
  $("#historyClose")?.addEventListener("click", closeHistory);
  const sheet = $("#historySheet");
  sheet?.addEventListener("click", (e) => {
    if (e.target === sheet) closeHistory();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isHistoryOpen()) closeHistory();
  });
  $("#newChatBtn2")?.addEventListener("click", async () => {
    await ctx.onNewConversation?.();
    closeHistory();
  });
  $("#pageNewChatBtn")?.addEventListener("click", async () => {
    await ctx.onNewConversation?.();
    if (typeof window !== "undefined" && window.VDPAI?.switchPage) {
      window.VDPAI.switchPage("chat");
    }
  });
  $("#historySearch")?.addEventListener("input", (e) => {
    const pageSearch = $("#pageHistorySearch");
    if (pageSearch && pageSearch.value !== e.target.value) pageSearch.value = e.target.value;
    renderHistory();
  });
  $("#pageHistorySearch")?.addEventListener("input", (e) => {
    const sheetSearch = $("#historySearch");
    if (sheetSearch && sheetSearch.value !== e.target.value) sheetSearch.value = e.target.value;
    renderHistory();
  });
  renderHistory();
}

export function openHistory() {
  ui.openOverlay("historySheet");
  renderHistory();
}

export function closeHistory() {
  ui.closeOverlay("historySheet");
}

export function isHistoryOpen() {
  return !$("#historySheet")?.hidden;
}

export function renderHistory() {
  const hosts = [$("#historyList"), $("#pageHistoryList")].filter(Boolean);
  if (!hosts.length) return;
  const query = ($("#pageHistorySearch")?.value || $("#historySearch")?.value || "").trim();
  const conversations = searchConversations(query);
  const active = getActiveConversation();

  for (const host of hosts) {
    host.textContent = "";
    if (!conversations.length) {
      host.appendChild(
        ui.el(
          "div",
          "history-empty",
          query ? "No conversation matches that search." : "No conversations yet. Start one from the HUD.",
        ),
      );
      continue;
    }
    for (const conversation of conversations) {
      const item = ui.el("div", `history-item${active?.id === conversation.id ? " is-active" : ""}`);
      const open = ui.el("button", "history-open");
      open.type = "button";
      open.appendChild(ui.el("strong", "", conversation.title));
      const count = conversation.messages.length;
      const provider = conversation.model ? ` · ${conversation.model}` : "";
      open.appendChild(
        ui.el(
          "small",
          "",
          `${count} message${count === 1 ? "" : "s"} · ${ui.relativeTime(conversation.updatedAt)}${provider}`,
        ),
      );
      open.addEventListener("click", () => {
        setActiveConversation(conversation.id);
        saveNow().catch(() => {});
        closeHistory();
        ctx.onOpenConversation?.(conversation.id);
        ctx.onChanged?.();
        if (typeof window !== "undefined" && window.VDPAI?.switchPage) {
          window.VDPAI.switchPage("chat");
        }
      });
      item.appendChild(open);

      const actions = ui.el("div", "history-actions");
      const rename = ui.el("button", "btn tiny", "Rename");
      rename.type = "button";
      rename.addEventListener("click", async () => {
        const title = await ui.promptAction({
          title: "Rename conversation",
          text: "Choose a short, recognizable title.",
          value: conversation.title,
          confirmLabel: "Rename",
        });
        if (title === null) return;
        renameConversation(conversation.id, title);
        await saveNow().catch(() => {});
        renderHistory();
        ctx.onChanged?.();
        ui.toast("Conversation renamed.", "ok", 2200);
      });
      actions.appendChild(rename);

      const remove = ui.el("button", "btn tiny danger-ghost", "Delete");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        const ok = await ui.confirmAction({
          title: "Delete this conversation?",
          text: `“${conversation.title}” and its messages will be permanently removed from this device.`,
          confirmLabel: "Delete conversation",
        });
        if (!ok) return;
        deleteConversation(conversation.id);
        await saveNow().catch(() => {});
        renderHistory();
        ctx.onChanged?.();
        ui.toast("Conversation deleted.", "ok", 2400);
      });
      actions.appendChild(remove);
      item.appendChild(actions);
      host.appendChild(item);
    }
  }
}

export function getConversationCount() {
  return getConversations().length;
}
