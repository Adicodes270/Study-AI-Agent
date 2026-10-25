// src/intake/storage.js
import { hasDatabaseUrl, readLocalStore, withDb, writeLocalStore, pickNcertByTitle, ncertSubjectName } from "../db.js";
import { questionCountFor } from "../quizEngine.js";
import { getUserClass } from "./userKeys.js";

/** Save each subject (always split into granular subjects: History, Civics, Geography, Economics, Physics, Chemistry, Biology). */
export async function saveSyllabus(chatId, rawSyllabus, options = {}) {
  const syllabus = rawSyllabus; // subjects come from the database (ncert_chapters), not from the parser
  // The student's class comes from the setup page (users.class_level), never from .env
  const userClass = await getUserClass(chatId).catch(() => null);
  const exam = syllabus.exam || "";
  const results = {};
  const userQuestionCount =
    options.questionCount != null && options.questionCount !== ""
      ? Math.max(1, Math.min(50, parseInt(options.questionCount, 10) || 10))
      : null;

  // Always mirror to local store for offline / no-DB resilience
  try {
    const store = readLocalStore();
    store.syllabi = store.syllabi || {};
    const existingList = Array.isArray(store.syllabi[String(chatId)]) ? store.syllabi[String(chatId)] : [];
    const nextList = [...existingList];
    let nextId = nextList.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0) + 1;

    for (const subject of syllabus.subjects || []) {
      const label = syllabus.exam ? `${subject.name} (${syllabus.exam})` : subject.name;
      const prepared = (subject.chapters || []).map((c) => {
        // NEVER build PDF URLs from AI-provided ncert_book_code/ncert_chapter_number.
        // Only use verified URLs from ncert_chapters table (looked up by title in the DB section below).
        // For local store, we can't do DB lookups, so leave pdf_url null for NCERT chapters;
        // the DB section will populate the correct URL when saving to Postgres.
        const pdfUrl = c.is_ncert ? null : (c.pdf_url || null);
        const matchStatus = pdfUrl ? "matched" : "unmatched";
        const aiDefaultCount = questionCountFor({
          subject: subject.name,
          title: c.title,
          recommended_questions: c.recommended_questions,
        });
        const recommendedQuestions = userQuestionCount || Math.max(10, Math.min(50, aiDefaultCount));
        return {
          id: nextId++,
          class: userClass || syllabus.class_level || null,
          subject: subject.name,
          exam,
          number: c.number,
          title: c.title,
          note: c.note || null,
          pdf_url: pdfUrl,
          match_status: matchStatus,
          recommended_questions: recommendedQuestions,
          pending_quiz: null,
          result: null,
        };
      });

      const oldForSubj = nextList.filter((r) => r.subject === subject.name && (r.exam || "") === exam);
      if (oldForSubj.length > 0 && prepared.length <= 2) {
        for (const inc of prepared) {
          const idx = nextList.findIndex(
            (m) =>
              m.subject === subject.name &&
              m.title.toLowerCase() === inc.title.toLowerCase()
          );
          if (idx >= 0) nextList[idx] = { ...nextList[idx], ...inc, id: nextList[idx].id };
          else nextList.push(inc);
        }
        results[label] = "updated";
      } else {
        for (let i = nextList.length - 1; i >= 0; i--) {
          if (nextList[i].subject === subject.name && (nextList[i].exam || "") === exam) {
            nextList.splice(i, 1);
          }
        }
        nextList.push(...prepared);
        results[label] = oldForSubj.length ? "updated" : "added";
      }
    }
    store.syllabi[String(chatId)] = nextList;
    writeLocalStore(store);
  } catch {}

  if (!hasDatabaseUrl()) {
    return results;
  }

  await withDb(async (db) => {
    // Class priority: the one this student chose on the setup page > the syllabus itself > already saved on the chat
    const { rows: chatRows } = await db.query("SELECT class FROM chats WHERE chat_id = $1", [chatId]);
    const savedClass = chatRows[0] ? chatRows[0].class : null;
    const classValue = userClass || syllabus.class_level || savedClass || null;

    await db.query(
      "INSERT INTO chats (chat_id, class) VALUES ($1, $2) " +
        "ON CONFLICT (chat_id) DO UPDATE SET class = EXCLUDED.class",
      [chatId, classValue]
    );

    // Subject and link come from ncert_chapters (matched by chapter title and class). Chapters with no match
    // keep what the upload gave them.
    const { rows: ncertRows } = await db
      .query("SELECT id, class, book, subject, number, title, pdf_url FROM ncert_chapters WHERE pdf_url IS NOT NULL")
      .catch(() => ({ rows: [] }));
    const rowFor = (c) => {
      const id = c.ncert_id ?? c.ncertId;
      return (id != null && ncertRows.find((r) => r.id === Number(id))) || pickNcertByTitle(ncertRows, c.title, classValue);
    };
    const grouped = new Map();
    for (const sub of syllabus.subjects || []) {
      for (const c of sub.chapters || []) {
        const row = rowFor(c);
        const name = (row && ncertSubjectName(row)) || sub.name;
        const chapter = row ? { ...c, number: row.number, is_ncert: true, ncert_book_code: null, ncert_chapter_number: null, pdf_url: row.pdf_url } : c; // number = the one in ncert_chapters
        if (!grouped.has(name)) grouped.set(name, { name, chapters: [] });
        grouped.get(name).chapters.push(chapter);
      }
    }
    const dbSubjects = [...grouped.values()];

    for (const subject of dbSubjects) {
      const label = syllabus.exam ? `${subject.name} (${syllabus.exam})` : subject.name;

      const preparedChapters = subject.chapters.map((c) => {
        // NEVER build PDF URLs from AI-provided ncert_book_code/ncert_chapter_number.
        // Only use verified URLs from ncert_chapters table (matched by title below).
        // AI-provided book codes are NEVER trusted for URL construction.
        const pdfUrl = c.is_ncert ? null : (c.pdf_url || null);
        const matchStatus = pdfUrl ? "matched" : "unmatched";
        const aiDefaultCount = questionCountFor({
          subject: subject.name,
          title: c.title,
          recommended_questions: c.recommended_questions,
        });
        const recommendedQuestions = userQuestionCount || Math.max(10, Math.min(50, aiDefaultCount));

        return {
          number: c.number,
          title: c.title,
          ncertId: c.ncert_id ?? null,
          bookCode: null,
          ncertChNum: null,
          pdfUrl,
          matchStatus,
          recommendedQuestions,
        };
      });

      const { rows: oldRows } = await db.query(
        "SELECT number, title, pdf_url, match_status, recommended_questions FROM syllabus_chapters " +
          "WHERE chat_id = $1 AND subject = $2 AND exam = $3 ORDER BY id",
        [chatId, subject.name, exam]
      );

      // If the user uploaded a single NCERT chapter PDF (1-2 chapters) via "New Quiz" and already has
      // chapters for this subject, merge the new chapter(s) in instead of wiping out their existing chapters!
      let finalChapters = preparedChapters;
      if (oldRows.length > 0 && preparedChapters.length <= 2) {
        const merged = oldRows.map((r) => ({
          number: r.number,
          title: r.title,
          bookCode: null,
          ncertChNum: r.number,
          pdfUrl: r.pdf_url,
          matchStatus: r.match_status,
          recommendedQuestions:
            r.recommended_questions ||
            questionCountFor({ subject: subject.name, title: r.title }),
        }));
        for (const inc of preparedChapters) {
          const idx = merged.findIndex(
            (m) =>
              m.title.toLowerCase() === inc.title.toLowerCase() ||
              (m.pdfUrl && inc.pdfUrl && m.pdfUrl === inc.pdfUrl)
          );
          if (idx >= 0) merged[idx] = inc;
          else merged.push(inc);
        }
        finalChapters = merged;
      }

      const fresh = finalChapters.map((c) => [
        c.number,
        c.title,
        c.pdfUrl,
        c.matchStatus,
        c.recommendedQuestions,
      ]);
      const old = oldRows.map((r) => [
        r.number,
        r.title,
        r.pdf_url,
        r.match_status,
        r.recommendedQuestions,
      ]);

      if (JSON.stringify(old) === JSON.stringify(fresh)) {
        results[label] = "unchanged";
        continue;
      }

      results[label] = old.length ? "updated" : "added";
      await db.query(
        "DELETE FROM syllabus_chapters WHERE chat_id = $1 AND subject = $2 AND exam = $3",
        [chatId, subject.name, exam]
      );

      for (const c of finalChapters) {
        let ncertId = null;
        let savePdfUrl = c.pdfUrl;

        // ncert_chapters is the source of truth: match by title and take ITS link, not Gemini's guessed number
        const byTitle = rowFor(c);
        if (byTitle) {
          ncertId = byTitle.id;
          savePdfUrl = byTitle.pdf_url;
        } else {
          // NO fallback to AI-provided book codes. If no verified match, leave unmatched.
          ncertId = null;
          savePdfUrl = null;
        }

        await db.query(
          "INSERT INTO syllabus_chapters " +
            "(chat_id, class, subject, exam, number, title, pdf_url, ncert_id, match_status, recommended_questions) " +
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          [
            chatId,
            classValue,
            subject.name,
            exam,
            c.number,
            c.title,
            savePdfUrl,
            ncertId,
            c.matchStatus,
            c.recommendedQuestions,
          ]
        );
      }
    }
  });

  return results;
}