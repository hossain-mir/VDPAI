/* VDPAI — User Profiles & App Reset:
 * Isolated profiles with independent chat history, memories, tasks, and settings.
 */

import {
  addProfile,
  deleteProfile,
  getActiveProfileId,
  getProfiles,
  resetProfile,
  setActiveProfileId,
  subscribe,
} from "./store.js";
import * as ui from "./ui.js";

const $ = ui.$;
const $$ = ui.$$;

let profilesBound = false;

export function initProfiles(context = {}) {
  if (profilesBound) {
    renderProfiles();
    return;
  }
  profilesBound = true;

  bindProfileControls(context.onProfileSwitched);
  subscribe(() => {
    renderProfiles();
  });
  renderProfiles();
}

function bindProfileControls(onProfileSwitched) {
  const select = $("#profileSelect");
  const addForm = $("#addProfileForm");
  const addInput = $("#addProfileInput");
  const resetBtn = $("#resetProfileBtn");

  select?.addEventListener("change", () => {
    const newId = select.value;
    if (newId && newId !== getActiveProfileId()) {
      setActiveProfileId(newId);
      ui.toast(`Switched to profile: ${select.options[select.selectedIndex]?.text}`, "ok");
      onProfileSwitched?.(newId);
    }
  });

  addForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = String(addInput?.value || "").trim();
    if (!name) return;
    const profile = addProfile(name);
    if (addInput) addInput.value = "";
    if (profile) {
      setActiveProfileId(profile.id);
      ui.toast(`Created and switched to profile: ${profile.name}`, "ok");
      onProfileSwitched?.(profile.id);
    }
  });

  resetBtn?.addEventListener("click", () => {
    const currentId = getActiveProfileId();
    ui.confirm({
      title: "Reset Current Profile Data?",
      text:
        `This will permanently delete all conversations, memories, tasks, and notes ` +
        `stored in the active profile. Other profiles will not be affected.`,
      confirmLabel: "Reset Profile",
      onConfirm: () => {
        resetProfile(currentId);
        ui.toast("Profile data reset successfully", "ok");
        onProfileSwitched?.(currentId);
      },
    });
  });
}

export function renderProfiles() {
  const select = $("#profileSelect");
  const list = $("#profilesManagerList");
  const activeBadge = $("#activeProfileBadge");

  const profiles = getProfiles();
  const activeId = getActiveProfileId();

  if (activeBadge) {
    const current = profiles.find((p) => p.id === activeId);
    activeBadge.textContent = current?.name || "Primary";
  }

  if (select) {
    while (select.firstChild) select.removeChild(select.firstChild);
    for (const p of profiles) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.id})`;
      if (p.id === activeId) opt.selected = true;
      select.appendChild(opt);
    }
  }

  if (list) {
    while (list.firstChild) list.removeChild(list.firstChild);
    for (const p of profiles) {
      const row = document.createElement("div");
      row.className = `profile-item-row ${p.id === activeId ? "is-active" : ""}`;

      const name = document.createElement("strong");
      name.textContent = p.name;

      const actions = document.createElement("div");
      actions.className = "row";

      if (p.id !== "primary") {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "btn tiny danger-ghost";
        delBtn.textContent = "Delete";
        delBtn.addEventListener("click", () => {
          ui.confirm({
            title: `Delete profile "${p.name}"?`,
            text: "All data in this profile will be permanently deleted.",
            confirmLabel: "Delete Profile",
            onConfirm: () => {
              deleteProfile(p.id);
              renderProfiles();
              ui.toast(`Profile "${p.name}" deleted`, "ok");
            },
          });
        });
        actions.appendChild(delBtn);
      }

      row.appendChild(name);
      row.appendChild(actions);
      list.appendChild(row);
    }
  }
}
