// src/intake/storage.js
import { DEFAULT_CLASS_LEVEL } from "../config.js";
import { withDb } from "../db.js";
import { questionCountFor } from "../quizEngine.js";

function buildNcertPdfUrl(bookCode, chapterNumber) {
  if (!bookCode || !chapterNumber) return null;
  const cleanCode = bookCode.toLowerCase().trim();
  const padded = String(chapterNumber).padStart(2, "0");
  return `https://ncert.nic.in/textbook/pdf/${cleanCode}${padded}.pdf`;
}

/** Save each subject. Returns {label: "added" | "updated" | "unchanged"}. */
export async function saveSyllabus(chatId, syllabus, options = {}) {
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
          const existing = found[0];

          if (existing) {
            ncertId = existing.id;
            if (existing.pdf_url !== c.pdfUrl) {
              await db.query("UPDATE ncert_chapters SET pdf_url = $1, title = $2 WHERE id = $3", [
                c.pdfUrl,
                c.title,
                existing.id,
              ]);
            }
          } else {
            const { rows: inserted } = await db.query(
              "INSERT INTO ncert_chapters (class, book, edition, number, title, pdf_url, pdf_path) " +
                "VALUES ($1, $2, 'latest', $3, $4, $5, NULL) RETURNING id",
              [effectiveClass, bookName, chNum, c.title, c.pdfUrl]
            );
            ncertId = inserted[0].id;
          }
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