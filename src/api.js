// src/api.js
// All API logic lives here and returns { status, body }.
// Used by the Vercel functions in /api and by the local server (src/webServer.js).
import { Api } from "grammy";
import { GoogleGenAI, Type } from "@google/genai";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { DEFAULT_CLASS_LEVEL, GEMINI_API_KEY, GEMINI_MODEL, TELEGRAM_BOT_TOKEN } from "./config.js";
import {
  createQuizSession,
  getChapterForUser,
  getChapterResource,
  getChaptersWithResources,
  getChaptersWithResults,
  getLastQuizResult,
  hasChapterResource,
  hasQuizResult,
  initDb,
  saveChapterResource,
  takeQuizSession,
  upsertQuizResult,
  withDb,
} from "./db.js";
import { generateQuiz, grade, questionCountFor } from "./quizEngine.js";
import {
  deleteUserKey,
  exportStorageStateFile,
  getUserKeys,
  getUserProfile,
  saveUserConfig,
} from "./intake/userKeys.js";
import { saveSyllabus } from "./intake/storage.js";
import { parseSyllabus, parseSyllabusPdf } from "./intake/syllabusParser.js";

const parseId = (v) => (/^\d+$/.test(String(v ?? "")) ? Number(v) : NaN);
const ok = (body) => ({ status: 200, body });
const fail = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

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
  const rawEmail = loginEmail || (typeof body.google_email === "string" ? body.google_email.trim().toLowerCase() : "");
  if (rawEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) return fail(400, "That email address doesn't look valid");

  const saved = await saveUserConfig(id, { keys, notebooklmState, email: rawEmail || null });
  if (!saved.keys && !saved.session && !saved.email) {
    return fail(400, `Nothing valid to save: received ${keys.length} Gemini key(s), none accepted (20+ characters, no spaces), and no NotebookLM session`);
  }
  return ok({ ok: true, telegram_user_id: id, keys_saved: saved.keys, session_saved: saved.session, email_saved: saved.email, google_email: rawEmail || null });
});

// GET /api/user-keys/:id
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
      `SELECT subject, exam, number, title, match_status, pdf_url, recommended_questions
       FROM syllabus_chapters
       WHERE chat_id = $1
       ORDER BY subject, number`,
      [chatId]
    )).rows
  );
  return ok({ chatId, chapters });
});

// ---- Telegram helpers for the setup page ----
const tg = () => {
  if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set on the server");
  return new Api(TELEGRAM_BOT_TOKEN);
};

let botInfo;
export const telegramBotInfo = safe(async () => {
  if (!botInfo) {
    const me = await tg().getMe();
    botInfo = { username: me.username, first_name: me.first_name };
  }
  return ok({ ok: true, result: botInfo });
});

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
// Quizzes (Typed / Spoken Answer Format + AI Textbook Verification + Requiz + Review)
// ---------------------------------------------------------------------------
const quizUserId = (given, ctx) => parseId(given ?? ctx?.cookies?.sa_telegram_id);
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
      id: c.id,
      subject: c.subject,
      exam: c.exam,
      number: c.number,
      title: c.title,
      matched: isMatched(c),
      recommended_questions: questionCountFor(c),
      result: c.result,
    })),
  });
});

// POST /api/quizzes/generate { telegramUserId, chapterId, questionCount?, geminiKey? }
// Supports both initial quiz AND Requiz (retaking any chapter with a fresh set of questions).
export const quizGenerate = safe(async (body = {}, ctx = {}) => {
  const id = quizUserId(body.telegramUserId, ctx);
  const chapterId = parseId(body.chapterId);
  if (Number.isNaN(id) || Number.isNaN(chapterId)) return fail(400, "Missing Telegram user id or chapter id");

  const chapter = await getChapterForUser(id, chapterId);
  if (!chapter) return fail(404, "Chapter not found in your syllabus");

  // Fetch previous attempt (if any) so Requiz generates a different set of questions
  const lastResult = await getLastQuizResult(id, chapter.subject, chapter.exam, chapter.title);
  const previousQuestions = Array.isArray(lastResult?.review)
    ? lastResult.review.map((r) => r.question).filter(Boolean)
    : [];
  const attemptNumber = (lastResult?.attempts || 0) + 1;

  const saved = await getUserKeys(id);
  const extra = [body.geminiKey, ctx?.cookies?.sa_gemini_key].filter((k) => typeof k === "string" && k.length >= 20);
  let quiz;
  try {
    quiz = await generateQuiz(chapter, [...saved, ...extra], {
      questionCount: body.questionCount,
      previousQuestions,
      attemptNumber,
    });
  } catch (e) {
    return fail(e.status || 502, e.message);
  }
  const quizId = crypto.randomUUID();
  await createQuizSession(quizId, id, chapter, quiz.questions);
  return ok({
    quizId,
    attempt: attemptNumber,
    chapter: {
      id: chapter.id,
      subject: chapter.subject,
      exam: chapter.exam,
      number: chapter.number,
      title: chapter.title,
      recommended_questions: questionCountFor(chapter),
    },
    // Expected answers are withheld; only the open-ended questions are sent to the browser
    questions: quiz.questions.map(({ subtopic, question }) => ({ subtopic, question })),
  });
});

// POST /api/quizzes/submit { telegramUserId, quizId, answers: ["typed/spoken answer 1", ...] }
export const quizSubmit = safe(async (body = {}, ctx = {}) => {
  const id = quizUserId(body.telegramUserId, ctx);
  if (Number.isNaN(id)) return fail(400, "Missing or invalid Telegram user id");
  if (!Array.isArray(body.answers)) return fail(400, "answers must be an array");

  const savedKeys = await getUserKeys(id);
  const extraKeys = [body.geminiKey, ctx?.cookies?.sa_gemini_key].filter((k) => typeof k === "string" && k.length >= 20);
  const apiKeys = [...new Set([...savedKeys, ...extraKeys])];

  const out = await withDb(async (db) => {
    const session = await takeQuizSession(db, String(body.quizId || ""), id);
    if (!session) return null;
    const ch = session.chapter;
    const g = await grade(session.questions, body.answers, apiKeys, ch);
    const saved = await upsertQuizResult(
      {
        telegramUserId: id,
        chapterId: ch.id,
        subject: ch.subject,
        exam: ch.exam,
        title: ch.title,
        score: g.score,
        total: g.total,
        percentage: g.percentage,
        tier: g.tier,
        message: g.message,
        weakSubtopics: g.weakSubtopics,
        review: g.review,
      },
      db
    );
    return { g, ch, saved };
  });
  if (!out) return fail(410, "This quiz expired or was already submitted. Start it again from your chapters.");
  const { g, ch, saved } = out;
  return ok({
    score: g.score,
    total: g.total,
    percentage: g.percentage,
    revision_tier: g.tier,
    revision_message: g.message,
    weak_subtopics: g.weakSubtopics,
    attempts: saved.attempts,
    review: g.review,
    chapter: { id: ch.id, subject: ch.subject, exam: ch.exam, number: ch.number, title: ch.title },
  });
});

// POST /api/quizzes/transcribe { telegramUserId, audioBase64, mimeType?, geminiKey? }
// High-accuracy Gemini audio-to-text transcription fallback for the Speak Answer button
export const quizTranscribe = safe(async (body = {}, ctx = {}) => {
  const id = quizUserId(body.telegramUserId, ctx);
  const audioBase64 = String(body.audioBase64 || "").trim();
  const mimeType = String(body.mimeType || "audio/webm").split(";")[0].trim() || "audio/webm";
  if (!audioBase64) return fail(400, "No audio data received");

  const saved = Number.isNaN(id) ? [] : await getUserKeys(id);
  const extra = [body.geminiKey, ctx?.cookies?.sa_gemini_key].filter((k) => typeof k === "string" && k.length >= 20);
  const keys = [...new Set([...saved, ...extra, GEMINI_API_KEY].filter(Boolean))];
  if (!keys.length) return fail(400, "No Gemini API key found.");

  let lastErr;
  for (const key of keys) {
    try {
      const res = await getGenClient(key).models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          { inlineData: { data: audioBase64, mimeType } },
          {
            text:
              "Transcribe the student's spoken quiz answer into clean, accurate plain text. Output ONLY the exact transcribed words spoken by the student, with no commentary or quotes. If no speech is audible, output an empty string.",
          },
        ],
        config: { temperature: 0.1 },
      });
      const text = String(res.text || "").trim();
      return ok({ ok: true, transcript: text });
    } catch (e) {
      lastErr = e;
    }
  }
  return fail(502, `Could not transcribe audio: ${lastErr?.message || "unknown error"}`);
});

// Self-contained single-chapter NCERT PDF extractor (used if parseSyllabusPdf returns empty subjects)
const SINGLE_DOC_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    class_level: { type: Type.INTEGER, nullable: true },
    subject: { type: Type.STRING },
    chapter_number: { type: Type.INTEGER },
    chapter_title: { type: Type.STRING },
    is_ncert: { type: Type.BOOLEAN },
    ncert_book_code: { type: Type.STRING, nullable: true },
    ncert_chapter_number: { type: Type.INTEGER, nullable: true },
    recommended_questions: { type: Type.INTEGER, nullable: true },
  },
  required: ["subject", "chapter_number", "chapter_title", "is_ncert", "recommended_questions"],
};

async function extractSingleChapterFallback(body, apiKeys) {
  const allKeys = [...new Set([].concat(apiKeys || [], GEMINI_API_KEY).filter(Boolean))];
  const fileName = String(body.fileName || "");
  const codeMatch = /(?:^|[^a-z0-9])([a-z]{4}\d)(\d{2})(?:[^0-9]|$)/i.exec(fileName);
  const codeHint = codeMatch ? codeMatch[1].toLowerCase() : null;
  const numHint = codeMatch ? parseInt(codeMatch[2], 10) : null;

  const prompt = `This document is a single textbook chapter, NCERT PDF, or study notes${fileName ? ` (filename: "${fileName}")` : ""}.
Identify:
1. "class_level": integer class (e.g. 9 or 10)
2. "subject": standard subject name (e.g. Science, Mathematics, History, Geography, Civics, Economics, English, Hindi)
3. "chapter_number": integer chapter number (1-based)
4. "chapter_title": exact chapter title from the heading
5. "is_ncert": true if this is an NCERT chapter
6. "ncert_book_code": 5-character lowercase NCERT book code if known (e.g. "iesc1", "iemh1", "iess1", "iess2", "iess3", "iess4", "jesc1", "jemh1", "jess1", "jess2", "jess3", "jess4")
7. "ncert_chapter_number": 1-based NCERT chapter number
8. "recommended_questions": analyze the chapter's length, subtopics, and complexity and recommend a default number of quiz questions between 10 and 50 (minimum 10, maximum 50).`;

  const contents =
    body.kind === "pdf" && body.dataBase64
      ? [{ inlineData: { data: String(body.dataBase64), mimeType: "application/pdf" } }, { text: prompt }]
      : `${prompt}\n\nTEXT:\n${String(body.text || "").slice(0, 30000)}`;

  for (const key of allKeys) {
    try {
      const res = await getGenClient(key).models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: {
          responseMimeType: "application/json",
          responseSchema: SINGLE_DOC_SCHEMA,
          temperature: 0.1,
        },
      });
      const d = JSON.parse(res.text);
      if (d && d.subject && d.chapter_title) {
        const bookCode = (d.ncert_book_code || codeHint || "").toLowerCase().trim() || null;
        const chNum = d.ncert_chapter_number || d.chapter_number || numHint || 1;
        const pdfUrl =
          bookCode && chNum
            ? `https://ncert.nic.in/textbook/pdf/${bookCode}${String(chNum).padStart(2, "0")}.pdf`
            : null;
        const recQ = Math.max(10, Math.min(50, Number(d.recommended_questions) || 15));
        return {
          class_level: d.class_level || DEFAULT_CLASS_LEVEL,
          exam: null,
          subjects: [
            {
              name: d.subject,
              chapters: [
                {
                  number: d.chapter_number || chNum,
                  title: d.chapter_title,
                  is_ncert: Boolean(d.is_ncert || bookCode),
                  ncert_book_code: bookCode,
                  ncert_chapter_number: chNum,
                  pdf_url: pdfUrl,
                  recommended_questions: recQ,
                },
              ],
            },
          ],
        };
      }
    } catch (e) {
      console.log(`Single chapter fallback error: ${e.message}`);
    }
  }
  return null;
}

// POST /api/syllabus/upload { telegramUserId, kind: "pdf" | "text", fileName?, dataBase64?, text?, questionCount?, geminiKey? }
// Used both on initial onboarding AND when the student clicks "New Quiz" to upload an NCERT PDF or syllabus.
export const MAX_SYLLABUS_PDF_BYTES = 20 * 1024 * 1024;
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
    if (String.fromCharCode(...bytes.slice(0, 4)) !== "%PDF") return fail(400, "That file doesn't look like a PDF");
    parseFn = parseSyllabusPdf; payload = bytes;
  } else if (body.kind === "text") {
    const text = String(body.text || "").trim();
    if (text.length < 10) return fail(400, "Paste your syllabus text first");
    if (text.length > 100_000) return fail(413, "That text is too long. Paste just the portion you need.");
    parseFn = parseSyllabus; payload = text;
  } else {
    return fail(400, 'kind must be "pdf" or "text"');
  }

  let syllabus = null;
  try {
    syllabus = await parseFn(payload, keys, body.fileName || "");
  } catch (e) {
    console.log(`Initial syllabus parse failed (${e.message}), trying single-chapter extractor`);
  }

  if (!syllabus?.subjects?.length) {
    syllabus = await extractSingleChapterFallback(body, keys);
  }

  if (!syllabus?.subjects?.length) {
    const fallbackTitle =
      body.kind === "pdf"
        ? String(body.fileName || "Uploaded Study PDF").replace(/\.pdf$/i, "").trim()
        : String(body.text || "Custom Study Topic").split("\n")[0].slice(0, 60).trim();
    syllabus = {
      class_level: DEFAULT_CLASS_LEVEL,
      exam: "Custom Source",
      subjects: [
        {
          name: "Custom Study",
          chapters: [
            {
              number: 1,
              title: fallbackTitle || "Uploaded Study Material",
              is_ncert: false,
              ncert_book_code: null,
              ncert_chapter_number: null,
              pdf_url: null,
              recommended_questions: 12,
            },
          ],
        },
      ],
    };
  }

  // Compute the AI-analyzed default question count (minimum 10, max 50) for the uploaded chapter(s)
  const firstSub = syllabus.subjects[0];
  const firstCh = firstSub?.chapters?.[0];
  const aiRecommended = firstCh
    ? Math.max(
        10,
        Math.min(
          50,
          Number(firstCh.recommended_questions) ||
            questionCountFor({ subject: firstSub.name, title: firstCh.title })
        )
      )
    : 12;

  const results = await saveSyllabus(id, syllabus, { questionCount: body.questionCount });

  // Find the newly saved chapter in the DB so the New Quiz UI can offer an instant "Start Quiz" action
  const allChapters = await getChaptersWithResults(id);
  const matchingCh =
    (firstCh &&
      allChapters.find(
        (c) =>
          c.subject.toLowerCase() === firstSub.name.toLowerCase() &&
          c.title.toLowerCase() === firstCh.title.toLowerCase()
      )) ||
    allChapters[allChapters.length - 1] ||
    null;

  return ok({
    ok: true,
    subjects: results,
    ai_recommended_questions: aiRecommended,
    latest_chapter: matchingCh
      ? {
          id: matchingCh.id,
          subject: matchingCh.subject,
          exam: matchingCh.exam,
          number: matchingCh.number,
          title: matchingCh.title,
          recommended_questions: questionCountFor(matchingCh),
        }
      : null,
  });
});

// Keep quizGenerateCustom alias pointing to syllabusUpload for backwards compatibility
export const quizGenerateCustom = syllabusUpload;


// ---------------------------------------------------------------------------
// NotebookLM Resource Generation Flow (public/resources.html)
// ---------------------------------------------------------------------------
export const NOTEBOOKLM_RESOURCE_TYPES = [
  {
    id: "audio_overview",
    label: "Audio Overview",
    icon: "fa-solid fa-headphones",
    description: "Two-host AI deep-dive conversation unpacking the chapter's big ideas.",
  },
  {
    id: "study_guide",
    label: "Study Guide",
    icon: "fa-solid fa-book-open-reader",
    description: "Structured concept breakdown, glossary of key terms, and short-answer review.",
  },
  {
    id: "briefing_doc",
    label: "Briefing Doc",
    icon: "fa-solid fa-file-lines",
    description: "Executive summary of core principles, formulas, and high-yield exam takeaways.",
  },
  {
    id: "faq",
    label: "FAQ",
    icon: "fa-solid fa-circle-question",
    description: "Frequently asked exam questions with clear, step-by-step model explanations.",
  },
  {
    id: "timeline",
    label: "Timeline",
    icon: "fa-solid fa-timeline",
    description: "Sequential flow of events, scientific processes, or step-by-step derivations.",
  },
  {
    id: "flashcards",
    label: "Flashcards",
    icon: "fa-solid fa-layer-group",
    description: "Active-recall Q&A cards covering definitions, equations, and key distinctions.",
  },
  {
    id: "mind_map",
    label: "Mind Map",
    icon: "fa-solid fa-diagram-project",
    description: "Hierarchical topic tree mapping how every subtopic in the chapter connects.",
  },
  {
    id: "slide_deck",
    label: "Slide Deck",
    icon: "fa-solid fa-chalkboard",
    description: "Slide-by-slide visual revision outline for rapid pre-exam review.",
  },
];

export const EXCLUDED_RESOURCE_TYPES = new Set([
  "infographics",
  "infographic",
  "report",
  "reports",
]);

const VALID_RESOURCE_IDS = new Set(NOTEBOOKLM_RESOURCE_TYPES.map((t) => t.id));
const RESOURCE_META_BY_ID = new Map(NOTEBOOKLM_RESOURCE_TYPES.map((t) => [t.id, t]));

const USER_QUOTA_WINDOW_MS = 15 * 60 * 1000;
const USER_MAX_GENERATIONS_PER_WINDOW = parseInt(process.env.NOTEBOOKLM_QUOTA_PER_WINDOW ?? "", 10) || 24;
const userQuotaHits = new Map();

function formatWaitDuration(ms) {
  const totalSec = Math.max(1, Math.ceil(ms / 1000));
  if (totalSec < 60) return `${totalSec} second${totalSec === 1 ? "" : "s"}`;
  const mins = Math.ceil(totalSec / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs} hour${hrs === 1 ? "" : "s"}`;
}

function checkUserNotebookLMQuota(userId) {
  const now = Date.now();
  let rec = userQuotaHits.get(userId);
  if (!rec) {
    rec = { timestamps: [], cooldownUntil: 0 };
    userQuotaHits.set(userId, rec);
  }
  if (rec.cooldownUntil > now) {
    return { allowed: false, retryAfter: formatWaitDuration(rec.cooldownUntil - now) };
  }
  rec.timestamps = rec.timestamps.filter((t) => now - t < USER_QUOTA_WINDOW_MS);
  if (rec.timestamps.length >= USER_MAX_GENERATIONS_PER_WINDOW) {
    const oldest = rec.timestamps[0];
    const waitMs = Math.max(60_000, USER_QUOTA_WINDOW_MS - (now - oldest));
    rec.cooldownUntil = now + waitMs;
    return { allowed: false, retryAfter: formatWaitDuration(waitMs) };
  }
  return { allowed: true, recordHit: () => rec.timestamps.push(Date.now()) };
}

function extractQuotaRetryTime(err) {
  if (!err) return null;
  if (err.retryAfter) return String(err.retryAfter);
  const msg = String(err.message || err || "");
  const isQuota =
    err.status === 429 ||
    err.code === 429 ||
    /quota|rate.?limit|resource_exhausted|too many requests|429|limit reached/i.test(msg);
  if (!isQuota) return null;

  const retryMatch =
    msg.match(/try again (?:in|after)\s+([0-9]+\s*(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)(?:\s*[0-9]+\s*(?:minutes?|mins?|m|seconds?|secs?|s))?)/i) ||
    msg.match(/retry(?:Delay| in| after)?["':\s]+([0-9]+(?:\.[0-9]+)?\s*(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h))/i);
  if (retryMatch) {
    const raw = retryMatch[1].trim();
    const secMatch = /^([0-9]+(?:\.[0-9]+)?)\s*s$/i.exec(raw);
    if (secMatch) return formatWaitDuration(Math.ceil(parseFloat(secMatch[1]) * 1000));
    return raw;
  }
  return "15 minutes";
}

const NOTEBOOKLM_PY_SCRIPT = `
import asyncio, json, sys

async def run():
    payload = json.loads(sys.argv[1])
    storage_path = payload["storage_path"]
    ch = payload["chapter"]
    r_type = payload["resource_type"]
    nb_title = f"Study Agent — {ch.get('subject', 'Study')}: {ch.get('title', 'Chapter')}"

    try:
        from notebooklm import NotebookLMClient, ReportFormat
    except ImportError as e:
        print(json.dumps({"ok": False, "reason": "not_installed", "error": str(e)}))
        return

    try:
        async with NotebookLMClient.from_storage(storage_path) as client:
            notebooks = await client.notebooks.list()
            nb = next((n for n in notebooks if getattr(n, "title", "") == nb_title), None)
            if nb is None:
                nb = await client.notebooks.create(nb_title)

            sources = await client.sources.list(nb.id)
            src_ids = [s.id for s in sources if getattr(s, "id", None)]
            if not src_ids:
                pdf_url = ch.get("pdf_url")
                if pdf_url:
                    src = await client.sources.add_url(nb.id, pdf_url, wait=True, wait_timeout=90.0)
                else:
                    text_body = f"Subject: {ch.get('subject')}\\nChapter: {ch.get('title')}\\nNotes: {ch.get('note') or 'CBSE curriculum chapter'}"
                    src = await client.sources.add_text(nb.id, ch.get("title", "Chapter Notes"), text_body, wait=True, wait_timeout=60.0)
                if getattr(src, "id", None):
                    src_ids = [src.id]

            task_id = None
            if r_type == "audio_overview":
                st = await client.artifacts.generate_audio(nb.id, source_ids=src_ids or None)
                task_id = getattr(st, "task_id", None)
            elif r_type == "study_guide":
                if hasattr(client.artifacts, "generate_study_guide"):
                    st = await client.artifacts.generate_study_guide(nb.id, source_ids=src_ids or None)
                else:
                    st = await client.artifacts.generate_report(nb.id, report_format=ReportFormat.STUDY_GUIDE, source_ids=src_ids or None)
                task_id = getattr(st, "task_id", None)
            elif r_type == "briefing_doc":
                st = await client.artifacts.generate_report(nb.id, report_format=ReportFormat.BRIEFING_DOC, source_ids=src_ids or None)
                task_id = getattr(st, "task_id", None)
            elif r_type == "faq":
                st = await client.artifacts.generate_report(
                    nb.id,
                    report_format=ReportFormat.CUSTOM,
                    custom_prompt=f"Create a comprehensive exam FAQ with questions and model answers for {ch.get('title')}.",
                    source_ids=src_ids or None,
                )
                task_id = getattr(st, "task_id", None)
            elif r_type == "timeline":
                st = await client.artifacts.generate_report(
                    nb.id,
                    report_format=ReportFormat.CUSTOM,
                    custom_prompt=f"Create a detailed chronological timeline and sequential process breakdown for {ch.get('title')}.",
                    source_ids=src_ids or None,
                )
                task_id = getattr(st, "task_id", None)
            elif r_type == "flashcards":
                st = await client.artifacts.generate_flashcards(nb.id, source_ids=src_ids or None)
                task_id = getattr(st, "task_id", None)
            elif r_type == "mind_map":
                if hasattr(client, "mind_maps"):
                    mm = await client.mind_maps.generate(nb.id)
                    task_id = getattr(mm, "note_id", None) or getattr(mm, "id", None)
                else:
                    mm = await client.artifacts.generate_mind_map(nb.id, source_ids=src_ids or None)
                    task_id = getattr(mm, "note_id", None)
            elif r_type == "slide_deck":
                st = await client.artifacts.generate_slide_deck(nb.id, source_ids=src_ids or None)
                task_id = getattr(st, "task_id", None)

            print(json.dumps({
                "ok": True,
                "notebook_id": nb.id,
                "notebook_url": f"https://notebooklm.google.com/notebook/{nb.id}",
                "task_id": task_id,
            }))
    except Exception as exc:
        err_name = type(exc).__name__
        msg = str(exc)
        is_rate = "RateLimit" in err_name or "429" in msg or "quota" in msg.lower() or "rate limit" in msg.lower()
        print(json.dumps({
            "ok": False,
            "reason": "rate_limit" if is_rate else "rpc_error",
            "error": msg,
            "retry_after": getattr(exc, "retry_after", None) or "15 minutes",
        }))

asyncio.run(run())
`;

function invokeNotebookLmPython(sessionFile, chapter, resourceType) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      storage_path: sessionFile,
      chapter,
      resource_type: resourceType,
    });
    const pyBin = process.platform === "win32" ? "python" : "python3";
    const proc = spawn(pyBin, ["-c", NOTEBOOKLM_PY_SCRIPT, payload], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 90_000,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", (err) => resolve({ ok: false, reason: "spawn_error", error: err.message }));
    proc.on("close", () => {
      const lines = stdout.trim().split("\n").filter(Boolean);
      const last = lines[lines.length - 1] || "";
      try {
        resolve(JSON.parse(last));
      } catch {
        resolve({ ok: false, reason: "parse_error", error: stderr || stdout || "notebooklm-py returned no JSON" });
      }
    });
  });
}

const genClients = new Map();
const getGenClient = (key) => {
  if (!genClients.has(key)) genClients.set(key, new GoogleGenAI({ apiKey: key }));
  return genClients.get(key);
};

const RESOURCE_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    summary: { type: Type.STRING },
    sections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          heading: { type: Type.STRING },
          body: { type: Type.STRING },
          bullets: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ["heading", "body", "bullets"],
      },
    },
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          prompt: { type: Type.STRING },
          detail: { type: Type.STRING },
        },
        required: ["label", "prompt", "detail"],
      },
    },
    markdown: { type: Type.STRING },
  },
  required: ["title", "summary", "sections", "items", "markdown"],
};

function buildResourcePrompt(chapter, resourceType) {
  const meta = RESOURCE_META_BY_ID.get(resourceType) || { label: resourceType };
  const cls = chapter.class ?? DEFAULT_CLASS_LEVEL;
  const level = cls ? `Class ${cls}` : "CBSE Secondary School";
  const chNum = chapter.number != null ? `Chapter ${chapter.number}: ` : "";

  const specificInstructions = {
    audio_overview: `Create a NotebookLM-style two-host "Audio Overview" deep-dive dialogue between Host A (Alex, curious & structured) and Host B (Sam, insightful & example-driven).
- In "items", provide 8 to 12 conversational turns where label is "Host A (Alex)" or "Host B (Sam)", prompt is the subtopic being discussed, and detail is the spoken dialogue line.
- In "sections", summarize the key takeaways and analogies discussed in the episode.
- In "markdown", provide the full formatted transcript and show notes.`,
    study_guide: `Create a comprehensive NotebookLM Study Guide for exam preparation.
- In "sections", include: (1) Core Concepts & Big Picture, (2) Key Definitions & Formulas, (3) Common Exam Pitfalls, and (4) Short-Answer Review Prompts with Model Answers.
- In "items", provide 6 to 8 key glossary terms where label is the term, prompt is its category/formula, and detail is its clear definition.`,
    briefing_doc: `Create a concise NotebookLM Briefing Document.
- In "sections", include: (1) Executive Overview, (2) Essential Principles & Mechanisms, (3) High-Yield Exam Takeaways, and (4) Quick Revision Checklist.
- In "items", list 5 to 7 critical facts or principles (label = principle name, prompt = why it matters, detail = concise explanation).`,
    faq: `Create a NotebookLM FAQ (Frequently Asked Questions) resource targeting high-probability exam questions.
- In "items", provide 6 to 8 Q&A pairs where label is "Q1", "Q2", etc., prompt is the exact question a student or examiner asks, and detail is the complete, step-by-step model answer.
- In "sections", group the themes covered by these FAQs.`,
    timeline: `Create a NotebookLM Timeline / Sequential Process Breakdown for this chapter.
- In "items", provide 6 to 9 ordered steps, stages, derivations, or chronological milestones where label is the Step/Stage/Year (e.g. "Stage 1", "Step 2"), prompt is the milestone title, and detail is what happens and why.
- In "sections", explain how the sequence connects from start to finish.`,
    flashcards: `Create a deck of NotebookLM Active-Recall Flashcards for this chapter.
- In "items", provide 8 to 10 flashcards where label is the subtopic tag (e.g. "Formula", "Definition", "Concept"), prompt is the Front of the card (question/term), and detail is the Back of the card (concise, accurate answer).
- In "sections", provide quick memory hooks and mnemonics.`,
    mind_map: `Create a structured NotebookLM Mind Map for this chapter.
- In "sections", represent the main branches of the chapter (each section heading is a primary branch node, body explains the branch, and bullets list the child sub-nodes and connections).
- In "items", list 6 to 8 key cross-topic connections (label = Concept A -> Concept B, prompt = Relationship type, detail = How they interact).`,
    slide_deck: `Create a NotebookLM Slide Deck outline for rapid visual revision.
- In "items", provide 7 to 9 slides where label is "Slide 1", "Slide 2", etc., prompt is the Slide Headline, and detail is the key talking points & visual callout for that slide.
- In "sections", group the deck into Introduction, Core Concepts, Worked Examples, and Summary.`,
  };

  return `You are Google NotebookLM generating a "${meta.label}" study artifact grounded in the student's syllabus chapter.

Student Level: ${level}
Subject: ${chapter.subject}${chapter.exam ? ` (${chapter.exam})` : ""}
Chapter: ${chNum}${chapter.title}
${chapter.pdf_url ? `NCERT Textbook Source PDF: ${chapter.pdf_url}` : ""}
${chapter.note ? `Syllabus Scope / Notes: ${chapter.note}` : ""}

Task Instructions:
${specificInstructions[resourceType] || `Create a detailed ${meta.label} covering ${chapter.title}.`}

Ensure all content is 100% accurate for ${level} ${chapter.subject}, clearly structured, and directly useful for exam revision.`;
}

function buildFallbackResourceContent(chapter, resourceType) {
  const meta = RESOURCE_META_BY_ID.get(resourceType) || { label: resourceType };
  const chNum = chapter.number != null ? `Chapter ${chapter.number}: ` : "";
  const fullChapterTitle = `${chNum}${chapter.title}`;
  const scopeNote = chapter.note ? `Syllabus scope: ${chapter.note}.` : `Aligned with ${chapter.subject} curriculum standards.`;

  return {
    title: `${meta.label}: ${fullChapterTitle}`,
    summary: `Source-grounded NotebookLM ${meta.label.toLowerCase()} for ${fullChapterTitle} (${chapter.subject}).`,
    sections: [
      {
        heading: `1. Core Overview — ${chapter.title}`,
        body: `This ${meta.label} synthesizes the essential concepts of ${fullChapterTitle} in ${chapter.subject}. ${scopeNote}`,
        bullets: [
          `Primary concepts and foundational framework of ${chapter.title}`,
          "Key relationships, rules, and structured explanations",
          "High-yield points frequently tested in school and board assessments",
        ],
      },
    ],
    items: [
      {
        label: "Checkpoint 1",
        prompt: `Foundational Principles of ${chapter.title}`,
        detail: `Master the primary definitions, core laws/rules, and conceptual scope of ${fullChapterTitle}.`,
      },
    ],
    markdown: `# ${meta.label}: ${fullChapterTitle}\n\n**Subject:** ${chapter.subject}${chapter.exam ? ` (${chapter.exam})` : ""}\n${chapter.pdf_url ? `**NCERT PDF:** ${chapter.pdf_url}\n` : ""}\n## 1. Core Overview\nThis ${meta.label} synthesizes the essential concepts of ${fullChapterTitle} in ${chapter.subject}. ${scopeNote}`,
  };
}

async function generateSingleNotebookLMResource({ telegramUserId, chapter, resourceType, apiKeys, backendUrl }) {
  if (process.env.FORCE_NOTEBOOKLM_QUOTA_LIMIT) {
    const err = new Error(`Limit Reached! try again after ${process.env.FORCE_NOTEBOOKLM_QUOTA_LIMIT}`);
    err.status = 429;
    err.retryAfter = process.env.FORCE_NOTEBOOKLM_QUOTA_LIMIT;
    throw err;
  }

  let sessionFile = null;
  try {
    sessionFile = await exportStorageStateFile(telegramUserId);
  } catch {}

  let notebookLmUrl = null;
  let notebookId = null;

  if (sessionFile) {
    const pyResult = await invokeNotebookLmPython(sessionFile, chapter, resourceType);
    if (pyResult?.ok && pyResult.notebook_url) {
      notebookLmUrl = pyResult.notebook_url;
      notebookId = pyResult.notebook_id || null;
    } else if (pyResult?.reason === "rate_limit") {
      const retryAfter = pyResult.retry_after || extractQuotaRetryTime(pyResult.error) || "15 minutes";
      const err = new Error(`Limit Reached! try again after ${retryAfter}`);
      err.status = 429;
      err.retryAfter = retryAfter;
      throw err;
    }
  }

  const bridgeBase = (backendUrl || process.env.NOTEBOOKLM_BACKEND_URL || "").trim().replace(/\/+$/, "");
  if (!notebookLmUrl && bridgeBase && /^https?:\/\//i.test(bridgeBase)) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch(`${bridgeBase}/api/notebooklm/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctl.signal,
        body: JSON.stringify({
          telegram_user_id: telegramUserId,
          storage_state_path: sessionFile,
          resource_type: resourceType,
          chapter,
        }),
      }).finally(() => clearTimeout(timer));

      if (res.status === 429) {
        const errBody = await res.json().catch(() => ({}));
        const retryAfter = errBody.retry_after || errBody.retryAfter || "15 minutes";
        const err = new Error(`Limit Reached! try again after ${retryAfter}`);
        err.status = 429;
        err.retryAfter = retryAfter;
        throw err;
      }

      if (res.ok) {
        const data = await res.json();
        if (data?.notebook_url || data?.resource_url) {
          notebookLmUrl = data.notebook_url || data.resource_url;
        }
        if (data && (data.content || data.sections || data.markdown)) {
          return {
            title: data.title || `${RESOURCE_META_BY_ID.get(resourceType)?.label || resourceType}: ${chapter.title}`,
            summary: data.summary || "",
            content: { ...(data.content || data), notebook_url: notebookLmUrl, notebook_id: notebookId },
            resourceUrl: notebookLmUrl || chapter.pdf_url || null,
          };
        }
      }
    } catch (e) {
      if (e.status === 429 || e.retryAfter) throw e;
    }
  }

  const keys = [...new Set([].concat(apiKeys || [], GEMINI_API_KEY).filter(Boolean))];
  if (keys.length) {
    const prompt = buildResourcePrompt(chapter, resourceType);
    let lastQuotaErr = null;
    for (const key of keys) {
      try {
        const res = await getGenClient(key).models.generateContent({
          model: GEMINI_MODEL,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseSchema: RESOURCE_RESPONSE_SCHEMA,
            temperature: 0.5,
          },
        });
        const parsed = JSON.parse(res.text);
        if (parsed && parsed.title && Array.isArray(parsed.sections)) {
          return {
            title: parsed.title,
            summary: parsed.summary || "",
            content: { ...parsed, notebook_url: notebookLmUrl, notebook_id: notebookId },
            resourceUrl: notebookLmUrl || chapter.pdf_url || null,
          };
        }
      } catch (e) {
        const retryTime = extractQuotaRetryTime(e);
        if (retryTime) {
          lastQuotaErr = new Error(`Limit Reached! try again after ${retryTime}`);
          lastQuotaErr.status = 429;
          lastQuotaErr.retryAfter = retryTime;
          continue;
        }
      }
    }
    if (lastQuotaErr) throw lastQuotaErr;
  }

  const built = buildFallbackResourceContent(chapter, resourceType);
  return {
    title: built.title,
    summary: built.summary,
    content: { ...built, notebook_url: notebookLmUrl, notebook_id: notebookId },
    resourceUrl: notebookLmUrl || chapter.pdf_url || null,
  };
}

// GET /api/resources/chapters?telegramUserId=...
export const resourcesChapters = safe(async (query = {}, ctx = {}) => {
  const id = quizUserId(query.telegramUserId, ctx);
  if (Number.isNaN(id)) return fail(400, "Missing or invalid Telegram user id");

  const [rows, keys, profile] = await Promise.all([
    getChaptersWithResources(id),
    getUserKeys(id),
    getUserProfile(id),
  ]);

  const hasNotebookLM =
    Boolean(profile?.has_session) ||
    ctx?.cookies?.sa_notebooklm_auth === "connected";

  return ok({
    telegram_user_id: id,
    has_syllabus: rows.length > 0,
    has_gemini_key: keys.length > 0 || Boolean(ctx?.cookies?.sa_gemini_key) || Boolean(GEMINI_API_KEY),
    has_notebooklm_session: hasNotebookLM,
    google_email: profile?.google_email || null,
    resource_types: NOTEBOOKLM_RESOURCE_TYPES,
    chapters: rows.map((c) => ({
      id: c.id,
      class: c.class,
      subject: c.subject,
      exam: c.exam,
      number: c.number,
      title: c.title,
      note: c.note,
      pdf_url: c.pdf_url,
      matched: isMatched(c),
      generated_resources: c.generated_resources || {},
    })),
  });
});

// GET /api/resources/item?telegramUserId=...&chapterId=...&resourceType=...
export const resourceGet = safe(async (query = {}, ctx = {}) => {
  const id = quizUserId(query.telegramUserId, ctx);
  const chapterId = parseId(query.chapterId);
  const resourceType = String(query.resourceType || "").trim().toLowerCase();
  if (Number.isNaN(id) || Number.isNaN(chapterId) || !resourceType) {
    return fail(400, "Missing telegramUserId, chapterId, or resourceType");
  }
  const item = await getChapterResource(id, chapterId, resourceType);
  if (!item) return fail(404, "Resource not found or not yet generated");
  return ok({ ok: true, resource: item });
});

// POST /api/resources/generate
export const resourcesGenerate = safe(async (body = {}, ctx = {}) => {
  const id = quizUserId(body.telegramUserId, ctx);
  if (Number.isNaN(id)) return fail(400, "Missing or invalid Telegram user id");

  const selections = Array.isArray(body.selections) ? body.selections : [];
  if (!selections.length) return fail(400, "Select at least one chapter resource to generate.");

  const tasks = [];
  for (const sel of selections) {
    const chapterId = parseId(sel?.chapterId);
    if (Number.isNaN(chapterId)) continue;
    const types = Array.isArray(sel?.resourceTypes) ? sel.resourceTypes : [];
    for (const rawType of types) {
      const t = String(rawType || "").trim().toLowerCase();
      if (EXCLUDED_RESOURCE_TYPES.has(t)) {
        return fail(400, `Resource type "${rawType}" is not supported (Infographics and Report are excluded).`);
      }
      if (!VALID_RESOURCE_IDS.has(t)) {
        return fail(400, `Unknown NotebookLM resource type: "${rawType}"`);
      }
      tasks.push({ chapterId, resourceType: t });
    }
  }

  if (!tasks.length) {
    return fail(400, "No valid NotebookLM resource types selected.");
  }

  const savedKeys = await getUserKeys(id);
  const extraKeys = [body.geminiKey, ctx?.cookies?.sa_gemini_key].filter(
    (k) => typeof k === "string" && k.length >= 20
  );
  const apiKeys = [...new Set([...savedKeys, ...extraKeys])];

  const generated = [];
  const skipped = [];

  for (let i = 0; i < tasks.length; i++) {
    const { chapterId, resourceType } = tasks[i];
    const chapter = await getChapterForUser(id, chapterId);
    if (!chapter) continue;

    const alreadyExists = await hasChapterResource(
      id,
      chapter.subject,
      chapter.exam,
      chapter.title,
      resourceType
    );
    if (alreadyExists) {
      const existing = await getChapterResource(id, chapterId, resourceType);
      if (existing) skipped.push(existing);
      continue;
    }

    if (
      typeof body.simulateQuotaAfter === "number" &&
      generated.length >= body.simulateQuotaAfter
    ) {
      const retryTime = String(body.simulateRetryAfter || "15 minutes");
      const msg = `Limit Reached! try again after ${retryTime}`;
      return {
        status: 429,
        body: {
          ok: false,
          quota_exceeded: true,
          retry_after: retryTime,
          error: msg,
          generated,
          skipped,
        },
      };
    }

    const quotaCheck = checkUserNotebookLMQuota(id);
    if (!quotaCheck.allowed) {
      const msg = `Limit Reached! try again after ${quotaCheck.retryAfter}`;
      return {
        status: 429,
        body: {
          ok: false,
          quota_exceeded: true,
          retry_after: quotaCheck.retryAfter,
          error: msg,
          generated,
          skipped,
        },
      };
    }

    try {
      const built = await generateSingleNotebookLMResource({
        telegramUserId: id,
        chapter,
        resourceType,
        apiKeys,
        backendUrl: body.notebooklmBackendUrl,
      });

      quotaCheck.recordHit();

      const savedRow = await saveChapterResource({
        telegramUserId: id,
        chapterId: chapter.id,
        subject: chapter.subject,
        exam: chapter.exam,
        chapterTitle: chapter.title,
        resourceType,
        title: built.title,
        summary: built.summary,
        content: built.content,
        resourceUrl: built.resourceUrl,
      });

      generated.push({
        id: savedRow.id,
        chapter_id: chapter.id,
        subject: chapter.subject,
        exam: chapter.exam,
        chapter_title: chapter.title,
        resource_type: resourceType,
        title: savedRow.title,
        summary: savedRow.summary,
        content: savedRow.content,
        resource_url: savedRow.resource_url || null,
        created_at: savedRow.created_at,
      });
    } catch (err) {
      const retryTime = extractQuotaRetryTime(err);
      if (retryTime) {
        const msg = `Limit Reached! try again after ${retryTime}`;
        return {
          status: 429,
          body: {
            ok: false,
            quota_exceeded: true,
            retry_after: retryTime,
            error: msg,
            generated,
            skipped,
          },
        };
      }
      return fail(502, `Failed to generate ${resourceType} for "${chapter.title}": ${err.message}`, {
        generated,
        skipped,
      });
    }
  }

  return ok({
    ok: true,
    quota_exceeded: false,
    generated,
    skipped,
  });
});