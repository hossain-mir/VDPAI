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
  $("#newChatBtn2")?.addEventListener("click", async () => {
    await ctx.onNewConversation?.();
    closeHistory();
  });
  $("#historySearch")?.addEventListener("input", () => renderHistory());
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
  const host = $("#historyList");
  if (!host) return;
  const query = $("#historySearch")?.value || "";
  const conversations = searchConversations(query);
  const active = getActiveConversation();
  host.textContent = "";
  if (!conversations.length) {
    host.appendChild(
      ui.el(
        "div",
        "history-empty",
        query ? "No conversation matches that search." : "No conversations yet. Start one from the HUD.",
      ),
    );
    return;
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

export function getConversationCount() {
  return getConversations().length;
}
