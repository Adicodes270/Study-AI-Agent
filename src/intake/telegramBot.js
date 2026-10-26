// src/intake/telegramBot.js
import { Api, Bot, HttpError } from "grammy";

import {
  GEMINI_API_KEY,
  GEMINI_MODEL,
  TELEGRAM_BOT_TOKEN,
} from "../config.js";

const DEFAULT_CLASS_LEVEL = parseInt(process.env.CLASS_LEVEL ?? "", 10) || 10;
const CRON_SECRET = (process.env.CRON_SECRET ?? "").trim();
const MORNING_BRIEF_TIME = (process.env.MORNING_BRIEF_TIME ?? "08:00").trim() || "08:00";
import {
  compactTaskId,
  createPomodoroSession,
  findTaskInPlan,
  getAllActiveStudyUserIds,
  getDailyProgressStats,
  getMorningBriefSentDate,
  getPomodoroSession,
  initDb,
  logStudyFocusMinutes,
   savePairing,
  setMorningBriefSentDate,
  updatePomodoroSession,
} from "../db.js";
import { saveSyllabus } from "./storage.js";
import { enqueueSyllabus, scheduleAutoStart } from "../generationQueue.js";
import {
  inferNcertFromFilename,
  parseSyllabus,
  parseSyllabusPdf,
  splitSyllabusIntoGranularSubjects,
} from "./syllabusParser.js";
import {
  deleteUserKey,
  getUserClass,
  getUserKeys,
  isValidKey,
  saveUserKey,
} from "./userKeys.js";
import { identifyChaptersFromPdf, syllabusFromNcertRows } from "./chapterIdentifier.js";
import {
  carryOverPartialTask,
  completeStudyTask,
  formatFriendlyDate,
  getTodayIstYmd,
  getTodayScheduleForUser,
  rescheduleTasks,
} from "../plannerEngine.js";

const MAX_PDF_BYTES = 20 * 1024 * 1024; // Telegram bots can't download files over 20 MB

// In groups, only look at messages that seem to be about a syllabus or NCERT chapter.
const SYLLABUS_HINTS = new RegExp(
  "syllabus|portion|subject|chapter|topic|lesson|ncert|\\b[a-z]{4}\\d{3}\\b" +
    "|\\bch[\\s.\\-:\\d]|\\btt\\d|half[\\s-]?yearly|annual|pre-?board" +
    "|physics|chemistry|biology|math|science|history|geography|economics" +
    "|english|hindi|sanskrit",
  "i"
);

const inGroup = (ctx) => ["group", "supergroup"].includes(ctx.chat?.type);

const PAIR_CODE = /^SA-\d{4}$/i;

// Active in-memory Pomodoro and Break timers (sessionId -> Timeout)
const activeTimers = new Map();

/**
 * Ensures any callback_data string is strictly under Telegram's 64-byte limit.
 */
export function buildSafeCallbackData(prefix, ...parts) {
  const joined = [prefix, ...parts.map((p) => String(p ?? ""))].join(":");
  if (Buffer.byteLength(joined, "utf8") <= 64) {
    return joined;
  }
  return Buffer.from(joined, "utf8").subarray(0, 64).toString("utf8");
}

/**
 * Safely edits a Telegram message in-place, ignoring "message is not modified" errors.
 */
export async function safeEditMessageText(ctx, text, extra = {}) {
  try {
    if (ctx.callbackQuery?.message) {
      return await ctx.editMessageText(text, extra);
    }
    return await ctx.reply(text, extra);
  } catch (err) {
    const msg = String(err?.description || err?.message || "");
    if (/message is not modified/i.test(msg)) {
      return null;
    }
    // If Markdown/HTML parse failed or message couldn't be edited, retry plain edit or reply
    try {
      const plainExtra = { ...extra };
      delete plainExtra.parse_mode;
      if (ctx.callbackQuery?.message) {
        return await ctx.editMessageText(text, plainExtra);
      }
    } catch (retryErr) {
      const retryMsg = String(retryErr?.description || retryErr?.message || "");
      if (/message is not modified/i.test(retryMsg)) {
        return null;
      }
    }
    return null;
  }
}

/**
 * Safely calls answerCallbackQuery immediately to stop the Telegram button loading spinner.
 */
export async function safeAnswerCallback(ctx, text = undefined, showAlert = false) {
  if (typeof ctx?.answerCallbackQuery !== "function") return;
  try {
    await ctx.answerCallbackQuery(text ? { text, show_alert: showAlert } : undefined);
  } catch {}
}

// ---------------------------------------------------------------------------
// 1. Morning Study Brief & Interactive Task Cards Formatting
// ---------------------------------------------------------------------------

/**
 * Builds the text and inline_keyboard for a user's Daily Study Brief.
 * Each active task gets 1-tap action buttons:
 *  - [ ✅ Done ]        (callback_data: "task_done:<taskId>")
 *  - [ ⏳ Half Done ]   (callback_data: "task_partial:<taskId>")
 *  - [ 🔄 Reschedule ]  (callback_data: "task_reschedule:<taskId>")
 *  - [ 🍅 25m Focus ]   (callback_data: "pomo_start:<taskId>:25")
 */
export function buildDailyBriefPayload(day, stats, { statusBanner = null } = {}) {
  const blocks = Array.isArray(day?.studyBlocks) ? day.studyBlocks : [];
  const dayTitle = day?.dayLabel || day?.displayDate || day?.date || "Today";
  const pct = stats?.percentage ?? 0;
  const completedCount = stats?.completed ?? 0;
  const totalCount = stats?.total ?? blocks.length;

  const lines = [
    `☀️ *Morning Study Brief — ${dayTitle}*`,
    `📊 Today's Progress: ${completedCount}/${totalCount} tasks (${pct}%)`,
    "",
  ];

  if (!blocks.length) {
    lines.push("🎉 No study blocks scheduled for today! Send your syllabus or use /reschedule to rebalance upcoming chapters.");
  } else {
    blocks.forEach((b, idx) => {
      const num = idx + 1;
      const subj = b.subject || "Study";
      const title = b.title || b.chapterTitle || `Topic ${num}`;
      const dur = Number(b.durationMins) || 45;
      const timeRange = b.startTime && b.endTime ? `${b.startTime}–${b.endTime} · ` : "";

      if (b.completed || b.status === "done") {
        lines.push(`${num}. ✅ Completed · ~[${subj}] ${title}~ (${dur}m)`);
      } else if (b.status === "partial" || Number(b.completionPct) === 50) {
        const movedTo = b.carriedToDate ? ` (${b.carriedToDate})` : "";
        lines.push(`${num}. ⏳ Half Done (50%) · [${subj}] ${title} (${dur}m) — Remaining portion moved to tomorrow${movedTo}`);
      } else if (b.status === "rescheduled") {
        const movedTo = b.rescheduledTo || "upcoming schedule";
        lines.push(`${num}. 🔄 Rescheduled · ~[${subj}] ${title}~ → Moved to ${movedTo}`);
      } else {
        lines.push(`${num}. 📚 *[${subj}] ${title}*\n   ⏱ ${timeRange}${dur} mins`);
      }
    });
  }

  if (statusBanner) {
    lines.push("", statusBanner);
  }

  const inline_keyboard = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.completed || b.status === "done" || b.status === "rescheduled") {
      continue;
    }
    const shortId = compactTaskId(b.id || `block_${day?.date || "today"}_${i + 1}`);
    inline_keyboard.push([
      {
        text: "✅ Done",
        callback_data: buildSafeCallbackData("task_done", shortId),
      },
      {
        text: "⏳ Half Done",
        callback_data: buildSafeCallbackData("task_partial", shortId),
      },
    ]);
    inline_keyboard.push([
      {
        text: "🔄 Reschedule",
        callback_data: buildSafeCallbackData("task_reschedule", shortId),
      },
      {
        text: "🍅 25m Focus",
        callback_data: buildSafeCallbackData("pomo_start", shortId, 25),
      },
    ]);
  }

  return {
    text: lines.join("\n"),
    reply_markup: { inline_keyboard },
  };
}

/**
 * Reusable function to send the Daily Morning Study Brief to a specific chatId.
 * Can be called from the `/today` command, local scheduler, or `/api/cron/morning-brief`.
 */
export async function sendDailyMorningBrief(chatId, options = {}) {
  const numericChatId = Number(chatId);
  if (!Number.isFinite(numericChatId)) {
    throw new Error(`Invalid chatId: ${chatId}`);
  }

  const todayYmd = options.todayYmd || getTodayIstYmd();
  const { day, stats, plan } = await getTodayScheduleForUser(numericChatId, {
    todayYmd,
    forceRegenerate: Boolean(options.forceRegenerate),
  });

  const payload = buildDailyBriefPayload(day, stats, {
    statusBanner: options.statusBanner || null,
  });

  const api =
    options.api ||
    options.botInstance?.api ||
    (TELEGRAM_BOT_TOKEN ? new Api(TELEGRAM_BOT_TOKEN) : null);

  let sentMessage = null;
  if (options.ctx && typeof options.ctx.reply === "function") {
    sentMessage = await options.ctx.reply(payload.text, {
      reply_markup: payload.reply_markup,
    });
  } else if (api && typeof api.sendMessage === "function") {
    sentMessage = await api.sendMessage(numericChatId, payload.text, {
      reply_markup: payload.reply_markup,
    });
  }

  await setMorningBriefSentDate(numericChatId, todayYmd);

  return {
    ok: true,
    chatId: numericChatId,
    date: todayYmd,
    text: payload.text,
    reply_markup: payload.reply_markup,
    message: sentMessage,
    day,
    stats,
    plan,
  };
}

/**
 * Sends the daily morning brief to all active users who haven't received it yet today (or all if force=true).
 */
export async function triggerDailyMorningBriefsForAllUsers({
  todayYmd = getTodayIstYmd(),
  force = false,
  chatId = null,
  api = null,
} = {}) {
  const targetIds = chatId != null ? [Number(chatId)] : await getAllActiveStudyUserIds();
  const results = [];
  let sentCount = 0;
  let skippedCount = 0;

  for (const id of targetIds) {
    if (!Number.isFinite(id) || id <= 0) continue;
    try {
      if (!force && chatId == null) {
        const lastSent = await getMorningBriefSentDate(id);
        if (lastSent === todayYmd) {
          skippedCount++;
          results.push({ chatId: id, status: "already_sent", date: todayYmd });
          continue;
        }
      }
      const res = await sendDailyMorningBrief(id, { todayYmd, api });
      sentCount++;
      results.push({ chatId: id, status: "sent", date: todayYmd, tasksCount: res.stats?.total || 0 });
    } catch (err) {
      results.push({ chatId: id, status: "error", error: err.message });
    }
  }

  return {
    ok: true,
    date: todayYmd,
    sentCount,
    skippedCount,
    totalUsers: targetIds.length,
    results,
  };
}

// ---------------------------------------------------------------------------
// 2. Pomodoro Focus Session Engine
// ---------------------------------------------------------------------------

function makeCompactSessionId() {
  const ts = Date.now().toString(36).slice(-6);
  const rnd = Math.random().toString(36).slice(2, 6);
  return `p_${ts}${rnd}`;
}

function getTimerMsPerMinute() {
  const override = Number(process.env.POMODORO_MS_PER_MIN);
  if (Number.isFinite(override) && override > 0) return override;
  return 60_000;
}

/**
 * Completes a Pomodoro session (either when its timer finishes or when [ ✅ Finished Early ] is tapped).
 */
export async function completePomodoroSession(
  sessionId,
  { early = false, ctx = null, api = null } = {}
) {
  const timer = activeTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(sessionId);
  }

  const session = await getPomodoroSession(sessionId);
  if (!session) {
    return { ok: false, error: "Pomodoro session not found." };
  }
  if (session.status === "completed" || session.status === "cancelled") {
    return { ok: true, alreadyFinished: true, session };
  }

  const loggedMins = Math.max(1, Number(session.durationMins) || 25);
  const completedAt = new Date().toISOString();

  await updatePomodoroSession(session.id, {
    status: "completed",
    focusedMins: loggedMins,
    completedAt,
  });

  await logStudyFocusMinutes(session.telegramUserId, {
    sessionId: session.id,
    taskId: session.taskId,
    subject: session.subject,
    topicTitle: session.topicTitle,
    minutes: loggedMins,
  });

  if (ctx?.callbackQuery?.message) {
    await safeEditMessageText(
      ctx,
      `🍅 **${session.durationMins}-Minute Focus Session ${early ? "Finished Early" : "Completed"}** for ${session.topicTitle} (${session.subject}).\n✅ Logged ${loggedMins} focused study minutes!`,
      { reply_markup: { inline_keyboard: [] } }
    );
  }

  const shortTask = compactTaskId(session.taskId || "general");
  const followUpKeyboard = {
    inline_keyboard: [
      [
        {
          text: "✅ Mark Topic Done",
          callback_data: buildSafeCallbackData("task_done", shortTask),
        },
      ],
      [
        {
          text: "⏳ Need Another 25m",
          callback_data: buildSafeCallbackData("pomo_start", shortTask, 25),
        },
        {
          text: "☕ Take 5m Break",
          callback_data: buildSafeCallbackData("pomo_break", 5),
        },
      ],
    ],
  };

  const alertText =
    `🔔 🍅 **Focus Session Complete!**\n` +
    `Great work! Logged **${loggedMins} minutes** of focused study on **${session.topicTitle}** (${session.subject}).\n\n` +
    `What would you like to do next?`;

  const resolvedApi =
    api ||
    ctx?.api ||
    (TELEGRAM_BOT_TOKEN ? new Api(TELEGRAM_BOT_TOKEN) : null);

  let alertMessage = null;
  if (ctx && typeof ctx.reply === "function") {
    alertMessage = await ctx.reply(alertText, {
      disable_notification: false,
      reply_markup: followUpKeyboard,
    });
  } else if (resolvedApi && typeof resolvedApi.sendMessage === "function") {
    alertMessage = await resolvedApi.sendMessage(session.chatId, alertText, {
      disable_notification: false,
      reply_markup: followUpKeyboard,
    });
  }

  return {
    ok: true,
    session: { ...session, status: "completed", focusedMins: loggedMins, completedAt },
    loggedMins,
    alertText,
    reply_markup: followUpKeyboard,
    alertMessage,
  };
}

/**
 * Starts a new in-chat Pomodoro focus timer for a user/chat.
 */
export async function startPomodoroForUser({
  chatId,
  telegramUserId,
  taskId = null,
  durationMins = 25,
  customTopic = null,
  ctx = null,
  api = null,
}) {
  const uid = Number(telegramUserId || chatId);
  const cid = Number(chatId || telegramUserId);
  const mins = Math.max(1, Math.min(180, parseInt(durationMins, 10) || 25));

  let resolvedTaskId = taskId;
  let subject = "General";
  let topicTitle = customTopic ? String(customTopic).trim() : "";

  try {
    const { plan, day } = await getTodayScheduleForUser(uid);
    if (resolvedTaskId && resolvedTaskId !== "general") {
      const found = findTaskInPlan(plan, resolvedTaskId);
      if (found?.block) {
        resolvedTaskId = found.block.id;
        subject = found.block.subject || subject;
        topicTitle = topicTitle || found.block.title || found.block.chapterTitle || "Study Session";
      }
    } else if (day && Array.isArray(day.studyBlocks) && day.studyBlocks.length > 0) {
      const nextBlock =
        day.studyBlocks.find((b) => !b.completed && b.status !== "done" && b.status !== "rescheduled") ||
        day.studyBlocks[0];
      if (nextBlock) {
        resolvedTaskId = nextBlock.id;
        subject = nextBlock.subject || subject;
        topicTitle = topicTitle || nextBlock.title || nextBlock.chapterTitle || "Study Session";
      }
    }
  } catch {}

  if (!topicTitle) {
    topicTitle = "Focused Study Session";
  }

  const sessionId = makeCompactSessionId();
  const statusText = `🍅 **${mins}-Minute Focus Session Started** for ${topicTitle}. Put your phone down—I'll ping you when time is up!`;
  const reply_markup = {
    inline_keyboard: [
      [
        {
          text: "✅ Finished Early",
          callback_data: buildSafeCallbackData("pomo_finish", sessionId),
        },
        {
          text: "✖️ Cancel Timer",
          callback_data: buildSafeCallbackData("pomo_cancel", sessionId),
        },
      ],
    ],
  };

  let sentMsg = null;
  if (ctx && typeof ctx.reply === "function") {
    sentMsg = await ctx.reply(statusText, { reply_markup });
  } else {
    const resolvedApi = api || (TELEGRAM_BOT_TOKEN ? new Api(TELEGRAM_BOT_TOKEN) : null);
    if (resolvedApi && typeof resolvedApi.sendMessage === "function") {
      sentMsg = await resolvedApi.sendMessage(cid, statusText, { reply_markup });
    }
  }

  const session = await createPomodoroSession({
    id: sessionId,
    telegramUserId: uid,
    chatId: cid,
    taskId: resolvedTaskId,
    subject,
    topicTitle,
    durationMins: mins,
    status: "running",
    messageId: sentMsg?.message_id ?? null,
  });

  const resolvedApiForTimeout =
    api ||
    ctx?.api ||
    (TELEGRAM_BOT_TOKEN ? new Api(TELEGRAM_BOT_TOKEN) : null);

  const timeoutMs = mins * getTimerMsPerMinute();
  const timer = setTimeout(() => {
    completePomodoroSession(sessionId, {
      early: false,
      api: resolvedApiForTimeout,
    }).catch((err) => console.log(`Pomodoro completion error: ${err.message}`));
  }, timeoutMs);

  if (typeof timer.unref === "function") {
    timer.unref();
  }
  activeTimers.set(sessionId, timer);

  return {
    ok: true,
    session,
    text: statusText,
    reply_markup,
    message: sentMsg,
  };
}

export async function cancelPomodoroSession(sessionId, { ctx = null } = {}) {
  const timer = activeTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(sessionId);
  }

  const session = await getPomodoroSession(sessionId);
  if (session) {
    await updatePomodoroSession(session.id, { status: "cancelled" });
  }

  const topic = session?.topicTitle || "your study topic";
  const text = `✖️ Focus timer for **${topic}** cancelled. Use /today or /pomodoro whenever you're ready to start again!`;
  if (ctx) {
    await safeEditMessageText(ctx, text, { reply_markup: { inline_keyboard: [] } });
  }
  return { ok: true, session, text };
}

// ---------------------------------------------------------------------------
// 3. Command & Callback Query Handlers
// ---------------------------------------------------------------------------

async function start(ctx) {
  const code = (ctx.match || "").trim().toUpperCase();
  if (PAIR_CODE.test(code)) {
    await savePairing({
      code,
      chatId: ctx.chat.id,
      userId: ctx.from.id,
      firstName: ctx.from.first_name || null,
      username: ctx.from.username || null,
    });
    await ctx.reply(
      `🎉 Hey ${ctx.from.first_name || "there"}! Study Agent is linked!\n\n` +
        `Your Telegram ID (${ctx.from.id}) is now paired with the setup page. Go back to it and press Save Configuration, ` +
        `then send me your syllabus or NCERT chapter as text or a PDF.\n\n` +
        `Daily study commands:\n` +
        `• /today — View today's interactive study plan\n` +
        `• /pomodoro [mins] — Start an in-chat focus timer\n` +
        `• /reschedule — Dynamically rebalance unfinished tasks`
    );
    return;
  }
  await ctx.reply(
    `Hi! First add your Gemini API key on the setup page (or send it here in private: /setkey YOUR_KEY).\n\n` +
      `Then send your syllabus or NCERT chapter as text or as a PDF and I'll read it.\n(Using model: ${GEMINI_MODEL})\n\n` +
      `Commands:\n` +
      `• /today — Today's study brief & 1-tap progress tracker\n` +
      `• /pomodoro [minutes] — Start a 25m focus session\n` +
      `• /reschedule — Redistribute unfinished tasks across upcoming days\n` +
      `• /removekey — Delete your saved Gemini key\n• /help — View all commands & usage guide`
  );
}

async function setKey(ctx) {
  if (inGroup(ctx)) {
    await ctx.reply("For safety, send /setkey in a private chat with me, not in a group.");
    return;
  }
  const key = (ctx.match || "").trim();
  await ctx.deleteMessage().catch(() => {});
  if (!isValidKey(key)) {
    await ctx.reply("That doesn't look like a Gemini key . Usage: /setkey YOUR_KEY");
    return;
  }
  await saveUserKey(ctx.from.id, key);
  await ctx.reply(
    "Saved your Gemini key. I deleted your message so the key isn't left in the chat. Now send your syllabus or NCERT PDF, or type /today to see your study plan!"
  );
}

async function removeKey(ctx) {
  const removed = await deleteUserKey(ctx.from.id);
  await ctx.reply(removed ? "Your Gemini key has been deleted." : "You don't have a saved key.");
}

/**
 * `/help` command handler: displays all available bot commands, 1-tap study actions, and syllabus intake tips.
 */
export async function handleHelpCommand(ctx) {
  const helpText = [
    "🤖 *Study AI Agent — Command & Study Guide*",
    "",
    "📅 *Daily Study & Planning*",
    "• /today — View today's study brief, progress %, and 1-tap task buttons",
    "• /reschedule — Dynamically move unfinished or overdue topics to upcoming days",
    "• /pomodoro `[minutes] [topic]` — Start an in-chat focus timer (default: 25m)",
    "",
    "⚡ *1-Tap Inline Actions (on /today cards)*",
    "• *✅ Done* — Mark topic 100% completed (syncs with Web Planner & Todoist)",
    "• *⏳ Half Done* — Log 50% progress & carry the remaining half to tomorrow",
    "• *🔄 Reschedule* — Rebalance a topic into an upcoming day with open capacity",
    "• *🍅 25m Focus* — Launch a 25-minute Pomodoro timer for that specific topic",
    "",
    "📚 *Syllabus & NCERT Intake*",
    "• Send any *syllabus text* or *NCERT chapter PDF* (up to 20 MB) directly in chat to parse chapters and queue study resources.",
    "",
    "🔑 *Account & Setup*",
    "• /start `SA-XXXX` — Pair your Telegram chat with the Web Dashboard",
    "• /setkey `YOUR_GEMINI_KEY` — Save your Gemini API key (private chat only)",
    "• /removekey — Delete your saved Gemini API key",
    "• /help — Show this help menu",
  ].join("\n");

  const reply_markup = {
    inline_keyboard: [
      [
        { text: "☀️ View Today's Plan", callback_data: "help_today" },
        { text: "🍅 Start 25m Focus", callback_data: "pomo_start:general:25" },
      ],
    ],
  };

  return await ctx.reply(helpText, { reply_markup });
}


/**
 * `/today` command handler: sends the user's Morning Study Brief with interactive 1-tap buttons.
 */
export async function handleTodayCommand(ctx) {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  await sendDailyMorningBrief(chatId, { ctx });
}

/**
 * `/reschedule` command handler: redistributes overdue or unfinished tasks across upcoming days.
 */
export async function handleRescheduleCommand(ctx) {
  const userId = ctx.chat?.id ?? ctx.from?.id;
  const res = await rescheduleTasks(userId, { taskId: null });

  if (!res.ok) {
    await ctx.reply(`⚠️ Could not reschedule tasks: ${res.error || "Unknown error"}`);
    return res;
  }

  if (!res.movedTasks.length) {
    await ctx.reply("✅ You're all caught up! No overdue or unfinished tasks needed rescheduling.");
    return res;
  }

  const summaryLines = res.movedTasks.map(
    (m) => `• **[${m.subject}] ${m.title}** → moved to **${m.toDayLabel}** (${m.toDate}, ${m.startTime}–${m.endTime})`
  );

  const banner =
    `🔄 **Schedule Dynamically Rebalanced!**\n` +
    `Redistributed ${res.movedTasks.length} unfinished topic(s) across upcoming days without overloading any single day:\n` +
    summaryLines.join("\n");

  if (res.day && res.stats) {
    const payload = buildDailyBriefPayload(res.day, res.stats, { statusBanner: banner });
    await ctx.reply(payload.text, { reply_markup: payload.reply_markup });
  } else {
    await ctx.reply(banner);
  }
  return res;
}

/**
 * `/pomodoro [minutes] [topic]` command handler: starts an in-chat focus timer (default 25 mins).
 */
export async function handlePomodoroCommand(ctx) {
  const rawArgs = String(ctx.match || "").trim();
  let durationMins = 25;
  let customTopic = null;

  if (rawArgs) {
    const parts = rawArgs.split(/\s+/);
    const maybeMins = parseInt(parts[0], 10);
    if (Number.isFinite(maybeMins) && maybeMins > 0) {
      durationMins = Math.min(180, maybeMins);
      customTopic = parts.slice(1).join(" ").trim() || null;
    } else {
      customTopic = rawArgs;
    }
  }

  return await startPomodoroForUser({
    chatId: ctx.chat?.id ?? ctx.from?.id,
    telegramUserId: ctx.from?.id ?? ctx.chat?.id,
    durationMins,
    customTopic,
    ctx,
  });
}

/**
 * Handles all `callback_query` events for 1-tap task updates, dynamic rescheduling, and Pomodoro sessions.
 */
export async function handleCallbackQuery(ctx) {
  const data = String(ctx.callbackQuery?.data || "").trim();
  const userId = ctx.chat?.id ?? ctx.from?.id;

  // Always answer callback query immediately to stop Telegram's loading spinner
  await safeAnswerCallback(ctx);

  if (!data) return;

  if (data === "help_today") {
    return await sendDailyMorningBrief(userId, { ctx });
  }

  // 1. task_done:<taskId>
  if (data.startsWith("task_done:")) {
    const taskId = data.slice("task_done:".length).trim();
    const res = await completeStudyTask(userId, taskId);

    if (!res.ok) {
      const { day, stats } = await getTodayScheduleForUser(userId);
      const fallbackPayload = buildDailyBriefPayload(day, stats, {
        statusBanner: `✅ Task marked completed!`,
      });
      await safeEditMessageText(ctx, fallbackPayload.text, {
        reply_markup: fallbackPayload.reply_markup,
      });
      return res;
    }

    const doneTitle = res.task?.title || res.task?.chapterTitle || "Topic";
    const banner = `✅ Completed: [${res.task?.subject || "Study"}] ~${doneTitle}~`;
    const payload = buildDailyBriefPayload(res.day, res.stats, {
      statusBanner: banner,
    });

    await safeEditMessageText(ctx, payload.text, {
      reply_markup: payload.reply_markup,
    });
    return res;
  }

  // 2. task_partial:<taskId>
  if (data.startsWith("task_partial:")) {
    const taskId = data.slice("task_partial:".length).trim();
    const res = await carryOverPartialTask(userId, taskId);

    const confirmText = "⏳ Logged partial progress! Remaining portion moved to tomorrow.";
    if (!res.ok) {
      await safeEditMessageText(ctx, confirmText);
      return res;
    }

    const payload = buildDailyBriefPayload(res.day, res.stats, {
      statusBanner: `${confirmText} (${res.tomorrowLabel || res.tomorrowDate})`,
    });

    await safeEditMessageText(ctx, payload.text, {
      reply_markup: payload.reply_markup,
    });
    return res;
  }

  // 3. task_reschedule:<taskId>
  if (data.startsWith("task_reschedule:")) {
    const taskId = data.slice("task_reschedule:".length).trim();
    const res = await rescheduleTasks(userId, { taskId });

    if (!res.ok || !res.movedTasks?.length) {
      await safeEditMessageText(
        ctx,
        "🔄 Schedule updated! All remaining tasks are balanced across your upcoming days."
      );
      return res;
    }

    const primaryMove = res.movedTasks[0];
    const extraCount = res.movedTasks.length - 1;
    const moveSummary =
      `🔄 Rescheduled **[${primaryMove.subject}] ${primaryMove.title}** to **${primaryMove.toDayLabel}** (${primaryMove.toDate}, ${primaryMove.startTime}–${primaryMove.endTime})` +
      (extraCount > 0 ? ` (+${extraCount} overdue task(s) balanced across upcoming days).` : " — your daily workload stays balanced!");

    const payload = buildDailyBriefPayload(res.day, res.stats, {
      statusBanner: moveSummary,
    });

    await safeEditMessageText(ctx, payload.text, {
      reply_markup: payload.reply_markup,
    });
    return res;
  }

  // 4. pomo_start:<taskId>:<minutes>
  if (data.startsWith("pomo_start:")) {
    const parts = data.split(":");
    const taskId = parts[1] || null;
    const mins = parseInt(parts[2] || "25", 10) || 25;
    return await startPomodoroForUser({
      chatId: ctx.chat?.id ?? userId,
      telegramUserId: ctx.from?.id ?? userId,
      taskId,
      durationMins: mins,
      ctx,
    });
  }

  // 5. pomo_finish:<sessionId>
  if (data.startsWith("pomo_finish:")) {
    const sessionId = data.slice("pomo_finish:".length).trim();
    return await completePomodoroSession(sessionId, { early: true, ctx });
  }

  // 6. pomo_cancel:<sessionId>
  if (data.startsWith("pomo_cancel:")) {
    const sessionId = data.slice("pomo_cancel:".length).trim();
    return await cancelPomodoroSession(sessionId, { ctx });
  }

  // 7. pomo_break:<minutes>
  if (data.startsWith("pomo_break:")) {
    const mins = Math.max(1, Math.min(60, parseInt(data.slice("pomo_break:".length), 10) || 5));
    const breakId = `brk_${Date.now().toString(36).slice(-6)}`;
    const breakText = `☕ **${mins}-Minute Break Started!** Step away from your screen, stretch, and hydrate—I'll ping you when break time is up!`;

    await safeEditMessageText(ctx, breakText, {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✖️ End Break Early",
              callback_data: buildSafeCallbackData("pomo_cancel", breakId),
            },
          ],
        ],
      },
    });

    await createPomodoroSession({
      id: breakId,
      telegramUserId: ctx.from?.id ?? userId,
      chatId: ctx.chat?.id ?? userId,
      taskId: null,
      subject: "Break",
      topicTitle: `${mins}m Recharge Break`,
      durationMins: mins,
      status: "break",
    });

    const resolvedApi = ctx?.api || (TELEGRAM_BOT_TOKEN ? new Api(TELEGRAM_BOT_TOKEN) : null);
    const chatId = ctx.chat?.id ?? userId;
    const timer = setTimeout(async () => {
      activeTimers.delete(breakId);
      await updatePomodoroSession(breakId, {
        status: "completed",
        completedAt: new Date().toISOString(),
      }).catch(() => {});
      if (resolvedApi && typeof resolvedApi.sendMessage === "function") {
        await resolvedApi
          .sendMessage(
            chatId,
            "🔔 ☕ **Break Time's Up!** Ready to jump back into your study plan? Tap /today or /pomodoro to continue!",
            { disable_notification: false }
          )
          .catch(() => {});
      }
    }, mins * getTimerMsPerMinute());

    if (typeof timer.unref === "function") timer.unref();
    activeTimers.set(breakId, timer);

    return { ok: true, breakId, durationMins: mins, text: breakText };
  }
}

// ---------------------------------------------------------------------------
// 4. Existing Syllabus & NCERT PDF Intake Handlers (Preserved Intact)
// ---------------------------------------------------------------------------

/** Shared by text and PDF fallback: parse, save, reply. */
async function processSyllabus(ctx, parseFn, payload, hintText, fileName = "") {
  const group = inGroup(ctx);

  if (group && !SYLLABUS_HINTS.test(hintText)) {
    console.log("Ignored: no syllabus keywords found");
    return;
  }

  const apiKey = await getUserKeys(ctx.from.id);
  if (!apiKey.length && !GEMINI_API_KEY) {
    console.log(`No Gemini key for user ${ctx.from.id}`);
    await ctx.reply(
      "I need your Gemini API key first. Add it on the setup page, or in a private chat with me send:\n/setkey YOUR_KEY"
    );
    return;
  }

  if (!group) {
    await ctx.reply("Got it, reading your document...");
  }
  await ctx.replyWithChatAction("typing");

  let syllabus;
  try {
    syllabus = await parseFn(payload, apiKey, fileName);
  } catch (e) {
    console.log(`Parse error: ${e.message}`);
    const inferred = inferNcertFromFilename(fileName || hintText);
    if (inferred) {
      syllabus = inferred;
    } else {
      if (!group) {
        await ctx.reply(`Sorry, I couldn't read that: ${e.message}`);
      }
      return;
    }
  }

  if (!syllabus?.subjects?.length) {
    const inferred = inferNcertFromFilename(fileName || hintText);
    if (inferred) {
      syllabus = inferred;
    } else {
      const fallbackTitle = fileName
        ? String(fileName).replace(/\.pdf$/i, "").trim()
        : String(hintText || "Uploaded Study Material").split("\n")[0].slice(0, 60).trim();
      syllabus = {
        class_level: (await getUserClass(ctx.from.id)) || DEFAULT_CLASS_LEVEL,
        exam: "Custom Source",
        subjects: [
          {
            name: "Custom Study",
            chapters: [
              {
                number: 1,
                title: fallbackTitle || "Uploaded Study Material",
                is_ncert: false,
                ncert_book_code: null,
                ncert_chapter_number: null,
                pdf_url: null,
              },
            ],
          },
        ],
      };
    }
  }

  const results = await saveSyllabus(ctx.chat.id, syllabus);
  await scheduleAutoStart(ctx.chat.id, splitSyllabusIntoGranularSubjects(syllabus)).catch((e) =>
    console.log(`Could not schedule chapter generation: ${e.message}`)
  );

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
  const first = ctx.message.entities?.[0];
  if (first && first.type === "bot_command" && first.offset === 0) return;
  await processSyllabus(ctx, parseSyllabus, text, text);
}

/** PDF: find the chapter in ncert_chapters or fall back to parseSyllabusPdf. */
async function processPdf(ctx, pdfBytes, fileName, hint) {
  const group = inGroup(ctx);
  const apiKeys = await getUserKeys(ctx.from.id);
  const classLevel = await getUserClass(ctx.from.id);
  if (!group) {
    await ctx.reply("Got it, finding which chapter this is...");
    await ctx.replyWithChatAction("typing");
  }

  let found = null;
  try {
    found = await identifyChaptersFromPdf({ pdfBytes, fileName, classLevel, apiKeys });
  } catch (e) {
    console.log(`Identify error: ${e.message}`);
  }

  if (found && Array.isArray(found.rows) && found.rows.length > 0) {
    const syllabus = syllabusFromNcertRows(found.rows, classLevel);
    await saveSyllabus(ctx.chat.id, syllabus);
    await enqueueSyllabus(ctx.chat.id, syllabus).catch((e) =>
      console.log(`Could not queue chapter generation: ${e.message}`)
    );

    const lines = found.rows.map(
      (r) =>
        `Ch ${r.number} · ${syllabus.subjects.find((s) => s.chapters.some((c) => c.ncert_id === r.id))?.name} · ${r.title}`
    );
    await ctx.reply("Done!\n" + lines.join("\n"));
    return;
  }

  // Fallback to syllabus PDF parser when ncert_chapters table is empty or offline
  await processSyllabus(ctx, parseSyllabusPdf, pdfBytes, hint, fileName);
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

  await processPdf(ctx, pdfBytes, doc.file_name || "", hint);
}

function onError(err) {
  const error = err.error;
  if (error instanceof HttpError) {
    console.log(`Network hiccup, retrying automatically: ${error.message}`);
    return;
  }
  console.log(`Unexpected error: ${error}`);
}

/**
 * Registers all Study Agent commands, callback_query handlers, and syllabus intake handlers on a Grammy Bot instance.
 */
export function registerBotHandlers(botInstance) {
  if (!botInstance || botInstance._studyAgentHandlersRegistered) {
    return botInstance;
  }
  botInstance._studyAgentHandlersRegistered = true;

  botInstance.command("start", start);
  botInstance.command("help", handleHelpCommand);
  botInstance.command("setkey", setKey);
  botInstance.command("removekey", removeKey);
  botInstance.command("today", handleTodayCommand);
  botInstance.command("reschedule", handleRescheduleCommand);
  botInstance.command("pomodoro", handlePomodoroCommand);

  botInstance.on("callback_query:data", handleCallbackQuery);

  botInstance.on("message:document", (ctx, next) =>
    ctx.message.document.mime_type === "application/pdf" ? handlePdf(ctx) : next()
  );
  botInstance.on("message:text", handleText);
  botInstance.catch(onError);

  return botInstance;
}

/**
 * Creates a configured Grammy Bot instance with all handlers registered.
 */
export function createBot(token = TELEGRAM_BOT_TOKEN) {
  const effectiveToken = token || "000000000:AAH_placeholder_token_for_local_init";
  const instance = new Bot(effectiveToken);
  return registerBotHandlers(instance);
}

export const bot = createBot(TELEGRAM_BOT_TOKEN);

// ---------------------------------------------------------------------------
// 5. Local Morning Brief Scheduler (8:00 AM IST) & Cron Auth Helper
// ---------------------------------------------------------------------------
let dailyBriefInterval = null;

export function startDailyBriefScheduler({
  checkIntervalMs = 60_000,
  targetTimeIst = MORNING_BRIEF_TIME || "08:00",
  api = null,
} = {}) {
  if (dailyBriefInterval) return dailyBriefInterval;

  const [targetHour, targetMin] = String(targetTimeIst)
    .split(":")
    .map((n) => parseInt(n, 10));

  dailyBriefInterval = setInterval(async () => {
    try {
      const istNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
      const h = istNow.getHours();
      const m = istNow.getMinutes();
      if (h === (Number.isFinite(targetHour) ? targetHour : 8) && m >= (Number.isFinite(targetMin) ? targetMin : 0) && m <= (Number.isFinite(targetMin) ? targetMin : 0) + 5) {
        const todayYmd = getTodayIstYmd();
        await triggerDailyMorningBriefsForAllUsers({ todayYmd, force: false, api });
      }
    } catch (err) {
      console.log(`Daily morning brief scheduler error: ${err.message}`);
    }
  }, checkIntervalMs);

  if (typeof dailyBriefInterval.unref === "function") {
    dailyBriefInterval.unref();
  }
  return dailyBriefInterval;
}

export function stopDailyBriefScheduler() {
  if (dailyBriefInterval) {
    clearInterval(dailyBriefInterval);
    dailyBriefInterval = null;
  }
}

/**
 * Verifies whether an incoming HTTP cron request is authorized to trigger morning briefs.
 */
export function isCronRequestAuthorized(req, query = {}) {
  const authHeader = String(req?.headers?.authorization || req?.headers?.Authorization || "").trim();
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  const cronHeader = String(req?.headers?.["x-cron-secret"] || "").trim();
  const vercelCron = String(req?.headers?.["x-vercel-cron"] || "").trim();
  const querySecret = String(query?.secret || query?.token || "").trim();

  const provided = bearer || cronHeader || querySecret;
  const expectedSecrets = [CRON_SECRET, process.env.CRON_SECRET, TELEGRAM_BOT_TOKEN].filter(Boolean);

  if (expectedSecrets.length > 0) {
    if (provided && expectedSecrets.includes(provided)) return true;
    // Allow Vercel Cron internal header when CRON_SECRET is not explicitly set
    if (!CRON_SECRET && !process.env.CRON_SECRET && vercelCron === "1") return true;
    // If caller passed a wrong secret/token, reject immediately
    if (provided) return false;
    // If CRON_SECRET is set in env, require it
    if (CRON_SECRET || process.env.CRON_SECRET) return false;
  } else if (provided) {
    return false;
  }

  return true;
}

export async function runBot() {
  await initDb();
  const activeBot = createBot(TELEGRAM_BOT_TOKEN);
  startDailyBriefScheduler({ api: activeBot.api });

  const stop = () => {
    stopDailyBriefScheduler();
    activeBot.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.log(`Bot is running with Gemini model: ${GEMINI_MODEL}. Press Ctrl+C to stop.`);

  let stopping = false;
  process.once("SIGINT", () => (stopping = true));
  process.once("SIGTERM", () => (stopping = true));
  while (!stopping) {
    try {
      await activeBot.start();
      break;
    } catch (e) {
      console.log(`Network hiccup, retrying automatically: ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}