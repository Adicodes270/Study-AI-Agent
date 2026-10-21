// src/intake/syllabusParser.js
import { GoogleGenAI, Type } from "@google/genai";

import { DEFAULT_CLASS_LEVEL, GEMINI_API_KEY, GEMINI_MODEL } from "../config.js";
import { Syllabus } from "./models.js";

const clients = new Map();
/** One Gemini client per API key (each Telegram user brings their own). */
function getClient(key) {
  if (!clients.has(key)) clients.set(key, new GoogleGenAI({ apiKey: key }));
  return clients.get(key);
}

/** apiKeys: a key or a list (primary first). Tries the next key if one fails. */
async function generate(apiKeys, request) {
  const keys = [].concat(apiKeys || [], GEMINI_API_KEY).filter(Boolean);
  if (!keys.length) {
    throw new Error("No Gemini API key set. Save one on the setup page or send /setkey YOUR_KEY to the bot.");
  }
  let lastErr;
  for (const key of keys) {
    try {
      return await getClient(key).models.generateContent(request);
    } catch (e) {
      lastErr = e;
      console.log(`Gemini key ...${key.slice(-4)} failed (${e.message}); trying next`);
    }
  }
  throw lastErr;
}

// Lookup table for official NCERT book codes (e.g. iesc101.pdf, jesc102.pdf)
const NCERT_BOOKS_CATALOG = {
  iesc1: {
    class_level: 9,
    subject: "Science",
    chapters: {
      1: "Matter in Our Surroundings",
      2: "Is Matter Around Us Pure?",
      3: "Atoms and Molecules",
      4: "Structure of the Atom",
      5: "The Fundamental Unit of Life",
      6: "Tissues",
      7: "Motion",
      8: "Force and Laws of Motion",
      9: "Gravitation",
      10: "Work and Energy",
      11: "Sound",
      12: "Improvement in Food Resources",
    },
  },
  iemh1: {
    class_level: 9,
    subject: "Mathematics",
    chapters: {
      1: "Number Systems",
      2: "Polynomials",
      3: "Coordinate Geometry",
      4: "Linear Equations in Two Variables",
      5: "Introduction to Euclid's Geometry",
      6: "Lines and Angles",
      7: "Triangles",
      8: "Quadrilaterals",
      9: "Circles",
      10: "Heron's Formula",
      11: "Surface Areas and Volumes",
      12: "Statistics",
    },
  },
  iess1: {
    class_level: 9,
    subject: "Geography",
    chapters: {
      1: "India - Size and Location",
      2: "Physical Features of India",
      3: "Drainage",
      4: "Climate",
      5: "Natural Vegetation and Wildlife",
      6: "Population",
    },
  },
  iess2: {
    class_level: 9,
    subject: "Economics",
    chapters: {
      1: "The Story of Village Palampur",
      2: "People as Resource",
      3: "Poverty as a Challenge",
      4: "Food Security in India",
    },
  },
  iess3: {
    class_level: 9,
    subject: "History",
    chapters: {
      1: "The French Revolution",
      2: "Socialism in Europe and the Russian Revolution",
      3: "Nazism and the Rise of Hitler",
      4: "Forest Society and Colonialism",
      5: "Pastoralists in the Modern World",
    },
  },
  iess4: {
    class_level: 9,
    subject: "Civics",
    chapters: {
      1: "What is Democracy? Why Democracy?",
      2: "Constitutional Design",
      3: "Electoral Politics",
      4: "Working of Institutions",
      5: "Democratic Rights",
    },
  },
  iebe1: {
    class_level: 9,
    subject: "English",
    chapters: {
      1: "The Fun They Had",
      2: "The Sound of Music",
      3: "The Little Girl",
      4: "A Truly Beautiful Mind",
      5: "The Snake and the Mirror",
      6: "My Childhood",
      7: "Reach for the Top",
      8: "Kathmandu",
      9: "If I Were You",
    },
  },
  iemo1: {
    class_level: 9,
    subject: "English",
    chapters: {
      1: "The Lost Child",
      2: "The Adventures of Toto",
      3: "Iswaran the Storyteller",
      4: "In the Kingdom of Fools",
      5: "The Happy Prince",
      6: "Weathering the Storm in Ersama",
      7: "The Last Leaf",
      8: "A House Is Not a Home",
      9: "The Beggar",
    },
  },
  jesc1: {
    class_level: 10,
    subject: "Science",
    chapters: {
      1: "Chemical Reactions and Equations",
      2: "Acids, Bases and Salts",
      3: "Metals and Non-metals",
      4: "Carbon and its Compounds",
      5: "Life Processes",
      6: "Control and Coordination",
      7: "How do Organisms Reproduce?",
      8: "Heredity",
      9: "Light - Reflection and Refraction",
      10: "The Human Eye and the Colourful World",
      11: "Electricity",
      12: "Magnetic Effects of Electric Current",
      13: "Our Environment",
    },
  },
  jemh1: {
    class_level: 10,
    subject: "Mathematics",
    chapters: {
      1: "Real Numbers",
      2: "Polynomials",
      3: "Pair of Linear Equations in Two Variables",
      4: "Quadratic Equations",
      5: "Arithmetic Progressions",
      6: "Triangles",
      7: "Coordinate Geometry",
      8: "Introduction to Trigonometry",
      9: "Some Applications of Trigonometry",
      10: "Circles",
      11: "Areas Related to Circles",
      12: "Surface Areas and Volumes",
      13: "Statistics",
      14: "Probability",
    },
  },
  jess1: {
    class_level: 10,
    subject: "Geography",
    chapters: {
      1: "Resources and Development",
      2: "Forest and Wildlife Resources",
      3: "Water Resources",
      4: "Agriculture",
      5: "Minerals and Energy Resources",
      6: "Manufacturing Industries",
      7: "Lifelines of National Economy",
    },
  },
  jess2: {
    class_level: 10,
    subject: "Economics",
    chapters: {
      1: "Development",
      2: "Sectors of the Indian Economy",
      3: "Money and Credit",
      4: "Globalisation and the Indian Economy",
      5: "Consumer Rights",
    },
  },
  jess3: {
    class_level: 10,
    subject: "History",
    chapters: {
      1: "The Rise of Nationalism in Europe",
      2: "Nationalism in India",
      3: "The Making of a Global World",
      4: "The Age of Industrialisation",
      5: "Print Culture and the Modern World",
    },
  },
  jess4: {
    class_level: 10,
    subject: "Civics",
    chapters: {
      1: "Power-sharing",
      2: "Federalism",
      3: "Gender, Religion and Caste",
      4: "Political Parties",
      5: "Outcomes of Democracy",
    },
  },
};

/**
 * If the uploaded file name matches an NCERT chapter code (e.g. "iesc101.pdf" or "jesc105.pdf"),
 * return a ready-made Syllabus object immediately.
 */
export function inferNcertFromFilename(fileName) {
  const m = /(?:^|[^a-z0-9])([a-z]{4}\d)(\d{2})(?:[^0-9]|$)/i.exec(String(fileName || ""));
  if (!m) return null;
  const bookCode = m[1].toLowerCase();
  const chNum = parseInt(m[2], 10);
  if (!chNum || chNum < 1 || chNum > 30) return null;
  const padded = String(chNum).padStart(2, "0");
  const pdfUrl = `https://ncert.nic.in/textbook/pdf/${bookCode}${padded}.pdf`;
  const entry = NCERT_BOOKS_CATALOG[bookCode];
  if (entry) {
    const title = entry.chapters[chNum] || `Chapter ${chNum}`;
    return {
      class_level: entry.class_level,
      exam: null,
      subjects: [
        {
          name: entry.subject,
          chapters: [
            {
              number: chNum,
              title,
              is_ncert: true,
              ncert_book_code: bookCode,
              ncert_chapter_number: chNum,
              pdf_url: pdfUrl,
            },
          ],
        },
      ],
    };
  }
  return null;
}

const CLASS_9_AND_10_NCERT_REFERENCE = `
Complete Class 9 NCERT Books & Chapters Reference:
- Science ("iesc1"):
  1: Matter in Our Surroundings | 2: Is Matter Around Us Pure? | 3: Atoms and Molecules | 4: Structure of the Atom | 5: The Fundamental Unit of Life | 6: Tissues | 7: Motion | 8: Force and Laws of Motion | 9: Gravitation | 10: Work and Energy | 11: Sound | 12: Improvement in Food Resources
  (Note: Older editions also had Diversity in Living Organisms, Why Do We Fall Ill, Natural Resources)
- Mathematics ("iemh1"):
  1: Number Systems | 2: Polynomials | 3: Coordinate Geometry | 4: Linear Equations in Two Variables | 5: Introduction to Euclid's Geometry | 6: Lines and Angles | 7: Triangles | 8: Quadrilaterals | 9: Circles | 10: Heron's Formula | 11: Surface Areas and Volumes | 12: Statistics
- Social Science - Geography: Contemporary India-I ("iess1"):
  1: India - Size and Location | 2: Physical Features of India (covers Theory of Plate Tectonics, Tectonic Plates, Himalayas, Northern Plains, Peninsular Plateau, Indian Desert, Coastal Plains, Islands) | 3: Drainage | 4: Climate | 5: Natural Vegetation and Wildlife | 6: Population
- Social Science - Economics ("iess2"):
  1: The Story of Village Palampur (Introductory Economics concepts / Factors of Production) | 2: People as Resource | 3: Poverty as a Challenge | 4: Food Security in India
- Social Science - History: India and the Contemporary World-I ("iess3"):
  1: The French Revolution | 2: Socialism in Europe and the Russian Revolution | 3: Nazism and the Rise of Hitler | 4: Forest Society and Colonialism | 5: Pastoralists in the Modern World
- Social Science - Civics / Political Science: Democratic Politics-I ("iess4"):
  1: What is Democracy? Why Democracy? (Introductory Political Science / Democracy concepts) | 2: Constitutional Design | 3: Electoral Politics | 4: Working of Institutions | 5: Democratic Rights
- English - Beehive ("iebe1"):
  1: The Fun They Had / The Road Not Taken | 2: The Sound of Music / Wind | 3: The Little Girl / Rain on the Roof | 4: A Truly Beautiful Mind / The Lake Isle of Innisfree | 5: The Snake and the Mirror / A Legend of the Northland | 6: My Childhood / No Men Are Foreign | 7: Reach for the Top / On Killing a Tree | 8: Kathmandu / A Slumber Did My Spirit Seal | 9: If I Were You
- English - Moments ("iemo1"):
  1: The Lost Child | 2: The Adventures of Toto | 3: Iswaran the Storyteller | 4: In the Kingdom of Fools | 5: The Happy Prince | 6: Weathering the Storm in Ersama | 7: The Last Leaf | 8: A House Is Not a Home | 9: The Beggar
- Hindi - Kshitij Part 1 ("ihks1"):
  1: Do Bailon Ki Katha | 2: Lhasa Ki Aur | 3: Upbhoktavad Ki Sanskriti | 4: Sanwale Sapnon Ki Yaad | 5: Premchand Ke Phate Joote | 6: Mere Bachpan Ke Din | 7: Sakhiyan Evam Sabad (Kabir) | 8: Vaakh (Lalladyad) | 9: Savaiye (Raskhan) | 10: Kaidi Aur Kokila | 11: Gram Shree | 12: Megh Aaye | 13: Bachche Kaam Par Ja Rahe Hain
- Hindi - Kritika Part 1 ("ihkr1"):
  1: Is Jal Pralay Mein | 2: Mere Sang Ki Auratein | 3: Reedh Ki Haddi
- Hindi - Sparsh Part 1 ("ihsp1"):
  1: Dukh Ka Adhikar | 2: Everest: Meri Shikhar Yatra | 3: Tum Kab Jaoge, Atithi | 4: Vaigyanik Chetna Ke Vahak | 5: Shukratare Ke Saman | 6: Pad (Raidas) | 7: Dohe (Rahim) | 8: Geet-Ageet | 9: Agnipath | 10: Naye Ilake Mein / Khushboo Rachte Hain Haath
- Hindi - Sanchayan Part 1 ("ihsa1"):
  1: Gillu | 2: Smriti | 3: Kallu Kumhar Ki Unakoti | 4: Mera Chota Sa Niji Pustakalay
- Sanskrit - Shemushi Part 1 ("issh1"):
  1: Bharativasantgeetih | 2: Swarnakakah | 3: Godohanam | 4: Suktimauktikam | 5: Bhranto Balah | 6: Pratyabhigyanam | 7: Lauhatula | 8: SiktaSetuh | 9: Jatayoh Shauryam | 10: Paryavaranam | 11: Vangmanah PranSwarupam

Complete Class 10 NCERT Books & Chapters Reference:
- Science ("jesc1"): 1: Chemical Reactions and Equations | 2: Acids, Bases and Salts | 3: Metals and Non-metals | 4: Carbon and its Compounds | 5: Life Processes | 6: Control and Coordination | 7: How do Organisms Reproduce? | 8: Heredity | 9: Light - Reflection and Refraction | 10: The Human Eye and the Colourful World | 11: Electricity | 12: Magnetic Effects of Electric Current | 13: Our Environment
- Mathematics ("jemh1"): 1: Real Numbers | 2: Polynomials | 3: Pair of Linear Equations in Two Variables | 4: Quadratic Equations | 5: Arithmetic Progressions | 6: Triangles | 7: Coordinate Geometry | 8: Introduction to Trigonometry | 9: Some Applications of Trigonometry | 10: Circles | 11: Areas Related to Circles | 12: Surface Areas and Volumes | 13: Statistics | 14: Probability
- Geography ("jess1"): 1: Resources and Development | 2: Forest and Wildlife Resources | 3: Water Resources | 4: Agriculture | 5: Minerals and Energy Resources | 6: Manufacturing Industries | 7: Lifelines of National Economy
- Economics ("jess2"): 1: Development | 2: Sectors of the Indian Economy | 3: Money and Credit | 4: Globalisation and the Indian Economy | 5: Consumer Rights
- History ("jess3"): 1: The Rise of Nationalism in Europe | 2: Nationalism in India | 3: The Making of a Global World | 4: The Age of Industrialisation | 5: Print Culture and the Modern World
- Civics ("jess4"): 1: Power-sharing | 2: Federalism | 3: Gender, Religion and Caste | 4: Political Parties | 5: Outcomes of Democracy
- English First Flight ("jeff1") & Footprints Without Feet ("jefp1"), Hindi Kshitij-2 ("jhks1"), Kritika-2 ("jhkr1"), Sparsh-2 ("jhsp1"), Sanchayan-2 ("jhsa1"), Sanskrit Shemushi-2 ("jssh1").
`;

const PROMPT = `Extract the subjects and chapters from the provided document and classify each unit for NCERT textbook linking.
The document may be EITHER:
(A) A school syllabus / portion sheet listing multiple subjects and chapters, OR
(B) An actual NCERT textbook chapter PDF, textbook unit, study notes PDF, or worksheet for a single chapter/topic!

${DEFAULT_CLASS_LEVEL ? `Note: If the document does not mention the class/grade level, assume Class ${DEFAULT_CLASS_LEVEL}.` : ""}

${CLASS_9_AND_10_NCERT_REFERENCE}

Rules:
- CRITICAL — IF THE DOCUMENT IS AN NCERT CHAPTER PDF OR SINGLE-CHAPTER STUDY DOCUMENT:
  1. NEVER return an empty subjects list!
  2. Identify the Subject (e.g. Science, Mathematics, Social Science, History, Geography, Civics, Economics, Physics, Chemistry, Biology, English, Hindi, Sanskrit) from the chapter's content, headings, and topics.
  3. Extract the Chapter number and Chapter title from the PDF/text (and if it matches an NCERT chapter from the reference list above, use the exact NCERT chapter title, book code, chapter number, and pdf_url).
  4. Return a 1-element "subjects" array containing that subject and its chapter(s).
- IF THE DOCUMENT IS A SCHOOL SYLLABUS / PORTION SHEET:
  1. Include EVERY subject that appears (English, Hindi, Sanskrit, Mathematics, Physics, Chemistry, Biology, Science, Social Science, Artificial Intelligence, etc.). Never skip a subject.
  2. For each subject, list the actual study units in order: textbook chapters, lessons, poems, units or topics.
  3. Headings like "Section A: Reading" or "Section B: Writing" are NOT chapters. List the lessons and topics under them.
- Use standard English subject names.
- Set exam to one of: Term Test 1, Term Test 2, Half Yearly, Annual, Pre-Board (or leave exam as null/empty if not mentioned).
- Semantic & Fuzzy NCERT Chapter Matching (CRITICAL):
  1. Syllabus documents or chapter PDFs may use shortened, paraphrased, or sub-topic names (for example, "Tectonic Plates" -> Class 9 Geography Chapter 2 "Physical Features of India").
  2. EXCEPTION FOR ENGLISH, HINDI, AND SANSKRIT GRAMMAR/WRITING/READING:
     All Grammar (Vyakaran), Writing Skills, and Reading Comprehension are NOT in NCERT textbooks ("is_ncert": false, fields null).
  3. When a chapter or PDF matches an NCERT textbook chapter ("is_ncert": true), you MUST provide:
     - "ncert_book_code": the 5-character NCERT textbook code in lowercase (e.g. "iesc1", "jemh1", "iess1", "iess3", "iess4").
     - "ncert_chapter_number": the 1-based chapter number in that NCERT book.
     - "pdf_url": "https://ncert.nic.in/textbook/pdf/<ncert_book_code><2_digit_padded_ncert_chapter_number>.pdf"
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
                is_ncert: { type: Type.BOOLEAN },
                ncert_book_code: { type: Type.STRING, nullable: true },
                ncert_chapter_number: { type: Type.INTEGER, nullable: true },
                pdf_url: { type: Type.STRING, nullable: true },
              },
              required: [
                "number",
                "title",
                "is_ncert",
                "ncert_book_code",
                "ncert_chapter_number",
                "pdf_url",
              ],
            },
          },
        },
        required: ["name", "chapters"],
      },
    },
  },
  required: ["subjects"],
};

const UNMATCHED_RESOLVER_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      idx: { type: Type.INTEGER },
      is_ncert: { type: Type.BOOLEAN },
      ncert_book_code: { type: Type.STRING, nullable: true },
      ncert_chapter_number: { type: Type.INTEGER, nullable: true },
      pdf_url: { type: Type.STRING, nullable: true },
    },
    required: [
      "idx",
      "is_ncert",
      "ncert_book_code",
      "ncert_chapter_number",
      "pdf_url",
    ],
  },
};

/**
 * Second-pass AI resolver: takes any unmatched chapters from the initial parse
 * and asks Gemini to figure out if they correspond to an existing NCERT chapter.
 */
async function resolveUnmatchedChapters(syllabus, apiKey) {
  const classLevel = syllabus.class_level || DEFAULT_CLASS_LEVEL || 9;
  const unmatchedRefs = [];

  for (const subject of syllabus.subjects) {
    for (const ch of subject.chapters) {
      if (!ch.is_ncert || !ch.ncert_book_code || !ch.ncert_chapter_number) {
        unmatchedRefs.push({
          idx: unmatchedRefs.length,
          subject: subject.name,
          number: ch.number,
          title: ch.title,
          ref: ch,
        });
      }
    }
  }

  if (!unmatchedRefs.length) return syllabus;

  const payloadForAi = unmatchedRefs.map(({ idx, subject, number, title }) => ({
    idx,
    subject,
    number,
    title,
  }));

  const resolverPrompt = `You are an expert on NCERT textbooks for Class ${classLevel}.
Below is a list of syllabus/chapter items (each with a unique "idx") that were initially marked as "unmatched".
Your job is to figure out if each item can be mapped to an NCERT textbook chapter for Class ${classLevel}:
- Paraphrased, abbreviated, or sub-topic titles (e.g. "Tectonic Plates" -> Class 9 Geography "iess1" Chapter 2 "Physical Features of India").
- Poems or supplementary stories listed separately from their main chapter.

IMPORTANT:
- If the item is English, Hindi, or Sanskrit Grammar (Vyakaran), Writing Skills, or Reading Comprehension, keep "is_ncert": false and fields null.
- Otherwise, if it maps to an NCERT chapter, set "is_ncert": true, provide the 5-character lowercase "ncert_book_code", the 1-based "ncert_chapter_number", and the full "pdf_url" ("https://ncert.nic.in/textbook/pdf/<code><2_digit_ch>.pdf").

${CLASS_9_AND_10_NCERT_REFERENCE}

Unmatched items to verify for Class ${classLevel}:
${JSON.stringify(payloadForAi, null, 2)}`;

  try {
    const response = await generate(apiKey, {
      model: GEMINI_MODEL,
      contents: resolverPrompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: UNMATCHED_RESOLVER_SCHEMA,
      },
    });

    const resolvedList = JSON.parse(response.text);
    for (const item of resolvedList) {
      const target = unmatchedRefs[item.idx]?.ref;
      if (target && item.is_ncert && item.ncert_book_code && item.ncert_chapter_number) {
        const cleanCode = item.ncert_book_code.toLowerCase().trim();
        const paddedCh = String(item.ncert_chapter_number).padStart(2, "0");
        target.is_ncert = true;
        target.ncert_book_code = cleanCode;
        target.ncert_chapter_number = item.ncert_chapter_number;
        target.pdf_url =
          item.pdf_url || `https://ncert.nic.in/textbook/pdf/${cleanCode}${paddedCh}.pdf`;
      }
    }
  } catch (e) {
    console.log(`Unmatched AI resolution skipped: ${e.message}`);
  }

  return syllabus;
}

/**
 * Fallback extractor when a single NCERT chapter PDF or study document returned empty `subjects` on the first pass.
 */
async function fallbackExtractSingleDocument(contents, apiKey, fileName = "") {
  const singleDocPrompt = `This document is a single textbook chapter, NCERT PDF, or study handout${fileName ? ` (File name: "${fileName}")` : ""}.
Identify its Subject name (e.g. Science, Mathematics, History, Geography, Civics, Economics, English, Hindi, Physics, Chemistry, Biology) and its Chapter number and Chapter title.
If it is an NCERT textbook chapter, also fill in "is_ncert": true, "ncert_book_code", "ncert_chapter_number", and "pdf_url".
You MUST return at least 1 subject and 1 chapter in "subjects" (NEVER return an empty subjects array).

${CLASS_9_AND_10_NCERT_REFERENCE}`;

  const fallbackContents = Array.isArray(contents)
    ? [contents[0], { text: singleDocPrompt }]
    : `${singleDocPrompt}\n\nDOCUMENT:\n${contents}`;

  try {
    const response = await generate(apiKey, {
      model: GEMINI_MODEL,
      contents: fallbackContents,
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });
    const result = Syllabus.safeParse(JSON.parse(response.text));
    if (result.success && result.data.subjects.length > 0) {
      return result.data;
    }
  } catch (e) {
    console.log(`Single-document fallback extraction failed: ${e.message}`);
  }
  return null;
}

async function ask(contents, apiKey, fileName = "") {
  // Fast-path check if the filename itself is a known NCERT book+chapter code (e.g. iesc101.pdf, jesc102.pdf)
  const inferredByFilename = inferNcertFromFilename(fileName);

  let parsed = null;
  try {
    const response = await generate(apiKey, {
      model: GEMINI_MODEL,
      contents,
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });
    const result = Syllabus.safeParse(JSON.parse(response.text));
    if (result.success) parsed = result.data;
  } catch (e) {
    if (inferredByFilename) return inferredByFilename;
    throw e;
  }

  if (parsed === null) {
    if (inferredByFilename) return inferredByFilename;
    throw new Error("Could not read the document.");
  }

  // If the first pass returned no subjects (e.g. a single NCERT chapter PDF), run the single-document extractor
  if (!parsed.subjects || parsed.subjects.length === 0) {
    const fallback = await fallbackExtractSingleDocument(contents, apiKey, fileName);
    if (fallback && fallback.subjects?.length) {
      parsed = fallback;
    } else if (inferredByFilename) {
      return inferredByFilename;
    }
  }

  return resolveUnmatchedChapters(parsed, apiKey);
}

export function parseSyllabus(rawText, apiKey) {
  return ask(`${PROMPT}\nDOCUMENT:\n${rawText}`, apiKey);
}

export function parseSyllabusPdf(pdfBytes, apiKey, fileName = "") {
  const pdf = {
    inlineData: {
      data: Buffer.from(pdfBytes).toString("base64"),
      mimeType: "application/pdf",
    },
  };
  const promptWithHint = fileName ? `${PROMPT}\nUploaded PDF file name: "${fileName}"` : PROMPT;
  return ask([pdf, { text: promptWithHint }], apiKey, fileName);
}