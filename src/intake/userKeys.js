// src/intake/userKeys.js
// Gemini & Todoist API keys, stored per Telegram user id. keys[0] = primary, rest = fallbacks.
import fs from "node:fs";
import path from "node:path";
import { ROOT, TODOIST_API_KEY } from "../config.js";
import { hasDatabaseUrl, readLocalStore, withDb, writeLocalStore } from "../db.js";

// Same leniency as the setup page: any 20+ character token without spaces or quotes
const KEY_RE = /^[^\s"']{20,}$/;
export const isValidKey = (k) => typeof k === "string" && KEY_RE.test(k.trim());

/**
 * Clean & normalize a Todoist API token (strips surrounding spaces, quotes, or accidental "Bearer " prefix).
 */
export function cleanTodoistKey(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

// Todoist API tokens (personal and OAuth) are exactly 40 hex characters. Anything else is not a real key.
const TODOIST_KEY_RE = /^[a-f0-9]{40}$/i;
export const isValidTodoistKey = (k) => {
  const cleaned = cleanTodoistKey(k);
  return TODOIST_KEY_RE.test(cleaned);
};

/** Class 1..12 as an integer, or null when it isn't a valid class. */
export function normalizeClassLevel(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = parseInt(String(raw).replace(/^class\s*/i, ""), 10);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

/** Check a Playwright storage_state object; returns a summary or throws. */
export function inspectStorageState(state, domainPart = "google") {
  const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
  const google = cookies.filter((c) => String(c.domain || "").includes(domainPart));
  if (!google.length) throw new Error("The captured session has no Google cookies. Please sign in again.");
  return { cookie_count: cookies.length, google_cookie_count: google.length };
}

/**
 * Save everything the setup page collects for one Telegram user.
 * keys: Gemini keys (primary first); notebooklmState: notebooklm-py storage_state object;
 * todoistKey: Todoist API token.
 */
export async function saveUserConfig(
  telegramUserId,
  { keys = [], notebooklmState = null, email = null, todoistKey = undefined, classLevel = undefined } = {}
) {
  const cls = normalizeClassLevel(classLevel);
  const clean = [...new Set((Array.isArray(keys) ? keys : []).map((k) => String(k).trim()).filter(isValidKey))];
  const [primary = "", ...fallbacks] = clean;

  const hasTodoistArg = todoistKey !== undefined && todoistKey !== null && String(todoistKey).trim() !== "";
  const cleanedTodoist = hasTodoistArg ? cleanTodoistKey(todoistKey) : "";
  const validTodoist = hasTodoistArg && isValidTodoistKey(cleanedTodoist);
  const clearTodoist = todoistKey === "";

  // Mirror to local store so keys work even if Postgres is offline or DATABASE_URL is not configured
  const store = readLocalStore();
  store.users = store.users || {};
  const uidStr = String(telegramUserId);
  const prev = store.users[uidStr] || {
    gemini_api_key: "",
    gemini_fallback_keys: [],
    todoist_api_key: null,
    google_email: null,
    has_session: false,
  };
  if (clean.length) {
    prev.gemini_api_key = primary;
    prev.gemini_fallback_keys = fallbacks;
  }
  if (validTodoist) {
    prev.todoist_api_key = cleanedTodoist;
    // Also mirror as default global fallback in local store so single-user setups never lose the key across ID changes
    store.default_todoist_api_key = cleanedTodoist;
  } else if (clearTodoist) {
    prev.todoist_api_key = null;
  }
  if (email) {
    prev.google_email = email;
  }
  if (cls) prev.class_level = cls;
  if (notebooklmState) {
    prev.has_session = true;
    prev.notebooklm_saved_at = new Date().toISOString();
    try {
      const sessDir = path.join(ROOT, "data", "sessions");
      fs.mkdirSync(sessDir, { recursive: true });
      fs.writeFileSync(path.join(sessDir, `${telegramUserId}.json`), JSON.stringify(notebooklmState), { mode: 0o600 });
    } catch {}
  }
  prev.updated_at = new Date().toISOString();
  store.users[uidStr] = prev;
  writeLocalStore(store);

  if (hasDatabaseUrl()) {
    try {
      await withDb(async (db) => {
        await db.query(
          "INSERT INTO users (telegram_user_id, gemini_api_key, gemini_fallback_keys, todoist_api_key) VALUES ($1, $2, $3, $4) " +
            "ON CONFLICT (telegram_user_id) DO NOTHING",
          [telegramUserId, primary, JSON.stringify(fallbacks), validTodoist ? cleanedTodoist : null]
        );
        if (clean.length) {
          await db.query(
            "UPDATE users SET gemini_api_key = $1, gemini_fallback_keys = $2, updated_at = now() " +
              "WHERE telegram_user_id = $3",
            [primary, JSON.stringify(fallbacks), telegramUserId]
          );
        }
        if (validTodoist) {
          await db.query(
            "UPDATE users SET todoist_api_key = $1, updated_at = now() WHERE telegram_user_id = $2",
            [cleanedTodoist, telegramUserId]
          );
        } else if (clearTodoist) {
          await db.query(
            "UPDATE users SET todoist_api_key = NULL, updated_at = now() WHERE telegram_user_id = $1",
            [telegramUserId]
          );
        }
        if (email) {
          await db.query(
            "UPDATE users SET google_email = $1, updated_at = now() WHERE telegram_user_id = $2",
            [email, telegramUserId]
          );
        }
        if (cls) {
          await db.query(
            "UPDATE users SET class_level = $1, updated_at = now() WHERE telegram_user_id = $2",
            [cls, telegramUserId]
          );
        }
        if (notebooklmState) {
          await db.query(
            "UPDATE users SET notebooklm_state = $1, notebooklm_saved_at = now(), " +
              "updated_at = now() WHERE telegram_user_id = $2",
            [JSON.stringify(notebooklmState), telegramUserId]
          );
        }
      });
    } catch (e) {
      console.log(`Saved user config to local store (DB warning: ${e.message})`);
    }
  }

  return {
    keys: clean.length,
    session: Boolean(notebooklmState),
    email: Boolean(email),
    todoist: Boolean(validTodoist),
    class_level: cls,
  };
}

export const saveUserKeys = (id, keys) => saveUserConfig(id, { keys });
export const saveTodoistKey = (id, todoistKey) => saveUserConfig(id, { todoistKey });
export const saveUserClass = (id, classLevel) => saveUserConfig(id, { classLevel });

/** This student's class (1..12) as saved on the setup page, or null if they haven't chosen one yet. Never read from .env. */
export async function getUserClass(telegramUserId) {
  if (hasDatabaseUrl()) {
    try {
      const v = await withDb(async (db) => {
        const { rows } = await db.query("SELECT class_level FROM users WHERE telegram_user_id = $1", [telegramUserId]);
        return rows[0]?.class_level ?? null;
      });
      const n = normalizeClassLevel(v);
      if (n) return n;
    } catch {}
  }
  const store = readLocalStore();
  return normalizeClassLevel(store.users?.[String(telegramUserId)]?.class_level);
}

export async function getUserProfile(telegramUserId) {
  const store = readLocalStore();
  const localUser = store.users?.[String(telegramUserId)] || null;

  if (hasDatabaseUrl()) {
    try {
      const dbRow = await withDb(async (db) => {
        const { rows } = await db.query(
          "SELECT google_email, todoist_api_key, class_level, (notebooklm_state IS NOT NULL) AS has_session, notebooklm_saved_at " +
            "FROM users WHERE telegram_user_id = $1",
          [telegramUserId]
        );
        return rows[0] || null;
      });
      if (dbRow) {
        return {
          ...dbRow,
          class_level: normalizeClassLevel(dbRow.class_level) || normalizeClassLevel(localUser?.class_level),
          todoist_api_key: dbRow.todoist_api_key || localUser?.todoist_api_key || store.default_todoist_api_key || null,
        };
      }
    } catch {}
  }

  if (localUser) {
    return {
      google_email: localUser.google_email || null,
      todoist_api_key: localUser.todoist_api_key || store.default_todoist_api_key || null,
      has_session: Boolean(localUser.has_session),
      class_level: normalizeClassLevel(localUser.class_level),
      notebooklm_saved_at: localUser.notebooklm_saved_at || null,
    };
  }
  return null;
}

export const saveUserKey = (telegramUserId, apiKey) => saveUserKeys(telegramUserId, [apiKey]);

/** All Gemini keys for this user, primary first. [] if none. */
export async function getUserKeys(telegramUserId) {
  const store = readLocalStore();
  const localUser = store.users?.[String(telegramUserId)];
  const localKeys = localUser
    ? [localUser.gemini_api_key, ...(localUser.gemini_fallback_keys || [])].filter(Boolean)
    : [];

  if (hasDatabaseUrl()) {
    try {
      const dbKeys = await withDb(async (db) => {
        const { rows } = await db.query(
          "SELECT gemini_api_key, gemini_fallback_keys FROM users WHERE telegram_user_id = $1",
          [telegramUserId]
        );
        const row = rows[0];
        if (!row) return [];
        let fb = [];
        try { fb = JSON.parse(row.gemini_fallback_keys); } catch {}
        return [row.gemini_api_key, ...fb].filter(Boolean);
      });
      if (dbKeys.length) return dbKeys;
    } catch {}
  }

  if (localKeys.length) return localKeys;

  // Fallback to any configured user key in local store if guest/paired ID changed
  for (const u of Object.values(store.users || {})) {
    const k = [u?.gemini_api_key, ...(u?.gemini_fallback_keys || [])].filter(Boolean);
    if (k.length) return k;
  }
  return [];
}

/**
 * Retrieve the user's Todoist API key, checking:
 * 1) Explicit override (if passed from request/cookie and valid)
 * 2) User's saved key in database / local store
 * 3) Any saved Todoist key across local store or users table (handles Guest ID -> Telegram ID transitions)
 * 4) Fallback to process.env.TODOIST_API_KEY
 */
export async function getTodoistKey(telegramUserId, overrideKey = null) {
  if (overrideKey && isValidTodoistKey(overrideKey)) {
    return cleanTodoistKey(overrideKey);
  }
  if (telegramUserId && !Number.isNaN(Number(telegramUserId))) {
    const profile = await getUserProfile(Number(telegramUserId));
    if (profile?.todoist_api_key && isValidTodoistKey(profile.todoist_api_key)) {
      return cleanTodoistKey(profile.todoist_api_key);
    }
  }

  // Check local store across any saved user ID (e.g., if saved before Telegram pairing under 100000001)
  const store = readLocalStore();
  if (store.default_todoist_api_key && isValidTodoistKey(store.default_todoist_api_key)) {
    return cleanTodoistKey(store.default_todoist_api_key);
  }
  for (const u of Object.values(store.users || {})) {
    if (u?.todoist_api_key && isValidTodoistKey(u.todoist_api_key)) {
      return cleanTodoistKey(u.todoist_api_key);
    }
  }

  // Check database fallback across users table
  if (hasDatabaseUrl()) {
    try {
      const anyDbKey = await withDb(async (db) => {
        const { rows } = await db.query(
          "SELECT todoist_api_key FROM users WHERE todoist_api_key IS NOT NULL AND todoist_api_key <> '' ORDER BY updated_at DESC LIMIT 1"
        );
        return rows[0]?.todoist_api_key || null;
      });
      if (anyDbKey && isValidTodoistKey(anyDbKey)) {
        return cleanTodoistKey(anyDbKey);
      }
    } catch {}
  }

  if (TODOIST_API_KEY && isValidTodoistKey(TODOIST_API_KEY)) {
    return cleanTodoistKey(TODOIST_API_KEY);
  }
  if (process.env.TODOIST_API_KEY && isValidTodoistKey(process.env.TODOIST_API_KEY)) {
    return cleanTodoistKey(process.env.TODOIST_API_KEY);
  }
  return "";
}

export async function deleteUserKey(telegramUserId) {
  const store = readLocalStore();
  const hadLocal = Boolean(store.users?.[String(telegramUserId)]);
  if (store.users) {
    delete store.users[String(telegramUserId)];
    writeLocalStore(store);
  }

  if (hasDatabaseUrl()) {
    try {
      return await withDb(async (db) => {
        const res = await db.query("DELETE FROM users WHERE telegram_user_id = $1", [telegramUserId]);
        return res.rowCount > 0 || hadLocal;
      });
    } catch {}
  }
  return hadLocal;
}

/**
 * Write this user's saved NotebookLM session to a file notebooklm-py can load
 * (e.g. NotebookLMClient.from_storage(path)). Returns the path, or null if none saved.
 */
export async function exportStorageStateFile(telegramUserId, dir = path.join(ROOT, "data", "sessions")) {
  if (hasDatabaseUrl()) {
    try {
      const row = await withDb(async (db) => {
        const { rows } = await db.query(
          "SELECT notebooklm_state FROM users WHERE telegram_user_id = $1",
          [telegramUserId]
        );
        return rows[0];
      });
      if (row?.notebooklm_state) {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${telegramUserId}.json`);
        fs.writeFileSync(file, row.notebooklm_state, { mode: 0o600 });
        return file;
      }
    } catch {}
  }
  const existingFile = path.join(dir, `${telegramUserId}.json`);
  if (fs.existsSync(existingFile)) return existingFile;
  return null;
}
