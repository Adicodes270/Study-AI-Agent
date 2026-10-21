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

// Chapter-level subject mapping for NCERT Science books (iesc1 = Class 9, jesc1 = Class 10)
const NCERT_SCIENCE_CHAPTER_DISCIPLINE = {
  iesc1: {
    1: "Chemistry", // Matter in Our Surroundings
    2: "Chemistry", // Is Matter Around Us Pure?
    3: "Chemistry", // Atoms and Molecules
    4: "Chemistry", // Structure of the Atom
    5: "Biology",   // The Fundamental Unit of Life
    6: "Biology",   // Tissues
    7: "Physics",   // Motion
    8: "Physics",   // Force and Laws of Motion
    9: "Physics",   // Gravitation
    10: "Physics",  // Work and Energy
    11: "Physics",  // Sound
    12: "Biology",  // Improvement in Food Resources
  },
  jesc1: {
    1: "Chemistry", // Chemical Reactions and Equations
    2: "Chemistry", // Acids, Bases and Salts
    3: "Chemistry", // Metals and Non-metals
    4: "Chemistry", // Carbon and its Compounds
    5: "Biology",   // Life Processes
    6: "Biology",   // Control and Coordination
    7: "Biology",   // How do Organisms Reproduce?
    8: "Biology",   // Heredity
    9: "Physics",   // Light - Reflection and Refraction
    10: "Physics",  // The Human Eye and the Colourful World
    11: "Physics",  // Electricity
    12: "Physics",  // Magnetic Effects of Electric Current
    13: "Biology",  // Our Environment
  },
};

/**
 * Classifies any generic "Social Science" / "SST" chapter into History, Civics, Geography, or Economics,
 * and any generic "Science" chapter into Physics, Chemistry, or Biology.
 */
export function classifyGranularSubject(rawSubject, title = "", pdfUrl = "", bookCode = "", chNum = null) {
  const subj = String(rawSubject || "").trim();
  const text = `${title || ""} ${subj}`.toLowerCase();
  const urlCodeMatch = /\/([a-z]{4,5}\d)(\d{2})\.pdf$/i.exec(String(pdfUrl || ""));
  const code = (bookCode || (urlCodeMatch ? urlCodeMatch[1] : "")).toLowerCase().trim();
  const num = chNum || (urlCodeMatch ? parseInt(urlCodeMatch[2], 10) : null);

  // 1. Check exact NCERT book code + chapter number
  if (code === "iess1" || code === "jess1" || code === "fess2" || code === "gess2" || code === "hess2") {
    return "Geography";
  }
  if (code === "iess2" || code === "jess2") {
    return "Economics";
  }
  if (code === "iess3" || code === "jess3" || code === "fess1" || code === "gess1" || code === "hess1") {
    return "History";
  }
  if (code === "iess4" || code === "jess4" || code === "fess3" || code === "gess3" || code === "hess3") {
    return "Civics";
  }
  if ((code === "iesc1" || code === "jesc1") && num && NCERT_SCIENCE_CHAPTER_DISCIPLINE[code]?.[num]) {
    return NCERT_SCIENCE_CHAPTER_DISCIPLINE[code][num];
  }

  // Normalize already-specific subjects
  if (/^history$/i.test(subj)) return "History";
  if (/^(civics|political science|polity)$/i.test(subj)) return "Civics";
  if (/^geography$/i.test(subj)) return "Geography";
  if (/^economics$/i.test(subj)) return "Economics";
  if (/^physics$/i.test(subj)) return "Physics";
  if (/^chemistry$/i.test(subj)) return "Chemistry";
  if (/^biology$/i.test(subj)) return "Biology";

  const isSocialScience = /^(social\s*science|social\s*studies|sst|s\.s\.t\.?)$/i.test(subj);
  const isScience = /^(science|general\s*science|sci)$/i.test(subj);

  if (isSocialScience || !subj) {
    if (
      /civics|politic|democracy|democratic|constitution|constitutional|electoral|election|parliament|judiciary|working of institutions|institution|fundamental rights|democratic rights|power.?sharing|federalism|gender,?\s*religion|caste|political parties|outcomes of democracy|government|panchayat|municipal|citizen|secularism|marginalisation|equality|legislature|executive/i.test(
        text
      )
    ) {
      return "Civics";
    }
    if (
      /economic|palampur|people as resource|poverty|food security|sectors of|money and credit|globalisation|consumer rights|problem of choice|scarcity|microeconomics|macroeconomics|production|market|budget|banking|gdp|employment/i.test(
        text
      )
    ) {
      return "Economics";
    }
    if (
      /geography|size and location|physical features|tectonic|himalaya|drainage|climate|monsoon|natural vegetation|wildlife|population|resources and development|forest and wildlife|water resources|agriculture|minerals|energy resources|manufacturing industries|lifelines of national economy|latitude|longitude|lithosphere|atmosphere|hydrosphere|biosphere|landform|drainage basin|peninsular/i.test(
        text
      )
    ) {
      return "Geography";
    }
    if (
      /history|early human|civilisation|civilization|revolution|nationalism|colonial|empire|dynasty|mughal|sultan|british|east india|world war|hitler|nazism|socialism|russian|french|industrialisation|industrialization|print culture|global world|forest society|pastoralist|peasants|kings|chronicle|harappa|vedic|mesopotamia|stone age|medieval|ancient|modern world|revolt|1857|gandhi|indo.?china|making of/i.test(
        text
      )
    ) {
      return "History";
    }
    if (isSocialScience) return "History";
  }

  if (isScience || !subj) {
    if (
      /chemistry|chemical|matter in our surroundings|matter around us pure|atoms and molecules|structure of the atom|acids,?\s*bases|salts|metals and non.?metals|carbon and its compounds|periodic|element|compound|mixture|solution|suspension|colloid|mole concept|valency|isotope|isobar|combustion|flame|coal|petroleum|synthetic fibre|plastic|polymer|redox|corrosion|rancidity|electrolysis|organic|hydrocarbon/i.test(
        text
      )
    ) {
      return "Chemistry";
    }
    if (
      /biology|fundamental unit of life|cell|tissues|diversity in living|living organism|life processes|control and coordination|reproduce|reproduction|heredity|evolution|our environment|ecosystem|food chain|ozone|improvement in food resources|crop|microorganism|why do we fall ill|disease|nutrition|respiration|transportation in|excretion|photosynthesis|nervous|hormone|endocrine|genetics|dna|chromosome|biodiversity/i.test(
        text
      )
    ) {
      return "Biology";
    }
    if (
      /physics|motion|force and laws|laws of motion|inertia|momentum|newton|gravitation|gravity|thrust|pressure|archimedes|buoyancy|work and energy|kinetic|potential energy|sound|wave|echo|ultrasound|light|reflection|refraction|mirror|lens|human eye|colourful world|prism|dispersion|scattering|electricity|ohm|circuit|resistance|magnetic effects|electric current|electromagnet|motor|generator|fleming|friction|heat|temperature|optics/i.test(
        text
      )
    ) {
      return "Physics";
    }
    if (isScience) return "Physics";
  }

  return subj || "General";
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
 * Splits any subjects in a parsed Syllabus object so that "Social Science" chapters are
 * organized into History, Civics, Geography, and Economics, and "Science" chapters are
 * organized into Physics, Chemistry, and Biology.
 */
export function splitSyllabusIntoGranularSubjects(syllabus) {
  if (!syllabus || !Array.isArray(syllabus.subjects)) return syllabus;
  const bySubjectName = new Map();

  for (const sub of syllabus.subjects) {
    for (const ch of sub.chapters || []) {
      const granularName = classifyGranularSubject(
        sub.name,
        ch.title,
        ch.pdf_url,
        ch.ncert_book_code,
        ch.ncert_chapter_number || ch.number
      );
      if (!bySubjectName.has(granularName)) {
        bySubjectName.set(granularName, { name: granularName, chapters: [] });
      }
      bySubjectName.get(granularName).chapters.push(ch);
    }
  }

  syllabus.subjects = [...bySubjectName.values()];
  return syllabus;
}

/**
 * If the uploaded file name matches an NCERT chapter code (e.g. "iesc101.pdf" or "jesc105.pdf"),
 * return a ready-made Syllabus object immediately with the specific subject (Physics/Chemistry/Biology/History/Civics/Geography/Economics).
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
    const specificSubject = classifyGranularSubject(entry.subject, title, pdfUrl, bookCode, chNum);
    return {
      class_level: entry.class_level,
      exam: null,
      subjects: [
        {
          name: specificSubject,
          chapters: [
            {
              number: chNum,
              title,
              is_ncert: true,
              ncert_book_code: bookCode,
              ncert_chapter_number: chNum,
              pdf_url: pdfUrl,
              recommended_questions: 15,
            },
          ],
        },
      ],
    };
  }
  return null;
}

const CLASS_9_AND_10_NCERT_REFERENCE = `
Complete Class 9 NCERT Books & Chapters Reference (Use Exact Specific Subject Names: Physics, Chemistry, Biology, History, Civics, Geography, Economics):
- Chemistry ("iesc1"): 1: Matter in Our Surroundings | 2: Is Matter Around Us Pure? | 3: Atoms and Molecules | 4: Structure of the Atom
- Biology ("iesc1"): 5: The Fundamental Unit of Life | 6: Tissues | 12: Improvement in Food Resources (Older editions: Diversity in Living Organisms, Why Do We Fall Ill, Natural Resources)
- Physics ("iesc1"): 7: Motion | 8: Force and Laws of Motion | 9: Gravitation | 10: Work and Energy | 11: Sound
- Mathematics ("iemh1"): 1: Number Systems | 2: Polynomials | 3: Coordinate Geometry | 4: Linear Equations in Two Variables | 5: Introduction to Euclid's Geometry | 6: Lines and Angles | 7: Triangles | 8: Quadrilaterals | 9: Circles | 10: Heron's Formula | 11: Surface Areas and Volumes | 12: Statistics
- Geography ("iess1"): 1: India - Size and Location | 2: Physical Features of India | 3: Drainage | 4: Climate | 5: Natural Vegetation and Wildlife | 6: Population
- Economics ("iess2"): 1: The Story of Village Palampur | 2: People as Resource | 3: Poverty as a Challenge | 4: Food Security in India
- History ("iess3"): 1: The French Revolution | 2: Socialism in Europe and the Russian Revolution | 3: Nazism and the Rise of Hitler | 4: Forest Society and Colonialism | 5: Pastoralists in the Modern World
- Civics ("iess4"): 1: What is Democracy? Why Democracy? | 2: Constitutional Design | 3: Electoral Politics | 4: Working of Institutions | 5: Democratic Rights
- English - Beehive ("iebe1") & Moments ("iemo1"), Hindi - Kshitij ("ihks1"), Kritika ("ihkr1"), Sparsh ("ihsp1"), Sanchayan ("ihsa1"), Sanskrit - Shemushi ("issh1").

Complete Class 10 NCERT Books & Chapters Reference:
- Chemistry ("jesc1"): 1: Chemical Reactions and Equations | 2: Acids, Bases and Salts | 3: Metals and Non-metals | 4: Carbon and its Compounds
- Biology ("jesc1"): 5: Life Processes | 6: Control and Coordination | 7: How do Organisms Reproduce? | 8: Heredity | 13: Our Environment
- Physics ("jesc1"): 9: Light - Reflection and Refraction | 10: The Human Eye and the Colourful World | 11: Electricity | 12: Magnetic Effects of Electric Current
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
- STRICT SUBJECT GRANULARITY RULE (NEVER USE GENERIC "Social Science" OR "Science"):
  1. NEVER group chapters under the generic subject name "Social Science" or "SST"! Always organize Social Science chapters into their exact discipline: "History", "Civics", "Geography", or "Economics".
  2. NEVER group chapters under the generic subject name "Science"! Always organize Science chapters into their exact discipline: "Physics", "Chemistry", or "Biology".
- CRITICAL — IF THE DOCUMENT IS AN NCERT CHAPTER PDF OR SINGLE-CHAPTER STUDY DOCUMENT:
  1. NEVER return an empty subjects list!
  2. Identify the exact granular Subject ("Physics", "Chemistry", "Biology", "History", "Civics", "Geography", "Economics", "Mathematics", "English", "Hindi", "Sanskrit", etc.) from the chapter's content and headings.
  3. Extract the Chapter number and Chapter title from the PDF/text.
  4. Return a 1-element "subjects" array containing that subject and its chapter(s).
- IF THE DOCUMENT IS A SCHOOL SYLLABUS / PORTION SHEET:
  1. Include EVERY subject that appears, splitting any "Science" section into "Physics", "Chemistry", and "Biology", and splitting any "Social Science" section into "History", "Civics", "Geography", and "Economics".
  2. For each subject, list the actual study units in order: textbook chapters, lessons, poems, units or topics.
- For EVERY chapter, analyze its breadth, length, and concept density and set "recommended_questions" to an integer between 10 and 50 (MINIMUM 10, MAXIMUM 50).
- Set exam to one of: Term Test 1, Term Test 2, Half Yearly, Annual, Pre-Board (or leave exam as null/empty if not mentioned).
- When a chapter or PDF matches an NCERT textbook chapter ("is_ncert": true), you MUST provide:
  - "ncert_book_code": the 5-character NCERT textbook code in lowercase (e.g. "iesc1", "jemh1", "iess1", "iess2", "iess3", "iess4").
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
                recommended_questions: { type: Type.INTEGER, nullable: true },
              },
              required: [
                "number",
                "title",
                "is_ncert",
                "ncert_book_code",
                "ncert_chapter_number",
                "pdf_url",
                "recommended_questions",
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
 * and asks Gemini to figure out if they correspond to an existing NCERT chapter,
 * then enforces granular subject splitting (History/Civics/Geography/Economics & Physics/Chemistry/Biology).
 */
async function resolveUnmatchedChapters(syllabus, apiKey) {
  const classLevel = syllabus.class_level || DEFAULT_CLASS_LEVEL || 9;
  const unmatchedRefs = [];

  for (const subject of syllabus.subjects) {
    for (const ch of subject.chapters) {
      ch.recommended_questions = Math.max(10, Math.min(50, Number(ch.recommended_questions) || 12));
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

  if (unmatchedRefs.length) {
    const payloadForAi = unmatchedRefs.map(({ idx, subject, number, title }) => ({
      idx,
      subject,
      number,
      title,
    }));

    const resolverPrompt = `You are an expert on NCERT textbooks for Class ${classLevel}.
Below is a list of syllabus/chapter items (each with a unique "idx") that were initially marked as "unmatched".
Your job is to figure out if each item can be mapped to an NCERT textbook chapter for Class ${classLevel}.

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
  }

  return splitSyllabusIntoGranularSubjects(syllabus);
}

/**
 * Fallback extractor when a single NCERT chapter PDF or study document returned empty `subjects` on the first pass.
 */
async function fallbackExtractSingleDocument(contents, apiKey, fileName = "") {
  const singleDocPrompt = `This document is a single textbook chapter, NCERT PDF, or study handout${fileName ? ` (File name: "${fileName}")` : ""}.
Identify its exact granular Subject name ("Physics", "Chemistry", "Biology", "History", "Civics", "Geography", "Economics", "Mathematics", "English", "Hindi", "Sanskrit" — NEVER use generic "Science" or "Social Science"), its Chapter number, its Chapter title, and set "recommended_questions" (an integer between 10 and 50; minimum 10).
If it is an NCERT textbook chapter, also fill in "is_ncert": true, "ncert_book_code", "ncert_chapter_number", and "pdf_url".
You MUST return at least 1 subject and 1 chapter in "subjects".

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
      return splitSyllabusIntoGranularSubjects(result.data);
    }
  } catch (e) {
    console.log(`Single-document fallback extraction failed: ${e.message}`);
  }
  return null;
}

async function ask(contents, apiKey, fileName = "") {
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