/* VDPAI 2.0 — Real Persistent Client Database (IndexedDB & Local Storage).
 *
 * Provides transactional, durable, local-first database operations for
 * user accounts, conversations, chat messages, and user preferences.
 */

const DB_NAME = "VDPAI_2_DB";
const DB_VERSION = 1;

let dbInstance = null;

export function initDatabase() {
  if (typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // User accounts store
        if (!db.objectStoreNames.contains("users")) {
          const userStore = db.createObjectStore("users", { keyPath: "username" });
          userStore.createIndex("email", "email", { unique: false });
        }

        // Conversations store
        if (!db.objectStoreNames.contains("conversations")) {
          const convStore = db.createObjectStore("conversations", { keyPath: "id" });
          convStore.createIndex("updatedAt", "updatedAt", { unique: false });
          convStore.createIndex("profileId", "profileId", { unique: false });
        }

        // Key-Value preferences store
        if (!db.objectStoreNames.contains("preferences")) {
          db.createObjectStore("preferences", { keyPath: "key" });
        }
      };

      request.onsuccess = (event) => {
        dbInstance = event.target.result;
        resolve(dbInstance);
      };

      request.onerror = () => {
        resolve(null);
      };
    } catch {
      resolve(null);
    }
  });
}

function getStore(storeName, mode = "readonly") {
  if (!dbInstance) return null;
  try {
    const tx = dbInstance.transaction(storeName, mode);
    return tx.objectStore(storeName);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- User Accounts */
export async function hashPassword(password, salt) {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const data = new TextEncoder().encode(`${salt}:${password}`);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  let hash = 0;
  for (let i = 0; i < password.length; i++) {
    hash = (hash << 5) - hash + password.charCodeAt(i);
    hash |= 0;
  }
  return String(hash);
}

export function generateSalt() {
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

export async function dbSaveUser(user) {
  await initDatabase();
  const store = getStore("users", "readwrite");
  if (!store) {
    try {
      localStorage.setItem(`vdpai_user_${user.username}`, JSON.stringify(user));
      return true;
    } catch {
      return false;
    }
  }
  return new Promise((resolve) => {
    try {
      const req = store.put(user);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function dbGetUser(usernameOrEmail) {
  await initDatabase();
  const target = String(usernameOrEmail || "").trim();
  const store = getStore("users", "readonly");
  if (!store) {
    try {
      const direct = localStorage.getItem(`vdpai_user_${target}`);
      if (direct) return JSON.parse(direct);
      // Scan for email match in localStorage fallback
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith("vdpai_user_")) {
          const item = JSON.parse(localStorage.getItem(k) || "null");
          if (item?.email?.toLowerCase() === target.toLowerCase()) return item;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  return new Promise((resolve) => {
    try {
      // First try by username keyPath
      const req = store.get(target);
      req.onsuccess = () => {
        if (req.result) {
          resolve(req.result);
          return;
        }
        // Then try by email index
        try {
          const index = store.index("email");
          const emailReq = index.get(target.toLowerCase());
          emailReq.onsuccess = () => resolve(emailReq.result || null);
          emailReq.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function dbDeleteUser(username) {
  await initDatabase();
  const store = getStore("users", "readwrite");
  if (!store) {
    try {
      localStorage.removeItem(`vdpai_user_${username}`);
      return true;
    } catch {
      return false;
    }
  }
  return new Promise((resolve) => {
    try {
      const req = store.delete(username);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/* ------------------------------------------------------------- Conversations */
export async function dbSaveConversation(conversation) {
  await initDatabase();
  const store = getStore("conversations", "readwrite");
  if (!store) return true; // Handled by Capacitor Preferences / store.js
  return new Promise((resolve) => {
    try {
      const req = store.put(conversation);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function dbGetConversation(id) {
  await initDatabase();
  const store = getStore("conversations", "readonly");
  if (!store) return null;
  return new Promise((resolve) => {
    try {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function dbGetAllConversations() {
  await initDatabase();
  const store = getStore("conversations", "readonly");
  if (!store) return [];
  return new Promise((resolve) => {
    try {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function dbDeleteConversation(id) {
  await initDatabase();
  const store = getStore("conversations", "readwrite");
  if (!store) return true;
  return new Promise((resolve) => {
    try {
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/* ------------------------------------------------------------- Preferences */
export async function dbSavePref(key, value) {
  await initDatabase();
  const store = getStore("preferences", "readwrite");
  if (!store) {
    try {
      localStorage.setItem(`vdpai_pref_${key}`, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }
  return new Promise((resolve) => {
    try {
      const req = store.put({ key, value });
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function dbGetPref(key) {
  await initDatabase();
  const store = getStore("preferences", "readonly");
  if (!store) {
    try {
      const raw = localStorage.getItem(`vdpai_pref_${key}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => {
    try {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function dbClearAll() {
  await initDatabase();
  const stores = ["users", "conversations", "preferences"];
  for (const name of stores) {
    const s = getStore(name, "readwrite");
    if (s) {
      try {
        s.clear();
      } catch {
        /* ignore */
      }
    }
  }
}
