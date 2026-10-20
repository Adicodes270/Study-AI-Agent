// src/db.js  (Neon Postgres)
import pg from "pg";
import { DATABASE_URL } from "./config.js";

// Telegram ids are BIGINT; return them as normal JS numbers (they fit in 2^53)
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    telegram_user_id     BIGINT PRIMARY KEY,
    gemini_api_key       TEXT NOT NULL,
    gemini_fallback_keys TEXT NOT NULL DEFAULT '[]',
    google_email         TEXT,
    notebooklm_state     TEXT,
    notebooklm_saved_at  TIMESTAMPTZ,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chats (
    chat_id BIGINT PRIMARY KEY,
    class   INTEGER
);

CREATE TABLE IF NOT EXISTS ncert_chapters (
    id       BIGSERIAL PRIMARY KEY,
    class    INTEGER NOT NULL,
    book     TEXT NOT NULL,
    edition  TEXT NOT NULL,
    number   INTEGER NOT NULL,
    title    TEXT NOT NULL,
    pdf_url  TEXT,
    pdf_path TEXT
);

CREATE TABLE IF NOT EXISTS syllabus_chapters (
    id           BIGSERIAL PRIMARY KEY,
    chat_id      BIGINT NOT NULL REFERENCES chats(chat_id),
    class        INTEGER,
    subject      TEXT NOT NULL,
    exam         TEXT NOT NULL DEFAULT '',
    number       INTEGER,
    title        TEXT NOT NULL,
    note         TEXT,
    pdf_url      TEXT,
    ncert_id     BIGINT REFERENCES ncert_chapters(id),
    match_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_syllabus_lookup
    ON syllabus_chapters (chat_id, subject, exam);

-- Telegram pairing: the bot records which chat sent a code like SA-1234,
-- the setup page then asks the server for it (so no bot token is needed in the browser)
CREATE TABLE IF NOT EXISTS pairings (
    code       TEXT PRIMARY KEY,
    chat_id    BIGINT NOT NULL,
    user_id    BIGINT,
    first_name TEXT,
    username   TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let pool;
export function getPool() {
  if (!pool) {
    if (!DATABASE_URL) throw new Error("DATABASE_URL is not set (use your Neon connection string)");
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 5000, // Neon suspends idle connections; don't hold them
      connectionTimeoutMillis: 10000,
    });
    pool.on("error", (e) => console.log(`DB pool error (ignored): ${e.message}`));
  }
  return pool;
}

/** Wrapper so callers write: await db.all(sql, params) / db.get / db.run (Postgres $1, $2 placeholders). */
function wrap(client) {
  return {
    all: async (sql, params = []) => (await client.query(sql, params)).rows,
    get: async (sql, params = []) => (await client.query(sql, params)).rows[0] ?? null,
    run: async (sql, params = []) => (await client.query(sql, params)).rowCount,
  };
}

/** Run `fn(db)` inside a transaction. Commits if it worked, rolls back if anything threw. */
export async function withDb(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(wrap(client));
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

let initPromise;
/** Creates tables if missing. Safe to call on every request (runs once per process). */
export function initDb() {
  if (!initPromise) {
    initPromise = getPool()
      .query(SCHEMA)
      .catch((e) => {
        initPromise = null; // retry next time
        throw e;
      });
  }
  return initPromise;
}
