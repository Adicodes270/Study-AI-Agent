// src/intake/telegramBot.js
import { Bot, HttpError } from "grammy";

import { GEMINI_API_KEY, GEMINI_MODEL, TELEGRAM_BOT_TOKEN } from "../config.js";
import { initDb, withDb } from "../db.js";
import { saveSyllabus } from "./storage.js";
import { deleteUserKey, getUserKeys, isValidKey, saveUserKey } from "./userKeys.js";
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
    `Hi! First add your Gemini API key on the setup page (or send it here in private: /setkey YOUR_KEY).\n\n` +
      `Then send your syllabus as text or as a PDF and I'll read it.\n(Using model: ${GEMINI_MODEL})\n\n` +
      `/removekey deletes your saved key.`
  );
}

async function setKey(ctx) {
  if (inGroup(ctx)) {
    await ctx.reply("For safety, send /setkey in a private chat with me, not in a group.");
    return;
  }
  const key = (ctx.match || "").trim();
  // Remove the message holding the key from the chat history when possible
  await ctx.deleteMessage().catch(() => {});
  if (!isValidKey(key)) {
    await ctx.reply("That doesn't look like a Gemini key . Usage: /setkey YOUR_KEY");
    return;
  }
  await saveUserKey(ctx.from.id, key);
  await ctx.reply("Saved your Gemini key. I deleted your message so the key isn't left in the chat. Now send your syllabus!");
}

async function removeKey(ctx) {
  const removed = await deleteUserKey(ctx.from.id);
  await ctx.reply(removed ? "Your Gemini key has been deleted." : "You don't have a saved key.");
}

/** Shared by text and PDF: parse, save, reply. */
async function processSyllabus(ctx, parseFn, payload, hintText) {
  const group = inGroup(ctx);

  if (group && !SYLLABUS_HINTS.test(hintText)) {
    console.log("Ignored: no syllabus keywords found");
    return;
  }

  // The key belongs to the Telegram user (ctx.from.id), falling back to the .env key
  const apiKey = await getUserKeys(ctx.from.id);
  if (!apiKey.length && !GEMINI_API_KEY) {
    console.log(`No Gemini key for user ${ctx.from.id}`);
    await ctx.reply("I need your Gemini API key first. Add it on the setup page, or in a private chat with me send:\n/setkey YOUR_KEY");
    return;
  }

  if (!group) {
    await ctx.reply("Got it, reading your syllabus...");
  }
  await ctx.replyWithChatAction("typing");

  let syllabus;
  try {
    syllabus = await parseFn(payload, apiKey);
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

  const results = await saveSyllabus(ctx.chat.id, syllabus);

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

// Setup page pairing: if a message contains a code like SA-1234, remember which chat sent it,
// so the website can look it up (the browser never needs the bot token)
const PAIR_RE = /\bSA-\d{4}\b/;
async function recordPairing(ctx, next) {
  const text = ctx.message?.text || ctx.message?.caption || "";
  const m = text.match(PAIR_RE);
  if (m && ctx.chat && ctx.chat.type === "private") {
    try {
      await withDb((db) =>
        db.run(
          "INSERT INTO pairings (code, chat_id, user_id, first_name, username, created_at) " +
            "VALUES ($1, $2, $3, $4, $5, now()) " +
            "ON CONFLICT (code) DO UPDATE SET chat_id = EXCLUDED.chat_id, user_id = EXCLUDED.user_id, " +
            "first_name = EXCLUDED.first_name, username = EXCLUDED.username, created_at = now()",
          [m[0], ctx.chat.id, ctx.from?.id ?? ctx.chat.id, ctx.chat.first_name || ctx.from?.first_name || null, ctx.chat.username || ctx.from?.username || null]
        )
      );
    } catch (e) {
      console.log(`Pairing save failed: ${e.message}`);
    }
  }
  await next();
}

/** Builds the bot with all handlers. Used by both the Vercel webhook and local polling. */
export function buildBot() {
  const bot = new Bot(TELEGRAM_BOT_TOKEN);
  bot.use(recordPairing);
  bot.command("start", start);
  bot.command("setkey", setKey);
  bot.command("removekey", removeKey);
  bot.on("message:document", (ctx, next) =>
    ctx.message.document.mime_type === "application/pdf" ? handlePdf(ctx) : next()
  );
  bot.on("message:text", handleText);
  bot.catch(onError);
  return bot;
}

/** Local development only: long polling. On Vercel the webhook (api/bot.js) is used instead. */
export async function runBot() {
  await initDb();
  const bot = buildBot();

  // Polling and a webhook can't run together, so clear any webhook first
  await bot.api.deleteWebhook().catch(() => {});

  const stop = () => bot.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.log(`Bot is running (polling) with Gemini model: ${GEMINI_MODEL}. Press Ctrl+C to stop.`);

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
