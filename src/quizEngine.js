// src/quizEngine.js
// Question-count heuristic (AI default min 10, max 50), Gemini open-ended quiz generation
// (with fresh question sets on Requiz), and book-grounded AI answer verification.
import { GoogleGenAI, Type } from "@google/genai";
import { GEMINI_API_KEY, GEMINI_MODEL } from "./config.js";

export const MIN_QUESTIONS = 10;
export const MAX_QUESTIONS = 50;

// ---------------------------------------------------------------------------
// System Prompts (Book-Grounded Generation & High-Accuracy AI Verification)
// ---------------------------------------------------------------------------
export const QUIZ_GENERATION_SYSTEM_PROMPT = `You are an authoritative NCERT and CBSE subject-matter examiner and textbook researcher.
Your task is to generate open-ended, short-answer questions (NEVER multiple-choice) where the student must type or speak their own answer.

Core Principles:
1. Ground Every Question in the Book & Factual Research:
   - Base every question strictly on the official NCERT textbook chapter (if attached or matched) and verified academic facts for the student's class level.
   - Never invent facts, out-of-syllabus formulas, or ambiguous trick questions.
2. Open-Ended Typed/Spoken Format (No MCQs):
   - Do NOT provide options (A, B, C, D).
   - Frame each question so a student can type or speak a clear, complete answer in 1 to 3 sentences, a short derivation/calculation, a definition, or a corrected sentence (for grammar).
3. Fresh Questions on Requiz:
   - When previous questions are listed in the prompt, generate a completely new set of questions exploring different examples, subtopics, formulas, or cause-and-effect relationships from the chapter.
4. Authoritative Ground-Truth Reference Key:
   - For every question, provide an exact, textbook-verified "expectedAnswer", a list of essential "keywords" / core concepts, and a clear "explanation" citing the underlying textbook principle.`;

export const QUIZ_VERIFICATION_SYSTEM_PROMPT = `You are a rigorous, highly accurate NCERT/CBSE subject examiner and fact-checker grading a student's typed or voice-transcribed quiz answers.

How You Must Verify Each Answer:
1. Think Step-by-Step & Check the Book / Subject Facts:
   - Before deciding if an answer is right or wrong, carefully verify the question against the NCERT textbook chapter (if provided), the verified reference answer, and established scientific, mathematical, historical, or grammatical truth.
   - Write out your internal textbook/fact check in "verificationReasoning".
2. High-Accuracy Grading Rules:
   - Mark "correct": true ONLY if the student's answer is factually, conceptually, and (where applicable) numerically accurate according to the textbook and subject truth.
   - Accept valid paraphrasing, synonyms, minor speech-to-text transcription quirks, or concise phrasing in the student's own words as long as the core textbook concept/fact is genuinely right.
   - Mark "correct": false if the student's answer contradicts the textbook, states a wrong formula/number/date/law, reverses cause-and-effect, is too vague to demonstrate understanding, or is blank/skipped.
3. Constructive, Book-Grounded Feedback:
   - In "feedback", clearly tell the student why their answer is right or wrong according to the textbook/research, pointing out the exact concept or detail they got right or missed.`;

// ---------------------------------------------------------------------------
// Revision tiers (thresholds from the product spec)
// ---------------------------------------------------------------------------
export function revisionFor(percentage) {
  if (percentage >= 80) {
    return { tier: "mastered", message: "Mastered — Minimal revision required (light review 7 days before exam)" };
  }
  if (percentage >= 50) {
    return { tier: "moderate_revision", message: "Moderate Revision Required — Schedule 1–2 hrs targeted practice on weak concepts tomorrow" };
  }
  return { tier: "heavy_restudy", message: "Heavy Revision Required — Re-study chapter module fundamentals before retaking" };
}

// ---------------------------------------------------------------------------
// How many questions?
// - AI chapter analysis default is ALWAYS between 10 (MIN_QUESTIONS) and 50 (MAX_QUESTIONS).
// - Users can also override with a custom count up to 50.
// ---------------------------------------------------------------------------
const HEAVY_SUBJECT = /math|physics|chemistry|science|biology|economics|accountancy|computer|history|geography/i;
const LIGHT_SUBJECT = /hindi|sanskrit|english|art|drawing|music|physical education/i;

export function questionCountFor(chapter, requestedCount = null) {
  // 1. Explicit user-requested question count (from top bar or New Quiz input, 1..50)
  if (requestedCount != null && requestedCount !== "") {
    const n = parseInt(requestedCount, 10);
    if (!Number.isNaN(n) && n >= 1) {
      return Math.max(1, Math.min(MAX_QUESTIONS, n));
    }
  }

  // 2. Saved AI-recommended or chapter-specific question count (clamped 10..50)
  if (chapter?.recommended_questions != null) {
    const rec = parseInt(chapter.recommended_questions, 10);
    if (!Number.isNaN(rec) && rec >= 1) {
      return Math.max(MIN_QUESTIONS, Math.min(MAX_QUESTIONS, rec));
    }
  }

  // 3. AI chapter analysis heuristic (minimum default is ALWAYS 10, max 50)
  const title = String(chapter?.title ?? "");
  const note = String(chapter?.note ?? "");
  const subject = String(chapter?.subject ?? "");
  let score = 12; // baseline >= 10
  const topics = title.split(/\s*(?:,|;|\/|&|\band\b|\+|\s[-–—]\s)\s*/i).filter(Boolean).length;
  score += Math.min(Math.max(0, topics - 1) * 2, 6);
  const words = title.trim().split(/\s+/).filter(Boolean).length;
  if (words >= 7) score += 3;
  else if (words >= 4) score += 2;
  if (note.length > 200) score += 4;
  else if (note.length > 60) score += 2;
  if (HEAVY_SUBJECT.test(subject)) score += 3;
  if (LIGHT_SUBJECT.test(subject)) score -= 2;
  return Math.max(MIN_QUESTIONS, Math.min(MAX_QUESTIONS, score));
}

// ---------------------------------------------------------------------------
// Gemini Client & Schemas
// ---------------------------------------------------------------------------
const clients = new Map();
const clientFor = (key) => {
  if (!clients.has(key)) clients.set(key, new GoogleGenAI({ apiKey: key }));
  return clients.get(key);
};

// Cache fetched NCERT PDFs in memory briefly so generating + grading a chapter doesn't re-download
const pdfCache = new Map(); // pdfUrl -> { base64, at }
async function fetchChapterPdfPart(pdfUrl) {
  if (!pdfUrl || !/^https?:\/\//i.test(pdfUrl)) return null;
  const cached = pdfCache.get(pdfUrl);
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) {
    return { inlineData: { data: cached.base64, mimeType: "application/pdf" } };
  }
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    const res = await fetch(pdfUrl, { signal: ctl.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100 || buf.length > 18 * 1024 * 1024) return null;
    if (buf.slice(0, 4).toString("utf8") !== "%PDF") return null;
    const base64 = buf.toString("base64");
    if (pdfCache.size > 20) pdfCache.clear();
    pdfCache.set(pdfUrl, { base64, at: Date.now() });
    return { inlineData: { data: base64, mimeType: "application/pdf" } };
  } catch {
    return null;
  }
}

const QUIZ_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          subtopic: { type: Type.STRING },
          question: { type: Type.STRING },
          expectedAnswer: { type: Type.STRING },
          keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
          explanation: { type: Type.STRING },
        },
        required: ["subtopic", "question", "expectedAnswer", "keywords", "explanation"],
      },
    },
  },
  required: ["questions"],
};

const GRADING_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    evaluations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          index: { type: Type.INTEGER },
          verificationReasoning: { type: Type.STRING },
          correct: { type: Type.BOOLEAN },
          feedback: { type: Type.STRING },
        },
        required: ["index", "verificationReasoning", "correct", "feedback"],
      },
    },
  },
  required: ["evaluations"],
};

function bookCode(pdfUrl) {
  const m = /\/([a-z]{4,5}\d)\d{2}\.pdf$/i.exec(pdfUrl || "");
  return m ? m[1] : null;
}

const GRAMMAR = /grammar|tense|modal|determiner|preposition|conjunction|article|voice|narration|speech|clause|punctuation|sentence|gap.?fill|editing|omission|reordering|error|synonym|antonym|vocabulary|idiom|prefix|suffix|word formation/i;

export const isGrammarChapter = (ch) => /english|hindi|sanskrit/i.test(String(ch.subject ?? "")) && GRAMMAR.test(`${ch.title ?? ""} ${ch.note ?? ""}`);

export function buildPrompt(ch, count, options = {}) {
  const cls = ch.class ?? null;
  const level = cls ? `Class ${cls}` : "school (class not known: keep it at an average middle/secondary-school level)";
  const code = bookCode(ch.pdf_url);
  const matched = ch.match_status === "matched" || Boolean(ch.pdf_url);
  const grammar = isGrammarChapter(ch);
  const previousQuestions = Array.isArray(options.previousQuestions)
    ? options.previousQuestions.filter(Boolean)
    : [];
  const attemptNumber = Number(options.attemptNumber) || (previousQuestions.length ? 2 : 1);

  const head = `You are a CBSE exam-setter writing an open-ended, typed/spoken-answer chapter quiz for a ${level} student.

Chapter: ${ch.number != null ? `Chapter ${ch.number} — ` : ""}${ch.title}
Subject: ${ch.subject}${ch.exam ? `\nExam this is for: ${ch.exam}` : ""}${code ? `\nNCERT book code: ${code}` : ""}${ch.pdf_url ? `\nNCERT book PDF URL: ${ch.pdf_url}` : ""}${ch.note ? `\nSchool syllabus note (treat as the scope boundary): ${ch.note}` : ""}
`;

  const scope = matched
    ? `Write exactly ${count} open-ended short-answer questions (NO multiple-choice options) grounded strictly in this chapter's NCERT textbook module and the school's scope. All questions must suit a ${level} student.`
    : grammar
      ? `This is a grammar / language-skills topic, not a textbook story or poem. Write exactly ${count} open-ended typed-response questions on the topic "${ch.title}" only.
- Pitch every question at ${level} CBSE grammar: the rules, sentence length and vocabulary a ${level} student actually studies.
- Ask the student to type the corrected sentence, fill in the blank with the right word/form, or transform/rewrite the given sentence.`
      : `This chapter is not linked to an NCERT chapter, so rely on the title and the school note for scope. Write exactly ${count} open-ended short-answer questions on "${ch.title}" at the level of a ${level} student.`;

  const requizBlock = previousQuestions.length
    ? `\nIMPORTANT — REQUIZ / RETAKE MODE (Attempt #${attemptNumber}, Variation Seed ${Date.now() % 10000}):
The student is retaking this chapter's quiz to practice more!
You MUST generate a FRESH, DIFFERENT set of ${count} questions that test new angles, different examples, other subtopics, numerical values, or deeper applications from the chapter.
Avoid repeating these questions from their previous attempt:
${previousQuestions.slice(0, 35).map((q, idx) => `${idx + 1}. ${q}`).join("\n")}\n`
    : "";

  return `${head}
${scope}
${requizBlock}
Format & Difficulty Rules (Typed / Voice-Spoken Answers — NOT Multiple Choice):
- Generate EXACTLY ${count} questions.
- The student will TYPE or SPEAK their answer in a text input box. Do NOT generate multiple-choice options (A/B/C/D).
- Keep question stems clear, direct, and answerable in 1 to 3 concise sentences, a key term/formula, or a single-step calculation.
- About half the questions easy (direct concept explanation or definition in own words), about 40% medium (cause-and-effect, everyday scenario application, or simple 1-step calculation), and at most 10% slightly harder ones.
- Spread the questions across all of the chapter's subtopics instead of repeating one idea; start with easier questions and build up gently.
- "subtopic": a short label (2-5 words) for the concept the question tests, so a student can see which concepts are weak.
- "expectedAnswer": the accurate, textbook-verified model answer (1-3 sentences) against which the student's answer will be checked.
- "keywords": 2 to 5 essential textbook terms, facts, or values that a correct response should include.
- "explanation": 1-3 sentences citing the textbook concept and explaining why the answer is right and what the common misconception is.`;
}

/** Validate and tidy what the model returned; returns only well-formed typed questions. */
export function cleanQuestions(raw, count) {
  const list = Array.isArray(raw?.questions) ? raw.questions : [];
  const out = [];
  const seen = new Set();
  for (const q of list) {
    const question = String(q?.question ?? "").trim();
    const expectedAnswer = String(q?.expectedAnswer ?? "").trim();
    if (!question || !expectedAnswer) continue;
    if (seen.has(question.toLowerCase())) continue;
    seen.add(question.toLowerCase());
    const keywords = Array.isArray(q?.keywords)
      ? q.keywords.map((k) => String(k ?? "").trim()).filter(Boolean)
      : [];
    out.push({
      subtopic: String(q.subtopic ?? "").trim() || "General",
      question,
      expectedAnswer,
      keywords,
      explanation: String(q.explanation ?? "").trim() || expectedAnswer,
    });
  }
  return out.slice(0, count);
}

/**
 * Ask Gemini for a typed/spoken-answer quiz grounded in the chapter (and its NCERT PDF if available).
 * Supports custom questionCount (1..50) and Requiz variation (previousQuestions).
 */
export async function generateQuiz(chapter, apiKeys, options = {}) {
  const keys = [...new Set([].concat(apiKeys || [], GEMINI_API_KEY).filter(Boolean))];
  if (!keys.length) {
    const e = new Error("No Gemini API key found. Save one on the setup page first.");
    e.status = 400;
    throw e;
  }
  const count = questionCountFor(chapter, options.questionCount);
  const promptText = buildPrompt(chapter, count, options);
  const pdfPart = await fetchChapterPdfPart(chapter.pdf_url);
  const contents = pdfPart ? [pdfPart, { text: promptText }] : promptText;

  const isRequiz = Array.isArray(options.previousQuestions) && options.previousQuestions.length > 0;
  const request = {
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction: QUIZ_GENERATION_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: QUIZ_SCHEMA,
      temperature: isRequiz ? 0.65 : 0.45,
    },
  };
  let lastErr;
  for (const key of keys) {
    try {
      const res = await clientFor(key).models.generateContent(request);
      const questions = cleanQuestions(JSON.parse(res.text), count);
      const minRequired = Math.min(count, 5);
      if (questions.length < minRequired) {
        throw new Error(`Gemini returned only ${questions.length} usable questions`);
      }
      return { questions, requested: count };
    } catch (e) {
      lastErr = e;
      console.log(`Quiz: Gemini key ...${key.slice(-4)} failed (${e.message}); trying next`);
    }
  }
  const err = new Error(`Could not generate the quiz: ${lastErr?.message || "unknown error"}`);
  err.status = 502;
  throw err;
}

// ---------------------------------------------------------------------------
// Deterministic Keyword & Concept Fallback Grader (used only if AI call fails)
// ---------------------------------------------------------------------------
function normalizeTokens(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/^(the|and|for|are|but|not|you|all|any|can|had|her|was|one|our|out|who|get|has|him|his|how|man|new|now|old|see|two|way|its|let|put|say|she|too|use|that|with|this|from|have|they|will|what|when|make|like|time|just|know|take|into|year|your|good|some|them|than|then|look|only|come|over|also|back|after|work|first|well|even|want|because|these|give|most)$/.test(w));
}

function fallbackGradeSingle(q, userAnswerRaw) {
  const ans = String(userAnswerRaw ?? "").trim();
  if (!ans) {
    return { correct: false, feedback: "No answer was provided for this question." };
  }
  const ansLower = ans.toLowerCase();
  const expectedLower = String(q.expectedAnswer || "").toLowerCase();
  if (ansLower === expectedLower) {
    return { correct: true, feedback: "Correct! Your answer matches the textbook explanation." };
  }
  const keywords = Array.isArray(q.keywords) && q.keywords.length
    ? q.keywords.map((k) => k.toLowerCase())
    : normalizeTokens(q.expectedAnswer);

  if (!keywords.length) {
    const ok = ans.length >= 12;
    return {
      correct: ok,
      feedback: ok ? "Correct response." : "Your response was too brief to cover the required concept.",
    };
  }

  let matchedCount = 0;
  for (const kw of keywords) {
    if (ansLower.includes(kw)) {
      matchedCount++;
    } else {
      const kwTokens = normalizeTokens(kw);
      if (kwTokens.length > 0 && kwTokens.every((t) => ansLower.includes(t))) {
        matchedCount++;
      }
    }
  }
  const isCorrect = matchedCount / keywords.length >= 0.5;
  return {
    correct: isCorrect,
    feedback: isCorrect
      ? "Correct! Your answer covers the key concepts from the chapter."
      : `Incorrect — your answer missed key textbook concepts (${(q.keywords || []).slice(0, 3).join(", ")}).`,
  };
}

/**
 * Grade user-typed or voice-spoken answers (array of strings) by having the AI think, check the book
 * (attaching the NCERT PDF if available) and research/verify each answer with high accuracy.
 */
export async function grade(questions, answers, apiKeys = [], chapter = null) {
  const normalizedAnswers = questions.map((_, i) =>
    typeof answers?.[i] === "string" ? answers[i].trim() : ""
  );

  let aiEvaluations = null;
  const keys = [...new Set([].concat(apiKeys || [], GEMINI_API_KEY).filter(Boolean))];

  if (keys.length && normalizedAnswers.some((a) => a.length > 0)) {
    const cls = chapter?.class ?? null;
    const level = cls ? `Class ${cls}` : "CBSE Secondary School";
    const itemsToVerify = questions.map((q, index) => ({
      index,
      subtopic: q.subtopic,
      question: q.question,
      textbookExpectedAnswer: q.expectedAnswer,
      textbookKeyConcepts: q.keywords || [],
      textbookExplanation: q.explanation || "",
      studentTypedAnswer: normalizedAnswers[index] || "(Skipped / left blank)",
    }));

    const verificationPrompt = `Verify and grade the student's answers for the following ${level} quiz.

Chapter: ${chapter?.number != null ? `Chapter ${chapter.number} — ` : ""}${chapter?.title || "Study Chapter"}
Subject: ${chapter?.subject || "General"}${chapter?.exam ? ` (${chapter.exam})` : ""}
${chapter?.pdf_url ? `NCERT Textbook PDF Source: ${chapter.pdf_url}` : ""}
${chapter?.note ? `Syllabus Scope / Notes: ${chapter.note}` : ""}

Instructions:
1. For each question (by "index"), think carefully and cross-check the student's answer ("studentTypedAnswer") against the textbook chapter, "textbookExpectedAnswer", "textbookKeyConcepts", and verified subject knowledge.
2. In "verificationReasoning", briefly state what the textbook/subject facts require and whether the student's statement satisfies or contradicts it.
3. Set "correct": true ONLY if the student's answer is genuinely accurate (allowing natural phrasing or spoken dictation in their own words). Set "correct": false if it is wrong, contradicts the book, misses the core point, or is blank.
4. In "feedback", write 1-2 clear sentences telling the student why their answer is right or wrong according to the textbook.

Questions & Student Answers to Verify:
${JSON.stringify(itemsToVerify, null, 2)}`;

    const pdfPart = chapter?.pdf_url ? await fetchChapterPdfPart(chapter.pdf_url) : null;
    const contents = pdfPart ? [pdfPart, { text: verificationPrompt }] : verificationPrompt;

    for (const key of keys) {
      try {
        const res = await clientFor(key).models.generateContent({
          model: GEMINI_MODEL,
          contents,
          config: {
            systemInstruction: QUIZ_VERIFICATION_SYSTEM_PROMPT,
            responseMimeType: "application/json",
            responseSchema: GRADING_SCHEMA,
            temperature: 0.1,
          },
        });
        const parsed = JSON.parse(res.text);
        if (Array.isArray(parsed?.evaluations)) {
          aiEvaluations = new Map(parsed.evaluations.map((ev) => [ev.index, ev]));
          break;
        }
      } catch (e) {
        console.log(`Quiz AI verification fallback on key ...${key.slice(-4)}: ${e.message}`);
      }
    }
  }

  let score = 0;
  const weak = new Map(); // subtopic -> { wrong, asked }
  const review = questions.map((q, i) => {
    const userAnswer = normalizedAnswers[i];
    const aiEv = aiEvaluations?.get(i);
    const fbEv = fallbackGradeSingle(q, userAnswer);
    const correct = userAnswer ? Boolean(aiEv ? aiEv.correct : fbEv.correct) : false;
    const feedback = userAnswer
      ? String(aiEv?.feedback || fbEv.feedback)
      : "Skipped — no answer was provided.";

    if (correct) score++;
    const w = weak.get(q.subtopic) || { wrong: 0, asked: 0 };
    w.asked++;
    if (!correct) w.wrong++;
    weak.set(q.subtopic, w);

    return {
      question: q.question,
      subtopic: q.subtopic,
      userAnswer: userAnswer || null,
      expectedAnswer: q.expectedAnswer,
      correct,
      feedback,
      explanation: q.explanation,
    };
  });

  const total = questions.length;
  const percentage = total ? Math.round((score / total) * 100) : 0;
  const weakSubtopics = [...weak.entries()]
    .filter(([, w]) => w.wrong > 0 && w.wrong / w.asked >= 0.5)
    .sort((a, b) => b[1].wrong - a[1].wrong)
    .map(([name]) => name);

  return { score, total, percentage, weakSubtopics, review, ...revisionFor(percentage) };
}