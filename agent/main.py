# agent/main.py - NotebookLM worker. Run from the project root:  python agent/main.py
#
# Every cycle, for each student who saved a NotebookLM sign-in:
#   1. discover  syllabus chapters -> nlm_notebooks / nlm_assets rows
#   2. sources   create one notebook per chapter and load its NCERT PDF
#   3. poll      check generations that are running; download finished ones and send them on Telegram
#   4. start     begin new generations (a few per cycle, skipping asset types that hit a daily limit)
#   5. notify    tell the student when a chapter's items have all finished
# All state is in Neon, so the worker can be stopped/restarted/redeployed at any time and carries on.
import asyncio
import logging
import signal
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import config
import db
import generate
import notify
import quota
import session
import sources

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("worker")


def _notebook_url(notebook_id: str) -> str:
    return f"https://notebooklm.google.com/notebook/{notebook_id}"


def _enabled_assets(u: dict) -> list[str]:
    chosen = u.get("enabled_assets_json")
    types = chosen if isinstance(chosen, list) and chosen else config.DEFAULT_ASSETS
    return [t for t in dict.fromkeys(types) if t in generate.ASSETS]


def _reraise_if_auth(e: Exception) -> None:
    if session.is_auth_error(e):
        raise session.SessionExpired(str(e)) from e


async def finish_asset(client, uid: int, a: dict) -> None:
    """The artifact exists: record it, then try to hand the file to the student on Telegram."""
    db.mark_done(a["id"])
    quota.clear(uid, a["asset_type"])
    try:
        with tempfile.TemporaryDirectory(prefix="nlm-out-") as tmp:
            path = await generate.download(client, a["asset_type"], a, a["artifact_id"], Path(tmp))
            caption = f"{a['subject']}: {a['chapter_title']}\n{generate.label(a['asset_type'])}"
            sent = await notify.send_file(uid, path, caption)
            if not sent:  # too big for Telegram, or the bot can't message them: the notebook still has it
                await notify.send_message(uid, f"{caption}\nReady in NotebookLM: {_notebook_url(a['notebook_id'])}")
    except Exception as e:  # noqa: BLE001 - generation succeeded; delivery is best effort
        _reraise_if_auth(e)
        log.warning("user %s: could not deliver %s: %s", uid, a["asset_type"], e)


async def sources_phase(client, uid: int) -> None:
    for nb in db.pending_sources(uid, config.MAX_SOURCES_PER_CYCLE):
        if not nb["pdf_url"]:
            db.mark_source_skipped(nb["id"])
            continue
        if not nb["notebook_id"] and db.notebook_count(uid) >= config.MAX_NOTEBOOKS_PER_USER:
            log.warning("user %s reached the notebook cap (%s); leaving the rest pending", uid, config.MAX_NOTEBOOKS_PER_USER)
            return
        try:
            notebook_id = nb["notebook_id"]
            if not notebook_id:
                notebook_id = await sources.create_notebook(
                    client, sources.notebook_title(nb["subject"], nb["chapter_title"], nb["exam"]))
                db.set_notebook_id(nb["id"], notebook_id)  # keep it so a retry reuses it instead of making another
            await sources.add_chapter_source(client, notebook_id, nb["pdf_url"])
            db.mark_source_added(nb["id"], notebook_id)
            log.info("user %s: notebook ready for %s / %s", uid, nb["subject"], nb["chapter_title"])
        except Exception as e:  # noqa: BLE001
            _reraise_if_auth(e)
            log.warning("user %s: source failed for %s: %s", uid, nb["chapter_title"], e)
            db.mark_source_retry(nb["id"], str(e))


async def poll_phase(client, uid: int) -> None:
    now = datetime.now(timezone.utc)
    for a in db.running_assets(uid):
        if not a["artifact_id"]:
            continue  # claimed but not started yet (or an instant item mid-finish); release_stale() handles crashes
        try:
            prog = await generate.poll(client, a["notebook_id"], a["artifact_id"])
        except Exception as e:  # noqa: BLE001
            _reraise_if_auth(e)
            log.warning("user %s: poll failed for asset %s: %s", uid, a["id"], e)
            continue
        if prog.state == "done":
            await finish_asset(client, uid, a)
        elif prog.state == "failed":
            if quota.looks_like_quota(prog.error):
                db.mark_blocked(a["id"], quota.block(uid, a["asset_type"]), prog.error)
            else:
                db.mark_retry(a["id"], a["attempts"], "generation_failed", prog.error, config.MAX_ATTEMPTS)
        elif a["started_at"] and (now - a["started_at"]).total_seconds() > config.RUNNING_TIMEOUT_MIN * 60:
            db.mark_retry(a["id"], a["attempts"], "timeout", "NotebookLM took too long", config.MAX_ATTEMPTS)


async def start_phase(client, uid: int) -> None:
    for asset_id in db.claim_assets(uid, config.MAX_STARTS_PER_CYCLE):
        a = db.get_asset(asset_id)
        try:
            task_id = await generate.start(client, a["asset_type"], a)
            if task_id:
                db.set_artifact(asset_id, task_id)
                log.info("user %s: started %s for %s", uid, a["asset_type"], a["chapter_title"])
            elif generate.ASSETS[a["asset_type"]].immediate:
                await finish_asset(client, uid, a)
            else:
                raise generate.GenerationFailed("NotebookLM did not return a task id")
        except generate.QuotaExceeded as e:
            hours = quota.block(uid, a["asset_type"])
            db.mark_blocked(asset_id, hours, str(e))
            log.info("user %s: %s hit a limit, paused for %sh", uid, a["asset_type"], hours)
        except Exception as e:  # noqa: BLE001
            _reraise_if_auth(e)
            log.warning("user %s: could not start %s: %s", uid, a["asset_type"], e)
            db.mark_retry(asset_id, a["attempts"], type(e).__name__, str(e), config.MAX_ATTEMPTS)


async def notify_phase(uid: int) -> None:
    for nb in db.finished_notebooks(uid):
        if nb["done"]:
            text = f"Your study material for {nb['subject']}: {nb['chapter_title']} is ready ({nb['done']} items)."
            if nb["failed"]:
                text += f" {nb['failed']} couldn't be made."
            text += f"\nOpen the notebook: {_notebook_url(nb['notebook_id'])}"
            await notify.send_message(uid, text)
        db.mark_notified(nb["id"])  # also when everything failed, so we never repeat ourselves


async def process_user(u: dict) -> None:
    uid = u["telegram_user_id"]
    if u["paused"] or u["session_status"] == "expired":
        return
    db.discover(uid, _enabled_assets(u))
    db.release_stale(uid)
    counts = db.work_counts(uid)
    if not any(counts.values()):
        return  # nothing to do: don't even log in to Google
    state = db.get_state(uid)
    try:
        async with session.open_client(session.decrypt_state(state)) as client:
            await sources_phase(client, uid)
            await poll_phase(client, uid)
            await start_phase(client, uid)
        await notify_phase(uid)
    except session.SessionExpired as e:
        log.warning("user %s: NotebookLM sign-in expired (%s)", uid, e)
        db.set_session_status(uid, "expired")
        if not u["expired_notified_at"]:
            await notify.send_message(
                uid, "Your NotebookLM sign-in has expired, so I've paused your study material. "
                     "Please sign in again on the Study Agent setup page and press Save Configuration.")
            db.mark_expired_notified(uid)


async def main() -> None:
    db.ensure_schema()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # Windows
            pass
    log.info("NotebookLM worker started (cycle every %ss)", config.POLL_SECONDS)
    while not stop.is_set():
        try:
            for u in db.users_with_sessions():
                try:
                    await process_user(u)
                except Exception:  # noqa: BLE001 - one student's problem must not stop the others
                    log.exception("user %s failed this cycle", u["telegram_user_id"])
        except Exception:  # noqa: BLE001 - e.g. database briefly unreachable
            log.exception("cycle failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=config.POLL_SECONDS)
        except asyncio.TimeoutError:
            pass
    log.info("worker stopped")


if __name__ == "__main__":
    asyncio.run(main())