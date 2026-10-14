import { DEFAULT_CLASS_LEVEL } from "../config.js";
import { withDb } from "../db.js";

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
      "SELECT number, title FROM syllabus_chapters " +
        "WHERE chat_id = ? AND subject = ? AND exam = ? ORDER BY id"
    );
    const deleteOld = db.prepare(
      "DELETE FROM syllabus_chapters WHERE chat_id = ? AND subject = ? AND exam = ?"
    );
    const insertNew = db.prepare(
      "INSERT INTO syllabus_chapters " +
        "(chat_id, class, subject, exam, number, title) " +
        "VALUES (?, ?, ?, ?, ?, ?)"
    );

    for (const subject of syllabus.subjects) {
      const label = syllabus.exam ? `${subject.name} (${syllabus.exam})` : subject.name;
      const fresh = subject.chapters.map((c) => [c.number, c.title]);
      const old = selectOld
        .all(chatId, subject.name, exam)
        .map((r) => [r.number, r.title]);

      if (JSON.stringify(old) === JSON.stringify(fresh)) {
        results[label] = "unchanged";
        continue;
      }

      results[label] = old.length ? "updated" : "added";
      deleteOld.run(chatId, subject.name, exam);
      for (const [num, title] of fresh) {
        insertNew.run(chatId, classValue, subject.name, exam, num, title);
      }
    }
  });

  return results;
}
