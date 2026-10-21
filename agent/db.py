# agent/db.py - all SQL for the worker (Neon Postgres). A fresh short-lived connection per call, so a
# Neon autosuspend between worker cycles can never leave us holding a dead connection.
import time

import psycopg
from psycopg.rows import dict_row

import config

# Notebook/asset tables are keyed by telegram_user_id as TEXT; users/syllabus_chapters use BIGINT.
_T = lambda uid: str(uid)  # noqa: E731


def run(sql: str, params=None, *, one: bool = False, many: bool = False):
    with psycopg.connect(config.DATABASE_URL, row_factory=dict_row, connect_timeout=15) as conn:
        cur = conn.execute(sql, params or ())
        if one:
            return cur.fetchone()
        if many:
            return cur.fetchall()
        return cur.rowcount


def ensure_schema() -> None:
    """The Node app creates the tables on its first start; wait for them, then add the two retry columns."""
    if not config.DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not set")
    for _ in range(60):
        row = run("SELECT to_regclass('public.nlm_assets') AS a, to_regclass('public.users') AS u", one=True)
        if row and row["a"] and row["u"]:
            break
        print("Waiting for the web app to create the database tables...", flush=True)
        time.sleep(5)
    else:
        raise RuntimeError("Tables not found. Start the Node app once (npm start) so it creates them.")
    run("ALTER TABLE nlm_notebooks ADD COLUMN IF NOT EXISTS source_attempts INT NOT NULL DEFAULT 0")
    run("ALTER TABLE nlm_notebooks ADD COLUMN IF NOT EXISTS source_next_attempt_at TIMESTAMPTZ DEFAULT NOW()")


# ---- users -------------------------------------------------------------------------------------

def users_with_sessions():
    return run(
        """SELECT u.telegram_user_id, u.google_email,
                  COALESCE(s.session_status, 'ok') AS session_status,
                  COALESCE(s.paused, FALSE) AS paused,
                  s.enabled_assets_json, s.expired_notified_at
             FROM users u LEFT JOIN nlm_user_state s ON s.telegram_user_id = u.telegram_user_id::text
            WHERE u.notebooklm_state IS NOT NULL""",
        many=True,
    )


def get_state(user_id: int):
    row = run("SELECT notebooklm_state FROM users WHERE telegram_user_id = %s", (user_id,), one=True)
    return row["notebooklm_state"] if row else None


def set_session_status(user_id: int, status: str) -> None:
    run(
        """INSERT INTO nlm_user_state (telegram_user_id, session_status) VALUES (%s, %s)
           ON CONFLICT (telegram_user_id) DO UPDATE SET session_status = EXCLUDED.session_status""",
        (_T(user_id), status),
    )


def mark_expired_notified(user_id: int) -> None:
    run("UPDATE nlm_user_state SET expired_notified_at = now() WHERE telegram_user_id = %s", (_T(user_id),))


# ---- discovery: syllabus chapters -> notebooks -> assets ---------------------------------------

def discover(user_id: int, asset_types: list[str]) -> None:
    t = _T(user_id)
    # 1. chapters that have no notebook row yet (chat_id == user id in a private chat)
    fresh = run(
        """SELECT DISTINCT ON (sc.subject, sc.exam, sc.title) sc.subject, sc.exam, sc.title, sc.pdf_url
             FROM syllabus_chapters sc
            WHERE sc.chat_id = %s
              AND NOT EXISTS (SELECT 1 FROM nlm_notebooks n WHERE n.telegram_user_id = %s
                               AND n.subject = sc.subject AND n.exam = sc.exam AND n.chapter_title = sc.title)
            ORDER BY sc.subject, sc.exam, sc.title, sc.id""",
        (user_id, t), many=True,
    )
    for c in fresh:
        run(
            """INSERT INTO nlm_notebooks (telegram_user_id, subject, exam, chapter_title, source_status)
               VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT (telegram_user_id, subject, exam, chapter_title) DO NOTHING""",
            (t, c["subject"], c["exam"] or "", c["title"], "pending" if c["pdf_url"] else "skipped_no_source"),
        )
    # 2. chapters skipped earlier that have gained a textbook PDF (syllabus re-uploaded / re-matched)
    run(
        """UPDATE nlm_notebooks n SET source_status = 'pending', source_attempts = 0, source_next_attempt_at = now()
             FROM syllabus_chapters sc
            WHERE n.telegram_user_id = %s AND n.source_status = 'skipped_no_source'
              AND sc.chat_id = %s AND sc.subject = n.subject AND sc.exam = n.exam
              AND sc.title = n.chapter_title AND sc.pdf_url IS NOT NULL""",
        (t, user_id),
    )
    # 3. one asset row per enabled type for every notebook that can still produce them
    if asset_types:
        run(
            """INSERT INTO nlm_assets (notebook_row_id, asset_type)
               SELECT n.id, a FROM nlm_notebooks n CROSS JOIN unnest(%s::text[]) AS a
                WHERE n.telegram_user_id = %s AND n.source_status IN ('pending', 'added')
               ON CONFLICT (notebook_row_id, asset_type) DO NOTHING""",
            (asset_types, t),
        )


def release_stale(user_id: int) -> None:
    """A claim whose worker died before NotebookLM returned an id goes back to the queue."""
    run(
        """UPDATE nlm_assets a SET status = 'pending', lease_until = NULL
             FROM nlm_notebooks n
            WHERE n.id = a.notebook_row_id AND n.telegram_user_id = %s AND a.status = 'running'
              AND a.artifact_id IS NULL AND a.lease_until < now()""",
        (_T(user_id),),
    )


def work_counts(user_id: int) -> dict:
    t = _T(user_id)
    return run(
        """SELECT
             (SELECT COUNT(*) FROM nlm_notebooks WHERE telegram_user_id = %(t)s AND source_status = 'pending'
                 AND source_next_attempt_at <= now()) AS sources,
             (SELECT COUNT(*) FROM nlm_assets a JOIN nlm_notebooks n ON n.id = a.notebook_row_id
               WHERE n.telegram_user_id = %(t)s AND a.status = 'running') AS running,
             (SELECT COUNT(*) FROM nlm_assets a JOIN nlm_notebooks n ON n.id = a.notebook_row_id
               WHERE n.telegram_user_id = %(t)s AND n.source_status = 'added'
                 AND a.status IN ('pending', 'blocked_quota') AND a.next_attempt_at <= now()
                 AND NOT EXISTS (SELECT 1 FROM nlm_quota_blocks b WHERE b.telegram_user_id = n.telegram_user_id
                                  AND b.asset_type = a.asset_type AND b.blocked_until > now())) AS startable,
             (SELECT COUNT(*) FROM nlm_notebooks WHERE telegram_user_id = %(t)s AND notified_at IS NULL
                 AND source_status = 'added') AS unnotified""",
        {"t": t}, one=True,
    )


# ---- sources -----------------------------------------------------------------------------------

def pending_sources(user_id: int, limit: int):
    return run(
        """SELECT n.id, n.subject, n.exam, n.chapter_title, n.notebook_id, n.source_attempts,
                  (SELECT sc.pdf_url FROM syllabus_chapters sc
                    WHERE sc.chat_id = %(u)s AND sc.subject = n.subject AND sc.exam = n.exam
                      AND sc.title = n.chapter_title AND sc.pdf_url IS NOT NULL LIMIT 1) AS pdf_url
             FROM nlm_notebooks n
            WHERE n.telegram_user_id = %(t)s AND n.source_status = 'pending' AND n.source_next_attempt_at <= now()
            ORDER BY n.id LIMIT %(l)s""",
        {"u": user_id, "t": _T(user_id), "l": limit}, many=True,
    )


def notebook_count(user_id: int) -> int:
    row = run("SELECT COUNT(*) AS n FROM nlm_notebooks WHERE telegram_user_id = %s AND notebook_id IS NOT NULL",
              (_T(user_id),), one=True)
    return int(row["n"])


def set_notebook_id(row_id: int, notebook_id: str) -> None:
    run("UPDATE nlm_notebooks SET notebook_id = %s WHERE id = %s", (notebook_id, row_id))


def mark_source_added(row_id: int, notebook_id: str) -> None:
    run("UPDATE nlm_notebooks SET notebook_id = %s, source_status = 'added', source_error = NULL WHERE id = %s",
        (notebook_id, row_id))


def mark_source_skipped(row_id: int) -> None:
    run("UPDATE nlm_notebooks SET source_status = 'skipped_no_source' WHERE id = %s", (row_id,))


def mark_source_retry(row_id: int, error: str, max_attempts: int = 3) -> None:
    """Try a failing PDF up to 3 times (30 min, 60 min apart), then give up with 'source_failed'."""
    run(
        """UPDATE nlm_notebooks SET source_attempts = source_attempts + 1, source_error = %(e)s,
               source_status = CASE WHEN source_attempts + 1 >= %(m)s THEN 'source_failed' ELSE 'pending' END,
               source_next_attempt_at = now() + make_interval(mins => 30 * (source_attempts + 1))
         WHERE id = %(id)s""",
        {"e": error[:500], "m": max_attempts, "id": row_id},
    )


# ---- assets ------------------------------------------------------------------------------------

def claim_assets(user_id: int, limit: int) -> list[int]:
    rows = run(
        """UPDATE nlm_assets a SET status = 'running', attempts = a.attempts + 1, started_at = now(),
                  lease_until = now() + interval '20 minutes', error_class = NULL, error_message = NULL
            WHERE a.id IN (
                SELECT a2.id FROM nlm_assets a2 JOIN nlm_notebooks n ON n.id = a2.notebook_row_id
                 WHERE n.telegram_user_id = %(t)s AND n.source_status = 'added' AND n.notebook_id IS NOT NULL
                   AND a2.status IN ('pending', 'blocked_quota') AND a2.next_attempt_at <= now()
                   AND NOT EXISTS (SELECT 1 FROM nlm_quota_blocks b WHERE b.telegram_user_id = n.telegram_user_id
                                    AND b.asset_type = a2.asset_type AND b.blocked_until > now())
                 ORDER BY a2.next_attempt_at, a2.id LIMIT %(l)s
                 FOR UPDATE OF a2 SKIP LOCKED)
        RETURNING a.id""",
        {"t": _T(user_id), "l": limit}, many=True,
    )
    return [r["id"] for r in rows]


_ASSET_SELECT = """SELECT a.id, a.asset_type, a.artifact_id, a.attempts, a.started_at,
                          n.id AS nb_row, n.notebook_id, n.subject, n.exam, n.chapter_title,
                          (SELECT ch.class FROM chats ch WHERE ch.chat_id = n.telegram_user_id::bigint) AS class
                     FROM nlm_assets a JOIN nlm_notebooks n ON n.id = a.notebook_row_id"""


def get_asset(asset_id: int):
    return run(_ASSET_SELECT + " WHERE a.id = %s", (asset_id,), one=True)


def running_assets(user_id: int):
    return run(_ASSET_SELECT + " WHERE n.telegram_user_id = %s AND a.status = 'running' ORDER BY a.id",
               (_T(user_id),), many=True)


def set_artifact(asset_id: int, artifact_id: str) -> None:
    run("UPDATE nlm_assets SET artifact_id = %s WHERE id = %s", (artifact_id, asset_id))


def mark_done(asset_id: int) -> None:
    run("UPDATE nlm_assets SET status = 'done', finished_at = now(), lease_until = NULL, error_class = NULL, "
        "error_message = NULL WHERE id = %s", (asset_id,))


def mark_blocked(asset_id: int, hours: int, message: str) -> None:
    """Quota hit: not the item's fault, so the attempt doesn't count. It becomes startable again after the block."""
    run(
        """UPDATE nlm_assets SET status = 'blocked_quota', attempts = GREATEST(attempts - 1, 0), artifact_id = NULL,
               next_attempt_at = now() + make_interval(hours => %s), lease_until = NULL,
               error_class = 'quota', error_message = %s WHERE id = %s""",
        (hours, message[:500], asset_id),
    )


def mark_retry(asset_id: int, attempts: int, error_class: str, message: str, max_attempts: int) -> None:
    """Back off 5, 10, 20... minutes; after max_attempts the item is 'failed' for good."""
    if attempts >= max_attempts:
        run("UPDATE nlm_assets SET status = 'failed', finished_at = now(), lease_until = NULL, artifact_id = NULL, "
            "error_class = %s, error_message = %s WHERE id = %s", (error_class, message[:500], asset_id))
    else:
        run(
            """UPDATE nlm_assets SET status = 'pending', lease_until = NULL, artifact_id = NULL,
                   next_attempt_at = now() + make_interval(mins => 5 * power(2, %s)::int),
                   error_class = %s, error_message = %s WHERE id = %s""",
            (max(attempts - 1, 0), error_class, message[:500], asset_id),
        )


# ---- quota blocks ------------------------------------------------------------------------------

def get_strikes(user_id: int, asset_type: str) -> int:
    row = run("SELECT strikes FROM nlm_quota_blocks WHERE telegram_user_id = %s AND asset_type = %s",
              (_T(user_id), asset_type), one=True)
    return row["strikes"] if row else 0


def set_quota_block(user_id: int, asset_type: str, hours: int, strikes: int) -> None:
    run(
        """INSERT INTO nlm_quota_blocks (telegram_user_id, asset_type, blocked_until, strikes)
           VALUES (%s, %s, now() + make_interval(hours => %s), %s)
           ON CONFLICT (telegram_user_id, asset_type)
           DO UPDATE SET blocked_until = EXCLUDED.blocked_until, strikes = EXCLUDED.strikes""",
        (_T(user_id), asset_type, hours, strikes),
    )


def clear_quota_block(user_id: int, asset_type: str) -> None:
    run("DELETE FROM nlm_quota_blocks WHERE telegram_user_id = %s AND asset_type = %s", (_T(user_id), asset_type))


# ---- "chapter ready" messages ------------------------------------------------------------------

def finished_notebooks(user_id: int):
    """Notebooks whose items have all finished (done or failed) and that we haven't told the student about."""
    return run(
        """SELECT n.id, n.subject, n.exam, n.chapter_title, n.notebook_id,
                  COUNT(*) FILTER (WHERE a.status = 'done') AS done,
                  COUNT(*) FILTER (WHERE a.status = 'failed') AS failed
             FROM nlm_notebooks n JOIN nlm_assets a ON a.notebook_row_id = n.id
            WHERE n.telegram_user_id = %s AND n.notified_at IS NULL AND n.source_status = 'added'
            GROUP BY n.id
           HAVING COUNT(*) FILTER (WHERE a.status IN ('pending', 'running', 'blocked_quota')) = 0""",
        (_T(user_id),), many=True,
    )


def mark_notified(row_id: int) -> None:
    run("UPDATE nlm_notebooks SET notified_at = now() WHERE id = %s", (row_id,))