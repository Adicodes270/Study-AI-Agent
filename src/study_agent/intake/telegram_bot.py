import asyncio
import re

from telegram import Update
from telegram.error import NetworkError
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from ..config import TELEGRAM_BOT_TOKEN
from ..db import init_db
from .storage import save_syllabus
from .syllabus_parser import parse_syllabus, parse_syllabus_pdf

MAX_PDF_BYTES = 20 * 1024 * 1024  # Telegram bots can't download files over 20 MB

# In groups, only look at messages that seem to be about a syllabus.
SYLLABUS_HINTS = re.compile(
    r"syllabus|portion|subject|chapter|topic|lesson"
    r"|\bch[\s.\-:\d]|\btt\d|half[\s-]?yearly|annual|pre-?board"
    r"|physics|chemistry|biology|math|science|history|geography|economics"
    r"|english|hindi|sanskrit",
    re.IGNORECASE,
)


def in_group(update: Update) -> bool:
    return update.effective_chat.type in ("group", "supergroup")


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Hi! Send your syllabus as text or as a PDF and I'll read it."
    )


async def process_syllabus(update: Update, parse_fn, payload, hint_text: str):
    """Shared by text and PDF: parse, save, reply."""
    group = in_group(update)

    if group and not SYLLABUS_HINTS.search(hint_text):
        print("Ignored: no syllabus keywords found")
        return

    if not group:
        await update.message.reply_text("Got it, reading your syllabus...")
    await update.effective_chat.send_action("typing")

    try:
        syllabus = await asyncio.to_thread(parse_fn, payload)
    except Exception as e:
        print(f"Parse error: {e}")
        if not group:
            await update.message.reply_text(f"Sorry, I couldn't read that: {e}")
        return

    if not syllabus.subjects:
        print("Gemini found no subjects")
        if not group:
            await update.message.reply_text("I couldn't find any subjects in that.")
        return

    results = save_syllabus(update.effective_chat.id, syllabus)

    labels = {
        "added": "added",
        "updated": "updated with your latest",
        "unchanged": "already up to date",
    }
    lines = [f"{name}: {labels[status]}" for name, status in results.items()]
    await update.message.reply_text("Done!\n" + "\n".join(lines))


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text
    await process_syllabus(update, parse_syllabus, text, text)


async def handle_pdf(update: Update, context: ContextTypes.DEFAULT_TYPE):
    group = in_group(update)
    doc = update.message.document
    print(f"PDF received: {doc.file_name} ({doc.file_size} bytes)")

    if doc.file_size and doc.file_size > MAX_PDF_BYTES:
        if not group:
            await update.message.reply_text("That PDF is over 20 MB, which is too big for me.")
        return

    # In groups, decide from the file name and caption, since we aren't reading the text ourselves
    hint = f"{doc.file_name or ''} {update.message.caption or ''}"
    if group and not SYLLABUS_HINTS.search(hint):
        print("Ignored PDF: file name has no syllabus keywords")
        return

    try:
        tg_file = await doc.get_file()
        pdf_bytes = bytes(await tg_file.download_as_bytearray())
    except Exception as e:
        print(f"PDF error: {e}")
        if not group:
            await update.message.reply_text(f"Sorry, I couldn't download that PDF: {e}")
        return

    await process_syllabus(update, parse_syllabus_pdf, pdf_bytes, hint)


async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE):
    if isinstance(context.error, NetworkError):
        print(f"Network hiccup, retrying automatically: {context.error}")
        return
    print(f"Unexpected error: {context.error!r}")


def run_bot():
    init_db()
    app = (
        Application.builder()
        .token(TELEGRAM_BOT_TOKEN)
        .connect_timeout(30)
        .read_timeout(30)
        .write_timeout(30)
        .pool_timeout(30)
        .build()
    )
    app.add_handler(CommandHandler("start", start))
    app.add_handler(MessageHandler(filters.Document.PDF, handle_pdf))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    app.add_error_handler(on_error)
    print("Bot is running. Press Ctrl+C to stop.")
    app.run_polling(bootstrap_retries=-1)