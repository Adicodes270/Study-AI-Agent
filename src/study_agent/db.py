import sqlite3
from contextlib import contextmanager

from .config import ROOT

DB_PATH = ROOT / "data" / "study_agent.db"

SCHEMA = """
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
"""


@contextmanager
def get_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        with conn:  # commits if everything worked, rolls back if anything failed
            yield conn
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.executescript(SCHEMA)