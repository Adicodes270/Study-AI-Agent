// src/intake/telegramBot.js
import { Bot, HttpError } from "grammy";

import { GEMINI_MODEL, TELEGRAM_BOT_TOKEN } from "../config.js";
import { initDb } from "../db.js";
import { saveSyllabus } from "./storage.js";
import { parseSyllabus, parseSyllabusPdf } from "./syllabusParser.js";

const MAX_PDF_BYTES = 20 * 1024 * 1024; // Telegram bots can't download files over 20 MB

// In groups, only look at messages that seem to be about a syllabus.
const SYLLABUS_HINTS = new RegExp(
  "syllabus|portion|subject|chapter|topic|lesson" +
    "|\\bch[\\s.\\-:\\d]|\\btt\\d|half[\\s-]?yearly|annual|pre-?board" +
    "|physics|chemistry|biology|math|science|history|geography|economics" +
    "|english|hindi|sanskrit",
  "i"
);

const inGroup = (ctx) => ["group", "supergroup"].includes(ctx.chat.type);

async function start(ctx) {
  await ctx.reply(
    `Hi! Send your syllabus as text or as a PDF and I'll read it.\n(Using model: ${GEMINI_MODEL})`
  );
}

/** Shared by text and PDF: parse, save, reply. */
async function processSyllabus(ctx, parseFn, payload, hintText) {
  const group = inGroup(ctx);

  if (group && !SYLLABUS_HINTS.test(hintText)) {
    console.log("Ignored: no syllabus keywords found");
    return;
  }

  if (!group) {
    await ctx.reply("Got it, reading your syllabus...");
  }
  await ctx.replyWithChatAction("typing");

  let syllabus;
  try {
    syllabus = await parseFn(payload);
  } catch (e) {
    console.log(`Parse error: ${e.message}`);
    if (!group) {
      await ctx.reply(`Sorry, I couldn't read that: ${e.message}`);
    }
    return;
  }

  if (!syllabus.subjects.length) {
    console.log("Gemini found no subjects");
    if (!group) {
      await ctx.reply("I couldn't find any subjects in that.");
    }
    return;
  }

  const results = saveSyllabus(ctx.chat.id, syllabus);

  const labels = {
    added: "added",
    updated: "updated with your latest",
    unchanged: "already up to date",
  };
  const lines = Object.entries(results).map(([name, status]) => `${name}: ${labels[status]}`);
  await ctx.reply("Done!\n" + lines.join("\n"));
}

async function handleText(ctx) {
  const text = ctx.message.text;
  // equivalent of ~filters.COMMAND: skip messages that start with a bot command
  const first = ctx.message.entities?.[0];
  if (first && first.type === "bot_command" && first.offset === 0) return;
  await processSyllabus(ctx, parseSyllabus, text, text);
}

async function handlePdf(ctx) {
  const group = inGroup(ctx);
  const doc = ctx.message.document;
  console.log(`PDF received: ${doc.file_name} (${doc.file_size} bytes)`);

  if (doc.file_size && doc.file_size > MAX_PDF_BYTES) {
    if (!group) {
      await ctx.reply("That PDF is over 20 MB, which is too big for me.");
    }
    return;
  }

  // In groups, decide from the file name and caption, since we aren't reading the text ourselves
  const hint = `${doc.file_name || ""} ${ctx.message.caption || ""}`;
  if (group && !SYLLABUS_HINTS.test(hint)) {
    console.log("Ignored PDF: file name has no syllabus keywords");
    return;
  }

  let pdfBytes;
  try {
    const tgFile = await ctx.getFile();
    const res = await fetch(
      `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${tgFile.file_path}`
    );
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    pdfBytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    console.log(`PDF error: ${e.message}`);
    if (!group) {
      await ctx.reply(`Sorry, I couldn't download that PDF: ${e.message}`);
    }
    return;
  }

  await processSyllabus(ctx, parseSyllabusPdf, pdfBytes, hint);
}

function onError(err) {
  const error = err.error;
  if (error instanceof HttpError) {
    console.log(`Network hiccup, retrying automatically: ${error.message}`);
    return;
  }
  console.log(`Unexpected error: ${error}`);
}

export async function runBot() {
  initDb();
  const bot = new Bot(TELEGRAM_BOT_TOKEN);

  bot.command("start", start);
  bot.on("message:document", (ctx, next) =>
    ctx.message.document.mime_type === "application/pdf" ? handlePdf(ctx) : next()
  );
  bot.on("message:text", handleText);
  bot.catch(onError);

  const stop = () => bot.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.log(`Bot is running with Gemini model: ${GEMINI_MODEL}. Press Ctrl+C to stop.`);

  // keep retrying if the connection drops while polling (like bootstrap_retries=-1)
  let stopping = false;
  process.once("SIGINT", () => (stopping = true));
  process.once("SIGTERM", () => (stopping = true));
  while (!stopping) {
    try {
      await bot.start();
      break; // stopped cleanly
    } catch (e) {
      console.log(`Network hiccup, retrying automatically: ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}