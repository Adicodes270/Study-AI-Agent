// src/intake/chapterIdentifier.js
//
// Takes ONLY an uploaded PDF and works out which chapter(s) of the `ncert_chapters` table it is.
// The result is always read from that table:
//   chapter number -> ncert_chapters.number
//   subject        -> ncert_chapters.subject (or .book when that holds a subject name)
//   link           -> ncert_chapters.pdf_url
// Nothing here uses syllabusParser.js, and nothing guesses a subject from a title or chapter number.
import { GoogleGenAI, Type } from "@google/genai";

import { GEMINI_API_KEY, GEMINI_MODEL } from "../config.js";
import { ncertSubjectName, pickNcertByTitle, withDb } from "../db.js";

const clients = new Map();
const client = (key) => {
  if (!clients.has(key)) clients.set(key, new GoogleGenAI({ apiKey: key }));
  return clients.get(key);
};

const MATCH_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    matches: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { ncert_id: { type: Type.INTEGER } },
        required: ["ncert_id"],
      },
    },
  },
  required: ["matches"],
};

/** "iesc102" from "Downloads/IESC102 (1).pdf", "https://ncert.nic.in/textbook/pdf/iesc102.pdf", ... */
const stem = (s) =>
  String(s || "")
    .split(/[\\/]/)
    .pop()
    .replace(/\.pdf.*$/i, "")
    .toLowerCase()
    .trim();

/** Rows of ncert_chapters that have a link. When the student's class is known and has rows, only that class is searched. */
export async function loadNcertCandidates(classLevel = null) {
  const rows = await withDb(async (db) => {
    const { rows } = await db.query(
      "SELECT id, class, book, subject, number, title, pdf_url FROM ncert_chapters WHERE pdf_url IS NOT NULL ORDER BY class, book, number"
    );
    return rows;
  });
  if (classLevel != null) {
    const same = rows.filter((r) => Number(r.class) === Number(classLevel));
    if (same.length) return { rows: same, classMatched: true };
  }
  return { rows, classMatched: false };
}

/** Upload named like the NCERT file ("iesc102.pdf"): the row whose pdf_url ends in that name. Only when exactly one row fits. */
export function matchByFileName(rows, fileName) {
  const name = stem(fileName);
  if (name.length < 4) return null;
  const hits = rows.filter((r) => stem(r.pdf_url) === name);
  if (hits.length === 1) return hits[0];
  // "iesc102 (1)", "iesc102_copy": the NCERT code with extra text around it
  const loose = rows.filter((r) => {
    const code = stem(r.pdf_url);
    return code.length >= 6 && new RegExp(`(^|[^a-z0-9])${code}([^0-9]|$)`).test(name);
  });
  return loose.length === 1 ? loose[0] : null;
}

async function askGemini(pdfBytes, rows, apiKeys) {
  const keys = [...new Set([].concat(apiKeys || [], GEMINI_API_KEY).filter(Boolean))];
  if (!keys.length) return [];

  const list = rows
    .map((r) => `${r.id} | class ${r.class} | ${ncertSubjectName(r) || r.book} | chapter ${r.number} | ${r.title}`)
    .join("\n");
  const prompt =
    `The attached PDF is a school textbook chapter (or a list of chapters) from NCERT.\n` +
    `Below are the chapters in our database, one per line as: id | class | subject | chapter number | title.\n` +
    `Return the id of every database chapter that this PDF actually is or contains. Use the title printed in the PDF ` +
    `(and its chapter number and subject) to decide. Return an empty list if none of them is a match. ` +
    `Never invent an id that is not in the list.\n\n${list}`;

  const contents = [
    { inlineData: { data: Buffer.from(pdfBytes).toString("base64"), mimeType: "application/pdf" } },
    { text: prompt },
  ];

  let lastErr;
  for (const key of keys) {
    try {
      const res = await client(key).models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: { responseMimeType: "application/json", responseSchema: MATCH_SCHEMA, temperature: 0 },
      });
      const parsed = JSON.parse(res.text);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const seen = new Set();
      const out = [];
      for (const m of parsed?.matches || []) {
        const row = byId.get(Number(m.ncert_id));
        if (row && !seen.has(row.id)) { seen.add(row.id); out.push(row); }
      }
      return out;
    } catch (e) {
      lastErr = e;
      console.log(`[identify] Gemini key ...${key.slice(-4)} failed (${e.message}); trying next`);
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

/**
 * Which ncert_chapters row(s) is this PDF?
 *   1. file name equals the NCERT file name (iesc102.pdf)        -> no AI call needed
 *   2. Gemini reads the PDF and picks from the table's own rows  -> ids are checked against the table
 *   3. last resort: the file name read as a chapter title
 * Returns { rows: [ncert_chapters rows], method: "filename" | "ai" | "title" | null, classMatched }.
 */
export async function identifyChaptersFromPdf({ pdfBytes, fileName = "", classLevel = null, apiKeys = [] } = {}) {
  const { rows: candidates, classMatched } = await loadNcertCandidates(classLevel);
  if (!candidates.length) return { rows: [], method: null, classMatched, empty: true };

  const byName = matchByFileName(candidates, fileName);
  if (byName) return { rows: [byName], method: "filename", classMatched };

  try {
    const byAi = await askGemini(pdfBytes, candidates, apiKeys);
    if (byAi.length) return { rows: byAi, method: "ai", classMatched };
  } catch (e) {
    console.log(`[identify] could not read the PDF with Gemini: ${e.message}`);
  }

  const title = String(fileName || "").replace(/\.pdf$/i, "").replace(/[_\-]+/g, " ");
  const byTitle = title ? pickNcertByTitle(candidates, title, classLevel) : null;
  if (byTitle) return { rows: [byTitle], method: "title", classMatched };

  return { rows: [], method: null, classMatched };
}

/**
 * Shape the matched rows like the object saveSyllabus() and the generation queue already expect
 * ({ class_level, exam, subjects: [{ name, chapters: [...] }] }), but with every value taken from ncert_chapters.
 */
export function syllabusFromNcertRows(rows, classLevel = null) {
  const bySubject = new Map();
  for (const r of rows) {
    const name = ncertSubjectName(r) || "General";
    if (!bySubject.has(name)) bySubject.set(name, []);
    bySubject.get(name).push({
      number: r.number,
      title: r.title,
      is_ncert: true,
      ncert_id: r.id,
      ncert_book_code: null,
      ncert_chapter_number: null,
      pdf_url: r.pdf_url,
    });
  }
  const subjects = [...bySubject.entries()].map(([name, chapters]) => ({
    name,
    chapters: chapters.sort((a, b) => a.number - b.number),
  }));
  return { class_level: classLevel ?? rows[0]?.class ?? null, exam: "", subjects };
}
