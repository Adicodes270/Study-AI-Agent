// src/intake/ncertCatalog.js

export const NCERT_EDITION = "2024-25";

// Maps class_level -> standard subject name -> NCERT book metadata & chapters
export const NCERT_BOOKS = {
  9: {
    Science: [
      {
        book: "Science",
        code: "iesc1",
        chapters: [
          "Matter in Our Surroundings",
          "Is Matter Around Us Pure?",
          "Atoms and Molecules",
          "Structure of the Atom",
          "The Fundamental Unit of Life",
          "Tissues",
          "Motion",
          "Force and Laws of Motion",
          "Gravitation",
          "Work and Energy",
          "Sound",
          "Improvement in Food Resources",
        ],
      },
    ],
    Mathematics: [
      {
        book: "Mathematics",
        code: "iemh1",
        chapters: [
          "Number Systems",
          "Polynomials",
          "Coordinate Geometry",
          "Linear Equations in Two Variables",
          "Introduction to Euclid's Geometry",
          "Lines and Angles",
          "Triangles",
          "Quadrilaterals",
          "Circles",
          "Heron's Formula",
          "Surface Areas and Volumes",
          "Statistics",
        ],
      },
    ],
  },
  10: {
    Science: [
      {
        book: "Science",
        code: "jesc1",
        chapters: [
          "Chemical Reactions and Equations",
          "Acids, Bases and Salts",
          "Metals and Non-metals",
          "Carbon and its Compounds",
          "Life Processes",
          "Control and Coordination",
          "How do Organisms Reproduce?",
          "Heredity",
          "Light – Reflection and Refraction",
          "The Human Eye and the Colourful World",
          "Electricity",
          "Magnetic Effects of Electric Current",
          "Our Environment",
        ],
      },
    ],
    Mathematics: [
      {
        book: "Mathematics",
        code: "jemh1",
        chapters: [
          "Real Numbers",
          "Polynomials",
          "Pair of Linear Equations in Two Variables",
          "Quadratic Equations",
          "Arithmetic Progressions",
          "Triangles",
          "Coordinate Geometry",
          "Introduction to Trigonometry",
          "Some Applications of Trigonometry",
          "Circles",
          "Areas Related to Circles",
          "Surface Areas and Volumes",
          "Statistics",
          "Probability",
        ],
      },
    ],
    "Social Science": [
      {
        book: "India and the Contemporary World-II (History)",
        code: "jess3",
        chapters: [
          "The Rise of Nationalism in Europe",
          "Nationalism in India",
          "The Making of a Global World",
          "The Age of Industrialisation",
          "Print Culture and the Modern World",
        ],
      },
      {
        book: "Contemporary India-II (Geography)",
        code: "jess1",
        chapters: [
          "Resources and Development",
          "Forest and Wildlife Resources",
          "Water Resources",
          "Agriculture",
          "Minerals and Energy Resources",
          "Manufacturing Industries",
          "Lifelines of National Economy",
        ],
      },
      {
        book: "Democratic Politics-II (Civics)",
        code: "jess4",
        chapters: [
          "Power-sharing",
          "Federalism",
          "Gender, Religion and Caste",
          "Political Parties",
          "Outcomes of Democracy",
        ],
      },
      {
        book: "Understanding Economic Development (Economics)",
        code: "jess2",
        chapters: [
          "Development",
          "Sectors of the Indian Economy",
          "Money and Credit",
          "Globalisation and the Indian Economy",
          "Consumer Rights",
        ],
      },
    ],
    English: [
      {
        book: "First Flight",
        code: "jeff1",
        chapters: [
          "A Letter to God",
          "Nelson Mandela: Long Walk to Freedom",
          "Two Stories about Flying",
          "From the Diary of Anne Frank",
          "Glimpses of India",
          "Mijbil the Otter",
          "Madam Rides the Bus",
          "The Sermon at Benares",
          "The Proposal",
        ],
      },
      {
        book: "Footprints Without Feet",
        code: "jefp1",
        chapters: [
          "A Triumph of Surgery",
          "The Thief's Story",
          "The Midnight Visitor",
          "A Question of Trust",
          "Footprints without Feet",
          "The Making of a Scientist",
          "The Necklace",
          "Bholi",
          "The Book That Saved the Earth",
        ],
      },
    ],
  },
  11: {
    Physics: [
      {
        book: "Physics Part-I",
        code: "keph1",
        chapters: [
          "Units and Measurements",
          "Motion in a Straight Line",
          "Motion in a Plane",
          "Laws of Motion",
          "Work, Energy and Power",
          "System of Particles and Rotational Motion",
          "Gravitation",
        ],
      },
      {
        book: "Physics Part-II",
        code: "keph2",
        chapters: [
          "Mechanical Properties of Solids",
          "Mechanical Properties of Fluids",
          "Thermal Properties of Matter",
          "Thermodynamics",
          "Kinetic Theory",
          "Oscillations",
          "Waves",
        ],
      },
    ],
    Chemistry: [
      {
        book: "Chemistry Part-I",
        code: "kech1",
        chapters: [
          "Some Basic Concepts of Chemistry",
          "Structure of Atom",
          "Classification of Elements and Periodicity in Properties",
          "Chemical Bonding and Molecular Structure",
          "Thermodynamics",
          "Equilibrium",
        ],
      },
      {
        book: "Chemistry Part-II",
        code: "kech2",
        chapters: [
          "Redox Reactions",
          "Organic Chemistry – Some Basic Principles and Techniques",
          "Hydrocarbons",
        ],
      },
    ],
    Biology: [
      {
        book: "Biology",
        code: "kebo1",
        chapters: [
          "The Living World",
          "Biological Classification",
          "Plant Kingdom",
          "Animal Kingdom",
          "Morphology of Flowering Plants",
          "Anatomy of Flowering Plants",
          "Structural Organisation in Animals",
          "Cell: The Unit of Life",
          "Biomolecules",
          "Cell Cycle and Cell Division",
          "Photosynthesis in Higher Plants",
          "Respiration in Plants",
          "Plant Growth and Development",
          "Breathing and Exchange of Gases",
          "Body Fluids and Circulation",
          "Excretory Products and their Elimination",
          "Locomotion and Movement",
          "Neural Control and Coordination",
          "Chemical Coordination and Integration",
        ],
      },
    ],
  },
  12: {
    Physics: [
      {
        book: "Physics Part-I",
        code: "leph1",
        chapters: [
          "Electric Charges and Fields",
          "Electrostatic Potential and Capacitance",
          "Current Electricity",
          "Moving Charges and Magnetism",
          "Magnetism and Matter",
          "Electromagnetic Induction",
          "Alternating Current",
          "Electromagnetic Waves",
        ],
      },
      {
        book: "Physics Part-II",
        code: "leph2",
        chapters: [
          "Ray Optics and Optical Instruments",
          "Wave Optics",
          "Dual Nature of Radiation and Matter",
          "Atoms",
          "Nuclei",
          "Semiconductor Electronics: Materials, Devices and Simple Circuits",
        ],
      },
    ],
    Chemistry: [
      {
        book: "Chemistry Part-I",
        code: "lech1",
        chapters: [
          "Solutions",
          "Electrochemistry",
          "Chemical Kinetics",
          "The d- and f-Block Elements",
          "Coordination Compounds",
        ],
      },
      {
        book: "Chemistry Part-II",
        code: "lech2",
        chapters: [
          "Haloalkanes and Haloarenes",
          "Alcohols, Phenols and Ethers",
          "Aldehydes, Ketones and Carboxylic Acids",
          "Amines",
          "Biomolecules",
        ],
      },
    ],
    Biology: [
      {
        book: "Biology",
        code: "lebo1",
        chapters: [
          "Sexual Reproduction in Flowering Plants",
          "Human Reproduction",
          "Reproductive Health",
          "Principles of Inheritance and Variation",
          "Molecular Basis of Inheritance",
          "Evolution",
          "Human Health and Disease",
          "Microbes in Human Welfare",
          "Biotechnology: Principles and Processes",
          "Biotechnology and its Applications",
          "Organisms and Populations",
          "Ecosystem",
          "Biodiversity and Conservation",
        ],
      },
    ],
  },
};

/**
 * Generates the direct NCERT PDF URL for a book code and 1-based chapter number.
 */
export function buildNcertPdfUrl(bookCode, chapterNumber) {
  const padded = String(chapterNumber).padStart(2, "0");
  return `https://ncert.nic.in/textbook/pdf/${bookCode.toLowerCase()}${padded}.pdf`;
}

/**
 * Flattens all NCERT catalog entries into rows ready for `ncert_chapters`.
 */
export function getAllNcertCatalogRows() {
  const rows = [];
  for (const [classStr, subjects] of Object.entries(NCERT_BOOKS)) {
    const classLevel = parseInt(classStr, 10);
    for (const books of Object.values(subjects)) {
      for (const b of books) {
        b.chapters.forEach((title, idx) => {
          const number = idx + 1;
          rows.push({
            class: classLevel,
            book: b.book,
            edition: NCERT_EDITION,
            number,
            title,
            pdf_url: buildNcertPdfUrl(b.code, number),
            pdf_path: null, // No local download needed
          });
        });
      }
    }
  }
  return rows;
}

const normTitle = (t) => String(t || "").toLowerCase().replace(/^\s*(chapter|ch\.?)\s*\d+\s*[:.\-–—]?\s*/i, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Find the NCERT chapter that matches a syllabus chapter. Matches by title (and class/subject when known).
 * Returns { classLevel, subject, book, code, number, title, pdf_url } or null.
 */
export function findNcertChapter({ classLevel = null, subject = "", title = "" } = {}) {
  const want = normTitle(title);
  if (!want) return null;
  const subj = String(subject || "").toLowerCase();
  const classes = Object.keys(NCERT_BOOKS).map(Number);
  const ordered = classLevel && NCERT_BOOKS[classLevel] ? [classLevel, ...classes.filter((c) => c !== classLevel)] : classes;
  let loose = null;
  for (const cls of ordered) {
    for (const [subjName, books] of Object.entries(NCERT_BOOKS[cls])) {
      const subjectOk = !subj || subjName.toLowerCase().includes(subj) || subj.includes(subjName.toLowerCase());
      for (const b of books) {
        const idx = b.chapters.findIndex((c) => normTitle(c) === want);
        if (idx < 0) continue;
        const hit = { classLevel: cls, subject: subjName, book: b.book, code: b.code, number: idx + 1, title: b.chapters[idx], pdf_url: buildNcertPdfUrl(b.code, idx + 1) };
        if (cls === classLevel && subjectOk) return hit;
        if (!loose && subjectOk) loose = hit;
        if (!loose && cls === classLevel) loose = hit;
      }
    }
  }
  return loose;
}
