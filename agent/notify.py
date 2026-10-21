# agent/notify.py - Telegram messages and file delivery (plain text only, so nothing needs escaping)
import logging
from pathlib import Path

import httpx

import config

log = logging.getLogger("worker")
TG_FILE_LIMIT = 49 * 1024 * 1024  # bots may upload up to 50 MB


def _url(method: str) -> str:
    return f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}/{method}"


async def send_message(chat_id: int, text: str) -> bool:
    if not config.TELEGRAM_BOT_TOKEN:
        return False
    try:
        async with httpx.AsyncClient(timeout=30) as http:
            r = await http.post(_url("sendMessage"), json={"chat_id": chat_id, "text": text[:4000],
                                                          "disable_web_page_preview": True})
        if r.status_code != 200:
            log.info("sendMessage to %s failed: %s", chat_id, r.text[:200])
        return r.status_code == 200
    except httpx.HTTPError as e:
        log.info("sendMessage error: %s", e)
        return False


async def send_file(chat_id: int, path: Path, caption: str) -> bool:
    if not config.TELEGRAM_BOT_TOKEN or not path.exists() or path.stat().st_size > TG_FILE_LIMIT:
        return False
    try:
        async with httpx.AsyncClient(timeout=300) as http:
            with path.open("rb") as f:
                r = await http.post(_url("sendDocument"), data={"chat_id": str(chat_id), "caption": caption[:1000]},
                                    files={"document": (path.name, f)})
        if r.status_code != 200:
            log.info("sendDocument to %s failed: %s", chat_id, r.text[:200])
        return r.status_code == 200
    except httpx.HTTPError as e:
        log.info("sendDocument error: %s", e)
        return False