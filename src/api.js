// src/api.js
// All API logic lives here and returns { status, body }.
// Used by the Vercel functions in /api and by the local server (src/webServer.js).
import { Api } from "grammy";
import { TELEGRAM_BOT_TOKEN } from "./config.js";
import { initDb, withDb } from "./db.js";
import { deleteUserKey, getUserKeys, getUserProfile, saveUserConfig } from "./intake/userKeys.js";

const parseId = (v) => (/^\d+$/.test(String(v ?? "")) ? Number(v) : NaN);
const ok = (body) => ({ status: 200, body });
const fail = (status, error) => ({ status, body: { error } });

/** Wraps a handler: makes sure tables exist and turns thrown errors into JSON 500s. */
export function safe(fn) {
  return async (...args) => {
    try {
      await initDb();
      return await fn(...args);
    } catch (e) {
      console.log(`API error: ${e.message}`);
      return fail(500, e.message);
    }
  };
}

// POST /api/user-keys
// hooks: local-only NotebookLM login helpers ({ takeLoginSession, takeLoginEmail })
export const saveKeys = safe(async (body = {}, hooks = {}) => {
  const id = parseId(body.telegram_user_id);
  if (Number.isNaN(id)) return fail(400, "Invalid Telegram user id");
  const keys = Array.isArray(body.gemini_api_keys) ? body.gemini_api_keys : [];

  let notebooklmState = null;
  let loginEmail = null;
  if (body.notebooklm_login_id) {
    if (!hooks.takeLoginSession) {
      return fail(400, "NotebookLM browser login only works when Study Agent runs on your own computer");
    }
    notebooklmState = hooks.takeLoginSession(String(body.notebooklm_login_id));
    if (!notebooklmState) return fail(400, "NotebookLM login not finished yet. Sign in first");
    loginEmail = hooks.takeLoginEmail?.(String(body.notebooklm_login_id)) ?? null;
  }
  // The signed-in Google account wins; a typed email is only a fallback if it could not be read
  const rawEmail = loginEmail || (typeof body.google_email === "string" ? body.google_email.trim().toLowerCase() : "");
  if (rawEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) return fail(400, "That email address doesn't look valid");

  const saved = await saveUserConfig(id, { keys, notebooklmState, email: rawEmail || null });
  if (!saved.keys && !saved.session && !saved.email) {
    return fail(400, `Nothing valid to save: received ${keys.length} Gemini key(s), none accepted (20+ characters, no spaces), and no NotebookLM session`);
  }
  return ok({ ok: true, telegram_user_id: id, keys_saved: saved.keys, session_saved: saved.session, email_saved: saved.email, google_email: rawEmail || null });
});

// GET /api/user-keys/:id  (never returns the keys themselves, only a masked summary)
export const getKeys = safe(async (idRaw) => {
  const id = parseId(idRaw);
  if (Number.isNaN(id)) return fail(400, "Invalid Telegram user id");
  const keys = await getUserKeys(id);
  const profile = await getUserProfile(id);
  return ok({
    telegram_user_id: id,
    google_email: profile?.google_email || null,
    notebooklm_session_saved: Boolean(profile?.has_session),
    count: keys.length,
    masked: keys.map((k) => `AIza…${k.slice(-4)}`),
  });
});

// DELETE /api/user-keys/:id
export const removeKeys = safe(async (idRaw) => {
  const id = parseId(idRaw);
  if (Number.isNaN(id)) return fail(400, "Invalid Telegram user id");
  return ok({ ok: true, deleted: await deleteUserKey(id) });
});

// GET /api/syllabus/:chatId
export const getSyllabus = safe(async (chatIdRaw) => {
  const chatId = parseInt(chatIdRaw, 10);
  if (Number.isNaN(chatId)) return fail(400, "Invalid chat ID");
  const chapters = await withDb((db) =>
    db.all(
      `SELECT subject, exam, number, title, match_status, pdf_url
       FROM syllabus_chapters
       WHERE chat_id = $1
       ORDER BY subject, number`,
      [chatId]
    )
  );
  return ok({ chatId, chapters });
});

// ---- Telegram helpers for the setup page (the bot token stays on the server) ----
const tg = () => {
  if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set on the server");
  return new Api(TELEGRAM_BOT_TOKEN);
};

let botInfo;
// GET /api/telegram/bot -> { ok, result: { username, first_name } }
export const telegramBotInfo = safe(async () => {
  if (!botInfo) {
    const me = await tg().getMe();
    botInfo = { username: me.username, first_name: me.first_name };
  }
  return ok({ ok: true, result: botInfo });
});

// GET /api/telegram/pairing/:code -> the chat that sent this code to the bot (valid for 1 hour)
export const getPairing = safe(async (codeRaw) => {
  const code = String(codeRaw || "").toUpperCase();
  if (!/^SA-\d{4}$/.test(code)) return fail(400, "Invalid pairing code");
  const row = await withDb((db) =>
    db.get(
      "SELECT chat_id, user_id, first_name, username FROM pairings WHERE code = $1 AND created_at > now() - interval '1 hour'",
      [code]
    )
  );
  if (!row) return ok({ found: false });
  return ok({ found: true, chat_id: row.chat_id, user_id: row.user_id, first_name: row.first_name, username: row.username });
});

// POST /api/telegram/welcome { code } -> sends a "linked!" message to the chat that paired with this code
export const sendWelcome = safe(async (body = {}) => {
  const code = String(body.code || "").toUpperCase();
  if (!/^SA-\d{4}$/.test(code)) return fail(400, "Invalid pairing code");
  const row = await withDb((db) =>
    db.get("SELECT chat_id, first_name FROM pairings WHERE code = $1 AND created_at > now() - interval '1 hour'", [code])
  );
  if (!row) return fail(404, "Press Start inside the Study Agent bot first!");
  const name = row.first_name || "there";
  try {
    await tg().sendMessage(
      row.chat_id,
      `🎉 Hey ${name}! Study Agent is linked!\n\nYour Chat ID (${row.chat_id}) is now paired with your browser workspace. Send me any PDF, lecture topic, or quiz request anytime!`
    );
  } catch (e) {
    return fail(502, e.message || "Could not message you on Telegram");
  }
  return ok({ ok: true });
});
