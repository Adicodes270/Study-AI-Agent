// src/api.js
// All API logic lives here and returns { status, body }.
// Used by the Vercel functions in /api and by the local server (src/webServer.js).
import { Api } from "grammy";
import { GoogleGenAI, Type } from "@google/genai";
import { DEFAULT_CLASS_LEVEL, GEMINI_API_KEY, GEMINI_MODEL, TELEGRAM_BOT_TOKEN } from "./config.js";
import {
  createQuizSession,
  getChapterForUser,
  getChapterResource,
  getChaptersWithResources,
  getChaptersWithResults,
  hasChapterResource,
  hasQuizResult,
  initDb,
  saveChapterResource,
  takeQuizSession,
  upsertQuizResult,
  withDb,
} from "./db.js";
import { generateQuiz, grade } from "./quizEngine.js";
import crypto from "node:crypto";
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


// ---------------------------------------------------------------------------
// NotebookLM Resource Generation Flow (public/resources.html)
// Supported resource types exclude "Infographics" and "Report" per strict rule.
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

// Per-user NotebookLM quota tracker (protects session from rapid burst exhaustion)
const USER_QUOTA_WINDOW_MS = 15 * 60 * 1000; // 15-minute rolling window
const USER_MAX_GENERATIONS_PER_WINDOW = parseInt(process.env.NOTEBOOKLM_QUOTA_PER_WINDOW ?? "", 10) || 24;
const userQuotaHits = new Map(); // telegramUserId -> { timestamps: number[], cooldownUntil: number }

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

  // Try extracting an explicit duration from the upstream error message
  const retryMatch =
    msg.match(/try again (?:in|after)\s+([0-9]+\s*(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)(?:\s*[0-9]+\s*(?:minutes?|mins?|m|seconds?|secs?|s))?)/i) ||
    msg.match(/retry(?:Delay| in| after)?["':\s]+([0-9]+(?:\.[0-9]+)?\s*(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h))/i);
  if (retryMatch) {
    const raw = retryMatch[1].trim();
    const secMatch = /^([0-9]+(?:\.[0-9]+)?)\s*s$/i.exec(raw);
    if (secMatch) return formatWaitDuration(Math.ceil( parseFloat(secMatch[1]) * 1000 ));
    return raw;
  }
  return "15 minutes";
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

  if (resourceType === "audio_overview") {
    return {
      title: `Audio Overview: ${fullChapterTitle}`,
      summary: `Two-host deep-dive conversation exploring the core concepts, real-world applications, and exam highlights of ${chapter.title} (${chapter.subject}).`,
      sections: [
        {
          heading: "Episode Overview",
          body: `In this NotebookLM Audio Overview, Alex and Sam unpack ${fullChapterTitle} in ${chapter.subject}, breaking down foundational definitions, step-by-step mechanisms, and high-yield exam takeaways.`,
          bullets: [
            `Core theme and intuition behind ${chapter.title}`,
            "How examiners test this chapter in objective and descriptive questions",
            "Common misconceptions and how to avoid them",
          ],
        },
      ],
      items: [
        {
          label: "Host A (Alex)",
          prompt: "Introduction & Big Picture",
          detail: `Welcome back! Today we're diving into ${fullChapterTitle} in ${chapter.subject}. If you've ever wondered how this topic connects to real-world problems and what actually matters for your exam, we've got you covered.`,
        },
        {
          label: "Host B (Sam)",
          prompt: "Core Intuition",
          detail: `Exactly. The best way to approach ${chapter.title} is not by memorizing isolated lines, but by understanding the central mechanism first. ${scopeNote}`,
        },
        {
          label: "Host A (Alex)",
          prompt: "Key Definitions & Relationships",
          detail: `Let's break down the primary building blocks of ${chapter.title}. Whenever you see a question from this unit, it almost always hinges on identifying the core variables and their cause-and-effect link.`,
        },
        {
          label: "Host B (Sam)",
          prompt: "Exam Strategy & Wrap-Up",
          detail: `And before you wrap up your revision of ${chapter.title}, make sure you can state the core principle in one sentence and work through a standard example without looking at your notes!`,
        },
      ],
      markdown: `# Audio Overview: ${fullChapterTitle}\n\n**Subject:** ${chapter.subject}${chapter.exam ? ` (${chapter.exam})` : ""}\n\n## Transcript Highlights\n- **Host A (Alex):** Welcome back! Today we're diving into ${fullChapterTitle} in ${chapter.subject}.\n- **Host B (Sam):** The best way to approach ${chapter.title} is by understanding the central mechanism first. ${scopeNote}\n- **Host A (Alex):** Focus on the primary definitions, relationships, and standard worked applications.\n- **Host B (Sam):** Test yourself by explaining the main concept out loud in your own words.`,
    };
  }

  if (resourceType === "flashcards") {
    return {
      title: `Flashcards: ${fullChapterTitle}`,
      summary: `Active-recall flashcard deck covering key terms, core principles, and exam checkpoints for ${chapter.title}.`,
      sections: [
        {
          heading: "How to Use This Deck",
          body: `Review each card actively by stating the answer before flipping. Focus extra repetition on cards covering ${chapter.title} definitions and application rules.`,
          bullets: [
            "Say your answer aloud before revealing the back of the card",
            "Flag any card you miss for a 24-hour follow-up review",
          ],
        },
      ],
      items: [
        {
          label: "Core Concept",
          prompt: `What is the central focus of ${fullChapterTitle} in ${chapter.subject}?`,
          detail: `Understanding the fundamental principles, definitions, and problem-solving methods of ${chapter.title}. ${scopeNote}`,
        },
        {
          label: "Key Terminology",
          prompt: `Which foundational terms must be defined clearly when answering questions on ${chapter.title}?`,
          detail: `State the precise textbook definition, specify any conditions or units involved, and pair it with a concrete example from ${chapter.title}.`,
        },
        {
          label: "Application",
          prompt: `How do you approach a typical competency or application question from ${chapter.title}?`,
          detail: `1. Identify the given parameters and underlying concept in ${chapter.title}.\n2. State the governing rule, law, or grammatical/structural principle.\n3. Apply it step-by-step and verify the conclusion.`,
        },
        {
          label: "Exam Pitfall",
          prompt: `What is the most common mistake students make in ${chapter.title}?`,
          detail: `Skipping intermediate steps or confusing closely related subtopics. Always write the governing principle explicitly before concluding.`,
        },
      ],
      markdown: `# Flashcards: ${fullChapterTitle}\n\n1. **Q:** What is the central focus of ${fullChapterTitle}?\n   **A:** Understanding the fundamental principles, definitions, and problem-solving methods of ${chapter.title}.\n2. **Q:** How do you approach an application question from ${chapter.title}?\n   **A:** Identify the given parameters, state the governing principle, and apply it step by step.`,
    };
  }

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
      {
        heading: "2. Key Takeaways & Revision Checkpoints",
        body: `Use the structured breakdown below to verify your mastery of ${chapter.title} before attempting practice problems or chapter quizzes.`,
        bullets: [
          "Review core definitions and conceptual boundaries",
          "Practice explaining each subtopic with a clear example",
          "Cross-reference with your NCERT textbook chapter PDF",
        ],
      },
    ],
    items: [
      {
        label: "Checkpoint 1",
        prompt: `Foundational Principles of ${chapter.title}`,
        detail: `Master the primary definitions, core laws/rules, and conceptual scope of ${fullChapterTitle}.`,
      },
      {
        label: "Checkpoint 2",
        prompt: "Structured Analysis & Examples",
        detail: `Connect theoretical concepts in ${chapter.title} to standard textbook examples and real-world scenarios.`,
      },
      {
        label: "Checkpoint 3",
        prompt: "Exam Readiness & Common Questions",
        detail: `Focus on clarity, step-by-step reasoning, and accurate terminology when answering questions from ${chapter.title}.`,
      },
    ],
    markdown: `# ${meta.label}: ${fullChapterTitle}\n\n**Subject:** ${chapter.subject}${chapter.exam ? ` (${chapter.exam})` : ""}\n${chapter.pdf_url ? `**NCERT PDF:** ${chapter.pdf_url}\n` : ""}\n## 1. Core Overview\nThis ${meta.label} synthesizes the essential concepts of ${fullChapterTitle} in ${chapter.subject}. ${scopeNote}\n\n## 2. Key Checkpoints\n- **Foundational Principles:** Master the primary definitions and conceptual scope of ${chapter.title}.\n- **Structured Analysis:** Connect concepts to textbook examples.\n- **Exam Readiness:** Use precise terminology and step-by-step reasoning.`,
  };
}

/**
 * Generate a single NotebookLM resource for a chapter.
 * 1. Checks if a local/remote `notebooklm-py` bridge server is reachable (using the user's saved session file).
 * 2. Otherwise generates the NotebookLM artifact using the user's Gemini API keys (or fallback synthesis),
 *    preserving any quota/rate-limit errors so the caller can surface "Limit Reached! try again after {time}".
 */
async function generateSingleNotebookLMResource({ telegramUserId, chapter, resourceType, apiKeys, backendUrl }) {
  // Simulate quota trigger for testing if requested via special header/query or env
  if (process.env.FORCE_NOTEBOOKLM_QUOTA_LIMIT) {
    const err = new Error(`Limit Reached! try again after ${process.env.FORCE_NOTEBOOKLM_QUOTA_LIMIT}`);
    err.status = 429;
    err.retryAfter = process.env.FORCE_NOTEBOOKLM_QUOTA_LIMIT;
    throw err;
  }

  // Export saved NotebookLM storage_state.json if the user has one stored
  let sessionFile = null;
  try {
    sessionFile = await exportStorageStateFile(telegramUserId);
  } catch {}

  // 1. Optional external notebooklm-py HTTP bridge (if configured and running)
  const bridgeBase = (backendUrl || process.env.NOTEBOOKLM_BACKEND_URL || "").trim().replace(/\/+$/, "");
  if (bridgeBase && /^https?:\/\//i.test(bridgeBase)) {
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
          chapter: {
            id: chapter.id,
            subject: chapter.subject,
            exam: chapter.exam,
            class: chapter.class,
            number: chapter.number,
            title: chapter.title,
            note: chapter.note,
            pdf_url: chapter.pdf_url,
          },
        }),
      }).finally(() => clearTimeout(timer));

      if (res.status === 429) {
        const errBody = await res.json().catch(() => ({}));
        const retryHeader = res.headers.get("retry-after");
        const retryAfter =
          errBody.retry_after ||
          errBody.retryAfter ||
          (retryHeader ? (/^\d+$/.test(retryHeader) ? formatWaitDuration(Number(retryHeader) * 1000) : retryHeader) : null) ||
          extractQuotaRetryTime(errBody.error) ||
          "15 minutes";
        const err = new Error(`Limit Reached! try again after ${retryAfter}`);
        err.status = 429;
        err.retryAfter = retryAfter;
        throw err;
      }

      if (res.ok) {
        const data = await res.json();
        if (data && (data.content || data.sections || data.markdown)) {
          return {
            title: data.title || `${RESOURCE_META_BY_ID.get(resourceType)?.label || resourceType}: ${chapter.title}`,
            summary: data.summary || "",
            content: data.content || data,
            resourceUrl: data.resource_url || data.notebook_url || chapter.pdf_url || null,
          };
        }
      }
    } catch (e) {
      if (e.status === 429 || e.retryAfter) throw e;
      // Bridge not running on localhost:8000 -> fall through to built-in Gemini NotebookLM synthesizer
    }
  }

  // 2. Built-in NotebookLM artifact synthesis via Gemini API keys
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
            content: parsed,
            resourceUrl: chapter.pdf_url || null,
          };
        }
      } catch (e) {
        const retryTime = extractQuotaRetryTime(e);
        if (retryTime) {
          lastQuotaErr = new Error(`Limit Reached! try again after ${retryTime}`);
          lastQuotaErr.status = 429;
          lastQuotaErr.retryAfter = retryTime;
          continue; // try next fallback key if available
        }
        console.log(`Resource gen (${resourceType}): key ...${key.slice(-4)} failed (${e.message}); trying next`);
      }
    }
    // If all keys failed due to quota/rate-limit, surface the quota error
    if (lastQuotaErr) throw lastQuotaErr;
  }

  // 3. Deterministic structured fallback (when running offline or without live external API access)
  const built = buildFallbackResourceContent(chapter, resourceType);
  return {
    title: built.title,
    summary: built.summary,
    content: built,
    resourceUrl: chapter.pdf_url || null,
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
// Body: { telegramUserId, selections: [{ chapterId, resourceTypes: ["study_guide", ...] }], geminiKey?, notebooklmBackendUrl?, simulateQuotaAfter? }
export const resourcesGenerate = safe(async (body = {}, ctx = {}) => {
  const id = quizUserId(body.telegramUserId, ctx);
  if (Number.isNaN(id)) return fail(400, "Missing or invalid Telegram user id");

  const selections = Array.isArray(body.selections) ? body.selections : [];
  if (!selections.length) return fail(400, "Select at least one chapter resource to generate.");

  // Flatten and validate requested (chapterId, resourceType) pairs
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

  // Process sequentially and persist each resource immediately so partial completions are saved if quota expires mid-run
  for (let i = 0; i < tasks.length; i++) {
    const { chapterId, resourceType } = tasks[i];
    const chapter = await getChapterForUser(id, chapterId);
    if (!chapter) continue;

    // Strict No-Regeneration Check: never regenerate an already-generated resource
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

    // Optional test hook or rate-limit check
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