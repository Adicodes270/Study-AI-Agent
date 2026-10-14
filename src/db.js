import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { ROOT } from "./config.js";

export const DB_PATH = path.join(ROOT, "data", "study_agent.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
    chat_id INTEGER PRIMARY KEY,
    class   INTEGER
);

CREATE TABLE IF NOT EXISTS ncert_chapters (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    class    INTEGER NOT NULL,
    book     TEXT NOT NULL,
    edition  TEXT NOT NULL,
    number   INTEGER NOT NULL,
    title    TEXT NOT NULL,
    pdf_url  TEXT,
    pdf_path TEXT
);

CREATE TABLE IF NOT EXISTS syllabus_chapters (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id      INTEGER NOT NULL REFERENCES chats(chat_id),
    class        INTEGER,
    subject      TEXT NOT NULL,
    exam         TEXT NOT NULL DEFAULT '',
    number       INTEGER,
    title        TEXT NOT NULL,
    note         TEXT,
    ncert_id     INTEGER REFERENCES ncert_chapters(id),
    match_status TEXT NOT NULL DEFAULT 'pending'
);


CREATE INDEX IF NOT EXISTS idx_syllabus_lookup
    ON syllabus_chapters (chat_id, subject, exam);
`;

/**
 * Open the database, run `fn(conn)` inside a transaction, close it.
 * Commits if everything worked, rolls back if anything threw.
 */
export function withDb(fn) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const conn = new Database(DB_PATH);
  try {
    conn.pragma("foreign_keys = ON");
    return conn.transaction(() => fn(conn))();
  } finally {
    conn.close();
  }
}

export function initDb() {
  withDb((conn) => {
    conn.exec(SCHEMA);
  });
}
