/* VDPAI — Personal Assistant: Tasks, Notes, Reminders, Calendar,
 * Daily Activity Summary, and Quick Tools.
 */

import {
  addTask,
  deleteTask,
  getTasks,
  toggleTask,
  addNote,
  deleteNote,
  getNotes,
  searchNotes,
  updateNote,
  addReminder,
  deleteReminder,
  getReminders,
  toggleReminder,
  getConversations,
  subscribe,
} from "./store.js";
import * as ui from "./ui.js";

const $ = ui.$;
const $$ = ui.$$;

let assistantBound = false;
let taskFilter = "all";
let noteSearchQuery = "";

export function initAssistant() {
  if (assistantBound) {
    renderAllAssistant();
    return;
  }
  assistantBound = true;

  bindTaskControls();
  bindNoteControls();
  bindReminderControls();
  bindQuickTools();
  bindCalendar();
  bindSubtabs();

  subscribe(() => {
    renderAllAssistant();
  });

  renderAllAssistant();
}

export function renderAllAssistant() {
  renderTasks();
  renderNotes();
  renderReminders();
  renderDailySummary();
  renderCalendarAgenda();
}

/* -------------------------------------------------------------------- summary */
function renderDailySummary() {
  const conversations = getConversations();
  const tasks = getTasks();
  const reminders = getReminders();

  let messageCount = 0;
  for (const c of conversations) {
    messageCount += (c.messages || []).length;
  }

  const completedTasks = tasks.filter((t) => t.completed).length;
  const activeReminders = reminders.filter((r) => !r.completed).length;

  const countMsgEl = $("#summaryMessageCount");
  if (countMsgEl) countMsgEl.textContent = String(messageCount);

  const countTaskEl = $("#summaryTaskCount");
  if (countTaskEl) countTaskEl.textContent = `${completedTasks}/${tasks.length}`;

  const countRemEl = $("#summaryReminderCount");
  if (countRemEl) countRemEl.textContent = String(activeReminders);
}

/* ---------------------------------------------------------------------- tasks */
function bindTaskControls() {
  const form = $("#taskForm");
  const input = $("#taskInput");
  const prioritySelect = $("#taskPriority");

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = String(input?.value || "").trim();
    if (!title) return;
    const priority = prioritySelect?.value || "normal";
    addTask(title, priority);
    if (input) input.value = "";
    renderTasks();
    renderDailySummary();
    ui.toast("Task added", "ok");
  });

  $$(".task-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".task-filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      taskFilter = btn.dataset.filter || "all";
      renderTasks();
    });
  });
}

function renderTasks() {
  const list = $("#taskList");
  if (!list) return;

  const tasks = getTasks();
  let filtered = tasks;
  if (taskFilter === "pending") filtered = tasks.filter((t) => !t.completed);
  else if (taskFilter === "completed") filtered = tasks.filter((t) => t.completed);

  while (list.firstChild) list.removeChild(list.firstChild);

  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint text-center";
    empty.textContent = taskFilter === "all" ? "No tasks yet. Add one above." : `No ${taskFilter} tasks.`;
    list.appendChild(empty);
    return;
  }

  for (const task of filtered) {
    const item = document.createElement("div");
    item.className = `task-item ${task.completed ? "is-completed" : ""}`;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = task.completed;
    check.className = "task-check";
    check.setAttribute("aria-label", `Mark ${task.title} complete`);
    check.addEventListener("change", () => {
      toggleTask(task.id);
      renderTasks();
      renderDailySummary();
    });

    const label = document.createElement("span");
    label.className = "task-title";
    label.textContent = task.title;

    const badge = document.createElement("span");
    badge.className = `task-badge priority-${task.priority}`;
    badge.textContent = task.priority.toUpperCase();

    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn tiny danger-ghost";
    del.setAttribute("aria-label", `Delete task ${task.title}`);
    del.textContent = "×";
    del.addEventListener("click", () => {
      deleteTask(task.id);
      renderTasks();
      renderDailySummary();
      ui.toast("Task deleted", "ok");
    });

    item.appendChild(check);
    item.appendChild(label);
    item.appendChild(badge);
    item.appendChild(del);
    list.appendChild(item);
  }
}

/* ---------------------------------------------------------------------- notes */
function bindNoteControls() {
  const form = $("#noteForm");
  const titleInput = $("#noteTitleInput");
  const contentInput = $("#noteContentInput");
  const categoryInput = $("#noteCategoryInput");
  const searchInput = $("#noteSearchInput");

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = String(titleInput?.value || "").trim();
    const content = String(contentInput?.value || "").trim();
    const category = String(categoryInput?.value || "General").trim();
    if (!title && !content) return;

    addNote(title, content, category);
    if (titleInput) titleInput.value = "";
    if (contentInput) contentInput.value = "";
    renderNotes();
    ui.toast("Note saved", "ok");
  });

  searchInput?.addEventListener("input", () => {
    noteSearchQuery = searchInput.value;
    renderNotes();
  });
}

function renderNotes() {
  const list = $("#noteList");
  if (!list) return;

  const notes = noteSearchQuery ? searchNotes(noteSearchQuery) : getNotes();
  while (list.firstChild) list.removeChild(list.firstChild);

  if (notes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint text-center";
    empty.textContent = noteSearchQuery ? "No notes matching your search." : "No notes yet. Create your first note above.";
    list.appendChild(empty);
    return;
  }

  for (const note of notes) {
    const card = document.createElement("article");
    card.className = "note-card glass-soft";

    const head = document.createElement("div");
    head.className = "note-card-head";

    const title = document.createElement("h4");
    title.className = "note-title";
    title.textContent = note.title;

    const cat = document.createElement("span");
    cat.className = "note-category";
    cat.textContent = note.category;

    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn tiny danger-ghost";
    del.setAttribute("aria-label", `Delete note ${note.title}`);
    del.textContent = "×";
    del.addEventListener("click", () => {
      deleteNote(note.id);
      renderNotes();
      ui.toast("Note deleted", "ok");
    });

    head.appendChild(title);
    head.appendChild(cat);
    head.appendChild(del);

    const body = document.createElement("p");
    body.className = "note-content";
    body.textContent = note.content;

    card.appendChild(head);
    card.appendChild(body);
    list.appendChild(card);
  }
}

/* ------------------------------------------------------------------ reminders */
function bindReminderControls() {
  const form = $("#reminderForm");
  const titleInput = $("#reminderTitleInput");
  const timeInput = $("#reminderTimeInput");

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = String(titleInput?.value || "").trim();
    if (!title) return;
    const timeVal = timeInput?.value;
    const dueAt = timeVal ? new Date(timeVal).getTime() : Date.now() + 3600000;

    addReminder(title, dueAt);
    if (titleInput) titleInput.value = "";
    if (timeInput) timeInput.value = "";
    renderReminders();
    renderDailySummary();
    ui.toast("Reminder set", "ok");
  });
}

function renderReminders() {
  const list = $("#reminderList");
  if (!list) return;

  const reminders = getReminders();
  while (list.firstChild) list.removeChild(list.firstChild);

  if (reminders.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint text-center";
    empty.textContent = "No reminders scheduled.";
    list.appendChild(empty);
    return;
  }

  for (const rem of reminders) {
    const item = document.createElement("div");
    item.className = `reminder-item ${rem.completed ? "is-completed" : ""}`;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = rem.completed;
    check.className = "reminder-check";
    check.setAttribute("aria-label", `Toggle reminder ${rem.title}`);
    check.addEventListener("change", () => {
      toggleReminder(rem.id);
      renderReminders();
      renderDailySummary();
    });

    const info = document.createElement("div");
    info.className = "reminder-info";

    const label = document.createElement("strong");
    label.textContent = rem.title;

    const time = document.createElement("small");
    const d = new Date(rem.dueAt);
    time.textContent = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

    info.appendChild(label);
    info.appendChild(time);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn tiny danger-ghost";
    del.textContent = "×";
    del.addEventListener("click", () => {
      deleteReminder(rem.id);
      renderReminders();
      renderDailySummary();
      ui.toast("Reminder deleted", "ok");
    });

    item.appendChild(check);
    item.appendChild(info);
    item.appendChild(del);
    list.appendChild(item);
  }
}

/* ------------------------------------------------------------------- calendar */
function bindCalendar() {
  renderCalendarAgenda();
}

function renderCalendarAgenda() {
  const agenda = $("#calendarAgenda");
  if (!agenda) return;

  while (agenda.firstChild) agenda.removeChild(agenda.firstChild);

  const now = new Date();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const header = document.createElement("div");
  header.className = "calendar-header";
  header.textContent = `${dayNames[now.getDay()]}, ${monthNames[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  agenda.appendChild(header);

  const hours = [
    { time: "09:00", event: "Morning Systems Briefing & Intelligence Standup" },
    { time: "12:00", event: "Midday Task Review" },
    { time: "15:00", event: "Project Architecture & Code Verification" },
    { time: "18:00", event: "Daily Summary & Activity Sync" },
  ];

  for (const slot of hours) {
    const row = document.createElement("div");
    row.className = "agenda-row";

    const timeCol = document.createElement("time");
    timeCol.className = "agenda-time";
    timeCol.textContent = slot.time;

    const eventCol = document.createElement("div");
    eventCol.className = "agenda-event glass-soft";
    eventCol.textContent = slot.event;

    row.appendChild(timeCol);
    row.appendChild(eventCol);
    agenda.appendChild(row);
  }
}

/* ---------------------------------------------------------------- quick tools */
function evaluateMath(expression) {
  const tokens = String(expression || "").match(/(\d+(?:\.\d+)?|[+\-*/()])/g) || [];
  if (tokens.length === 0) return 0;
  // Simple operator precedence evaluator
  let i = 0;
  function parsePrimary() {
    const token = tokens[i++];
    if (token === "(") {
      const result = parseExpression();
      if (tokens[i] === ")") i++;
      return result;
    }
    return parseFloat(token) || 0;
  }
  function parseMultiplication() {
    let result = parsePrimary();
    while (tokens[i] === "*" || tokens[i] === "/") {
      const op = tokens[i++];
      const next = parsePrimary();
      result = op === "*" ? result * next : (next !== 0 ? result / next : 0);
    }
    return result;
  }
  function parseExpression() {
    let result = parseMultiplication();
    while (tokens[i] === "+" || tokens[i] === "-") {
      const op = tokens[i++];
      const next = parseMultiplication();
      result = op === "+" ? result + next : result - next;
    }
    return result;
  }
  return parseExpression();
}

function bindQuickTools() {
  // Calculator
  const calcDisplay = $("#calcDisplay");
  let calcExpr = "";

  $$(".calc-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = btn.dataset.val;
      if (val === "C") {
        calcExpr = "";
        if (calcDisplay) calcDisplay.value = "";
      } else if (val === "=") {
        try {
          const res = evaluateMath(calcExpr);
          calcExpr = String(Math.round(res * 10000) / 10000);
          if (calcDisplay) calcDisplay.value = calcExpr;
        } catch {
          if (calcDisplay) calcDisplay.value = "Error";
          calcExpr = "";
        }
      } else if (val) {
        calcExpr += val;
        if (calcDisplay) calcDisplay.value = calcExpr;
      }
    });
  });

  // World Clocks
  updateWorldClocks();
  setInterval(updateWorldClocks, 10000);
}

function updateWorldClocks() {
  const clocks = [
    { id: "clockNYC", tz: "America/New_York", label: "New York" },
    { id: "clockLondon", tz: "Europe/London", label: "London" },
    { id: "clockTokyo", tz: "Asia/Tokyo", label: "Tokyo" },
    { id: "clockDhaka", tz: "Asia/Dhaka", label: "Dhaka" },
  ];

  for (const c of clocks) {
    const el = $(`#${c.id}`);
    if (el) {
      try {
        const timeStr = new Date().toLocaleTimeString("en-US", {
          timeZone: c.tz,
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        });
        el.textContent = `${c.label}: ${timeStr}`;
      } catch {
        /* ignore invalid tz fallback */
      }
    }
  }
}

function bindSubtabs() {
  $$("#assistantSubtabs .subtab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pane = btn.dataset.pane;
      $$("#assistantSubtabs .subtab-btn").forEach((b) => {
        const active = b === btn;
        b.classList.toggle("is-active", active);
        b.setAttribute("aria-selected", active ? "true" : "false");
      });
      $$(".assistant-pane").forEach((p) => {
        const active = p.dataset.pane === pane;
        p.hidden = !active;
        p.classList.toggle("is-active", active);
      });
    });
  });
}

