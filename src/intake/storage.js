// src/intake/storage.js
import { DEFAULT_CLASS_LEVEL } from "../config.js";
import { withDb } from "../db.js";

function buildNcertPdfUrl(bookCode, chapterNumber) {
  if (!bookCode || !chapterNumber) return null;
  const cleanCode = bookCode.toLowerCase().trim();
  const padded = String(chapterNumber).padStart(2, "0");
  return `https://ncert.nic.in/textbook/pdf/${cleanCode}${padded}.pdf`;
}

/** Save each subject. Returns {label: "added" | "updated" | "unchanged"}. */
export async function saveSyllabus(chatId, syllabus) {
  const exam = syllabus.exam || "";
  const results = {};

  await withDb(async (db) => {
    // Class priority: in the message > already saved > CLASS_LEVEL from env
    const row = await db.get("SELECT class FROM chats WHERE chat_id = $1", [chatId]);
    const savedClass = row ? row.class : null;
    const classValue = syllabus.class_level || savedClass || DEFAULT_CLASS_LEVEL;

    await db.run(
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
            : null;
        const matchStatus = pdfUrl ? "matched" : "unmatched";

        return {
          number: c.number,
          title: c.title,
          bookCode,
          ncertChNum,
          pdfUrl,
          matchStatus,
        };
      });

      const fresh = preparedChapters.map((c) => [c.number, c.title, c.pdfUrl, c.matchStatus]);
      const old = (
        await db.all(
          "SELECT number, title, pdf_url, match_status FROM syllabus_chapters " +
            "WHERE chat_id = $1 AND subject = $2 AND exam = $3 ORDER BY id",
          [chatId, subject.name, exam]
        )
      ).map((r) => [r.number, r.title, r.pdf_url, r.match_status]);

      if (JSON.stringify(old) === JSON.stringify(fresh)) {
        results[label] = "unchanged";
        continue;
      }

      results[label] = old.length ? "updated" : "added";
      await db.run("DELETE FROM syllabus_chapters WHERE chat_id = $1 AND subject = $2 AND exam = $3", [
        chatId,
        subject.name,
        exam,
      ]);

      for (const c of preparedChapters) {
        let ncertId = null;

        if (c.pdfUrl) {
          const effectiveClass = classValue || 0;
          const bookName = c.bookCode || subject.name;
          const existing = await db.get(
            "SELECT id, pdf_url FROM ncert_chapters WHERE class = $1 AND book = $2 AND number = $3",
            [effectiveClass, bookName, c.ncertChNum]
          );

          if (existing) {
            ncertId = existing.id;
            if (existing.pdf_url !== c.pdfUrl) {
              await db.run("UPDATE ncert_chapters SET pdf_url = $1, title = $2 WHERE id = $3", [
                c.pdfUrl,
                c.title,
                existing.id,
              ]);
            }
          } else {
            const inserted = await db.get(
              "INSERT INTO ncert_chapters (class, book, edition, number, title, pdf_url, pdf_path) " +
                "VALUES ($1, $2, 'latest', $3, $4, $5, NULL) RETURNING id",
              [effectiveClass, bookName, c.ncertChNum, c.title, c.pdfUrl]
            );
            ncertId = inserted.id;
          }
        }

        await db.run(
          "INSERT INTO syllabus_chapters " +
            "(chat_id, class, subject, exam, number, title, pdf_url, ncert_id, match_status) " +
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
          [chatId, classValue, subject.name, exam, c.number, c.title, c.pdfUrl, ncertId, c.matchStatus]
        );
      }
    }
  });

  return results;
}
