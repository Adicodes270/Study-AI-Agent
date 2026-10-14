import { GoogleGenAI, Type } from "@google/genai";

import { GEMINI_API_KEY, GEMINI_MODEL } from "../config.js";
import { Syllabus } from "./models.js";

const client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const PROMPT = `Extract the school syllabus from the document.

Rules:
- Include EVERY subject that appears. Common ones are English, Hindi, Sanskrit,
  Mathematics, Physics, Chemistry, Biology, Social Science and Artificial
  Intelligence, but this list is only examples. Never skip a subject.
- For each subject, list the actual study units in order: textbook chapters,
  lessons, poems, units or topics.
- Headings like "Section A: Reading" or "Section B: Writing" are NOT chapters.
  List the lessons and topics under them. If a section only names skills
  (for example notice writing or letter writing), list those skills as topics.
- Use standard English subject names.
- Set exam to exactly one of: Term Test 1, Term Test 2, Half Yearly, Annual,
  Pre-Board. TT1 means Term Test 1 and TT2 means Term Test 2. Leave exam empty
  if the document does not say.
- Do not invent chapters that are not in the document.
- If the document is not a syllabus, return an empty subjects list.
`;

// JSON schema handed to Gemini (mirrors the Syllabus model)
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    class_level: { type: Type.INTEGER, nullable: true },
    exam: { type: Type.STRING, nullable: true },
    subjects: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          chapters: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                number: { type: Type.INTEGER },
                title: { type: Type.STRING },
              },
              required: ["number", "title"],
            },
          },
        },
        required: ["name", "chapters"],
      },
    },
  },
  required: ["subjects"],
};

async function ask(contents) {
  const response = await client.models.generateContent({
    model: GEMINI_MODEL,
    contents,
    config: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  let parsed = null;
  try {
    const result = Syllabus.safeParse(JSON.parse(response.text));
    if (result.success) parsed = result.data;
  } catch {
    // fall through to the error below
  }
  if (parsed === null) {
    throw new Error("Could not read the syllabus.");
  }
  return parsed;
}

export function parseSyllabus(rawText) {
  return ask(`${PROMPT}\nDOCUMENT:\n${rawText}`);
}

export function parseSyllabusPdf(pdfBytes) {
  const pdf = {
    inlineData: {
      data: Buffer.from(pdfBytes).toString("base64"),
      mimeType: "application/pdf",
    },
  };
  return ask([pdf, { text: PROMPT }]);
}
