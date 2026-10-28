// src/api.js
// All API logic lives here and returns { status, body }.
// Used by the Vercel functions in /api and by the local server (src/webServer.js).
import { Api } from "grammy";
import { GoogleGenAI, Type } from "@google/genai";
import { TodoistApi } from "@doist/todoist-sdk";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import {
  GEMINI_API_KEY,
  GEMINI_MODEL,
  TELEGRAM_BOT_TOKEN,
  TODOIST_API_KEY,
} from "./config.js";
import {
  createQuizSession,
  getChapterForUser,
  getChapterResource,
  getChaptersWithResources,
  getChaptersWithResults,
  getLastQuizResult,
  getQuizSession,
  getStudyPlanForUser,
  hasChapterResource,
  hasDatabaseUrl,
  hasQuizResult,
  initDb,
  ncertSubjectName,
  readLocalStore,
  relinkUserChapters,
  saveChapterResource,
  saveQuizProgress,
  saveStudyPlanForUser,
  storedSubject,
  takeQuizSession,
  upsertQuizResult,
  withDb,
  writeLocalStore,
} from "./db.js";
import { generateQuiz, grade, questionCountFor, revisionFor } from "./quizEngine.js";
import {
  cleanTodoistKey,
  deleteUserKey,
  exportStorageStateFile,
  getTodoistKey,
  getUserClass,
  getUserKeys,
  getUserProfile,
  normalizeClassLevel,
  inspectStorageState,
  isValidTodoistKey,
  saveTodoistKey,
  saveUserConfig,
} from "./intake/userKeys.js";
import { saveSyllabus } from "./intake/storage.js";
import { identifyChaptersFromPdf, syllabusFromNcertRows } from "./intake/chapterIdentifier.js";
import { cancelAutoStart, enqueueExisting, getAutoStart, getGenerationStatus, scheduleAutoStart } from "./generationQueue.js";
import {
  classifyGranularSubject,
  parseSyllabus,
  splitSyllabusIntoGranularSubjects,
} from "./intake/syllabusParser.js";
import {
  DEFAULT_PLANNER_CONFIG,
  SESSION_STYLE_PRESETS,
  generateAiStudyPlan,
  normalizePlannerConfig,
  setTodoistTaskCompleted,
  syncPlanToTodoist,
  trimEmptyDaysPastHorizon,
  verifyTodoistToken,
} from "./plannerEngine.js";

const parseId = (v) => (/^\d+$/.test(String(v ?? "")) ? Number(v) : NaN);
const FALLBACK_GUEST_ID = 100000001;
const resolveUserId = (given, ctx) => {
  const parsed = parseId(given ?? ctx?.cookies?.sa_telegram_id);
  return Number.isNaN(parsed) ? FALLBACK_GUEST_ID : parsed;
};
const ok = (body) => ({ status: 200, body });
const fail = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

/** Wraps a handler: makes sure tables exist and turns thrown errors into JSON 500s. */
export function safe(fn) {
  return async (...args) => {
    try {
      await initDb().catch((e) => console.log("DB init warning (using local store fallback):", e.message));
      return await fn(...args);
    } catch (e) {
      console.log(`API error: ${e.message}${e.code ? ` [${e.code}]` : ""}`);
      return fail(500, e.message);
    }
  };
}


/** Save a Todoist token only if it has the right format AND Todoist accepts it. Returns true when saved. */
async function saveTodoistKeyIfReal(id, raw) {
  if (!raw || !isValidTodoistKey(raw)) return false;
  const check = await verifyTodoistToken(raw).catch(() => ({ valid: false }));
  if (!check.valid) return false;
  await saveTodoistKey(id, cleanTodoistKey(raw));
  return true;
}

// POST /api/user-keys
export const saveKeys = safe(async (body = {}, hooks = {}) => {
  const parsedId = parseId(body.telegram_user_id);
  const id = Number.isNaN(parsedId) ? FALLBACK_GUEST_ID : parsedId;
  const keys = Array.isArray(body.gemini_api_keys) ? body.gemini_api_keys : [];
  const rawTodoist =
    body.todoist_api_key !== undefined
      ? body.todoist_api_key
      : body.todoistKey !== undefined
        ? body.todoistKey
        : undefined;

  let notebooklmState = null;
  let loginEmail = null;
  if (!body.notebooklm_login_id && body.notebooklm_storage_state) {
    let st = body.notebooklm_storage_state;
    if (typeof st === "string") {
      try {
        st = JSON.parse(st);
      } catch {
        return fail(400, "That storage_state.json is not valid JSON");
      }
    }
    const inspectFn = hooks.inspectStorageState || inspectStorageState;
    try {
      inspectFn(st);
    } catch (err) {
      return fail(400, err.message);
    }
    notebooklmState = st;
  }
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

  if (rawTodoist !== undefined && rawTodoist !== null && String(rawTodoist).trim() !== "") {
    if (!isValidTodoistKey(rawTodoist)) {
      return fail(400, "That isn't a Todoist API token. It is 40 letters and numbers (0-9, a-f). Copy it from Todoist Settings → Integrations → Developer.");
    }
    const check = await verifyTodoistToken(rawTodoist);
    if (!check.valid) return fail(400, check.error || "Todoist rejected this API token.");
  }

  let rawClass = body.class_level ?? body.classLevel;
  if (rawClass !== undefined && rawClass !== null && String(rawClass).trim() !== "" && !normalizeClassLevel(rawClass)) {
    return fail(400, "Class must be a number from 1 to 12.");
  }

  const saved = await saveUserConfig(id, {
    keys,
    notebooklmState,
    email: rawEmail || null,
    todoistKey: rawTodoist,
    classLevel: rawClass,
  });

  if (!saved.keys && !saved.session && !saved.email && !saved.todoist && !saved.class_level && rawTodoist !== "") {
    // Check if user already has keys saved so we don't error out on re-saving
    const existingKeys = await getUserKeys(id);
    const existingTodoist = await getTodoistKey(id);
    if (!existingKeys.length && !existingTodoist) {
      return fail(
        400,
        `Nothing valid to save: add a Gemini API key, Todoist API token, or NotebookLM session first.`
      );
    }
  }

  const activeTodoist = await getTodoistKey(id);
  return ok({
    ok: true,
    telegram_user_id: id,
    keys_saved: saved.keys,
    session_saved: saved.session,
    email_saved: saved.email,
    todoist_saved: saved.todoist,
    class_level: await getUserClass(id),
    has_todoist_key: Boolean(activeTodoist),
    todoist_masked: activeTodoist ? `${activeTodoist.slice(0, 4)}…${activeTodoist.slice(-4)}` : null,
    google_email: rawEmail || null,
  });
});

// GET /api/user-keys/:id
export const getKeys = safe(async (idRaw) => {
  const parsedId = parseId(idRaw);
  const id = Number.isNaN(parsedId) ? FALLBACK_GUEST_ID : parsedId;
  const keys = await getUserKeys(id);
  const profile = await getUserProfile(id);
  const todoistKey = await getTodoistKey(id);
  return ok({
    telegram_user_id: id,
    google_email: profile?.google_email || null,
    notebooklm_session_saved: Boolean(profile?.has_session),
    class_level: normalizeClassLevel(profile?.class_level) || (await getUserClass(id)),
    count: keys.length,
    masked: keys.map((k) => `AIza…${k.slice(-4)}`),
    has_todoist_key: Boolean(todoistKey),
    todoist_masked: todoistKey ? `${todoistKey.slice(0, 4)}…${todoistKey.slice(-4)}` : null,
    todoist_source: profile?.todoist_api_key ? "user" : TODOIST_API_KEY ? "env" : null,
  });
});

// DELETE /api/user-keys/:id
export const removeKeys = safe(async (idRaw) => {
  const parsedId = parseId(idRaw);
  const id = Number.isNaN(parsedId) ? FALLBACK_GUEST_ID : parsedId;
  return ok({ ok: true, deleted: await deleteUserKey(id) });
});

// POST /api/todoist/verify { telegramUserId?, todoistApiKey? }
export const todoistVerify = safe(async (body = {}, ctx = {}) => {
  const id = resolveUserId(body.telegramUserId ?? body.telegram_user_id, ctx);
  const rawKey =
    body.todoistApiKey ||
    body.todoist_api_key ||
    ctx?.cookies?.sa_todoist_key ||
    (await getTodoistKey(id));

  if (!rawKey) {
    return fail(400, "No Todoist API key provided. Paste your token from Todoist Developer Settings.");
  }

  const check = await verifyTodoistToken(rawKey);
  if (!check.valid) {
    return fail(400, check.error || "Invalid Todoist API token.");
  }

  const cleaned = cleanTodoistKey(rawKey);
  await saveTodoistKey(id, cleaned);

  return ok({
    ok: true,
    valid: true,
    verified: true,
    mode: check.mode,
    projectCount: check.projectCount ?? null,
    telegram_user_id: id,
    masked: `${cleaned.slice(0, 4)}…${cleaned.slice(-4)}`,
  });
});

// GET /api/syllabus/:chatId
export const getSyllabus = safe(async (chatIdRaw) => {
  const chatId = parseInt(chatIdRaw, 10);
  if (Number.isNaN(chatId)) return fail(400, "Invalid chat ID");
  if (!hasDatabaseUrl()) {
    const store = readLocalStore();
    return ok({ chatId, chapters: store.syllabi?.[String(chatId)] || [] });
  }
  const chapters = await withDb(async (db) => {
    const { rows } = await db.query(
      `SELECT id, subject, exam, number, title, match_status, pdf_url, recommended_questions
       FROM syllabus_chapters
       WHERE chat_id = $1
       ORDER BY subject, number`,
      [chatId]
    );
    for (const r of rows) {
      const granular = storedSubject(r.subject, r.title, r.pdf_url, "", r.number);
      if (granular && granular !== r.subject) {
        r.subject = granular;
        await db.query("UPDATE syllabus_chapters SET subject = $1 WHERE id = $2", [granular, r.id]).catch(() => {});
      }
    }
    return rows;
  });
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
// Quizzes (Typed / Spoken Answer Format + Pending Save/Resume + AI Verification + Requiz + Review)
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
      subject: storedSubject(c.subject, c.title, c.pdf_url, "", c.number),
      exam: c.exam,
      number: c.number,
      title: c.title,
      matched: isMatched(c),
      recommended_questions: questionCountFor(c),
      pending_quiz: c.pending_quiz || null,
      result: c.result,
    })),
  });
});

// POST /api/quizzes/generate { telegramUserId, chapterId, questionCount?, resumeQuizId?, geminiKey? }
// Supports initial quiz, resuming a Pending quiz from where the user left off, AND Requiz.
export const quizGenerate = safe(async (body = {}, ctx = {}) => {
  const id = quizUserId(body.telegramUserId, ctx);
  if (Number.isNaN(id)) return fail(400, "Missing Telegram user id");

  // If the student clicked the yellow Pending button to resume an existing pending quiz session:
  if (body.resumeQuizId) {
    const existingSession = await getQuizSession(String(body.resumeQuizId), id);
    if (existingSession && existingSession.questions?.length) {
      const ch = existingSession.chapter;
      const lastResult = await getLastQuizResult(id, ch.subject, ch.exam, ch.title);
      return ok({
        quizId: existingSession.quizId,
        resumed: true,
        attempt: (lastResult?.attempts || 0) + 1,
        currentIndex: existingSession.currentIndex || 0,
        answers: existingSession.answers || existingSession.questions.map(() => ""),
        chapter: {
          id: ch.id,
          subject: storedSubject(ch.subject, ch.title, ch.pdf_url, "", ch.number),
          exam: ch.exam,
          number: ch.number,
          title: ch.title,
          recommended_questions: questionCountFor(ch),
        },
        questions: existingSession.questions.map(({ subtopic, question }) => ({ subtopic, question })),
      });
    }
  }

  const chapterId = parseId(body.chapterId);
  if (Number.isNaN(chapterId)) return fail(400, "Missing or invalid chapter id");

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
    resumed: false,
    attempt: attemptNumber,
    currentIndex: 0,
    answers: quiz.questions.map(() => ""),
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

// POST /api/quizzes/progress { telegramUserId, quizId, answers, currentIndex, isPending }
// Saves the student's current progress (answers in order + current question index) and marks the quiz as Pending.
export const quizSaveProgress = safe(async (body = {}, ctx = {}) => {
  const id = quizUserId(body.telegramUserId, ctx);
  if (Number.isNaN(id)) return fail(400, "Missing or invalid Telegram user id");
  const quizId = String(body.quizId || "").trim();
  if (!quizId) return fail(400, "Missing quizId");
  const answers = Array.isArray(body.answers) ? body.answers.map((a) => String(a ?? "")) : [];
  const currentIndex = Math.max(0, parseInt(body.currentIndex, 10) || 0);
  const isPending = body.isPending !== undefined ? Boolean(body.isPending) : true;

  const updated = await saveQuizProgress({
    quizId,
    telegramUserId: id,
    answers,
    currentIndex,
    isPending,
  });

  return ok({
    ok: true,
    quizId,
    saved: Boolean(updated),
    currentIndex,
    isPending,
  });
});

// POST /api/quizzes/submit { telegramUserId, quizId, answers: ["typed/spoken answer 1", ...], chapter?, questions? }
export const quizSubmit = safe(async (body = {}, ctx = {}) => {
  const id = quizUserId(body.telegramUserId, ctx);
  if (Number.isNaN(id)) return fail(400, "Missing or invalid Telegram user id");
  if (!Array.isArray(body.answers)) return fail(400, "answers must be an array");

  const savedKeys = await getUserKeys(id);
  const extraKeys = [body.geminiKey, ctx?.cookies?.sa_gemini_key].filter((k) => typeof k === "string" && k.length >= 20);
  const apiKeys = [...new Set([...savedKeys, ...extraKeys])];

  const out = await withDb(async (db) => {
    let session = await takeQuizSession(db, String(body.quizId || ""), id);
    // Fallback if a pending quiz was resumed from localStorage after a DB reset
    if (!session && body.chapter && Array.isArray(body.questions) && body.questions.length > 0) {
      session = {
        chapter: body.chapter,
        questions: body.questions.map((q) => ({
          subtopic: String(q.subtopic || "General"),
          question: String(q.question || ""),
          expectedAnswer: String(q.expectedAnswer || q.question || ""),
          keywords: Array.isArray(q.keywords) ? q.keywords : [],
          explanation: String(q.explanation || ""),
        })),
        savedAnswers: body.answers,
      };
    }
    if (!session) return null;

    const ch = session.chapter;
    ch.subject = storedSubject(ch.subject, ch.title, ch.pdf_url, "", ch.number);

    // Merge saved pending answers with submitted answers in order so no previous answer is ever lost
    const mergedAnswers = session.questions.map((_, idx) => {
      const fromBody = typeof body.answers?.[idx] === "string" ? body.answers[idx].trim() : "";
      if (fromBody) return fromBody;
      const fromSaved = typeof session.savedAnswers?.[idx] === "string" ? session.savedAnswers[idx].trim() : "";
      return fromSaved;
    });

    const g = await grade(session.questions, mergedAnswers, apiKeys, ch);
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
2. "subject": specific discipline name — MUST be one of "History", "Civics", "Geography", "Economics", "Physics", "Chemistry", "Biology", "Mathematics", "English", "Hindi", "Sanskrit" (NEVER use generic "Social Science" or "Science")
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
        const granularSubject = classifyGranularSubject(
          d.subject,
          d.chapter_title,
          pdfUrl,
          bookCode,
          chNum
        );
        return {
          class_level: d.class_level || null,
          exam: null,
          subjects: [
            {
              name: granularSubject,
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

/**
 * Deterministic multi-line text syllabus parser fallback (works even without a Gemini key or when offline).
 */
export function parsePlainTextSyllabusHeuristic(rawText = "", classLevel = null) {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const bySubject = new Map();
  let currentSubject = "Physics";

  for (const line of lines) {
    // Check "Subject: Chapter 1, Chapter 2" or "Subject - Chapter"
    const colonMatch = /^([A-Za-z\s&]{3,28})\s*[:\-–]\s*(.+)$/.exec(line);
    if (colonMatch) {
      const potentialSubj = colonMatch[1].trim();
      const rest = colonMatch[2].trim();
      if (/^(physics|chemistry|biology|math|mathematics|science|history|civics|geography|economics|social\s*science|sst|english|hindi|sanskrit|computer|accountancy)$/i.test(potentialSubj)) {
        currentSubject = potentialSubj;
        const parts = rest.split(/\s*[;|,]\s*/).filter(Boolean);
        for (const p of parts) {
          const cleanTitle = p.replace(/^(?:ch(?:apter)?\s*\d+\s*[:.\-–]?\s*|\d+[.)]\s*)/i, "").trim();
          if (!cleanTitle) continue;
          const gran = classifyGranularSubject(currentSubject, cleanTitle, "", "", null);
          if (!bySubject.has(gran)) bySubject.set(gran, []);
          const list = bySubject.get(gran);
          list.push({
            number: list.length + 1,
            title: cleanTitle,
            is_ncert: false,
            ncert_book_code: null,
            ncert_chapter_number: null,
            pdf_url: null,
            recommended_questions: 15,
          });
        }
        continue;
      }
    }

    if (/^(physics|chemistry|biology|mathematics|maths|science|history|civics|political science|geography|economics|social science|english|hindi|sanskrit)\s*:?$/i.test(line)) {
      currentSubject = line.replace(/:$/, "").trim();
      continue;
    }

    const cleanTitle = line.replace(/^[-*•]\s*/, "").replace(/^(?:ch(?:apter)?\s*\d+\s*[:.\-–]?\s*|\d+[.)]\s*)/i, "").trim();
    if (cleanTitle.length >= 2) {
      const gran = classifyGranularSubject(currentSubject, cleanTitle, "", "", null);
      if (!bySubject.has(gran)) bySubject.set(gran, []);
      const list = bySubject.get(gran);
      list.push({
        number: list.length + 1,
        title: cleanTitle,
        is_ncert: false,
        ncert_book_code: null,
        ncert_chapter_number: null,
        pdf_url: null,
        recommended_questions: 15,
      });
    }
  }

  const subjects = [...bySubject.entries()].map(([name, chapters]) => ({ name, chapters }));
  return subjects.length
    ? { class_level: classLevel, exam: "School Syllabus", subjects }
    : null;
}

// POST /api/syllabus/upload { telegramUserId, kind: "pdf" | "text", fileName?, dataBase64?, text?, questionCount?, geminiKey? }
// Used on initial onboarding, when clicking "New Quiz", AND from the Planner page syllabus input.
export const MAX_SYLLABUS_PDF_BYTES = 20 * 1024 * 1024;
export const syllabusUpload = safe(async (body = {}, ctx = {}) => {
  const id = resolveUserId(body.telegramUserId, ctx);

  const saved = await getUserKeys(id);
  const extra = [body.geminiKey, ctx?.cookies?.sa_gemini_key].filter((k) => typeof k === "string" && k.length >= 20);
  const keys = [...new Set([...saved, ...extra])];

  const userClass = await getUserClass(id); // chosen on the setup page; never from .env

  let syllabus = null;
  let identified = null;

  if (body.kind === "pdf") {
    // PDF upload: no syllabus parser. Work out which chapter(s) of ncert_chapters the PDF is, then take
    // chapter number, subject and pdf_url straight from those table rows.
    const b64 = String(body.dataBase64 || "");
    if (!b64) return fail(400, "No file received");
    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    if (!bytes.length) return fail(400, "That file is empty");
    if (bytes.length > MAX_SYLLABUS_PDF_BYTES) return fail(413, "That PDF is over 20 MB, which is too big.");
    if (String.fromCharCode(...bytes.slice(0, 4)) !== "%PDF") return fail(400, "That file doesn't look like a PDF");

    if (!hasDatabaseUrl()) return fail(503, "Chapters are looked up in the ncert_chapters table, so DATABASE_URL must be set.");

    identified = await identifyChaptersFromPdf({
      pdfBytes: bytes,
      fileName: body.fileName || "",
      classLevel: userClass,
      apiKeys: keys,
    });
    if (identified.empty) return fail(404, "The ncert_chapters table has no chapters with a pdf_url yet.");
    if (!identified.rows.length) {
      return fail(
        422,
        userClass
          ? `Couldn't tell which Class ${userClass} chapter that PDF is. Check that it is an NCERT chapter of your class (and your class on the setup page).`
          : "Couldn't tell which chapter that PDF is. Choose your class on the setup page, then upload it again."
      );
    }
    syllabus = syllabusFromNcertRows(identified.rows, userClass);
  } else if (body.kind === "text") {
    const text = String(body.text || "").trim();
    if (text.length < 3) return fail(400, "Paste your syllabus text first");
    if (text.length > 100_000) return fail(413, "That text is too long. Paste just the portion you need.");

    if (keys.length || GEMINI_API_KEY) {
      try {
        syllabus = await parseSyllabus(text, keys, body.fileName || "");
      } catch (e) {
        console.log(`Initial syllabus parse failed (${e.message}), trying single-chapter/heuristic extractor`);
      }
      if (!syllabus?.subjects?.length) {
        syllabus = await extractSingleChapterFallback(body, keys);
      }
    }
    if (!syllabus?.subjects?.length) {
      syllabus = parsePlainTextSyllabusHeuristic(body.text, userClass);
    }
    if (!syllabus?.subjects?.length) {
      const fallbackTitle = String(body.text || "Custom Study Topic").split("\n")[0].slice(0, 60).trim();
      const inferredSubj = classifyGranularSubject("", fallbackTitle, "", "", 1);
      syllabus = {
        class_level: userClass,
        exam: "Custom Source",
        subjects: [
          {
            name: inferredSubj !== "General" ? inferredSubj : "Physics",
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
    syllabus = splitSyllabusIntoGranularSubjects(syllabus);
  } else {
    return fail(400, 'kind must be "pdf" or "text"');
  }

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

  let generation = null;
  try {
    generation = await scheduleAutoStart(id, syllabus);
  } catch (e) {
    console.log(`Could not schedule chapter generation: ${e.message}`);
  }

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
    identified: identified
      ? {
          method: identified.method,
          class_level: userClass,
          class_missing: !userClass,
          chapters: identified.rows.map((r) => ({
            ncert_id: r.id,
            class: r.class,
            subject: ncertSubjectName(r) || "General",
            number: r.number,
            title: r.title,
            pdf_url: r.pdf_url,
          })),
        }
      : null,
    ai_recommended_questions: aiRecommended,
    generation,
    chapters: allChapters,
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

// ---------------------------------------------------------------------------
// AI Study Planner & Todoist Integration Endpoints (/api/planner/*)
// ---------------------------------------------------------------------------

function buildQuizHistorySummary(chapters = []) {
  const quizzed = chapters.filter((c) => c.result && typeof c.result.percentage === "number");
  const heavyRestudy = [];
  const moderateRevision = [];
  const mastered = [];
  const weakSubtopics = [];

  for (const ch of quizzed) {
    const pct = ch.result.percentage;
    const tier = ch.result.revision_tier || revisionFor(pct).tier;
    const item = {
      id: ch.id,
      subject: ch.subject,
      title: ch.title,
      percentage: pct,
      score: ch.result.score,
      total: ch.result.total,
      tier,
      weakSubtopics: ch.result.weak_subtopics || [],
    };
    if (tier === "heavy_restudy" || pct < 50) heavyRestudy.push(item);
    else if (tier === "moderate_revision" || pct < 80) moderateRevision.push(item);
    else mastered.push(item);

    for (const w of ch.result.weak_subtopics || []) {
      weakSubtopics.push({ subject: ch.subject, chapterTitle: ch.title, subtopic: w, percentage: pct });
    }
  }

  const avgPercentage = quizzed.length
    ? Math.round(quizzed.reduce((acc, c) => acc + c.result.percentage, 0) / quizzed.length)
    : null;

  return {
    totalQuizzedChapters: quizzed.length,
    averagePercentage: avgPercentage,
    heavyRestudyCount: heavyRestudy.length,
    moderateRevisionCount: moderateRevision.length,
    masteredCount: mastered.length,
    heavyRestudy,
    moderateRevision,
    mastered,
    weakSubtopics,
  };
}

// GET /api/planner/state?telegramUserId=...
export const plannerState = safe(async (query = {}, ctx = {}) => {
  const id = quizUserId(query.telegramUserId, ctx);
  if (Number.isNaN(id)) {
    return fail(400, "Missing or invalid Telegram user id", {
      has_syllabus: false,
      chapters: [],
      plan: null,
    });
  }
  const [chapters, geminiKeys, profile, todoistKey, savedPlanData] = await Promise.all([
    getChaptersWithResults(id),
    getUserKeys(id),
    getUserProfile(id),
    getTodoistKey(id, ctx?.cookies?.sa_todoist_key),
    getStudyPlanForUser(id),
  ]);

  const normalizedChapters = chapters.map((c) => ({
    id: c.id,
    subject: classifyGranularSubject(c.subject, c.title, c.pdf_url, "", c.number),
    exam: c.exam || "",
    number: c.number,
    title: c.title,
    pdf_url: c.pdf_url || null,
    matched: isMatched(c),
    is_custom: Boolean(c.is_custom),
    recommended_questions: questionCountFor(c),
    result: c.result || null,
  }));

  const syllabusChaptersOnly = normalizedChapters.filter((c) => !c.is_custom);
  const hasSyllabus = syllabusChaptersOnly.length > 0;
  const savedConfig = normalizePlannerConfig(savedPlanData?.config || DEFAULT_PLANNER_CONFIG);
  // Older saved plans may carry empty padding days past the chosen horizon (e.g. an 8th day on a 7-day plan).
  if (savedPlanData?.plan) trimEmptyDaysPastHorizon(savedPlanData.plan, savedConfig.planDays);
  const quizHistory = buildQuizHistorySummary(normalizedChapters);

  return ok({
    ok: true,
    telegram_user_id: id,
    has_todoist_key: Boolean(todoistKey),
    todoist_masked: todoistKey ? `${todoistKey.slice(0, 4)}…${todoistKey.slice(-4)}` : null,
    todoist_source: profile?.todoist_api_key ? "user" : TODOIST_API_KEY ? "env" : ctx?.cookies?.sa_todoist_key ? "cookie" : null,
    todoist_upcoming_url: "https://app.todoist.com/app/upcoming",
    has_gemini_key: geminiKeys.length > 0 || Boolean(ctx?.cookies?.sa_gemini_key) || Boolean(GEMINI_API_KEY),
    has_syllabus: hasSyllabus,
    message: hasSyllabus ? null : "No syllabus has been processed yet. Upload your syllabus to get started.",
    chapters: hasSyllabus ? normalizedChapters : [],
    quiz_history: quizHistory,
    session_styles: Object.values(SESSION_STYLE_PRESETS),
    config: normalizePlannerConfig(savedPlanData?.config || DEFAULT_PLANNER_CONFIG),
    plan: hasSyllabus ? (savedPlanData?.plan || null) : null,
    synced_tasks: hasSyllabus ? (savedPlanData?.syncedTasks || []) : [],
    todoist_synced_at: hasSyllabus ? (savedPlanData?.todoistSyncedAt || null) : null,
  });
});

// POST /api/planner/syllabus { telegramUserId?, text?, chapters?: [{ subject, number?, title }], mode?: "append" | "replace", deleteChapterId? }
export const plannerSyllabusSave = safe(async (body = {}, ctx = {}) => {
  const id = resolveUserId(body.telegramUserId, ctx);

  // Deleting a single chapter from the syllabus
  if (body.deleteChapterId != null) {
    const delId = body.deleteChapterId;
    const store = readLocalStore();
    if (Array.isArray(store.syllabi?.[String(id)])) {
      store.syllabi[String(id)] = store.syllabi[String(id)].filter((c) => String(c.id) !== String(delId));
      writeLocalStore(store);
    }
    if (hasDatabaseUrl() && /^\d+$/.test(String(delId))) {
      await withDb((db) =>
        db.query("DELETE FROM syllabus_chapters WHERE id = $1 AND chat_id = $2", [Number(delId), id])
      ).catch(() => {});
    }
    const updatedChapters = await getChaptersWithResults(id);
    return ok({
      ok: true,
      has_syllabus: updatedChapters.length > 0,
      chapters: updatedChapters,
    });
  }

  // If user pasted raw text syllabus on the Planner page, parse & save it
  if (typeof body.text === "string" && body.text.trim().length >= 3) {
    const uploadRes = await syllabusUpload(
      {
        telegramUserId: id,
        kind: "text",
        text: body.text.trim(),
        geminiKey: body.geminiKey,
      },
      ctx
    );
    return uploadRes;
  }

  // If user added/edited structured chapter items [{ subject, number, title }]
  const incoming = Array.isArray(body.chapters) ? body.chapters : [];
  if (!incoming.length) {
    return fail(400, "Provide syllabus text or at least one chapter to save.");
  }

  const bySubject = new Map();
  for (const item of incoming) {
    const title = String(item?.title || "").trim();
    if (!title) continue;
    const rawSubject = String(item?.subject || "General").trim();
    const gran = storedSubject(rawSubject, title, item?.pdf_url || "", "", item?.number);
    if (!bySubject.has(gran)) bySubject.set(gran, []);
    const list = bySubject.get(gran);
    list.push({
      number: Number(item?.number) || list.length + 1,
      title,
      is_ncert: Boolean(item?.pdf_url),
      ncert_book_code: null,
      ncert_chapter_number: Number(item?.number) || list.length + 1,
      pdf_url: item?.pdf_url || null,
      recommended_questions: 15,
    });
  }

  if (body.mode === "append") {
    const existing = await getChaptersWithResults(id);
    for (const ex of existing) {
      if (ex.is_custom) continue;
      const gran = storedSubject(ex.subject, ex.title, ex.pdf_url, "", ex.number);
      if (!bySubject.has(gran)) bySubject.set(gran, []);
      const list = bySubject.get(gran);
      if (!list.some((c) => c.title.toLowerCase() === String(ex.title).toLowerCase())) {
        list.unshift({
          number: ex.number || 1,
          title: ex.title,
          is_ncert: Boolean(ex.pdf_url),
          ncert_book_code: null,
          ncert_chapter_number: ex.number || 1,
          pdf_url: ex.pdf_url || null,
          recommended_questions: ex.recommended_questions || 15,
        });
      }
    }
  }

  const syllabusObj = {
    class_level: await getUserClass(id),
    exam: String(body.exam || ""),
    subjects: [...bySubject.entries()].map(([name, chapters]) => ({
      name,
      chapters: chapters.map((c, i) => ({ ...c, number: c.number || i + 1 })),
    })),
  };

  await saveSyllabus(id, syllabusObj);
  const updated = await getChaptersWithResults(id);
  return ok({
    ok: true,
    has_syllabus: updated.length > 0,
    chapters: updated,
  });
});

// POST /api/planner/generate { telegramUserId?, config?, syllabusText?, autoSyncTodoist?, todoistApiKey?, geminiKey? }
export const plannerGenerate = safe(async (body = {}, ctx = {}) => {
  const id = quizUserId(body.telegramUserId, ctx);
  if (Number.isNaN(id)) {
    return fail(400, "Missing or invalid Telegram user id", { has_syllabus: false });
  }

  // If the user also pasted inline syllabus text while generating, save it first
  if (typeof body.syllabusText === "string" && body.syllabusText.trim().length >= 3) {
    await syllabusUpload(
      {
        telegramUserId: id,
        kind: "text",
        text: body.syllabusText.trim(),
        geminiKey: body.geminiKey,
      },
      ctx
    ).catch((e) => console.log(`Inline syllabus parse warning: ${e.message}`));
  }

  if (body.todoistApiKey) await saveTodoistKeyIfReal(id, body.todoistApiKey);

  const [chapters, savedGeminiKeys] = await Promise.all([
    getChaptersWithResults(id),
    getUserKeys(id),
  ]);

  const syllabusChaptersOnly = (chapters || []).filter((c) => !c?.is_custom);
  if (!syllabusChaptersOnly.length) {
    return fail(400, "No syllabus has been processed yet. Upload your syllabus to get started.", {
      has_syllabus: false,
      chapters: [],
    });
  }

  const extraGemini = [body.geminiKey, ctx?.cookies?.sa_gemini_key].filter(
    (k) => typeof k === "string" && k.length >= 20
  );
  const geminiKeys = [...new Set([...savedGeminiKeys, ...extraGemini])];

  const config = normalizePlannerConfig(body.config || {});
  const plan = await generateAiStudyPlan({
    chapters,
    config,
    geminiKeys,
    startDate: body.startDate || null,
    classLevel: await getUserClass(id),
  });

  let syncResult = null;
  if (body.autoSyncTodoist) {
    const token = await getTodoistKey(id, body.todoistApiKey || ctx?.cookies?.sa_todoist_key);
    if (token) {
      syncResult = await syncPlanToTodoist({ token, plan });
    }
  }

  const saved = await saveStudyPlanForUser(id, {
    config,
    plan: syncResult?.plan || plan,
    syncedTasks: syncResult?.syncedTasks || null,
    todoistSyncedAt: syncResult?.syncedAt || null,
  });

  return ok({
    ok: true,
    telegram_user_id: id,
    config: saved.config,
    plan: saved.plan,
    synced_tasks: saved.syncedTasks,
    todoist_synced_at: saved.todoistSyncedAt,
    chapters,
    quiz_history: buildQuizHistorySummary(chapters),
  });
});

// POST /api/planner/sync-todoist { telegramUserId?, todoistApiKey?, plan?, config? }
export const plannerSyncTodoist = safe(async (body = {}, ctx = {}) => {
  const id = quizUserId(body.telegramUserId, ctx);
  if (Number.isNaN(id)) {
    return fail(400, "Missing or invalid Telegram user id", { has_syllabus: false });
  }

  const chapters = await getChaptersWithResults(id);
  const syllabusChaptersOnly = (chapters || []).filter((c) => !c?.is_custom);
  if (!syllabusChaptersOnly.length) {
    return fail(400, "No syllabus has been processed yet. Upload your syllabus to get started.", {
      has_syllabus: false,
    });
  }

  if (body.todoistApiKey) await saveTodoistKeyIfReal(id, body.todoistApiKey);

  const token = await getTodoistKey(id, body.todoistApiKey || ctx?.cookies?.sa_todoist_key);
  if (!token) {
    return fail(
      400,
      "No Todoist API key found. Add your Todoist API token on the Setup page (or paste it in the Planner) first."
    );
  }

  let existingData = await getStudyPlanForUser(id);
  let planToSync = body.plan || existingData?.plan || null;
  const config = normalizePlannerConfig(body.config || existingData?.config || DEFAULT_PLANNER_CONFIG);

  if (!planToSync || !Array.isArray(planToSync.days) || !planToSync.days.length) {
    const geminiKeys = await getUserKeys(id);
    planToSync = await generateAiStudyPlan({
      chapters: syllabusChaptersOnly,
      config,
      geminiKeys,
      classLevel: await getUserClass(id),
    });
  }

  try {
    const syncOut = await syncPlanToTodoist({
      token,
      plan: planToSync,
      onlyDate: body.onlyDate || null,
      maxDays: body.maxDays || null,
      forceResync: Boolean(body.forceResync),
    });
    const saved = await saveStudyPlanForUser(id, {
      config,
      plan: syncOut.plan,
      syncedTasks: syncOut.syncedTasks,
      todoistSyncedAt: syncOut.syncedAt,
    });

    return ok({
      ok: true,
      telegram_user_id: id,
      syncedAt: syncOut.syncedAt,
      parentTasksCreated: syncOut.parentTasksCreated,
      subTasksCreated: syncOut.subTasksCreated,
      totalTasksCreated: syncOut.totalTasksCreated,
      upcomingUrl: syncOut.upcomingUrl,
      synced_tasks: saved.syncedTasks,
      plan: saved.plan,
    });
  } catch (err) {
    return fail(err.status || 502, err.message || "Failed to sync study plan to Todoist.");
  }
});

// POST /api/planner/task-toggle { telegramUserId?, blockId?, subtaskId?, todoistTaskId?, completed, todoistApiKey? }
export const plannerToggleTask = safe(async (body = {}, ctx = {}) => {
  const id = resolveUserId(body.telegramUserId, ctx);
  const completed = Boolean(body.completed);
  const blockId = body.blockId ? String(body.blockId) : null;
  const subtaskId = body.subtaskId ? String(body.subtaskId) : null;
  let todoistTaskId = body.todoistTaskId ? String(body.todoistTaskId) : null;

  const existingData = await getStudyPlanForUser(id);
  const plan = existingData?.plan || null;

  if (plan && Array.isArray(plan.days)) {
    for (const day of plan.days) {
      for (const block of day.studyBlocks || []) {
        if (blockId && block.id === blockId && !subtaskId) {
          block.completed = completed;
          if (!todoistTaskId && block.todoistTaskId) todoistTaskId = String(block.todoistTaskId);
        }
        if (subtaskId && Array.isArray(block.subtasks)) {
          for (const sub of block.subtasks) {
            if (sub.id === subtaskId) {
              sub.completed = completed;
              if (!todoistTaskId && sub.todoistTaskId) todoistTaskId = String(sub.todoistTaskId);
            }
          }
        }
      }
    }
    await saveStudyPlanForUser(id, { plan });
  }

  let todoistUpdated = false;
  if (todoistTaskId) {
    const token = await getTodoistKey(id, body.todoistApiKey || ctx?.cookies?.sa_todoist_key);
    if (token) {
      try {
        await setTodoistTaskCompleted({ token, taskId: todoistTaskId, completed });
        todoistUpdated = true;
      } catch (e) {
        console.log(`Todoist task toggle warning (${todoistTaskId}): ${e.message}`);
      }
    }
  }

  return ok({
    ok: true,
    blockId,
    subtaskId,
    todoistTaskId,
    completed,
    todoistUpdated,
    plan,
  });
});

// GET /api/resources?telegramUserId=...  (falls back to the sa_telegram_id cookie)
// -> { chapters: [{ chapterName, status, description, notebookUrl, subject }], message? }
// status: 'Ready' | 'Generating' | 'Failed' | 'Pending' (syllabus chapter that has not been queued yet)
const RESOURCE_STATUS_TEXT = {
  Ready: "Notebook resources generated successfully.",
  Generating: "Notebook resources are being generated. This can take a few minutes.",
  Pending: "Waiting to start generating notebook resources.",
};
export const resourcesList = safe(async (query = {}, ctx = {}) => {
  const id = quizUserId(query.telegramUserId, ctx);
  if (Number.isNaN(id)) return fail(400, "Missing or invalid Telegram user id", { chapters: [] });

  // subject, number and link come from ncert_chapters: re-link anything saved before that was in place
  await relinkUserChapters(id).catch((e) => console.log(`[ncert] re-link failed: ${e.message}`));

  const { rows } = await withDb((db) =>
    db.query(
      `SELECT sc.id, sc.subject, COALESCE(nc.number, sc.number) AS number, sc.title, g.status, g.error, g.notebook_url, g.step, g.result_json
         FROM syllabus_chapters sc
         LEFT JOIN ncert_chapters nc ON nc.id = sc.ncert_id
         LEFT JOIN chapter_generation g
           ON g.telegram_user_id = sc.chat_id AND g.subject = sc.subject AND g.exam = sc.exam
          AND lower(g.chapter_title) = lower(sc.title)
        WHERE sc.chat_id = $1
        ORDER BY sc.id`,
      [id]
    )
  );

  if (!rows.length) {
    return ok({ chapters: [], message: "No syllabus has been processed yet. Upload your syllabus to get started." });
  }

  const chapters = rows.map((r) => {
    const status = r.status === "Ready" || r.status === "Generating" || r.status === "Failed" ? r.status : r.status === "Completed" ? "Ready" : "Pending";
    let startedNote = "";
    try {
      const res = r.result_json ? JSON.parse(r.result_json).resources : null;
      if (res) {
        const entries = Object.entries(res);
        const missed = entries.filter(([, x]) => !x.ok);
        startedNote = ` ${entries.length - missed.length} of ${entries.length} study resources were started in NotebookLM; the longer ones can take a few minutes to finish.`;
        if (missed.length) {
          const why = missed.map(([k, x]) => `${k.replace(/_/g, " ")} (${String(x.error || "not started").slice(0, 90)})`).join("; ");
          startedNote += ` Not started: ${why}.`;
        }
      }
    } catch {}
    const description =
      status === "Ready" && startedNote
        ? `Notebook created.${startedNote}`
        : status === "Generating" && r.step
        ? `${r.step}…`
        : status === "Failed"
        ? `Generation failed${r.error ? `: ${String(r.error).slice(0, 200).replace(/[.\s]+$/, "")}` : ""}. Please try again.`
        : RESOURCE_STATUS_TEXT[status];
    return {
      chapterId: r.id,
      chapterName: r.number != null ? `Chapter ${r.number}: ${r.title}` : r.title,
      subject: r.subject,
      status,
      description,
      notebookUrl: status === "Ready" ? r.notebook_url || null : null,
    };
  });
  const resourceTypes = NOTEBOOKLM_RESOURCE_TYPES.filter((t) => !EXCLUDED_RESOURCE_TYPES.has(t.id)).map(({ id: tid, label, description }) => ({
    id: tid,
    label,
    description,
  }));
  const autoStart = await getAutoStart(id).catch(() => null);
  return ok({ chapters, resourceTypes, autoStart });
});

// POST /api/resources/start
export const resourcesStart = safe(async (body = {}, ctx = {}) => {
  const id = quizUserId(body.telegramUserId, ctx);
  if (Number.isNaN(id)) return fail(400, "Missing or invalid Telegram user id");
  const allowed = new Set(NOTEBOOKLM_RESOURCE_TYPES.map((t) => t.id).filter((t) => !EXCLUDED_RESOURCE_TYPES.has(t)));
  let ids = (Array.isArray(body.chapterIds) ? body.chapterIds : []).map(Number).filter(Number.isInteger);
  let typesById = null;
  const hasSelections = body.selections && typeof body.selections === "object" && !Array.isArray(body.selections);

  if (hasSelections) {
    typesById = {};
    ids = [];
    for (const [key, value] of Object.entries(body.selections)) {
      const chapterId = Number(key);
      if (!Number.isInteger(chapterId)) continue;
      const types = [...new Set((Array.isArray(value) ? value : []).map(String).filter((t) => allowed.has(t)))];
      if (!types.length) continue;
      typesById[chapterId] = types;
      ids.push(chapterId);
    }
    if (!ids.length) return fail(400, "Tick at least one chapter and choose at least one thing to generate for it.");
  } else if (body.cancelAuto === true) {
    const was = await cancelAutoStart(id);
    return ok({ ok: true, queued: 0, message: was ? "Automatic start cancelled. Generate chapters whenever you're ready." : "Automatic start was not active." });
  }

  if (hasSelections || !ids.length) await cancelAutoStart(id);
  const out = await enqueueExisting(id, ids, typesById);
  return ok({ ok: true, queued: out.queued, message: out.queued ? `Started generating ${out.queued} chapter(s).` : "Nothing to generate: every chapter is already Ready or none were found." });
});

// GET /api/generation/status?telegramUserId=...
export const generationStatus = safe(async (query = {}, ctx = {}) => {
  const id = quizUserId(query.telegramUserId, ctx);
  if (Number.isNaN(id)) return fail(400, "Missing or invalid Telegram user id");
  const rows = await getGenerationStatus(id);
  return ok({
    telegram_user_id: id,
    chapters: rows.map((r) => ({
      id: r.id, chapter_id: r.chapter_id, subject: r.subject, exam: r.exam, number: r.chapter_number,
      title: r.chapter_title, status: r.status, notebook_url: r.notebook_url, error: r.error, updated_at: r.updated_at,
    })),
  });
});

// Keep quizGenerateCustom alias pointing to syllabusUpload for backwards compatibility
export const quizGenerateCustom = syllabusUpload;


// ---------------------------------------------------------------------------
// NotebookLM Resource Generation Flow (public/resources.html)
// ---------------------------------------------------------------------------
// Exactly the tiles in NotebookLM's Studio panel, minus Reports and Infographic (never offered).
export const NOTEBOOKLM_RESOURCE_TYPES = [
  { id: "audio_overview", label: "Audio Overview", icon: "fa-solid fa-headphones", description: "Two-host AI deep-dive conversation unpacking the chapter's big ideas." },
  { id: "video_overview", label: "Video Overview", icon: "fa-solid fa-video", description: "Narrated visual video summary of the chapter." },
  { id: "mind_map", label: "Mind Map", icon: "fa-solid fa-diagram-project", description: "Hierarchical topic tree mapping how every subtopic in the chapter connects." },
  { id: "flashcards", label: "Flashcards", icon: "fa-solid fa-layer-group", description: "Active-recall Q&A cards covering definitions, equations, and key distinctions." },
  { id: "quiz", label: "Quiz", icon: "fa-solid fa-circle-question", description: "Multiple-choice quiz that tests the chapter's key ideas." },
  { id: "slide_deck", label: "Slide Deck", icon: "fa-solid fa-chalkboard", description: "Slide-by-slide visual revision deck for rapid pre-exam review." },
  { id: "data_table", label: "Data Table", icon: "fa-solid fa-table", description: "Key facts, terms and comparisons organised into a table." },
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
        async with NotebookLMClient.from_storage(storage_path, timeout=300.0) as client:
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
            elif r_type == "video_overview":
                st = await client.artifacts.generate_video(nb.id, source_ids=src_ids or None)
                task_id = getattr(st, "task_id", None)
            elif r_type == "quiz":
                st = await client.artifacts.generate_quiz(nb.id, source_ids=src_ids or None)
                task_id = getattr(st, "task_id", None)
            elif r_type == "data_table":
                st = await client.artifacts.generate_data_table(nb.id, source_ids=src_ids or None)
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
    const pyBin = process.env.NOTEBOOKLM_PYTHON || (process.platform === "win32" ? "python" : "python3");
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
  const cls = chapter.class ?? null; // the chapter row carries the student's class
  const level = cls ? `Class ${cls}` : "CBSE Secondary School";
  const chNum = chapter.number != null ? `Chapter ${chapter.number}: ` : "";

  const specificInstructions = {
    audio_overview: `Create a NotebookLM-style two-host "Audio Overview" deep-dive dialogue between Host A (Alex, curious & structured) and Host B (Sam, insightful & example-driven).
- In "items", provide 8 to 12 conversational turns where label is "Host A (Alex)" or "Host B (Sam)", prompt is the subtopic being discussed, and detail is the spoken dialogue line.
- In "sections", summarize the key takeaways and analogies discussed in the episode.
- In "markdown", provide the full formatted transcript and show notes.`,
    video_overview: `Create a NotebookLM-style "Video Overview" script for this chapter.
- In "items", provide 6 to 8 scenes where label is "Scene 1", "Scene 2", etc., prompt is the on-screen visual, and detail is the narration.
- In "sections", summarize the key takeaways.`,
    quiz: `Create a NotebookLM multiple-choice Quiz for this chapter.
- In "items", provide 8 to 10 questions where label is "Q1", "Q2", etc., prompt is the question with four options A-D, and detail is the correct answer with a one-line explanation.
- In "sections", group the questions by subtopic.`,
    data_table: `Create a NotebookLM Data Table for this chapter.
- In "items", provide 8 to 12 rows where label is the term or topic, prompt is its category, and detail is the key facts or values.
- In "sections", describe what each column means.`,
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
      subject: storedSubject(c.subject, c.title, c.pdf_url, "", c.number),
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

// ---------------------------------------------------------------------------
// "Ask a doubt" popup (Quizzes + Resources pages)
// ---------------------------------------------------------------------------
const DOUBT_SYSTEM_PROMPT = `You are "Study Agent", a friendly, accurate study helper for a school student following the NCERT / CBSE syllabus.

How to answer:
- Explain simply and clearly, in the style of a good teacher. Use short paragraphs, small bullet lists and a quick example when it helps.
- Keep answers focused and fairly short (usually under 180 words) unless the student asks for more detail.
- Match the student's class level when it is given. Prefer NCERT terms, definitions and formulas.
- If the student is clearly asking for the final answer to a quiz question they are being tested on right now, explain the concept and give hints instead of the direct answer, and say you are doing that.
- If you are not sure about something, say so instead of guessing. Never invent facts, formulas or textbook references.
- Only help with studies and learning. For anything unrelated, politely steer the student back to their studies.
- Reply in the same language the student writes in. Use plain text with light markdown (bold, bullets). No tables, no headings.`;

// POST /api/doubt/ask { telegramUserId?, message, history?: [{ role: "user" | "model", text }], page?, context?, geminiKey? }
export const doubtAsk = safe(async (body = {}, ctx = {}) => {
  const message = String(body.message ?? "").trim().slice(0, 2000);
  if (!message) return fail(400, "Type your doubt first");

  const id = quizUserId(body.telegramUserId, ctx);
  const saved = Number.isNaN(id) ? [] : await getUserKeys(id);
  const extra = [body.geminiKey, ctx?.cookies?.sa_gemini_key].filter((k) => typeof k === "string" && k.length >= 20);
  const keys = [...new Set([...saved, ...extra, GEMINI_API_KEY].filter(Boolean))];
  if (!keys.length) return fail(400, "No Gemini API key found. Save one on the setup page first.");

  const cls = Number.isNaN(id) ? null : await getUserClass(id).catch(() => null);
  const page = body.page === "resources" ? "Resources" : "Quizzes";
  const topic = String(body.context ?? "").trim().slice(0, 200);
  const systemInstruction = [
    DOUBT_SYSTEM_PROMPT,
    cls ? `The student is in Class ${cls}.` : "",
    `The student is on the ${page} page${topic ? ` and is looking at: ${topic}` : ""}.`,
  ].filter(Boolean).join("\n\n");

  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((m) => m && (m.role === "user" || m.role === "model") && typeof m.text === "string" && m.text.trim())
    .slice(-10)
    .map((m) => ({ role: m.role, parts: [{ text: m.text.slice(0, 2000) }] }));
  // Gemini requires the conversation to start with a user turn
  while (history.length && history[0].role !== "user") history.shift();
  const contents = [...history, { role: "user", parts: [{ text: message }] }];

  let lastErr;
  for (const key of keys) {
    try {
      const res = await getGenClient(key).models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: { systemInstruction, temperature: 0.4, maxOutputTokens: 900 },
      });
      const answer = String(res.text ?? "").trim();
      if (answer) return ok({ answer });
      lastErr = new Error("Empty answer");
    } catch (e) {
      lastErr = e;
      console.log(`Doubt: Gemini key ...${key.slice(-4)} failed (${e.message}); trying next`);
    }
  }
  return fail(502, `Could not get an answer right now. ${lastErr?.message ? "Please try again in a moment." : ""}`.trim());
});
