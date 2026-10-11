import asyncio
import re

from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from ..config import TELEGRAM_BOT_TOKEN
from .pdf_reader import extract_pdf_text
from .storage import save_syllabus
from .syllabus_parser import parse_syllabus

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


async def process_syllabus_text(update: Update, text: str):
    """Shared by text messages and PDFs: parse, save, reply."""
    group = in_group(update)

    await update.effective_chat.send_action("typing")

    if group and not SYLLABUS_HINTS.search(text):
        return

    if not group:
        await update.message.reply_text("Got it, reading your syllabus...")

    try:
        syllabus = await asyncio.to_thread(parse_syllabus, text)
    except Exception as e:
        print(f"Parse error: {e}")
        if not group:
            await update.message.reply_text(f"Sorry, I couldn't read that: {e}")
        return

    if not syllabus.subjects:
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
    await process_syllabus_text(update, update.message.text)


async def handle_pdf(update: Update, context: ContextTypes.DEFAULT_TYPE):
    
    group = in_group(update)
    doc = update.message.document

    if doc.file_size and doc.file_size > MAX_PDF_BYTES:
        if not group:
            await update.message.reply_text("That PDF is over 20 MB, which is too big for me.")
        return

    try:
        tg_file = await doc.get_file()
        pdf_bytes = bytes(await tg_file.download_as_bytearray())
        text = await asyncio.to_thread(extract_pdf_text, pdf_bytes)
    except Exception as e:
        print(f"PDF error: {e}")
        if not group:
            await update.message.reply_text(f"Sorry, I couldn't open that PDF: {e}")
        return

    if not text:
        if not group:
            await update.message.reply_text(
                "That PDF has no readable text. It might be a scanned image."
            )
        return

    await process_syllabus_text(update, text)


def run_bot():
    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(MessageHandler(filters.Document.PDF, handle_pdf))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    print("Bot is running. Press Ctrl+C to stop.")
    app.run_polling()