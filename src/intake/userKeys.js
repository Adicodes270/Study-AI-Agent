// src/intake/userKeys.js
// Gemini API keys, stored per Telegram user id. keys[0] = primary, rest = fallbacks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
export async function saveUserConfig(telegramUserId, { keys = [], notebooklmState = null, email = null } = {}) {
  const clean = [...new Set(keys.map((k) => String(k).trim()).filter(isValidKey))];
  const [primary = "", ...fallbacks] = clean;
  await withDb(async (db) => {
    await db.run(
      "INSERT INTO users (telegram_user_id, gemini_api_key, gemini_fallback_keys) VALUES ($1, $2, $3) " +
        "ON CONFLICT (telegram_user_id) DO NOTHING",
      [telegramUserId, primary, JSON.stringify(fallbacks)]
    );
    if (clean.length) {
      await db.run(
        "UPDATE users SET gemini_api_key = $1, gemini_fallback_keys = $2, updated_at = now() " +
          "WHERE telegram_user_id = $3",
        [primary, JSON.stringify(fallbacks), telegramUserId]
      );
    }
    if (email) {
      await db.run("UPDATE users SET google_email = $1, updated_at = now() WHERE telegram_user_id = $2", [
        email,
        telegramUserId,
      ]);
    }
    if (notebooklmState) {
      await db.run(
        "UPDATE users SET notebooklm_state = $1, notebooklm_saved_at = now(), " +
          "updated_at = now() WHERE telegram_user_id = $2",
        [JSON.stringify(notebooklmState), telegramUserId]
      );
    }
  });
  return { keys: clean.length, session: Boolean(notebooklmState), email: Boolean(email) };
}

export const saveUserKeys = (id, keys) => saveUserConfig(id, { keys });

export async function getUserProfile(telegramUserId) {
  return withDb((db) =>
    db.get(
      "SELECT google_email, (notebooklm_state IS NOT NULL) AS has_session, notebooklm_saved_at FROM users WHERE telegram_user_id = $1",
      [telegramUserId]
    )
  );
}

export const saveUserKey = (telegramUserId, apiKey) => saveUserKeys(telegramUserId, [apiKey]);

/** All keys for this user, primary first. [] if none. */
export async function getUserKeys(telegramUserId) {
  return withDb(async (db) => {
    const row = await db.get(
      "SELECT gemini_api_key, gemini_fallback_keys FROM users WHERE telegram_user_id = $1",
      [telegramUserId]
    );
    if (!row) return [];
    let fb = [];
    try { fb = JSON.parse(row.gemini_fallback_keys); } catch {}
    return [row.gemini_api_key, ...fb].filter(Boolean);
  });
}

export async function deleteUserKey(telegramUserId) {
  return withDb(async (db) => (await db.run("DELETE FROM users WHERE telegram_user_id = $1", [telegramUserId])) > 0);
}

/**
 * Write this user's saved NotebookLM session to a file notebooklm-py can load
 * (e.g. NotebookLMClient.from_storage(path)). Returns the path, or null if none saved.
 * Uses the OS temp folder (the only writable place on Vercel).
 */
export async function exportStorageStateFile(telegramUserId, dir = path.join(os.tmpdir(), "study-agent-sessions")) {
  const row = await withDb((db) =>
    db.get("SELECT notebooklm_state FROM users WHERE telegram_user_id = $1", [telegramUserId])
  );
  if (!row?.notebooklm_state) return null;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${telegramUserId}.json`);
  fs.writeFileSync(file, row.notebooklm_state, { mode: 0o600 });
  return file;
}
