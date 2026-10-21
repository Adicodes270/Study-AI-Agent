// src/quizEngine.js
// Question-count heuristic, Gemini quiz generation and grading rules. (Quiz sessions are stored in the database, see db.js.)
import crypto from "node:crypto";
import { GoogleGenAI, Type } from "@google/genai";
import { DEFAULT_CLASS_LEVEL, GEMINI_API_KEY, GEMINI_MODEL } from "./config.js";

export const MIN_QUESTIONS = 5;
export const MAX_QUESTIONS = 15;

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
// How many questions? Short/narrow chapters get 5-6, broad ones up to 15.
// There is no page count in the database, so breadth is estimated from what we do have:
// the chapter title (how many topics it names), the syllabus note, and the subject.
// ---------------------------------------------------------------------------
const HEAVY_SUBJECT = /math|physics|chemistry|science|biology|economics|accountancy|computer/i;
const LIGHT_SUBJECT = /hindi|sanskrit|english|art|drawing|music|physical education/i;

export function questionCountFor(chapter) {
  // Database columns arrive as null, which defaults in a destructuring pattern would not catch
  const title = String(chapter.title ?? "");
  const note = String(chapter.note ?? "");
  const subject = String(chapter.subject ?? "");
  let score = 7;
  // "Heredity and Evolution", "Light - Reflection and Refraction", "Sound, Light & Heat": several topics in one chapter
  const topics = title.split(/\s*(?:,|;|\/|&|\band\b|\+|\s[-–—]\s)\s*/i).filter(Boolean).length;
  score += Math.min(topics - 1, 3);
  const words = title.trim().split(/\s+/).filter(Boolean).length;
  if (words >= 7) score += 2;
  else if (words >= 4) score += 1;
  else if (words <= 2) score -= 1;
  // A long note usually lists sub-units the school wants covered
  if (note.length > 200) score += 2;
  else if (note.length > 60) score += 1;
  if (HEAVY_SUBJECT.test(subject)) score += 1;
  if (LIGHT_SUBJECT.test(subject)) score -= 2;
  return Math.max(MIN_QUESTIONS, Math.min(MAX_QUESTIONS, score));
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------
const clients = new Map();
const clientFor = (key) => {
  if (!clients.has(key)) clients.set(key, new GoogleGenAI({ apiKey: key }));
  return clients.get(key);
};

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
          options: { type: Type.ARRAY, items: { type: Type.STRING } },
          correctIndex: { type: Type.INTEGER },
          explanation: { type: Type.STRING },
        },
        required: ["subtopic", "question", "options", "correctIndex", "explanation"],
      },
    },
  },
  required: ["questions"],
};

function bookCode(pdfUrl) {
  const m = /\/([a-z]{4,5}\d)\d{2}\.pdf$/i.exec(pdfUrl || "");
  return m ? m[1] : null;
}

// Grammar / language-skill chapters (Tenses, Modals, Determiners, Letter writing...) are not NCERT textbook
// chapters, so they have no NCERT match. They are quizzed by topic at the student's class level instead.
const GRAMMAR = /grammar|tense|modal|determiner|preposition|conjunction|article|voice|narration|speech|clause|punctuation|sentence|gap.?fill|editing|omission|reordering|error|synonym|antonym|vocabulary|idiom|prefix|suffix|word formation/i;

export const isGrammarChapter = (ch) => /english|hindi|sanskrit/i.test(String(ch.subject ?? "")) && GRAMMAR.test(`${ch.title ?? ""} ${ch.note ?? ""}`);

export function buildPrompt(ch, count) {
  const cls = ch.class ?? DEFAULT_CLASS_LEVEL;
  const level = cls ? `Class ${cls}` : "school (class not known: keep it at an average middle/secondary-school level)";
  const code = bookCode(ch.pdf_url);
  const matched = ch.match_status === "matched" || Boolean(ch.pdf_url);
  const grammar = isGrammarChapter(ch);

  const head = `You are a CBSE exam-setter writing a chapter quiz for a ${level} student.

Chapter: ${ch.number != null ? `Chapter ${ch.number} — ` : ""}${ch.title}
Subject: ${ch.subject}${ch.exam ? `\nExam this is for: ${ch.exam}` : ""}${code ? `\nNCERT book code: ${code}` : ""}${ch.note ? `\nSchool syllabus note (treat as the scope boundary): ${ch.note}` : ""}
`;

  const scope = matched
    ? `Write exactly ${count} multiple-choice questions that stay inside this chapter's NCERT module and the school's scope. All questions must suit a ${level} student.`
    : grammar
      ? `This is a grammar / language-skills topic, not a textbook story or poem, so it has no NCERT chapter. Write exactly ${count} multiple-choice questions on the topic "${ch.title}" only.
- Pitch every question at ${level} CBSE English grammar: the rules, sentence length and vocabulary a ${level} student actually studies. Do not use rules or sentence patterns from a much higher or lower class.
- Use the question types CBSE sets for this topic: fill in the blank, choose the correct form, spot the error, rewrite or transform the sentence, match the usage. Give each question its own short sentence(s); do not refer to any story, poem or textbook chapter.
- Do not quiz literature content (characters, plots, poems) and do not drift into other grammar topics.`
      : `This chapter is not linked to an NCERT chapter, so rely on the title and the school note for scope. Write exactly ${count} multiple-choice questions on "${ch.title}" at the level of a ${level} student. Do not assume any particular textbook, and do not ask about topics from other chapters or other classes.`;

  return `${head}
${scope}

Difficulty: keep it easy to moderate, at the level of an average student who has read the chapter once or twice.
- About half the questions easy (one idea, answerable directly if you understood the concept), about 40% medium, and at most one or two slightly harder ones.
- Keep question stems short and in plain, simple language: one or two sentences, no long paragraphs and no trick wording.
- Avoid multi-step reasoning. Numerical questions use small, friendly numbers and a single step. Do not combine two concepts in one question.
- Distractors should be wrong in a clear way for someone who understands the concept; do not make options so close that only a very careful student could tell them apart.

The questions must still test understanding, not recall of the textbook's wording:
- Do NOT copy or lightly paraphrase sentences from the textbook. Do not ask "which of these is defined in the book as...".
- Prefer: simple real-world application, basic cause-and-effect, a short everyday scenario, comparing two ideas, or a simple one-step calculation (for maths and science), in the style of easier CBSE competency-based questions.
- Spread the questions across the chapter's different subtopics instead of repeating one idea; start with easier questions and build up gently.
- Each question has exactly 4 options. Exactly one is correct; the distractors must be plausible misconceptions, not obvious nonsense. Never use "all of the above" or "none of the above".
- "subtopic" is a short label (2-5 words) for the concept the question tests, so a student can see which concepts are weak. Reuse the same label when two questions test the same concept.
- "correctIndex" is the 0-based index of the correct option.
- "explanation" is 1-3 sentences saying why the answer is right and what the common wrong idea is.
- Be factually correct. If the chapter title is ambiguous, stick to the most standard ${level} CBSE interpretation.`;
}

/** Validate and tidy what the model returned; returns only well-formed questions. */
export function cleanQuestions(raw, count) {
  const list = Array.isArray(raw?.questions) ? raw.questions : [];
  const out = [];
  const seen = new Set();
  for (const q of list) {
    const options = Array.isArray(q?.options) ? q.options.map((o) => String(o ?? "").trim()) : [];
    const question = String(q?.question ?? "").trim();
    const idx = q?.correctIndex;
    if (!question || options.length !== 4 || options.some((o) => !o) || new Set(options).size !== 4) continue;
    if (!Number.isInteger(idx) || idx < 0 || idx > 3) continue;
    if (seen.has(question.toLowerCase())) continue;
    seen.add(question.toLowerCase());
    // Models tend to favour certain positions for the right answer, so shuffle the options.
    const order = shuffle([0, 1, 2, 3]);
    out.push({
      subtopic: String(q.subtopic ?? "").trim() || "General",
      question,
      options: order.map((i) => options[i]),
      correctIndex: order.indexOf(idx),
      explanation: String(q.explanation ?? "").trim(),
    });
  }
  return out.slice(0, count);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Ask Gemini for a quiz. apiKeys: user keys first (primary first); the server .env key is the last resort.
 * Tries each key in turn, like the syllabus parser does.
 */
export async function generateQuiz(chapter, apiKeys) {
  const keys = [...new Set([].concat(apiKeys || [], GEMINI_API_KEY).filter(Boolean))];
  if (!keys.length) {
    const e = new Error("No Gemini API key found. Save one on the setup page first.");
    e.status = 400;
    throw e;
  }
  const count = questionCountFor(chapter);
  const request = {
    model: GEMINI_MODEL,
    contents: buildPrompt(chapter, count),
    config: { responseMimeType: "application/json", responseSchema: QUIZ_SCHEMA, temperature: 0.6 },
  };
  let lastErr;
  for (const key of keys) {
    try {
      const res = await clientFor(key).models.generateContent(request);
      const questions = cleanQuestions(JSON.parse(res.text), count);
      // Accept a slightly short quiz rather than fail, but not a tiny one.
      if (questions.length < Math.min(count, MIN_QUESTIONS)) throw new Error(`Gemini returned only ${questions.length} usable questions`);
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

/** Grade answers (array of option indexes, null/-1 for skipped). */
export function grade(questions, answers) {
  let score = 0;
  const weak = new Map(); // subtopic -> { wrong, asked }
  const review = questions.map((q, i) => {
    const picked = Number.isInteger(answers[i]) && answers[i] >= 0 && answers[i] <= 3 ? answers[i] : null;
    const correct = picked === q.correctIndex;
    if (correct) score++;
    const w = weak.get(q.subtopic) || { wrong: 0, asked: 0 };
    w.asked++;
    if (!correct) w.wrong++;
    weak.set(q.subtopic, w);
    return {
      question: q.question, options: q.options, picked, correctIndex: q.correctIndex,
      correct, explanation: q.explanation, subtopic: q.subtopic,
    };
  });
  const total = questions.length;
  const percentage = total ? Math.round((score / total) * 100) : 0;
  // Weak = a subtopic where the student got at least half of its questions wrong
  const weakSubtopics = [...weak.entries()]
    .filter(([, w]) => w.wrong > 0 && w.wrong / w.asked >= 0.5)
    .sort((a, b) => b[1].wrong - a[1].wrong)
    .map(([name]) => name);
  return { score, total, percentage, weakSubtopics, review, ...revisionFor(percentage) };
}
