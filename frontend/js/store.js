/* VDPAI — local persistence and application data model.
 *
 * All non-secret UI preferences, provider configurations and conversations
 * live in one versioned document.  In the Android build the document is stored
 * through Capacitor Preferences (app-private SharedPreferences).  In a plain
 * browser the same document is stored in localStorage.
 *
 * API keys are only used by this device to call the selected provider.  They
 * are never sent to a backend operated by VDPAI and never written to a log.
 */

export const APP_NAME = "VDPAI";
export const APP_VERSION = "1.0.0";
export const APP_ID = "com.hsai.assistant";

const STORAGE_KEY = "hsai.store.v2";
const LEGACY_BACKEND_KEY = "jarvis.backendUrl";
const listeners = new Set();

let nativeStore = false;
let ready = false;
let saveTimer = null;
let saveChain = Promise.resolve();

export function defaultSettings() {
  return {
    language: "en-US",
    ttsEnabled: true,
    speechRate: 1,
    speechPitch: 1,
    voiceName: "",
    volume: 1,
    personalityStyle: "jarvis",
    userName: "Sir",
    assistantName: "VDPAI",
    systemPrompt:
      "You are VDPAI, a calm, confident, friendly personal AI assistant. " +
      "Answer clearly and honestly. Never claim to be conscious. If you do not know something, say so. " +
      "Use short paragraphs and plain text unless the user asks for detail.",
    activeProviderId: null,
    backendUrl: "",
    theme: "cyan",
    lowGlow: false,
    reduceMotion: false,
    showGrid: true,
    persistHistory: true,
    memoryEnabled: true,
    privateMode: false,
    launchAnimationEnabled: true,
    backgroundAssistantEnabled: false,
    continuousConversationMode: false,
  };
}

function defaultProfiles() {
  return [
    { id: "primary", name: "Primary", icon: "user", createdAt: Date.now() },
    { id: "work", name: "Work", icon: "briefcase", createdAt: Date.now() },
    { id: "private", name: "Private", icon: "shield", createdAt: Date.now() },
  ];
}

function defaultState() {
  return {
    version: 3,
    settings: defaultSettings(),
    activeProfileId: "primary",
    profiles: defaultProfiles(),
    providers: [],
    conversations: [],
    activeConversationId: null,
    tasks: [],
    notes: [],
    reminders: [],
    memories: [],
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, limit = 20000) {
  return String(value ?? "").slice(0, limit);
}

function normalizeUrl(value) {
  return String(value || "")
    .trim()
    .replace(/[\u2028\u2029<>"'\\]/g, "")
    .replace(/\/+$/, "");
}

function injectedBackendUrl() {
  if (typeof window === "undefined") return "";
  return normalizeUrl(window.HSAI_DEFAULT_BACKEND_URL || window.JARVIS_API_BASE || "");
}

export function id(prefix = "id") {
  const cryptoObject = typeof globalThis !== "undefined" ? globalThis.crypto : null;
  if (cryptoObject?.randomUUID) return `${prefix}_${cryptoObject.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------------------------------------------ storage */
function isNative() {
  return typeof window !== "undefined" && window.HSAI_NATIVE_BUILD === true;
}

function nativePreferences() {
  if (!isNative() || typeof window === "undefined") return null;
  const cap = window.Capacitor;
  if (!cap) return null;
  const plugin = cap.Plugins?.Preferences;
  if (plugin && typeof plugin.get === "function" && typeof plugin.set === "function") return plugin;
  if (typeof cap.nativePromise === "function") {
    return {
      get: (options) => cap.nativePromise("Preferences", "get", options),
      set: (options) => cap.nativePromise("Preferences", "set", options),
      remove: (options) => cap.nativePromise("Preferences", "remove", options),
    };
  }
  return null;
}

async function readRaw(key) {
  try {
    const prefs = nativePreferences();
    if (prefs) {
      nativeStore = true;
      const result = await prefs.get({ key });
      return result?.value || "";
    }
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

async function writeRaw(key, value) {
  try {
    const prefs = nativePreferences();
    if (prefs) {
      nativeStore = true;
      await prefs.set({ key, value });
      return;
    }
    localStorage.setItem(key, value);
  } catch {
    /* The in-memory state still works for this session. */
  }
}

async function removeRaw(key) {
  try {
    const prefs = nativePreferences();
    if (prefs) {
      nativeStore = true;
      await prefs.remove({ key });
      return;
    }
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ helpers */
function sanitizeProvider(raw) {
  if (!isObject(raw) || !raw.type) return null;
  const provider = {
    id: text(raw.id, 120) || id("prov"),
    name: text(raw.name, 80).trim() || "AI provider",
    type: text(raw.type, 30),
    apiKey: text(raw.apiKey, 4000),
    model: text(raw.model, 160).trim(),
    baseUrl: normalizeUrl(text(raw.baseUrl, 600)),
    endpoint: text(raw.endpoint, 300).trim(),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
  if (!provider.model) return null;
  return provider;
}

function sanitizeMessage(raw) {
  if (!isObject(raw) || !raw.role) return null;
  return {
    id: text(raw.id, 120) || id("msg"),
    role: raw.role === "assistant" ? "assistant" : "user",
    content: text(raw.content, 200000),
    createdAt: Number(raw.createdAt) || Date.now(),
  };
}

function sanitizeConversation(raw) {
  if (!isObject(raw) || !raw.id) return null;
  const messages = Array.isArray(raw.messages) ? raw.messages.map(sanitizeMessage).filter(Boolean) : [];
  return {
    id: text(raw.id, 120),
    title: text(raw.title, 120).trim() || "New conversation",
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    providerId: raw.providerId ? text(raw.providerId, 120) : null,
    model: raw.model ? text(raw.model, 160) : "",
    messages,
  };
}

function sanitizeTask(raw) {
  if (!isObject(raw) || !raw.title) return null;
  return {
    id: text(raw.id, 120) || id("task"),
    title: text(raw.title, 200).trim(),
    completed: Boolean(raw.completed),
    priority: ["high", "med", "normal"].includes(raw.priority) ? raw.priority : "normal",
    createdAt: Number(raw.createdAt) || Date.now(),
    dueDate: raw.dueDate ? Number(raw.dueDate) : null,
  };
}

function sanitizeNote(raw) {
  if (!isObject(raw) || (!raw.title && !raw.content)) return null;
  return {
    id: text(raw.id, 120) || id("note"),
    title: text(raw.title, 160).trim() || "Untitled note",
    content: text(raw.content, 40000),
    category: text(raw.category, 60).trim() || "General",
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function sanitizeReminder(raw) {
  if (!isObject(raw) || !raw.title) return null;
  return {
    id: text(raw.id, 120) || id("rem"),
    title: text(raw.title, 200).trim(),
    dueAt: Number(raw.dueAt) || Date.now() + 3600000,
    completed: Boolean(raw.completed),
    createdAt: Number(raw.createdAt) || Date.now(),
  };
}

function sanitizeMemory(raw) {
  if (!isObject(raw) || (!raw.key && !raw.value)) return null;
  return {
    id: text(raw.id, 120) || id("mem"),
    key: text(raw.key, 120).trim(),
    value: text(raw.value, 1000).trim(),
    category: ["identity", "preference", "habit", "custom"].includes(raw.category) ? raw.category : "preference",
    createdAt: Number(raw.createdAt) || Date.now(),
  };
}

function sanitizeProfile(raw) {
  if (!isObject(raw) || !raw.name) return null;
  return {
    id: text(raw.id, 60) || id("prof"),
    name: text(raw.name, 60).trim(),
    icon: text(raw.icon, 30) || "user",
    createdAt: Number(raw.createdAt) || Date.now(),
  };
}

function sanitize(raw) {
  const state = defaultState();
  if (!isObject(raw)) return state;
  state.settings = { ...state.settings, ...(isObject(raw.settings) ? raw.settings : {}) };
  state.settings.backendUrl = normalizeUrl(state.settings.backendUrl);
  state.settings.speechRate = Math.min(1.8, Math.max(0.5, Number(state.settings.speechRate) || 1));
  state.settings.speechPitch = Math.min(1.8, Math.max(0.6, Number(state.settings.speechPitch) || 1));
  state.settings.volume = Math.min(1, Math.max(0.1, Number(state.settings.volume) || 1));
  state.settings.ttsEnabled = Boolean(state.settings.ttsEnabled);
  state.settings.lowGlow = Boolean(state.settings.lowGlow);
  state.settings.reduceMotion = Boolean(state.settings.reduceMotion);
  state.settings.showGrid = state.settings.showGrid !== false;
  state.settings.persistHistory = state.settings.persistHistory !== false;
  state.settings.memoryEnabled = state.settings.memoryEnabled !== false;
  state.settings.privateMode = Boolean(state.settings.privateMode);
  state.settings.personalityStyle = text(state.settings.personalityStyle, 30) || "jarvis";
  state.settings.userName = text(state.settings.userName, 60) || "Sir";
  state.settings.assistantName = text(state.settings.assistantName, 60) || "VDPAI";
  state.settings.theme = ["cyan", "blue", "emerald", "gold", "violet", "crimson"].includes(state.settings.theme)
    ? state.settings.theme
    : "cyan";

  state.activeProfileId = text(raw.activeProfileId, 60) || "primary";
  state.profiles = Array.isArray(raw.profiles) && raw.profiles.length > 0
    ? raw.profiles.map(sanitizeProfile).filter(Boolean)
    : defaultProfiles();

  state.providers = Array.isArray(raw.providers) ? raw.providers.map(sanitizeProvider).filter(Boolean) : [];
  state.conversations = Array.isArray(raw.conversations)
    ? raw.conversations.map(sanitizeConversation).filter(Boolean)
    : [];
  state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  state.activeConversationId = state.conversations.some((item) => item.id === raw.activeConversationId)
    ? raw.activeConversationId
    : state.conversations[0]?.id || null;

  state.tasks = Array.isArray(raw.tasks) ? raw.tasks.map(sanitizeTask).filter(Boolean) : [];
  state.notes = Array.isArray(raw.notes) ? raw.notes.map(sanitizeNote).filter(Boolean) : [];
  state.reminders = Array.isArray(raw.reminders) ? raw.reminders.map(sanitizeReminder).filter(Boolean) : [];
  state.memories = Array.isArray(raw.memories) ? raw.memories.map(sanitizeMemory).filter(Boolean) : [];

  if (state.settings.activeProviderId && !state.providers.some((item) => item.id === state.settings.activeProviderId)) {
    state.settings.activeProviderId = null;
  }
  return state;
}

let state = defaultState();

/** Load the persisted document before the HUD is wired. */
export async function initStore() {
  if (ready) return state;
  ready = true;
  const raw = await readRaw(STORAGE_KEY);
  if (raw) {
    try {
      state = sanitize(JSON.parse(raw));
    } catch {
      state = defaultState();
    }
  } else {
    state = defaultState();
    // One-time, non-secret migration of the old backend URL setting.
    const legacy = await readRaw(LEGACY_BACKEND_KEY);
    state.settings.backendUrl = normalizeUrl(legacy || injectedBackendUrl());
  }
  if (!state.settings.backendUrl) state.settings.backendUrl = injectedBackendUrl();
  return state;
}

export function getState() {
  return state;
}

export function getSettings() {
  return state.settings;
}

export function usesNativeStorage() {
  return nativeStore;
}

function notify() {
  for (const listener of [...listeners]) {
    try {
      listener(state);
    } catch {
      /* a broken listener must never break persistence */
    }
  }
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow().catch(() => {});
  }, 180);
  notify();
}

/** Persist immediately (called when the app goes to the background). */
export function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const snapshot = JSON.stringify(state);
  saveChain = saveChain.then(() => writeRaw(STORAGE_KEY, snapshot)).catch(() => {});
  return saveChain;
}

function touchConversation(conversation) {
  conversation.updatedAt = Date.now();
  state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  scheduleSave();
}

/* --------------------------------------------------------------- settings */
export function updateSettings(patch) {
  if (!isObject(patch)) return state.settings;
  state.settings = { ...state.settings, ...patch };
  state.settings.backendUrl = normalizeUrl(state.settings.backendUrl);
  scheduleSave();
  return state.settings;
}

/* -------------------------------------------------------------- providers */
export function getProviders() {
  return state.providers;
}

export function getActiveProvider() {
  return state.providers.find((item) => item.id === state.settings.activeProviderId) || null;
}

export function getProvider(providerId) {
  return state.providers.find((item) => item.id === providerId) || null;
}

export function addProvider(raw) {
  const provider = sanitizeProvider({
    ...raw,
    id: id("prov"),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  if (!provider) throw new Error("A model ID is required.");
  state.providers.push(provider);
  if (!state.settings.activeProviderId) state.settings.activeProviderId = provider.id;
  scheduleSave();
  return provider;
}

export function updateProvider(providerId, patch) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error("Provider not found.");
  Object.assign(provider, sanitizeProvider({ ...provider, ...patch, id: provider.id, updatedAt: Date.now() }));
  scheduleSave();
  return provider;
}

export function removeProvider(providerId) {
  const before = state.providers.length;
  state.providers = state.providers.filter((item) => item.id !== providerId);
  if (state.settings.activeProviderId === providerId) {
    state.settings.activeProviderId = state.providers[0]?.id || null;
  }
  if (state.providers.length !== before) scheduleSave();
  return state.providers.length !== before;
}

export function setActiveProvider(providerId) {
  if (!getProvider(providerId)) throw new Error("Provider not found.");
  state.settings.activeProviderId = providerId;
  scheduleSave();
  return getProvider(providerId);
}

/* ---------------------------------------------------------- conversations */
export function getConversations() {
  return state.conversations;
}

export function getConversation(conversationId) {
  return state.conversations.find((item) => item.id === conversationId) || null;
}

export function getActiveConversation() {
  return getConversation(state.activeConversationId);
}

export function createConversation({ title = "", providerId = null, model = "" } = {}) {
  const conversation = {
    id: id("conv"),
    title: text(title, 120).trim() || "New conversation",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    providerId,
    model,
    messages: [],
  };
  state.conversations.unshift(conversation);
  state.activeConversationId = conversation.id;
  scheduleSave();
  return conversation;
}

/** Reuse an empty active conversation instead of creating empty duplicates. */
export function ensureConversation() {
  const active = getActiveConversation();
  if (active) return active;
  return createConversation();
}

export function setActiveConversation(conversationId) {
  if (!getConversation(conversationId)) return null;
  state.activeConversationId = conversationId;
  scheduleSave();
  return getConversation(conversationId);
}

export function setConversationProvider(conversationId, providerId, model) {
  const conversation = getConversation(conversationId);
  if (!conversation) return null;
  conversation.providerId = providerId || null;
  conversation.model = text(model, 160);
  touchConversation(conversation);
  return conversation;
}

export function addMessage(conversationId, role, content) {
  const conversation = getConversation(conversationId);
  if (!conversation) return null;
  const message = {
    id: id("msg"),
    role: role === "assistant" ? "assistant" : "user",
    content: text(content, 200000),
    createdAt: Date.now(),
  };
  conversation.messages.push(message);
  if (role === "user" && conversation.messages.filter((item) => item.role === "user").length === 1) {
    conversation.title = titleFrom(content);
  }
  touchConversation(conversation);
  return message;
}

export function updateMessage(conversationId, messageId, content) {
  const conversation = getConversation(conversationId);
  if (!conversation) return null;
  const message = conversation.messages.find((item) => item.id === messageId);
  if (!message) return null;
  message.content = text(content, 200000);
  touchConversation(conversation);
  return message;
}

export function removeMessage(conversationId, messageId) {
  const conversation = getConversation(conversationId);
  if (!conversation) return false;
  const before = conversation.messages.length;
  conversation.messages = conversation.messages.filter((item) => item.id !== messageId);
  if (conversation.messages.length === before) return false;
  touchConversation(conversation);
  return true;
}

export function renameConversation(conversationId, title) {
  const conversation = getConversation(conversationId);
  if (!conversation) return null;
  conversation.title = text(title, 120).trim() || conversation.title;
  touchConversation(conversation);
  return conversation;
}

export function deleteConversation(conversationId) {
  const index = state.conversations.findIndex((item) => item.id === conversationId);
  if (index < 0) return false;
  state.conversations.splice(index, 1);
  if (state.activeConversationId === conversationId) {
    state.activeConversationId = state.conversations[0]?.id || null;
  }
  scheduleSave();
  return true;
}

export function clearConversations() {
  state.conversations = [];
  state.activeConversationId = null;
  scheduleSave();
  return true;
}

export function searchConversations(query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return state.conversations;
  return state.conversations.filter(
    (item) =>
      item.title.toLowerCase().includes(needle) ||
      item.messages.some((message) => message.content.toLowerCase().includes(needle)),
  );
}

export function titleFrom(content) {
  const flat = String(content || "").replace(/\s+/g, " ").trim();
  if (!flat) return "New conversation";
  return flat.length > 52 ? `${flat.slice(0, 51)}…` : flat;
}

export const PERSONALITY_STYLES = {
  jarvis: {
    id: "jarvis",
    name: "JARVIS",
    tagline: "Confident, intelligent, and subtly witty assistant",
    instruction:
      "You are VDPAI, an elite, calm, witty, and exceptionally capable AI personal assistant inspired by J.A.R.V.I.S. " +
      "Address the user with respectful charm (e.g. Sir or their preferred name). Be observant, highly intelligent, and subtle in wit. " +
      "Never claim consciousness. Understand and fluently speak English, Bengali (বাংলা), Hindi (हिन्दी), and mixed Banglish.",
  },
  professional: {
    id: "professional",
    name: "Professional",
    tagline: "Executive precision, structured and clear",
    instruction:
      "You are VDPAI, a sharp executive AI assistant. Your answers are direct, well-structured, analytical, and objective. " +
      "Avoid unnecessary fluff. Understand and fluently speak English, Bengali (বাংলা), Hindi (हिन्दी), and mixed Banglish.",
  },
  friendly: {
    id: "friendly",
    name: "Friendly",
    tagline: "Warm, supportive, and companionable",
    instruction:
      "You are VDPAI, a warm, positive, friendly AI companion. Speak naturally, be supportive, and offer helpful guidance. " +
      "Understand and fluently speak English, Bengali (বাংলা), Hindi (हिन्दी), and mixed Banglish.",
  },
  concise: {
    id: "concise",
    name: "Concise",
    tagline: "Direct bullet points, maximum density",
    instruction:
      "You are VDPAI. Deliver ultra-concise answers. Use bullet points and direct solutions without unnecessary filler. " +
      "Understand and fluently speak English, Bengali (বাংলা), Hindi (हिन्दी), and mixed Banglish.",
  },
  creative: {
    id: "creative",
    name: "Creative",
    tagline: "Expansive, imaginative, and articulate",
    instruction:
      "You are VDPAI, an imaginative, articulate, and expressive AI assistant capable of deep ideation and brainstorming. " +
      "Understand and fluently speak English, Bengali (বাংলা), Hindi (हिन्दी), and mixed Banglish.",
  },
};

export function getEffectiveSystemPrompt() {
  const settings = state.settings;
  const style = PERSONALITY_STYLES[settings.personalityStyle] || PERSONALITY_STYLES.jarvis;
  let prompt = settings.systemPrompt || style.instruction;

  if (settings.userName && settings.userName !== "Sir") {
    prompt += ` Address the user as "${settings.userName}".`;
  }

  if (settings.memoryEnabled && !settings.privateMode && state.memories?.length) {
    const memoryLines = state.memories.slice(0, 20).map((m) => `- ${m.key}: ${m.value}`).join("\n");
    prompt += `\n\n[USER PERSONAL MEMORY CONTEXT]\n${memoryLines}\nUse this context naturally when relevant.`;
  }

  if (state.tasks?.some((t) => !t.completed)) {
    const pending = state.tasks.filter((t) => !t.completed).slice(0, 5).map((t) => `- ${t.title} (${t.priority})`).join("\n");
    prompt += `\n\n[ACTIVE USER TASKS]\n${pending}`;
  }

  return prompt;
}

/* -------------------------------------------------------------------- tasks */
export function getTasks() {
  return [...state.tasks];
}

export function addTask(title, priority = "normal", dueDate = null) {
  const task = {
    id: id("task"),
    title: text(title, 200).trim(),
    completed: false,
    priority: ["high", "med", "normal"].includes(priority) ? priority : "normal",
    createdAt: Date.now(),
    dueDate: dueDate ? Number(dueDate) : null,
  };
  if (!task.title) return null;
  state.tasks.unshift(task);
  scheduleSave();
  return task;
}

export function toggleTask(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return null;
  task.completed = !task.completed;
  scheduleSave();
  return task;
}

export function deleteTask(taskId) {
  const index = state.tasks.findIndex((item) => item.id === taskId);
  if (index < 0) return false;
  state.tasks.splice(index, 1);
  scheduleSave();
  return true;
}

/* -------------------------------------------------------------------- notes */
export function getNotes() {
  return [...state.notes];
}

export function addNote(title, content = "", category = "General") {
  const note = {
    id: id("note"),
    title: text(title, 160).trim() || "Untitled note",
    content: text(content, 40000),
    category: text(category, 60).trim() || "General",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.notes.unshift(note);
  scheduleSave();
  return note;
}

export function updateNote(noteId, fields = {}) {
  const note = state.notes.find((item) => item.id === noteId);
  if (!note) return null;
  if (fields.title !== undefined) note.title = text(fields.title, 160).trim() || note.title;
  if (fields.content !== undefined) note.content = text(fields.content, 40000);
  if (fields.category !== undefined) note.category = text(fields.category, 60).trim() || note.category;
  note.updatedAt = Date.now();
  scheduleSave();
  return note;
}

export function deleteNote(noteId) {
  const index = state.notes.findIndex((item) => item.id === noteId);
  if (index < 0) return false;
  state.notes.splice(index, 1);
  scheduleSave();
  return true;
}

export function searchNotes(query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return state.notes;
  return state.notes.filter(
    (n) => n.title.toLowerCase().includes(needle) || n.content.toLowerCase().includes(needle) || n.category.toLowerCase().includes(needle),
  );
}

/* ---------------------------------------------------------------- reminders */
export function getReminders() {
  return [...state.reminders];
}

export function addReminder(title, dueAt = null) {
  const reminder = {
    id: id("rem"),
    title: text(title, 200).trim(),
    dueAt: dueAt ? Number(dueAt) : Date.now() + 3600000,
    completed: false,
    createdAt: Date.now(),
  };
  if (!reminder.title) return null;
  state.reminders.unshift(reminder);
  scheduleSave();
  return reminder;
}

export function toggleReminder(reminderId) {
  const reminder = state.reminders.find((item) => item.id === reminderId);
  if (!reminder) return null;
  reminder.completed = !reminder.completed;
  scheduleSave();
  return reminder;
}

export function deleteReminder(reminderId) {
  const index = state.reminders.findIndex((item) => item.id === reminderId);
  if (index < 0) return false;
  state.reminders.splice(index, 1);
  scheduleSave();
  return true;
}

/* ----------------------------------------------------------------- memories */
export function getMemories() {
  return [...state.memories];
}

export function addMemory(key, value, category = "preference") {
  const memory = {
    id: id("mem"),
    key: text(key, 120).trim(),
    value: text(value, 1000).trim(),
    category: ["identity", "preference", "habit", "custom"].includes(category) ? category : "preference",
    createdAt: Date.now(),
  };
  if (!memory.key || !memory.value) return null;
  const existing = state.memories.find((item) => item.key.toLowerCase() === memory.key.toLowerCase());
  if (existing) {
    existing.value = memory.value;
    existing.category = memory.category;
  } else {
    state.memories.unshift(memory);
  }
  scheduleSave();
  return memory;
}

export function updateMemory(memoryId, fields = {}) {
  const memory = state.memories.find((item) => item.id === memoryId);
  if (!memory) return null;
  if (fields.key !== undefined) memory.key = text(fields.key, 120).trim() || memory.key;
  if (fields.value !== undefined) memory.value = text(fields.value, 1000).trim() || memory.value;
  if (fields.category !== undefined) memory.category = fields.category;
  scheduleSave();
  return memory;
}

export function deleteMemory(memoryId) {
  const index = state.memories.findIndex((item) => item.id === memoryId);
  if (index < 0) return false;
  state.memories.splice(index, 1);
  scheduleSave();
  return true;
}

export function clearMemories() {
  state.memories = [];
  scheduleSave();
  return true;
}

export function searchMemories(query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return state.memories;
  return state.memories.filter(
    (m) => m.key.toLowerCase().includes(needle) || m.value.toLowerCase().includes(needle),
  );
}

/* ----------------------------------------------------------------- profiles */
export function getProfiles() {
  return [...state.profiles];
}

export function getActiveProfileId() {
  return state.activeProfileId || "primary";
}

export function setActiveProfileId(profileId) {
  if (state.profiles.some((p) => p.id === profileId)) {
    state.activeProfileId = profileId;
    scheduleSave();
    return true;
  }
  return false;
}

export function addProfile(name, icon = "user") {
  const profile = {
    id: id("prof"),
    name: text(name, 60).trim() || "New Profile",
    icon: text(icon, 30) || "user",
    createdAt: Date.now(),
  };
  state.profiles.push(profile);
  scheduleSave();
  return profile;
}

export function deleteProfile(profileId) {
  if (profileId === "primary") return false;
  const index = state.profiles.findIndex((p) => p.id === profileId);
  if (index < 0) return false;
  state.profiles.splice(index, 1);
  if (state.activeProfileId === profileId) {
    state.activeProfileId = "primary";
  }
  scheduleSave();
  return true;
}

export function resetProfile(profileId) {
  if (state.activeProfileId === profileId) {
    state.conversations = [];
    state.activeConversationId = null;
    state.memories = [];
    state.tasks = [];
    state.notes = [];
    state.reminders = [];
    scheduleSave();
    return true;
  }
  return false;
}

/** Delete every locally stored setting, credential and conversation. */
export async function clearAllData() {
  state = defaultState();
  await removeRaw(STORAGE_KEY);
  await removeRaw(LEGACY_BACKEND_KEY);
  notify();
  return state;
}

/** JSON export for the privacy page (does not include a hidden copy). */
export function exportData() {
  return JSON.stringify(
    {
      app: APP_NAME,
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      settings: state.settings,
      profiles: state.profiles,
      activeProfileId: state.activeProfileId,
      providers: state.providers.map((provider) => ({ ...provider, apiKey: provider.apiKey ? "[redacted]" : "" })),
      conversations: state.conversations,
      tasks: state.tasks,
      notes: state.notes,
      reminders: state.reminders,
      memories: state.memories,
    },
    null,
    2,
  );
}

/* ------------------------------------------------------------------ HUD Log */
const HUD_LOG_KEY = "vdpai_hud_log";

export function getHudLog() {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(HUD_LOG_KEY) : null;
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function addHudLogEntry(text) {
  try {
    const log = getHudLog();
    const d = new Date();
    const time = [
      String(d.getHours()).padStart(2, "0"),
      String(d.getMinutes()).padStart(2, "0"),
      String(d.getSeconds()).padStart(2, "0"),
    ].join(":");
    const entry = { id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, time, text };
    log.unshift(entry);
    if (log.length > 40) log.length = 40;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(HUD_LOG_KEY, JSON.stringify(log));
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("vdpai:hudlog", { detail: entry }));
    }
    return entry;
  } catch {
    return null;
  }
}

export function clearHudLog() {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(HUD_LOG_KEY);
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("vdpai:hudlog", { detail: null }));
    }
  } catch {}
}

/* ----------------------------------------------------------- Quick Commands */
const QUICK_CMDS_KEY = "vdpai_quick_commands";
const DEFAULT_QUICK_COMMANDS = [
  { label: "Status Briefing", prompt: "Give me a short status briefing." },
  { label: "Plan Day", prompt: "Help me plan my day in five concise steps." },
  { label: "Capabilities", prompt: "What are your full capabilities as VDPAI?" },
  { label: "বাংলা", prompt: "কেমন আছেন? আজকের আবহাওয়া ও গুরুত্বপূর্ণ কাজ সম্পর্কে বলুন।" },
  { label: "हिन्दी", prompt: "नमस्ते VDPAI, आज की मुख्य योजना क्या है?" },
];

export function getCustomQuickCommands() {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(QUICK_CMDS_KEY) : null;
    if (raw) return JSON.parse(raw);
  } catch {}
  return [...DEFAULT_QUICK_COMMANDS];
}

export function saveCustomQuickCommands(commands) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(QUICK_CMDS_KEY, JSON.stringify(commands));
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("vdpai:quickcommands", { detail: commands }));
    }
  } catch {}
}

export function addCustomQuickCommand(item) {
  const list = getCustomQuickCommands();
  list.push(item);
  saveCustomQuickCommands(list);
  return list;
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (saveTimer) saveNow().catch(() => {});
  });
  document.addEventListener?.("visibilitychange", () => {
    if (document.hidden && saveTimer) saveNow().catch(() => {});
  });
}

