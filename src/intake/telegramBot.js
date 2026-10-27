// src/intake/telegramBot.js
import { Api, Bot, HttpError } from "grammy";

import {
  AGENT_TICK_TIME_EVENING,
  AGENT_TICK_TIME_MORNING,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  TELEGRAM_BOT_TOKEN,
} from "../config.js";

const DEFAULT_CLASS_LEVEL = parseInt(process.env.CLASS_LEVEL ?? "", 10) || 10;
const CRON_SECRET = (process.env.CRON_SECRET ?? "").trim();
const MORNING_BRIEF_TIME =
  (process.env.AGENT_TICK_TIME_MORNING ?? process.env.MORNING_BRIEF_TIME ?? "08:00").trim() || "08:00";
export const QUIET_HOURS_START = (process.env.QUIET_HOURS_START ?? "22:00").trim() || "22:00";
export const QUIET_HOURS_END = (process.env.QUIET_HOURS_END ?? "07:00").trim() || "07:00";

import {
  compactTaskId,
  createPomodoroSession,
  findTaskInPlan,
  getAgentMemory,
  getAllActiveStudyUserIds,
  getDailyProgressStats,
  getMorningBriefSentDate,
  getPomodoroSession,
  getRecentAgentActions,
  getStudyPlanForUser,
  initDb,
  logAgentAction,
  logStudyFocusMinutes,
  patchAgentMemory,
  savePairing,
  setMorningBriefSentDate,
  updatePomodoroSession,
} from "../db.js";
import {
  getNowIstHhMm,
  isQuietHours,
  parseTimeToMinutes,
} from "../agent/quiethours.js";
import * as agentToolsModule from "../agent/tools.js";
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
  addDaysYmd,
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
// Active in-memory timers for sending queued nudges at the first minute after quiet hours end (userId -> Timeout)
const pendingQuietNudgeTimers = new Map();

// ---------------------------------------------------------------------------
// 0. Per-User Quiet Hours, Pause State & Deferred Nudge Helpers
// ---------------------------------------------------------------------------

export function normalizeHhMm(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function getDefaultQuietHours() {
  const rawStart = String(process.env.QUIET_HOURS_START ?? QUIET_HOURS_START ?? "22:00").trim();
  const rawEnd = String(process.env.QUIET_HOURS_END ?? QUIET_HOURS_END ?? "07:00").trim();
  const start = normalizeHhMm(rawStart) || "22:00";
  const end = normalizeHhMm(rawEnd) || "07:00";
  return { start, end, window: `${start}-${end}` };
}

export function validateQuietHoursWindow(input) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return {
      ok: false,
      error: "Please provide a time window in HH:MM-HH:MM format (e.g. /quiet 23:00-06:00).",
    };
  }
  const match = /^(\d{1,2}:\d{2})\s*(?:-|–|—)\s*(\d{1,2}:\d{2})$/.exec(raw);
  if (!match) {
    return {
      ok: false,
      error: "Invalid format. Use 24-hour HH:MM-HH:MM format (for example: /quiet 23:00-06:00).",
    };
  }
  const start = normalizeHhMm(match[1]);
  const end = normalizeHhMm(match[2]);
  if (!start || !end) {
    return {
      ok: false,
      error: "Invalid time values. Hours must be 00–23 and minutes 00–59 (for example: /quiet 23:00-06:00).",
    };
  }
  if (start === end) {
    return {
      ok: false,
      error: "Quiet hours start and end times cannot be identical (for example: /quiet 23:00-06:00).",
    };
  }
  return {
    ok: true,
    start,
    end,
    window: `${start}-${end}`,
  };
}

export function resolveQuietHoursFromMemory(memory = null, fallbackConfig = null) {
  const defaults = getDefaultQuietHours();
  const mem = memory && typeof memory === "object" ? memory : {};
  const cfg = fallbackConfig && typeof fallbackConfig === "object" ? fallbackConfig : {};

  let memStart = normalizeHhMm(mem.quietHoursStart ?? mem.quiet_hours_start ?? "");
  let memEnd = normalizeHhMm(mem.quietHoursEnd ?? mem.quiet_hours_end ?? "");

  if ((!memStart || !memEnd) && mem.quietHours) {
    if (typeof mem.quietHours === "string") {
      const parsed = validateQuietHoursWindow(mem.quietHours);
      if (parsed.ok) {
        memStart = memStart || parsed.start;
        memEnd = memEnd || parsed.end;
      }
    } else if (typeof mem.quietHours === "object") {
      memStart = memStart || normalizeHhMm(mem.quietHours.start ?? "");
      memEnd = memEnd || normalizeHhMm(mem.quietHours.end ?? "");
    }
  }

  const cfgStart = normalizeHhMm(cfg.quietHoursStart ?? "");
  const cfgEnd = normalizeHhMm(cfg.quietHoursEnd ?? "");

  const start = memStart || cfgStart || defaults.start;
  const end = memEnd || cfgEnd || defaults.end;
  const isCustom = Boolean(memStart && memEnd);

  return {
    start,
    end,
    window: `${start}-${end}`,
    isCustom,
  };
}

export async function getUserQuietHours(telegramUserId) {
  const uid = Number(telegramUserId);
  if (!Number.isFinite(uid) || uid <= 0) {
    return { ...getDefaultQuietHours(), isCustom: false };
  }
  const [memory, planRecord] = await Promise.all([
    getAgentMemory(uid).catch(() => ({})),
    getStudyPlanForUser(uid).catch(() => null),
  ]);
  const cfg = planRecord?.config || planRecord?.plan?.config || null;
  return resolveQuietHoursFromMemory(memory, cfg);
}

export async function setUserQuietHours(telegramUserId, windowInput) {
  const uid = Number(telegramUserId);
  if (!Number.isFinite(uid) || uid <= 0) {
    return { ok: false, error: "Invalid user ID." };
  }
  const validated = validateQuietHoursWindow(windowInput);
  if (!validated.ok) return validated;

  const memory = await patchAgentMemory(uid, {
    quietHoursStart: validated.start,
    quietHoursEnd: validated.end,
    quietHours: validated.window,
  });
  return {
    ok: true,
    start: validated.start,
    end: validated.end,
    window: validated.window,
    memory,
  };
}

export function getNextQuietHoursEndDate(now = new Date(), start = undefined, end = undefined) {
  const defaults = getDefaultQuietHours();
  let resolvedEnd = end;
  if (start && typeof start === "object" && !(start instanceof Date)) {
    resolvedEnd = resolveQuietHoursFromMemory(start).end;
  } else if (typeof start === "string" && start.includes("-") && end === undefined) {
    const parsed = validateQuietHoursWindow(start);
    if (parsed.ok) resolvedEnd = parsed.end;
  }
  const endStr = normalizeHhMm(String(resolvedEnd || defaults.end)) || defaults.end;
  const endMins = parseTimeToMinutes(endStr, 7 * 60);

  let baseDate;
  if (now instanceof Date && !Number.isNaN(now.getTime())) {
    baseDate = new Date(now.getTime());
  } else if (typeof now === "string" && /^\d{1,2}:\d{2}(?::\d{2})?$/.test(now.trim())) {
    const todayYmd = getTodayIstYmd();
    const hhmm = now.trim().padStart(5, "0").slice(0, 5);
    baseDate = new Date(`${todayYmd}T${hhmm}:00+05:30`);
  } else {
    const parsed = new Date(now);
    baseDate = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  baseDate.setUTCSeconds(0, 0);
  const nowMins = parseTimeToMinutes(baseDate);
  let diffMins = endMins - nowMins;
  if (diffMins <= 0) {
    diffMins += 1440;
  }
  return new Date(baseDate.getTime() + diffMins * 60_000);
}

export function clearPendingNudgeTimer(telegramUserId) {
  const uid = Number(telegramUserId);
  const existing = pendingQuietNudgeTimers.get(uid);
  if (existing) {
    clearTimeout(existing);
    pendingQuietNudgeTimers.delete(uid);
  }
  if (typeof agentToolsModule.clearPendingNudgeTimer === "function") {
    try {
      agentToolsModule.clearPendingNudgeTimer(uid);
    } catch {}
  }
}

export async function flushPendingNudgesForUser(telegramUserId, options = {}) {
  if (typeof agentToolsModule.flushPendingNudgesForUser === "function") {
    return await agentToolsModule.flushPendingNudgesForUser(telegramUserId, options);
  }
  return { ok: true, sent: [], dropped: [], remaining: [] };
}

export async function reschedulePendingNudgesForUser(telegramUserId, options = {}) {
  if (typeof agentToolsModule.reschedulePendingNudgesForUser === "function") {
    return await agentToolsModule.reschedulePendingNudgesForUser(telegramUserId, options);
  }
  return { ok: true, updated: 0 };
}

export async function flushAllPendingNudges(options = {}) {
  if (typeof agentToolsModule.flushAllPendingNudges === "function") {
    return await agentToolsModule.flushAllPendingNudges(options);
  }
  return { ok: true, results: [] };
}

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
  const { hasSyllabus, hasPlan, day, stats, plan } = await getTodayScheduleForUser(numericChatId, {
    todayYmd,
    forceRegenerate: Boolean(options.forceRegenerate),
  });

  if (!hasPlan || !plan || !day) {
    const noPlanText = !hasSyllabus
      ? "📭 *You don't have any study plans saved yet* (and no syllabus has been processed yet).\nUpload your syllabus first and generate a study plan on the Web Planner to get started!"
      : "📭 *You don't have any study plans saved yet.*\nGenerate and save your study plan on the Web Planner first, then use /today here!";
    let sentMessage = null;
    if (options.ctx && typeof options.ctx.reply === "function") {
      sentMessage = await options.ctx.reply(noPlanText);
    }
    return {
      ok: false,
      noSyllabus: !hasSyllabus,
      noPlan: true,
      skipped: true,
      reason: !hasSyllabus ? "no_syllabus" : "no_plan",
      chatId: numericChatId,
      date: todayYmd,
      text: options.ctx ? noPlanText : null,
      reply_markup: null,
      message: sentMessage,
      day: null,
      stats: null,
      plan: null,
    };
  }

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
  delayMs = 50,
} = {}) {
  const targetIds = chatId != null ? [Number(chatId)] : await getAllActiveStudyUserIds();
  const results = [];
  let sentCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < targetIds.length; i++) {
    const id = targetIds[i];
    if (!Number.isFinite(id) || id <= 0) continue;
    if (i > 0 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    try {
      const memory = await getAgentMemory(id).catch(() => ({}));
      if (memory?.paused) {
        skippedCount++;
        results.push({ chatId: id, status: "paused", date: todayYmd });
        continue;
      }
      if (!force && chatId == null) {
        const lastSent = await getMorningBriefSentDate(id);
        if (lastSent === todayYmd) {
          skippedCount++;
          results.push({ chatId: id, status: "already_sent", date: todayYmd });
          continue;
        }
      }
      const res = await sendDailyMorningBrief(id, { todayYmd, api });
      if (res?.noSyllabus || res?.skipped || !res?.ok) {
        skippedCount++;
        results.push({ chatId: id, status: res?.reason || "no_syllabus", date: todayYmd });
        continue;
      }
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
    const { hasSyllabus, hasPlan, plan, day } = await getTodayScheduleForUser(uid);
    if (!hasPlan || !plan) {
      const noPlanText = !hasSyllabus
        ? "📭 *You don't have any study plans saved yet* (and no syllabus has been processed yet).\nUpload your syllabus first and generate a study plan on the Web Planner to get started!"
        : "📭 *You don't have any study plans saved yet.*\nGenerate and save your study plan on the Web Planner first to start focus sessions!";
      let sentMsg = null;
      if (ctx && typeof ctx.reply === "function") {
        sentMsg = await ctx.reply(noPlanText);
      }
      return {
        ok: false,
        noSyllabus: !hasSyllabus,
        noPlan: true,
        error: noPlanText,
        text: noPlanText,
        message: sentMsg,
      };
    }
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
// 3. Command & Callback Query Handlers (Including Student Controls)
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
        `• /reschedule — Dynamically rebalance unfinished tasks\n` +
        `• /quiet [HH:MM-HH:MM] — View or change quiet hours\n` +
        `• /pause & /resume — Pause or resume proactive agent actions\n` +
        `• /agentlog — View recent agent actions`
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
      `• /quiet [HH:MM-HH:MM] — Show or update your quiet-hours window\n` +
      `• /pause & /resume — Pause or resume all agent actions\n` +
      `• /agentlog — Show the last 5 agent actions in plain language\n` +
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
 * `/help` command handler: displays all available bot commands, student controls, 1-tap study actions, and syllabus intake tips.
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
    "🎛️ *Student Agent Controls*",
    "• /pause — Pause all proactive agent nudges, scheduled ticks, and actions",
    "• /resume — Resume proactive agent coaching and scheduled actions",
    "• /quiet `[HH:MM-HH:MM]` — Show or change your quiet-hours window (e.g. `/quiet 23:00-06:00`)",
    "• /agentlog — Show the last 5 agent actions in plain, friendly language",
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
 * `/pause` command handler: sets `paused: true` in `agent_memory` so every tick and tool becomes a no-op for this user.
 */
export async function handlePauseCommand(ctx) {
  const userId = Number(ctx.from?.id ?? ctx.chat?.id);
  clearPendingNudgeTimer(userId);
  const memory = await patchAgentMemory(userId, {
    paused: true,
    pausedAt: new Date().toISOString(),
  });
  const text =
    "⏸️ *Study Agent Paused*\n" +
    "All proactive nudges, scheduled ticks, and agent actions are now paused for your account. " +
    "Send /resume anytime when you're ready to turn them back on.";
  await ctx.reply(text);
  return { ok: true, paused: true, telegramUserId: userId, memory, text };
}

/**
 * `/resume` command handler: sets `paused: false` in `agent_memory` to re-enable ticks and tools for this user.
 */
export async function handleResumeCommand(ctx) {
  const userId = Number(ctx.from?.id ?? ctx.chat?.id);
  const memory = await patchAgentMemory(userId, {
    paused: false,
    resumedAt: new Date().toISOString(),
  });
  const text =
    "▶️ *Study Agent Resumed*\n" +
    "Welcome back! Proactive study check-ins and scheduled agent actions are active again. " +
    "Use /today to check your plan or /pause anytime.";
  await ctx.reply(text);
  return { ok: true, paused: false, telegramUserId: userId, memory, text };
}

function extractCommandArgs(ctx, commandName) {
  if (typeof ctx?.match === "string") {
    return ctx.match.trim();
  }
  const rawText = String(ctx?.message?.text || "").trim();
  const re = new RegExp(`^\\/${commandName}(?:@[\\w_]+)?(?:\\s+([\\s\\S]*))?$`, "i");
  const m = re.exec(rawText);
  return m && m[1] ? m[1].trim() : "";
}

/**
 * `/quiet [HH:MM-HH:MM]` command handler: shows or updates the user's quiet-hours window in `agent_memory`.
 */
export async function handleQuietCommand(ctx) {
  const userId = Number(ctx.from?.id ?? ctx.chat?.id);
  const rawArg = extractCommandArgs(ctx, "quiet");

  if (!rawArg) {
    const current = await getUserQuietHours(userId);
    const nowIst = getNowIstHhMm(new Date());
    const activeNow = isQuietHours(nowIst, current.start, current.end);
    const sourceLabel = current.isCustom ? "custom setting" : "default setting";
    const statusLabel = activeNow ? "🌙 Currently in quiet hours" : "☀️ Currently outside quiet hours";
    const text =
      `🔕 *Quiet Hours: ${current.start}-${current.end} IST* (${sourceLabel})\n` +
      `${statusLabel} (current time: ${nowIst} IST).\n\n` +
      `To change your quiet-hours window, send:\n` +
      `/quiet HH:MM-HH:MM (for example: /quiet 23:00-06:00)`;
    await ctx.reply(text);
    return {
      ok: true,
      mode: "show",
      start: current.start,
      end: current.end,
      window: current.window,
      isCustom: current.isCustom,
      inQuietHours: activeNow,
      text,
    };
  }

  const validation = validateQuietHoursWindow(rawArg);
  if (!validation.ok) {
    const errText = `⚠️ ${validation.error}`;
    await ctx.reply(errText);
    return {
      ok: false,
      error: validation.error,
      text: errText,
    };
  }

  const saved = await setUserQuietHours(userId, validation.window);
  await reschedulePendingNudgesForUser(userId, { api: ctx?.api || null }).catch(() => {});

  const nowIst = getNowIstHhMm(new Date());
  const activeNow = isQuietHours(nowIst, saved.start, saved.end);
  const text =
    `🔕 *Quiet hours updated to ${saved.window} IST*\n` +
    `Proactive nudges will be held between *${saved.start}* and *${saved.end}* IST ` +
    `(and sent at ${saved.end} if still relevant, or dropped if stale).` +
    (activeNow ? "\n🌙 Quiet hours are currently active right now." : "");
  await ctx.reply(text);

  return {
    ok: true,
    mode: "update",
    start: saved.start,
    end: saved.end,
    window: saved.window,
    inQuietHours: activeNow,
    memory: saved.memory,
    text,
  };
}

// ---------------------------------------------------------------------------
// Friendly `/agentlog` Formatting Helpers (Plain English, Never Raw JSON)
// ---------------------------------------------------------------------------

function formatDateToWeekday(ymd) {
  if (!ymd || typeof ymd !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00+05:30`);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
  }).format(d);
}

function formatDateIstYmd(date = new Date()) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date(date);
  const valid = Number.isNaN(d.getTime()) ? new Date() : d;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(valid);
  const y = parts.find((p) => p.type === "year")?.value || "2026";
  const m = parts.find((p) => p.type === "month")?.value || "01";
  const day = parts.find((p) => p.type === "day")?.value || "01";
  return `${y}-${m}-${day}`;
}

function formatActionTimestampFriendly(createdAt, now = new Date()) {
  const nowDate = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const actionDate = createdAt instanceof Date ? createdAt : new Date(createdAt || Date.now());
  const validDate = Number.isNaN(actionDate.getTime()) ? nowDate : actionDate;

  const todayYmd = formatDateIstYmd(nowDate);
  const yesterdayYmd = addDaysYmd(todayYmd, -1);
  const actionYmd = formatDateIstYmd(validDate);

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(validDate);
  const hourNum = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10) % 24;
  const minuteStr = parts.find((p) => p.type === "minute")?.value || "00";
  const timeStr = `${hourNum}:${minuteStr}`;

  if (actionYmd === todayYmd) {
    return `Today ${timeStr}`;
  }
  if (actionYmd === yesterdayYmd) {
    return `Yesterday ${timeStr}`;
  }

  const diffDays = Math.round(
    (new Date(`${todayYmd}T00:00:00+05:30`).getTime() -
      new Date(`${actionYmd}T00:00:00+05:30`).getTime()) /
      86_400_000
  );
  if (diffDays > 1 && diffDays <= 6) {
    const weekday = formatDateToWeekday(actionYmd);
    if (weekday) return `${weekday} ${timeStr}`;
  }

  const shortDate = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    month: "short",
    day: "numeric",
  }).format(validDate);
  return `${shortDate} ${timeStr}`;
}

function cleanPlainSnippet(str, maxLen = 70) {
  if (!str) return "";
  const cleaned = String(str)
    .replace(/[\r\n]+/g, " ")
    .replace(/[{}\[\]"]/g, "")
    .replace(/\*+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1).trim()}…`;
}

export function describeAgentActionPlainly(action = {}) {
  const tool = String(action?.tool_name ?? action?.toolName ?? "").trim();
  const status = String(action?.status || "ok").toLowerCase();
  const args = action?.tool_args && typeof action.tool_args === "object" ? action.tool_args : {};
  const result = action?.tool_result && typeof action.tool_result === "object" ? action.tool_result : {};
  const reasoning = String(action?.reasoning || "").trim();
  const messageSent = String(action?.message_sent ?? action?.messageSent ?? "").trim();

  if (tool === "reschedule_missed_tasks") {
    if (status === "pending_confirmation" || result?.requiresConfirmation) {
      const pendingCount = Number(result?.pendingCount) || 4;
      return `asked for confirmation before moving ${pendingCount} missed tasks`;
    }
    if (status === "skipped") {
      if (/declined/i.test(reasoning)) {
        return "cancelled bulk reschedule at your request";
      }
      return "skipped rescheduling tasks";
    }
    if (status === "error") {
      return "tried to reschedule missed tasks but couldn't update the plan";
    }
    const movedTasks = Array.isArray(result?.movedTasks) ? result.movedTasks : [];
    const count =
      Number.isFinite(Number(result?.movedCount))
        ? Number(result.movedCount)
        : movedTasks.length || (args?.taskId ? 1 : 0);

    if (count === 0) {
      return "checked for missed tasks (everything was already on track)";
    }

    const dayNames = [
      ...new Set(
        movedTasks
          .map((m) => {
            if (m?.toDayLabel) {
              return String(m.toDayLabel).split(",")[0].trim();
            }
            return formatDateToWeekday(m?.toDate);
          })
          .filter(Boolean)
      ),
    ];

    const targetLabel =
      dayNames.length === 1
        ? dayNames[0]
        : dayNames.length > 1
        ? dayNames.join(" & ")
        : result?.toDay || formatDateToWeekday(result?.toDate) || "upcoming days";

    return `moved ${count} missed ${count === 1 ? "task" : "tasks"} to ${targetLabel}`;
  }

  if (tool === "carry_over_partial") {
    if (status === "error") {
      return "tried to carry over a half-done task to tomorrow";
    }
    const tomorrowDay = formatDateToWeekday(result?.tomorrowDate) || "tomorrow";
    return `carried over remaining half of a study task to ${tomorrowDay}`;
  }

  if (tool === "send_morning_brief") {
    if (status === "skipped") {
      return "skipped sending the morning study brief";
    }
    const count = Number(result?.tasksCount);
    if (Number.isFinite(count) && count > 0) {
      return `sent your morning study brief (${count} ${count === 1 ? "task" : "tasks"} planned)`;
    }
    return "sent your daily morning study brief";
  }

  if (tool === "send_message") {
    const kind = String(args?.kind || result?.kind || "nudge").toLowerCase();
    const kindLabels = {
      nudge: "study nudge",
      reminder: "study reminder",
      celebration: "progress celebration",
      exam_alert: "exam alert",
    };
    const label = kindLabels[kind] || "study message";

    if (status === "skipped") {
      const skipReason = String(result?.reason || reasoning || "").toLowerCase();
      if (skipReason === "quiet_hours") {
        if (result?.nudgeStatus === "dropped_stale" || result?.dropped) {
          return `dropped a stale ${label} during quiet hours`;
        }
        if (result?.deliverAtHhMm) {
          return `held a ${label} during quiet hours (scheduled for ${result.deliverAtHhMm})`;
        }
        return `held a ${label} because quiet hours were active`;
      }
      if (skipReason === "paused") {
        return `skipped a ${label} while agent was paused`;
      }
      if (skipReason === "max_messages_per_day") {
        return `skipped a ${label} (daily message limit reached)`;
      }
      return `skipped sending a ${label}`;
    }

    const preview = cleanPlainSnippet(messageSent || args?.text || "", 55);
    if (result?.flushedAfterQuietHours) {
      return preview
        ? `sent queued ${label} after quiet hours: "${preview}"`
        : `sent a queued ${label} after quiet hours ended`;
    }
    return preview ? `sent a ${label}: "${preview}"` : `sent a ${label}`;
  }

  if (tool === "update_memory") {
    const keys = Array.isArray(result?.updatedKeys)
      ? result.updatedKeys
      : args?.patch && typeof args.patch === "object"
      ? Object.keys(args.patch)
      : [];
    const cleanKeys = keys
      .filter((k) => k !== "pendingNudges" && k !== "pendingBulkReschedule")
      .map((k) => k.replace(/([A-Z])/g, " $1").replace(/_/g, " ").toLowerCase().trim());
    if (cleanKeys.length > 0) {
      return `updated your study preferences (${cleanKeys.join(", ")})`;
    }
    return "saved a note to your study profile";
  }

  if (tool === "get_snapshot") {
    return "checked your study progress and upcoming schedule";
  }

  if (tool === "do_nothing") {
    const reason = cleanPlainSnippet(args?.reason || result?.reason || reasoning, 60);
    if (reason) {
      const lower = reason.charAt(0).toLowerCase() + reason.slice(1).replace(/\.$/, "");
      return `took no action (${lower})`;
    }
    return "checked in and saw you were on track (no action needed)";
  }

  if (tool === "send_quick_quiz") {
    const topic = cleanPlainSnippet(args?.subtopic || args?.chapter || args?.subject || "", 40);
    return topic ? `sent a quick practice quiz on ${topic}` : "sent a quick practice quiz";
  }

  if (tool === "schedule_review") {
    const topic = cleanPlainSnippet(args?.subtopic || args?.chapter || args?.subject || "", 40);
    const days = Number(args?.intervalDays ?? result?.intervalDays);
    const inDays = Number.isFinite(days) && days > 0 ? ` in ${days} ${days === 1 ? "day" : "days"}` : "";
    return topic
      ? `scheduled a revision check for ${topic}${inDays}`
      : `scheduled a spaced-repetition review${inDays}`;
  }

  if (tool === "send_followup_practice") {
    const topic = cleanPlainSnippet(args?.subtopic || args?.chapter || "", 40);
    return topic
      ? `sent a follow-up practice question on ${topic}`
      : "sent a follow-up practice question";
  }

  if (reasoning && !reasoning.includes("{")) {
    return cleanPlainSnippet(reasoning, 70);
  }

  if (tool) {
    return `ran ${tool.replace(/_/g, " ")}`;
  }

  return "completed a study check-in";
}

/**
 * Formats a single `agent_actions` row into a plain, friendly line:
 * e.g. `"Yesterday 8:00 - moved 2 missed tasks to Thursday"`
 */
export function formatAgentActionFriendly(action, { now = new Date() } = {}) {
  const timeLabel = formatActionTimestampFriendly(action?.created_at ?? action?.createdAt, now);
  const description = describeAgentActionPlainly(action);
  return `${timeLabel} - ${description}`;
}

/**
 * Formats a list of up to 5 `agent_actions` rows into a complete `/agentlog` message.
 */
export function formatAgentLogMessage(actions = [], { now = new Date() } = {}) {
  const slice = (Array.isArray(actions) ? actions : []).slice(0, 5);
  if (!slice.length) {
    return (
      "📋 *Recent Agent Activity*\n" +
      "No agent actions recorded yet! As I help manage your schedule, send morning briefs, or rebalance tasks, your last 5 actions will show up here."
    );
  }

  const lines = [
    "📋 *Last 5 Agent Actions*",
    "",
    ...slice.map((act) => `• ${formatAgentActionFriendly(act, { now })}`),
  ];
  return lines.join("\n");
}

/**
 * `/agentlog` command handler: shows the last 5 `agent_actions` for the user in plain, friendly language.
 */
export async function handleAgentLogCommand(ctx) {
  const userId = Number(ctx.from?.id ?? ctx.chat?.id);
  const actions = await getRecentAgentActions(userId, 5);
  const text = formatAgentLogMessage(actions);
  await ctx.reply(text);
  return {
    ok: true,
    telegramUserId: userId,
    count: actions.length,
    lines: actions.map((a) => formatAgentActionFriendly(a)),
    text,
  };
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
    if (res.noPlan || res.noSyllabus) {
      const msg = res.noSyllabus
        ? "📭 *You don't have any study plans saved yet* (and no syllabus has been processed yet).\nUpload your syllabus first and generate a study plan on the Web Planner to get started!"
        : "📭 *You don't have any study plans saved yet.*\nGenerate and save your study plan on the Web Planner first before rescheduling tasks!";
      await ctx.reply(msg);
      return res;
    }
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

function parseBulkRescheduleCallback(data) {
  const prefixes = [
    "reschedule_confirm:",
    "resched_confirm:",
    "confirm_reschedule:",
    "bulk_reschedule:",
    "bulk_resched_",
  ];
  const matchedPrefix = prefixes.find((p) => data.startsWith(p));
  if (!matchedPrefix) return null;

  const rest = data.slice(matchedPrefix.length).trim();
  const parts = rest.split(":");
  const decisionRaw = String(parts[0] || "").toLowerCase();
  if (decisionRaw !== "yes" && decisionRaw !== "no") return null;

  const rawTarget = parts.slice(1).join(":").trim();
  const taskId = rawTarget && rawTarget !== "all" ? rawTarget : null;
  return {
    decision: decisionRaw,
    taskId,
  };
}

/**
 * Handles all `callback_query` events for 1-tap task updates, bulk reschedule confirmations, dynamic rescheduling, and Pomodoro sessions.
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

  // 0. Bulk reschedule confirmation: reschedule_confirm:yes[:<taskId>] / reschedule_confirm:no[:<taskId>]
  const bulkConfirm = parseBulkRescheduleCallback(data);
  if (bulkConfirm) {
    const memory = await getAgentMemory(userId).catch(() => ({}));
    const pendingInfo = memory?.pendingBulkReschedule || null;
    const resolvedTaskId = bulkConfirm.taskId || pendingInfo?.taskId || null;

    if (bulkConfirm.decision === "no") {
      await patchAgentMemory(userId, { pendingBulkReschedule: null });
      const cancelText = "✖️ Bulk reschedule cancelled. Your current study schedule was kept unchanged.";
      await safeEditMessageText(ctx, cancelText, {
        reply_markup: { inline_keyboard: [] },
      });
      await logAgentAction({
        telegram_user_id: Number(userId),
        tick_type: "event",
        tool_name: "reschedule_missed_tasks",
        tool_args: { taskId: resolvedTaskId, confirmed: false },
        tool_result: { status: "skipped", reason: "user_declined", movedCount: 0, movedTasks: [] },
        message_sent: cancelText,
        reasoning: "Student declined bulk reschedule confirmation",
        status: "skipped",
      }).catch(() => {});

      return {
        ok: true,
        confirmed: false,
        cancelled: true,
        decision: "no",
        movedCount: 0,
        movedTasks: [],
        text: cancelText,
      };
    }

    // decision === "yes": execute the confirmed bulk reschedule
    const res = await rescheduleTasks(userId, { taskId: resolvedTaskId });
    await patchAgentMemory(userId, { pendingBulkReschedule: null });

    if (!res.ok || !res.movedTasks?.length) {
      const msg = "🔄 Schedule checked! All tasks are already balanced across your upcoming days.";
      await safeEditMessageText(ctx, msg, { reply_markup: { inline_keyboard: [] } });
      return { ok: true, confirmed: true, decision: "yes", movedCount: 0, movedTasks: [], text: msg };
    }

    const movedCount = res.movedTasks.length;
    const summaryLines = res.movedTasks
      .slice(0, 5)
      .map((m) => `• **[${m.subject}] ${m.title}** → **${m.toDayLabel}** (${m.toDate})`);
    const banner =
      `✅ **Bulk Reschedule Confirmed (${movedCount} tasks moved)!**\n` +
      summaryLines.join("\n");

    if (res.day && res.stats) {
      const payload = buildDailyBriefPayload(res.day, res.stats, { statusBanner: banner });
      await safeEditMessageText(ctx, payload.text, {
        reply_markup: payload.reply_markup,
      });
    } else {
      await safeEditMessageText(ctx, banner, {
        reply_markup: { inline_keyboard: [] },
      });
    }

    await logAgentAction({
      telegram_user_id: Number(userId),
      tick_type: "event",
      tool_name: "reschedule_missed_tasks",
      tool_args: { taskId: resolvedTaskId, confirmed: true },
      tool_result: {
        status: "ok",
        confirmed: true,
        movedCount,
        movedTasks: res.movedTasks.slice(0, 5).map((m) => ({
          fromId: m.originalTaskId,
          toId: m.newTaskId,
          subject: m.subject,
          title: m.title,
          toDate: m.toDate,
          toDayLabel: m.toDayLabel,
          startTime: m.startTime,
        })),
      },
      message_sent: banner,
      reasoning: `Student confirmed bulk reschedule of ${movedCount} tasks`,
      status: "ok",
    }).catch(() => {});

    return {
      ok: true,
      confirmed: true,
      decision: "yes",
      movedCount,
      movedTasks: res.movedTasks,
      res,
    };
  }

  // 1. task_done:<taskId>
  if (data.startsWith("task_done:")) {
    const taskId = data.slice("task_done:".length).trim();
    const res = await completeStudyTask(userId, taskId);

    if (!res.ok) {
      if (res.noPlan || res.noSyllabus) {
        await safeEditMessageText(
          ctx,
          "📭 *You don't have any study plans saved yet.*\nGenerate and save your study plan on the Web Planner first!"
        );
        return res;
      }
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
      if (res.noPlan || res.noSyllabus) {
        await safeEditMessageText(
          ctx,
          "📭 *You don't have any study plans saved yet.*\nGenerate and save your study plan on the Web Planner first!"
        );
        return res;
      }
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

    if (!res.ok) {
      if (res.noPlan || res.noSyllabus) {
        await safeEditMessageText(
          ctx,
          "📭 *You don't have any study plans saved yet.*\nGenerate and save your study plan on the Web Planner first!"
        );
        return res;
      }
    }

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
 * Registers all Study Agent commands, student controls, callback_query handlers, and syllabus intake handlers on a Grammy Bot instance.
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
  botInstance.command("pause", handlePauseCommand);
  botInstance.command("resume", handleResumeCommand);
  botInstance.command("quiet", handleQuietCommand);
  botInstance.command("agentlog", handleAgentLogCommand);

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
// 5. Local Morning & Evening Tick Scheduler (IST) & Cron Auth Helper
// ---------------------------------------------------------------------------
let dailyBriefInterval = null;

export function startDailyBriefScheduler({
  checkIntervalMs = 60_000,
  targetTimeIst = MORNING_BRIEF_TIME || "08:00",
  eveningTimeIst = AGENT_TICK_TIME_EVENING || "20:00",
  api = null,
} = {}) {
  if (dailyBriefInterval) return dailyBriefInterval;

  const [targetHour, targetMin] = String(targetTimeIst)
    .split(":")
    .map((n) => parseInt(n, 10));
  const [eveningHour, eveningMin] = String(eveningTimeIst)
    .split(":")
    .map((n) => parseInt(n, 10));

  dailyBriefInterval = setInterval(async () => {
    try {
      await flushAllPendingNudges({ now: new Date(), api }).catch(() => {});

      const istNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
      const h = istNow.getHours();
      const m = istNow.getMinutes();
      const todayYmd = getTodayIstYmd();

      if (
        h === (Number.isFinite(targetHour) ? targetHour : 8) &&
        m >= (Number.isFinite(targetMin) ? targetMin : 0) &&
        m <= (Number.isFinite(targetMin) ? targetMin : 0) + 5
      ) {
        const { runMorningTick } = await import("../agent/tick.js");
        await runMorningTick({ todayYmd, force: false, api });
      }

      if (
        h === (Number.isFinite(eveningHour) ? eveningHour : 20) &&
        m >= (Number.isFinite(eveningMin) ? eveningMin : 0) &&
        m <= (Number.isFinite(eveningMin) ? eveningMin : 0) + 5
      ) {
        const { runEveningTick } = await import("../agent/tick.js");
        await runEveningTick({ todayYmd, force: false, api });
      }
    } catch (err) {
      console.log(`Daily study tick scheduler error: ${err.message}`);
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