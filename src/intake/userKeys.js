// src/intake/userKeys.js
// Gemini API keys, stored per Telegram user id. keys[0] = primary, rest = fallbacks.
import crypto from "node:crypto";
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

// ---- AES-256-GCM for the stored NotebookLM session ------------------------------------------
// Stored format:  enc:v1:<iv hex>:<authTag hex>:<ciphertext hex>   (key: SESSION_ENC_KEY, 32 bytes as hex or base64)
// Rows that don't start with "enc:v1:" are legacy plaintext JSON and are still readable.
const ENC_PREFIX = "enc:v1:";

function loadEncKey() {
  const raw = (process.env.SESSION_ENC_KEY ?? "").trim();
  if (!raw) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("SESSION_ENC_KEY must be 32 bytes (64 hex chars or base64).");
  return key;
}

export function encryptState(plaintext) {
  const key = loadEncKey();
  if (!key) {
    console.log("WARNING: SESSION_ENC_KEY is not set; storing the NotebookLM session unencrypted.");
    return plaintext;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${ENC_PREFIX}${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ct.toString("hex")}`;
}

export function decryptState(stored) {
  if (typeof stored !== "string" || !stored.startsWith(ENC_PREFIX)) return stored; // legacy plaintext
  const key = loadEncKey();
  if (!key) throw new Error("Session is encrypted but SESSION_ENC_KEY is not set.");
  const [ivHex, tagHex, ctHex] = stored.slice(ENC_PREFIX.length).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
}

/**
 * Save everything the setup page collects for one Telegram user.
 * keys: Gemini keys (primary first); notebooklmState: notebooklm-py storage_state object.
 */
export async function saveUserConfig(telegramUserId, { keys = [], notebooklmState = null, email = null } = {}) {
  const clean = [...new Set(keys.map((k) => String(k).trim()).filter(isValidKey))];
  const [primary = "", ...fallbacks] = clean;
  await withDb(async (db) => {
    await db.query(
      "INSERT INTO users (telegram_user_id, gemini_api_key, gemini_fallback_keys) VALUES ($1, $2, $3) " +
        "ON CONFLICT (telegram_user_id) DO NOTHING",
      [telegramUserId, primary, JSON.stringify(fallbacks)]
    );
    if (clean.length) {
      await db.query(
        "UPDATE users SET gemini_api_key = $1, gemini_fallback_keys = $2, updated_at = now() " +
          "WHERE telegram_user_id = $3",
        [primary, JSON.stringify(fallbacks), telegramUserId]
      );
    }
    if (email) {
      await db.query(
        "UPDATE users SET google_email = $1, updated_at = now() WHERE telegram_user_id = $2",
        [email, telegramUserId]
      );
    }
    if (notebooklmState) {
      await db.query(
        "UPDATE users SET notebooklm_state = $1, notebooklm_saved_at = now(), " +
          "updated_at = now() WHERE telegram_user_id = $2",
        [encryptState(JSON.stringify(notebooklmState)), telegramUserId]
      );
      // A fresh sign-in un-expires the NotebookLM worker for this student (agent/main.py checks this row)
      await db.query(
        "INSERT INTO nlm_user_state (telegram_user_id, session_status, expired_notified_at) VALUES ($1, 'ok', NULL) " +
          "ON CONFLICT (telegram_user_id) DO UPDATE SET session_status = 'ok', expired_notified_at = NULL",
        [String(telegramUserId)]
      );
    }
  });
  return { keys: clean.length, session: Boolean(notebooklmState), email: Boolean(email) };
}

export const saveUserKeys = (id, keys) => saveUserConfig(id, { keys });

export async function getUserProfile(telegramUserId) {
  return withDb(async (db) => {
    const { rows } = await db.query(
      "SELECT google_email, (notebooklm_state IS NOT NULL) AS has_session, notebooklm_saved_at " +
        "FROM users WHERE telegram_user_id = $1",
      [telegramUserId]
    );
    return rows[0] || null;
  });
}

export const saveUserKey = (telegramUserId, apiKey) => saveUserKeys(telegramUserId, [apiKey]);

/** All keys for this user, primary first. [] if none. */
export async function getUserKeys(telegramUserId) {
  return withDb(async (db) => {
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
}

export async function deleteUserKey(telegramUserId) {
  return withDb(async (db) => {
    const res = await db.query("DELETE FROM users WHERE telegram_user_id = $1", [telegramUserId]);
    return res.rowCount > 0;
  });
}

/**
 * Write this user's saved NotebookLM session to a file notebooklm-py can load
 * (e.g. NotebookLMClient.from_storage(path)). Returns the path, or null if none saved.
 */
export async function exportStorageStateFile(telegramUserId, dir = path.join(ROOT, "data", "sessions")) {
  const row = await withDb(async (db) => {
    const { rows } = await db.query(
      "SELECT notebooklm_state FROM users WHERE telegram_user_id = $1",
      [telegramUserId]
    );
    return rows[0];
  });
  if (!row?.notebooklm_state) return null;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${telegramUserId}.json`);
  fs.writeFileSync(file, decryptState(row.notebooklm_state), { mode: 0o600 });
  return file;
}