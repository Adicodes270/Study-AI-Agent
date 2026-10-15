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
export function saveSyllabus(chatId, syllabus) {
  const exam = syllabus.exam || "";
  const results = {};

  withDb((db) => {
    // Class priority: in the message > already saved > CLASS_LEVEL from .env
    const row = db.prepare("SELECT class FROM chats WHERE chat_id = ?").get(chatId);
    const savedClass = row ? row.class : null;
    const classValue = syllabus.class_level || savedClass || DEFAULT_CLASS_LEVEL;

    db.prepare(
      "INSERT INTO chats (chat_id, class) VALUES (?, ?) " +
        "ON CONFLICT(chat_id) DO UPDATE SET class = excluded.class"
    ).run(chatId, classValue);

    const selectOld = db.prepare(
      "SELECT number, title, pdf_url, match_status FROM syllabus_chapters " +
        "WHERE chat_id = ? AND subject = ? AND exam = ? ORDER BY id"
    );
    const deleteOld = db.prepare(
      "DELETE FROM syllabus_chapters WHERE chat_id = ? AND subject = ? AND exam = ?"
    );
    const insertNew = db.prepare(
      "INSERT INTO syllabus_chapters " +
        "(chat_id, class, subject, exam, number, title, pdf_url, ncert_id, match_status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );

    const findNcertRow = db.prepare(
      "SELECT id, pdf_url FROM ncert_chapters WHERE class = ? AND book = ? AND number = ?"
    );
    const updateNcertUrl = db.prepare(
      "UPDATE ncert_chapters SET pdf_url = ?, title = ? WHERE id = ?"
    );
    const insertNcertRow = db.prepare(
      "INSERT INTO ncert_chapters (class, book, edition, number, title, pdf_url, pdf_path) " +
        "VALUES (?, ?, 'latest', ?, ?, ?, NULL)"
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

      const fresh = preparedChapters.map((c) => [
        c.number,
        c.title,
        c.pdfUrl,
        c.matchStatus,
      ]);
      const old = selectOld
        .all(chatId, subject.name, exam)
        .map((r) => [r.number, r.title, r.pdf_url, r.match_status]);

      if (JSON.stringify(old) === JSON.stringify(fresh)) {
        results[label] = "unchanged";
        continue;
      }

      results[label] = old.length ? "updated" : "added";
      deleteOld.run(chatId, subject.name, exam);

      for (const c of preparedChapters) {
        let ncertId = null;

        if (c.pdfUrl) {
          const effectiveClass = classValue || 0;
          const bookName = c.bookCode || subject.name;
          const existing = findNcertRow.get(effectiveClass, bookName, c.ncertChNum);

          if (existing) {
            ncertId = existing.id;
            if (existing.pdf_url !== c.pdfUrl) {
              updateNcertUrl.run(c.pdfUrl, c.title, existing.id);
            }
          } else {
            const info = insertNcertRow.run(
              effectiveClass,
              bookName,
              c.ncertChNum,
              c.title,
              c.pdfUrl
            );
            ncertId = info.lastInsertRowid;
          }
        }

        insertNew.run(
          chatId,
          classValue,
          subject.name,
          exam,
          c.number,
          c.title,
          c.pdfUrl,
          ncertId,
          c.matchStatus
        );
      }
    }
  });

  return results;
}