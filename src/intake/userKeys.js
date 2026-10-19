// src/intake/userKeys.js
// Gemini API keys, stored per Telegram user id. keys[0] = primary, rest = fallbacks.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";
import { withDb } from "../db.js";

// Same leniency as the setup page: any 20+ character token without spaces or quotes
const KEY_RE = /^[^\s"']{20,}$/;
export const isValidKey = (k) => typeof k === "string" && KEY_RE.test(k.trim());

/** Check a Playwright storage_state object; returns a summary or throws. */
export function inspectStorageState(state, domainPart = "google") {
  const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
  const google = cookies.filter((c) => String(c.domain || "").includes(domainPart));
  if (!google.length) throw new Error("The captured session has no Google cookies. Please sign in again.");
  return { cookie_count: cookies.length, google_cookie_count: google.length };
}

/**
 * Save everything the setup page collects for one Telegram user.
 * keys: Gemini keys (primary first); notebooklmState: notebooklm-py storage_state object.
 */
export function saveUserConfig(telegramUserId, { keys = [], notebooklmState = null, email = null } = {}) {
  const clean = [...new Set(keys.map((k) => String(k).trim()).filter(isValidKey))];
  const [primary = "", ...fallbacks] = clean;
  withDb((db) => {
    db.prepare(
      "INSERT INTO users (telegram_user_id, gemini_api_key, gemini_fallback_keys) VALUES (?, ?, ?) " +
        "ON CONFLICT(telegram_user_id) DO NOTHING"
    ).run(telegramUserId, primary, JSON.stringify(fallbacks));
    if (clean.length) {
      db.prepare(
        "UPDATE users SET gemini_api_key = ?, gemini_fallback_keys = ?, updated_at = datetime('now') " +
          "WHERE telegram_user_id = ?"
      ).run(primary, JSON.stringify(fallbacks), telegramUserId);
    }
    if (email) {
      db.prepare(
        "UPDATE users SET google_email = ?, updated_at = datetime('now') WHERE telegram_user_id = ?"
      ).run(email, telegramUserId);
    }
    if (notebooklmState) {
      db.prepare(
        "UPDATE users SET notebooklm_state = ?, notebooklm_saved_at = datetime('now'), " +
          "updated_at = datetime('now') WHERE telegram_user_id = ?"
      ).run(JSON.stringify(notebooklmState), telegramUserId);
    }
  });
  return { keys: clean.length, session: Boolean(notebooklmState), email: Boolean(email) };
}

export const saveUserKeys = (id, keys) => saveUserConfig(id, { keys });

export function getUserProfile(telegramUserId) {
  return withDb(
    (db) =>
      db
        .prepare("SELECT google_email, (notebooklm_state IS NOT NULL) AS has_session, notebooklm_saved_at FROM users WHERE telegram_user_id = ?")
        .get(telegramUserId) || null
  );
}

export const saveUserKey = (telegramUserId, apiKey) => saveUserKeys(telegramUserId, [apiKey]);

/** All keys for this user, primary first. [] if none. */
export function getUserKeys(telegramUserId) {
  return withDb((db) => {
    const row = db
      .prepare("SELECT gemini_api_key, gemini_fallback_keys FROM users WHERE telegram_user_id = ?")
      .get(telegramUserId);
    if (!row) return [];
    let fb = [];
    try { fb = JSON.parse(row.gemini_fallback_keys); } catch {}
    return [row.gemini_api_key, ...fb].filter(Boolean);
  });
}

export function deleteUserKey(telegramUserId) {
  return withDb(
    (db) => db.prepare("DELETE FROM users WHERE telegram_user_id = ?").run(telegramUserId).changes > 0
  );
}

/**
 * Write this user's saved NotebookLM session to a file notebooklm-py can load
 * (e.g. NotebookLMClient.from_storage(path)). Returns the path, or null if none saved.
 */
export function exportStorageStateFile(telegramUserId, dir = path.join(ROOT, "data", "sessions")) {
  const row = withDb((db) =>
    db.prepare("SELECT notebooklm_state FROM users WHERE telegram_user_id = ?").get(telegramUserId)
  );
  if (!row?.notebooklm_state) return null;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${telegramUserId}.json`);
  fs.writeFileSync(file, row.notebooklm_state, { mode: 0o600 });
  return file;
}
