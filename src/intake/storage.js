// src/intake/storage.js
import { DEFAULT_CLASS_LEVEL } from "../config.js";
import { withDb } from "../db.js";
import { questionCountFor } from "../quizEngine.js";
import { classifyGranularSubject, splitSyllabusIntoGranularSubjects } from "./syllabusParser.js";

function buildNcertPdfUrl(bookCode, chapterNumber) {
  if (!bookCode || !chapterNumber) return null;
  const cleanCode = bookCode.toLowerCase().trim();
  const padded = String(chapterNumber).padStart(2, "0");
  return `https://ncert.nic.in/textbook/pdf/${cleanCode}${padded}.pdf`;
}

/** Save each subject (always split into granular subjects: History, Civics, Geography, Economics, Physics, Chemistry, Biology). */
export async function saveSyllabus(chatId, rawSyllabus, options = {}) {
  const syllabus = splitSyllabusIntoGranularSubjects(rawSyllabus);
  const exam = syllabus.exam || "";
  const results = {};
  const userQuestionCount =
    options.questionCount != null && options.questionCount !== ""
      ? Math.max(1, Math.min(50, parseInt(options.questionCount, 10) || 10))
      : null;

  await withDb(async (db) => {
    // Class priority: in the message > already saved > CLASS_LEVEL from .env
    const { rows: chatRows } = await db.query("SELECT class FROM chats WHERE chat_id = $1", [chatId]);
    const savedClass = chatRows[0] ? chatRows[0].class : null;
    const classValue = syllabus.class_level || savedClass || DEFAULT_CLASS_LEVEL;

    await db.query(
      "INSERT INTO chats (chat_id, class) VALUES ($1, $2) " +
        "ON CONFLICT (chat_id) DO UPDATE SET class = EXCLUDED.class",
      [chatId, classValue]
    );

    // Also migrate any legacy "Social Science" or "Science" rows in DB for this chat into granular subjects
    const { rows: legacyRows } = await db.query(
      "SELECT id, subject, exam, number, title, pdf_url FROM syllabus_chapters WHERE chat_id = $1",
      [chatId]
    );
    for (const row of legacyRows) {
      const granular = classifyGranularSubject(row.subject, row.title, row.pdf_url, "", row.number);
      if (granular && granular !== row.subject) {
        await db.query("UPDATE syllabus_chapters SET subject = $1 WHERE id = $2", [granular, row.id]);
        await db
          .query(
            `UPDATE chapter_quiz_results
                SET subject = $1
              WHERE telegram_user_id = $2 AND subject = $3 AND exam = $4 AND chapter_title = $5`,
            [granular, chatId, row.subject, row.exam || "", row.title]
          )
          .catch(() => {});
      }
    }

    for (const subject of syllabus.subjects) {
      const label = syllabus.exam ? `${subject.name} (${syllabus.exam})` : subject.name;

      const preparedChapters = subject.chapters.map((c) => {
        const bookCode = c.ncert_book_code ? c.ncert_book_code.toLowerCase().trim() : null;
        const ncertChNum = c.ncert_chapter_number || c.number;
        const pdfUrl =
          c.is_ncert
            ? buildNcertPdfUrl(bookCode, ncertChNum) || c.pdf_url || null
            : c.pdf_url || null;
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
          bookCode,
          ncertChNum,
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
        r.recommended_questions,
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

        if (c.pdfUrl) {
          const effectiveClass = classValue || 0;
          const bookName = c.bookCode || subject.name;
          const chNum = c.ncertChNum || c.number || 1;
          const { rows: found } = await db.query(
            "SELECT id, pdf_url FROM ncert_chapters WHERE class = $1 AND book = $2 AND number = $3",
            [effectiveClass, bookName, chNum]
          );
          // ncert_chapters is a shared, read-only catalog: uploads must never insert into or update it
          // (that caused "duplicate key ... ncert_chapters_pkey"). The user's chapter is stored in
          // syllabus_chapters below; we only link to a catalog row if one already exists.
          ncertId = found[0] ? found[0].id : null;
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
            c.pdfUrl,
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