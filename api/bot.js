// api/bot.js
// Dual-mode Vercel Serverless Webhook & Scheduled Morning Brief Endpoint
import { webhookCallback } from "grammy";
import {
  bot,
  isCronRequestAuthorized,
  sendDailyMorningBrief,
  triggerDailyMorningBriefsForAllUsers,
} from "../src/intake/telegramBot.js";
import { initDb } from "../src/db.js";

let botInitialized = false;
async function ensureBotInitialized() {
  await initDb().catch(() => {});
  if (!botInitialized) {
    if (!bot.isInited()) {
      try {
        await bot.init();
      } catch {
        // Fallback botInfo when running offline or with test token
        bot.botInfo = bot.botInfo || {
          id: 123456789,
          is_bot: true,
          first_name: "Study Agent Bot",
          username: "study_agent_bot",
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        };
      }
    }
    botInitialized = true;
  }
}

function sendJson(res, status, body) {
  if (typeof res.status === "function" && typeof res.json === "function") {
    return res.status(status).json(body);
  }
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

export async function handleMorningBriefCron(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers?.host || "localhost"}`);
  const query = Object.fromEntries(url.searchParams);

  if (!isCronRequestAuthorized(req, query)) {
    return sendJson(res, 401, {
      ok: false,
      error: "Unauthorized cron request. Provide valid Authorization: Bearer <CRON_SECRET> header.",
    });
  }

  try {
    await initDb().catch(() => {});
    const chatId = query.chatId || query.chat_id || req.body?.chatId || req.body?.chat_id || null;
    const force = query.force === "true" || query.force === "1" || Boolean(req.body?.force);

    if (chatId) {
      const single = await sendDailyMorningBrief(Number(chatId), { forceRegenerate: force });
      return sendJson(res, 200, {
        ok: true,
        mode: "single_chat",
        chatId: single.chatId,
        date: single.date,
        stats: single.stats,
      });
    }

    const summary = await triggerDailyMorningBriefsForAllUsers({ force });
    return sendJson(res, 200, summary);
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message || "Cron execution failed" });
  }
}

export default async function handler(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers?.host || "localhost"}`);
  const pathname = url.pathname.replace(/\/+$/, "");

  // Handle GET /api/cron/morning-brief or GET /api/bot?action=morning-brief
  if (
    pathname === "/api/cron/morning-brief" ||
    url.searchParams.get("action") === "morning-brief" ||
    (req.method === "GET" && (url.searchParams.has("cron") || req.headers?.["x-vercel-cron"]))
  ) {
    return handleMorningBriefCron(req, res);
  }

  if (req.method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      service: "Study-AI-Agent Telegram Webhook",
      endpoints: ["POST /api/bot", "GET /api/cron/morning-brief"],
    });
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
  }

  try {
    await ensureBotInitialized();

    // If body is already parsed (e.g. Vercel Serverless / Express / test harness), pass directly to bot.handleUpdate
    if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
      await bot.handleUpdate(req.body);
      return sendJson(res, 200, { ok: true });
    }

    // Otherwise use Grammy's standard HTTP stream webhookCallback
    const callback = webhookCallback(bot, "http");
    return await callback(req, res);
  } catch (err) {
    console.log(`Webhook error: ${err.message}`);
    return sendJson(res, 500, { ok: false, error: err.message });
  }
}