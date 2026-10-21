// src/api.js
// All API logic lives here and returns { status, body }.
// Used by the Vercel functions in /api and by the local server (src/webServer.js).
import { Api } from "grammy";
import { TELEGRAM_BOT_TOKEN } from "./config.js";
import { createQuizSession, getChapterForUser, getChaptersWithResults, hasQuizResult, initDb, takeQuizSession, upsertQuizResult, withDb } from "./db.js";
import { generateQuiz, grade } from "./quizEngine.js";
import crypto from "node:crypto";
import { deleteUserKey, getUserKeys, getUserProfile, saveUserConfig } from "./intake/userKeys.js";
import { saveSyllabus } from "./intake/storage.js";
import { parseSyllabus, parseSyllabusPdf } from "./intake/syllabusParser.js";

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
      console.log(`API error: ${e.message}${e.code ? ` [${e.code}]` : ""}`);
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
  const chapters = await withDb(async (db) =>
    (await db.query(
      `SELECT subject, exam, number, title, match_status, pdf_url
       FROM syllabus_chapters
       WHERE chat_id = $1
       ORDER BY subject, number`,
      [chatId]
    )).rows
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
  const row = await withDb(async (db) =>
    (await db.query(
      "SELECT chat_id, user_id, first_name, username FROM pairings WHERE code = $1 AND created_at > now() - interval '1 hour'",
      [code]
    )).rows[0]
  );
  if (!row) return ok({ found: false });
  return ok({ found: true, chat_id: row.chat_id, user_id: row.user_id, first_name: row.first_name, username: row.username });
});

// POST /api/telegram/welcome { code } -> sends a "linked!" message to the chat that paired with this code
export const sendWelcome = safe(async (body = {}) => {
  const code = String(body.code || "").toUpperCase();
  if (!/^SA-\d{4}$/.test(code)) return fail(400, "Invalid pairing code");
  const row = await withDb(async (db) =>
    (await db.query("SELECT chat_id, first_name FROM pairings WHERE code = $1 AND created_at > now() - interval '1 hour'", [code])).rows[0]
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


// ---------------------------------------------------------------------------
// Quizzes
// The web app identifies the student by Telegram user id (cookie sa_telegram_id, or a query/body field).
// ctx = { cookies } parsed from the request by the server.
// Note: like /api/user-keys, this trusts the id the browser sends; there is no login session yet.
// ---------------------------------------------------------------------------
const quizUserId = (given, ctx) => parseId(given ?? ctx?.cookies?.sa_telegram_id);

// Matched = linked to an NCERT chapter (has a PDF link, or the intake marked it matched)
const isMatched = (c) => c.match_status === "matched" || Boolean(c.pdf_url);

// GET /api/quizzes/chapters?telegramUserId=...
export const quizChapters = safe(async (query = {}, ctx = {}) => {
  const id = quizUserId(query.telegramUserId, ctx);
  if (Number.isNaN(id)) return fail(400, "Missing or invalid Telegram user id");
  const rows = await getChaptersWithResults(id);
  const keys = await getUserKeys(id);
  return ok({
    telegram_user_id: id,
    has_syllabus: rows.length > 0,
    has_gemini_key: keys.length > 0 || Boolean(ctx?.cookies?.sa_gemini_key),
    chapters: rows.map((c) => ({
      id: c.id, subject: c.subject, exam: c.exam, number: c.number, title: c.title,
      matched: isMatched(c), result: c.result,
    })),
  });
});

// POST /api/quizzes/generate { telegramUserId, chapterId, geminiKey? }
export const quizGenerate = safe(async (body = {}, ctx = {}) => {
  const id = quizUserId(body.telegramUserId, ctx);
  const chapterId = parseId(body.chapterId);
  if (Number.isNaN(id) || Number.isNaN(chapterId)) return fail(400, "Missing Telegram user id or chapter id");

  const chapter = await getChapterForUser(id, chapterId);
  if (!chapter) return fail(404, "Chapter not found in your syllabus");
  // Unmatched chapters (e.g. grammar topics, which have no NCERT chapter) are quizzed by topic at the student's class level.

  // One attempt per chapter
  if (await hasQuizResult(id, chapter.subject, chapter.exam, chapter.title)) {
    return fail(409, "You've already taken this chapter's quiz. Each chapter can only be attempted once.");
  }

  // Keys saved in the database win; the cookie / body key is a fallback for users with none saved
  const saved = await getUserKeys(id);
  const extra = [body.geminiKey, ctx?.cookies?.sa_gemini_key].filter((k) => typeof k === "string" && k.length >= 20);
  let quiz;
  try {
    quiz = await generateQuiz(chapter, [...saved, ...extra]);
  } catch (e) {
    return fail(e.status || 502, e.message);
  }
  const quizId = crypto.randomUUID();
  await createQuizSession(quizId, id, chapter, quiz.questions);
  return ok({
    quizId,
    chapter: { id: chapter.id, subject: chapter.subject, exam: chapter.exam, number: chapter.number, title: chapter.title },
    // The answer key is withheld; it is only revealed in the submit response
    questions: quiz.questions.map(({ subtopic, question, options }) => ({ subtopic, question, options })),
  });
});

// POST /api/quizzes/submit { telegramUserId, quizId, answers: [optionIndex | null, ...] }
export const quizSubmit = safe(async (body = {}, ctx = {}) => {
  const id = quizUserId(body.telegramUserId, ctx);
  if (Number.isNaN(id)) return fail(400, "Missing or invalid Telegram user id");
  if (!Array.isArray(body.answers)) return fail(400, "answers must be an array");

  // One transaction: take the quiz out of the table, grade it and save the result. If saving throws,
  // the rollback restores the quiz, so the student can press Finish again.
  const out = await withDb(async (db) => {
    const session = await takeQuizSession(db, String(body.quizId || ""), id);
    if (!session) return null;
    // Two quizzes for one chapter can be open at once (two tabs): only the first to finish counts
    if (await hasQuizResult(id, session.chapter.subject, session.chapter.exam, session.chapter.title, db)) return "taken";
    const g = grade(session.questions, body.answers);
    const ch = session.chapter;
    const saved = await upsertQuizResult({
      telegramUserId: id, chapterId: ch.id, subject: ch.subject, exam: ch.exam, title: ch.title,
      score: g.score, total: g.total, percentage: g.percentage, tier: g.tier, message: g.message,
      weakSubtopics: g.weakSubtopics,
    }, db);
    return { g, ch, saved };
  });
  if (out === "taken") return fail(409, "You've already taken this chapter's quiz. Each chapter can only be attempted once.");
  if (!out) return fail(410, "This quiz expired or was already submitted. Start it again from your chapters.");
  const { g, ch, saved } = out;
  return ok({
    score: g.score, total: g.total, percentage: g.percentage,
    revision_tier: g.tier, revision_message: g.message, weak_subtopics: g.weakSubtopics,
    attempts: saved.attempts, review: g.review,
    chapter: { id: ch.id, subject: ch.subject, exam: ch.exam, title: ch.title },
  });
});

// POST /api/syllabus/upload { telegramUserId, kind: "pdf" | "text", dataBase64?, text?, geminiKey? }
// The "upload from your computer" twin of sending the syllabus to the Telegram bot: same parser, same saveSyllabus(),
// so the chapters land in the same table and the quiz page picks them up exactly like it does after the bot's "Done!".
// In a private chat the bot's chat id equals the Telegram user id, so that is what the syllabus is stored under.
export const MAX_SYLLABUS_PDF_BYTES = 20 * 1024 * 1024; // same cap as the bot
export const syllabusUpload = safe(async (body = {}, ctx = {}) => {
  const id = quizUserId(body.telegramUserId, ctx);
  if (Number.isNaN(id)) return fail(400, "Missing or invalid Telegram user id");

  const saved = await getUserKeys(id);
  const extra = [body.geminiKey, ctx?.cookies?.sa_gemini_key].filter((k) => typeof k === "string" && k.length >= 20);
  const keys = [...new Set([...saved, ...extra])];
  if (!keys.length && !GEMINI_API_KEY) return fail(400, "No Gemini API key found. Save one on the setup page first.");

  let parseFn, payload;
  if (body.kind === "pdf") {
    const b64 = String(body.dataBase64 || "");
    if (!b64) return fail(400, "No file received");
    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    if (!bytes.length) return fail(400, "That file is empty");
    if (bytes.length > MAX_SYLLABUS_PDF_BYTES) return fail(413, "That PDF is over 20 MB, which is too big.");
    // %PDF magic number: don't trust the browser's file name or mime type
    if (String.fromCharCode(...bytes.slice(0, 4)) !== "%PDF") return fail(400, "That file doesn't look like a PDF");
    parseFn = parseSyllabusPdf; payload = bytes;
  } else if (body.kind === "text") {
    const text = String(body.text || "").trim();
    if (text.length < 10) return fail(400, "Paste your syllabus text first");
    if (text.length > 100_000) return fail(413, "That text is too long. Paste just the portion you need.");
    parseFn = parseSyllabus; payload = text;
  } else {
    return fail(400, "kind must be \"pdf\" or \"text\"");
  }

  let syllabus;
  try {
    syllabus = await parseFn(payload, keys);
  } catch (e) {
    return fail(502, `Couldn't read that syllabus: ${e.message}`);
  }
  if (!syllabus?.subjects?.length) return fail(422, "I couldn't find any subjects in that.");

  const results = await saveSyllabus(id, syllabus);
  return ok({ ok: true, subjects: results }); // { "Physics": "added" | "updated" | "unchanged", ... }
});
