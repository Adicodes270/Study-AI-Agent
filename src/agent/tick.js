// src/agent/tick.js
import "../tz.js";
import { Api } from "grammy";

import {
  AGENT_TICK_TIME_EVENING,
  AGENT_TICK_TIME_MORNING,
  TELEGRAM_BOT_TOKEN,
} from "../config.js";
import {
  getAgentMemory,
  getAllActiveStudyUserIds,
  getMorningBriefSentDate,
  getRecentAgentActions,
  hasUserSavedStudyPlan,
  hasUserUploadedSyllabus,
  logAgentAction,
  patchAgentMemory,
} from "../db.js";
import { sendDailyMorningBrief } from "../intake/telegramBot.js";
import { getTodayIstYmd } from "../plannerEngine.js";
import { runAgentForUser } from "./agentloop.js";
import { getNowIstHhMm } from "./quiethours.js";
import { buildStudentSnapshot } from "./snapshot.js";
import { executeTool, flushAllPendingNudges, flushPendingNudgesForUser, isDryRun } from "./tools.js";

export { AGENT_TICK_TIME_EVENING, AGENT_TICK_TIME_MORNING };

const DEFAULT_TICK_DELAY_MS = 50;

export function getMorningTickTimeIst() {
  return (
    (process.env.AGENT_TICK_TIME_MORNING ?? process.env.MORNING_BRIEF_TIME ?? AGENT_TICK_TIME_MORNING ?? "08:00").trim() ||
    "08:00"
  );
}

export function getEveningTickTimeIst() {
  return (process.env.AGENT_TICK_TIME_EVENING ?? AGENT_TICK_TIME_EVENING ?? "20:00").trim() || "20:00";
}

export function getTickDelayMs(overrideDelayMs = undefined) {
  if (overrideDelayMs !== undefined && overrideDelayMs !== null && Number.isFinite(Number(overrideDelayMs))) {
    return Math.max(0, Number(overrideDelayMs));
  }
  const envRaw = process.env.AGENT_TICK_DELAY_MS ?? process.env.AGENT_USER_DELAY_MS;
  if (envRaw !== undefined && envRaw !== null && String(envRaw).trim() !== "") {
    const parsed = parseInt(String(envRaw).trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_TICK_DELAY_MS;
}

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function resolveApi(api = null) {
  if (api && typeof api.sendMessage === "function") return api;
  if (TELEGRAM_BOT_TOKEN) return new Api(TELEGRAM_BOT_TOKEN);
  return null;
}

/**
 * Check whether the given tick ('morning' | 'evening') has already run today (`todayYmd` in IST) for `telegramUserId`.
 */
export async function hasTickRunToday(
  telegramUserId,
  tickType = "morning",
  todayYmd = getTodayIstYmd()
) {
  const uid = Number(telegramUserId);
  if (!Number.isFinite(uid) || uid <= 0) return false;

  const memory = await getAgentMemory(uid).catch(() => ({}));
  if (tickType === "morning") {
    if (memory?.lastMorningTickDate === todayYmd) return true;
    const sentBriefDate = await getMorningBriefSentDate(uid).catch(() => null);
    if (sentBriefDate === todayYmd) return true;
  } else if (tickType === "evening") {
    if (memory?.lastEveningTickDate === todayYmd) return true;
  }

  const recentActions = await getRecentAgentActions(uid, 40).catch(() => []);
  for (const act of recentActions) {
    if (
      act &&
      act.tick_type === tickType &&
      act.status !== "error" &&
      act.reasoning !== "paused" &&
      formatDateIstYmd(act.created_at) === todayYmd
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Record in `agent_memory` that `tickType` ('morning' | 'evening') completed on `todayYmd`.
 */
export async function markTickCompletedToday(
  telegramUserId,
  tickType = "morning",
  todayYmd = getTodayIstYmd()
) {
  const uid = Number(telegramUserId);
  if (!Number.isFinite(uid) || uid <= 0) return null;
  const patch =
    tickType === "evening"
      ? { lastEveningTickDate: todayYmd }
      : { lastMorningTickDate: todayYmd };
  return await patchAgentMemory(uid, patch);
}

/**
 * Deterministic fallback for the evening tick when Gemini is unreachable or returns no actions:
 *  - Checks what was completed today
 *  - Schedules spaced-repetition reviews (`schedule_review`) for weak subtopics
 *  - Sends a quick quiz (`send_quick_quiz`) if one is due
 *  - Sends a gentle nudge or celebration (`send_message`) respecting quiet hours and daily caps
 */
async function runDeterministicEveningActions(
  telegramUserId,
  { api = null, dryRun = false, now = new Date() } = {}
) {
  const uid = Number(telegramUserId);
  const snapshot = await buildStudentSnapshot(uid, { now });
  const actions = [];

  // 1. Schedule spaced-repetition review if the student has a weak subtopic not yet scheduled
  const topWeak = snapshot.weakSubtopics?.[0];
  if (topWeak) {
    const alreadyDue = (snapshot.dueReviews || []).some(
      (r) => String(r.subtopic || "").toLowerCase() === String(topWeak.subtopic || "").toLowerCase()
    );
    if (!alreadyDue) {
      const reviewRes = await executeTool(
        "schedule_review",
        {
          subject: topWeak.subject,
          chapter: topWeak.chapter,
          subtopic: topWeak.subtopic,
          intervalDays: snapshot.examMode === "final_prep" ? 1 : 3,
        },
        { telegramUserId: uid, tickType: "evening", api, dryRun, now }
      );
      actions.push({ tool: "schedule_review", result: reviewRes });
    }
  }

  // 2. Send a quick quiz if a review is due (executeTool enforces quiet hours and daily caps)
  if (Array.isArray(snapshot.dueReviews) && snapshot.dueReviews.length > 0) {
    const due = snapshot.dueReviews[0];
    const quizRes = await executeTool(
      "send_quick_quiz",
      {
        subject: due.subject,
        chapter: due.chapter,
        subtopic: due.subtopic,
      },
      { telegramUserId: uid, tickType: "evening", api, dryRun, now }
    );
    actions.push({ tool: "send_quick_quiz", result: quizRes });
  }

  // 3. Check what was completed today and send a celebration or gentle nudge (respecting quiet hours & daily caps)
  const totalToday = Number(snapshot.progress?.totalToday) || 0;
  const completedToday = Number(snapshot.progress?.completedToday) || 0;

  if (totalToday > 0 && completedToday >= totalToday) {
    const text =
      snapshot.examMode === "final_prep"
        ? `🎉 Amazing work completing all ${completedToday}/${totalToday} tasks today! Do a light 10-minute formula skim if you like, then get a full night's sleep before your exam.`
        : `🎉 Great job completing all ${completedToday}/${totalToday} study blocks today! Rest up well tonight.`;
    const msgRes = await executeTool(
      "send_message",
      { kind: "celebration", text },
      { telegramUserId: uid, tickType: "evening", api, dryRun, now }
    );
    actions.push({ tool: "send_message", kind: "celebration", result: msgRes });
  } else if (totalToday > 0 && completedToday < totalToday) {
    const pendingTask = snapshot.todayTasks?.find((t) => t.status === "pending");
    const text =
      snapshot.examMode === "final_prep"
        ? `🌙 Evening check-in (${completedToday}/${totalToday} done): do a light 15-minute review of "${pendingTask?.title || "key formulas"}" and prioritize getting full sleep tonight!`
        : pendingTask
        ? `🌙 Evening check-in (${completedToday}/${totalToday} done): even 25 minutes on "${pendingTask.title}" (${pendingTask.subject}) will keep your streak going!`
        : `🌙 Evening check-in (${completedToday}/${totalToday} done): a short 25-minute focus block before bed will keep your momentum strong!`;
    const msgRes = await executeTool(
      "send_message",
      { kind: "nudge", text, taskId: pendingTask?.id || null },
      { telegramUserId: uid, tickType: "evening", api, dryRun, now }
    );
    actions.push({ tool: "send_message", kind: "nudge", result: msgRes });
  } else if (actions.length === 0) {
    const noopRes = await executeTool(
      "do_nothing",
      {
        reason: snapshot.isQuietHours
          ? "Quiet hours active during evening tick."
          : "Student is on track; no evening nudge needed.",
      },
      { telegramUserId: uid, tickType: "evening", api, dryRun, now }
    );
    actions.push({ tool: "do_nothing", result: noopRes });
  }

  return { snapshot, actions };
}

/**
 * Run the Morning Tick for a single user (`telegramUserId`).
 * Enforces pause state, idempotency, and deterministic morning brief fallback if Gemini fails.
 */
export async function runMorningTickForUser(
  telegramUserId,
  {
    todayYmd = undefined,
    force = false,
    api = null,
    dryRun = undefined,
    now = new Date(),
    generateFn = null,
    timeoutMs = undefined,
  } = {}
) {
  const uid = Number(telegramUserId);
  if (!Number.isFinite(uid) || uid <= 0) {
    return { ok: false, status: "error", error: `Invalid userId: ${telegramUserId}` };
  }

  const nowDate = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date(now || Date.now());
  const effectiveTodayYmd = todayYmd || formatDateIstYmd(nowDate);
  const dry = isDryRun({ dryRun });
  const resolvedApi = resolveApi(api);

  const memory = await getAgentMemory(uid).catch(() => ({}));
  if (memory?.paused) {
    return {
      ok: true,
      skipped: true,
      paused: true,
      status: "paused",
      reason: "paused",
      tickType: "morning",
      userId: uid,
      chatId: uid,
      date: effectiveTodayYmd,
    };
  }

  const [hasSyllabus, hasPlan] = await Promise.all([
    hasUserUploadedSyllabus(uid),
    hasUserSavedStudyPlan(uid),
  ]);
  if (!hasPlan) {
    const reason = !hasSyllabus ? "no_syllabus" : "no_plan";
    return {
      ok: true,
      skipped: true,
      noSyllabus: !hasSyllabus,
      noPlan: true,
      status: reason,
      reason,
      tickType: "morning",
      userId: uid,
      chatId: uid,
      date: effectiveTodayYmd,
      briefSent: false,
    };
  }

  if (!force && (await hasTickRunToday(uid, "morning", effectiveTodayYmd))) {
    return {
      ok: true,
      skipped: true,
      status: "already_sent",
      reason: "already_sent",
      tickType: "morning",
      userId: uid,
      chatId: uid,
      date: effectiveTodayYmd,
    };
  }

  await flushPendingNudgesForUser(uid, { now: nowDate, api: resolvedApi, dryRun: dry }).catch(() => {});

  const agentRes = await runAgentForUser(uid, {
    tickType: "morning",
    api: resolvedApi,
    dryRun: dry,
    now: nowDate,
    generateFn,
    timeoutMs,
  });

  let fallbackBrief = agentRes?.brief || null;
  const briefSentByAgent =
    Boolean(agentRes?.fallbackBriefSent) ||
    (Array.isArray(agentRes?.actions) &&
      agentRes.actions.some((a) => a.tool === "send_morning_brief" && a.result?.status === "ok")) ||
    (await getMorningBriefSentDate(uid).catch(() => null)) === effectiveTodayYmd;

  // Guarantee that even if Gemini fails (bad key / network error), the morning brief still goes out
  if (!briefSentByAgent && !dry) {
    fallbackBrief = await sendDailyMorningBrief(uid, {
      todayYmd: effectiveTodayYmd,
      api: resolvedApi,
    });
    await logAgentAction({
      telegram_user_id: uid,
      tick_type: "morning",
      tool_name: "send_morning_brief",
      tool_args: { fallback: true },
      tool_result: {
        status: "ok",
        fallback: true,
        date: fallbackBrief.date || effectiveTodayYmd,
        tasksCount: fallbackBrief.stats?.total || 0,
      },
      message_sent: fallbackBrief.text,
      reasoning: "Deterministic morning brief fallback",
      status: "ok",
      created_at: nowDate.toISOString(),
    }).catch(() => {});
  }

  await markTickCompletedToday(uid, "morning", effectiveTodayYmd);

  return {
    ok: true,
    status: "sent",
    tickType: "morning",
    userId: uid,
    chatId: uid,
    date: effectiveTodayYmd,
    usedFallback: Boolean(!agentRes?.ok || agentRes?.fallback || fallbackBrief),
    briefSent: Boolean(briefSentByAgent || fallbackBrief?.ok),
    agentResult: agentRes,
    brief: fallbackBrief,
  };
}

/**
 * Run the Evening Tick for a single user (`telegramUserId`) at `AGENT_TICK_TIME_EVENING` (IST):
 *  - Checks what was completed today
 *  - May send a gentle nudge or celebration (respecting quiet hours and daily caps)
 *  - Schedules spaced-repetition reviews
 *  - May send a quick quiz if one is due
 *  - Enforces the same idempotency and pause rules as the morning tick.
 */
export async function runEveningTickForUser(
  telegramUserId,
  {
    todayYmd = undefined,
    force = false,
    api = null,
    dryRun = undefined,
    now = new Date(),
    generateFn = null,
    timeoutMs = undefined,
  } = {}
) {
  const uid = Number(telegramUserId);
  if (!Number.isFinite(uid) || uid <= 0) {
    return { ok: false, status: "error", error: `Invalid userId: ${telegramUserId}` };
  }

  const nowDate = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date(now || Date.now());
  const effectiveTodayYmd = todayYmd || formatDateIstYmd(nowDate);
  const dry = isDryRun({ dryRun });
  const resolvedApi = resolveApi(api);

  const memory = await getAgentMemory(uid).catch(() => ({}));
  if (memory?.paused) {
    return {
      ok: true,
      skipped: true,
      paused: true,
      status: "paused",
      reason: "paused",
      tickType: "evening",
      userId: uid,
      chatId: uid,
      date: effectiveTodayYmd,
    };
  }

  const [hasSyllabus, hasPlan] = await Promise.all([
    hasUserUploadedSyllabus(uid),
    hasUserSavedStudyPlan(uid),
  ]);
  if (!hasPlan) {
    const reason = !hasSyllabus ? "no_syllabus" : "no_plan";
    return {
      ok: true,
      skipped: true,
      noSyllabus: !hasSyllabus,
      noPlan: true,
      status: reason,
      reason,
      tickType: "evening",
      userId: uid,
      chatId: uid,
      date: effectiveTodayYmd,
    };
  }

  if (!force && (await hasTickRunToday(uid, "evening", effectiveTodayYmd))) {
    return {
      ok: true,
      skipped: true,
      status: "already_sent",
      reason: "already_sent",
      tickType: "evening",
      userId: uid,
      chatId: uid,
      date: effectiveTodayYmd,
    };
  }

  await flushPendingNudgesForUser(uid, { now: nowDate, api: resolvedApi, dryRun: dry }).catch(() => {});

  const agentRes = await runAgentForUser(uid, {
    tickType: "evening",
    api: resolvedApi,
    dryRun: dry,
    now: nowDate,
    generateFn,
    timeoutMs,
  });

  if (agentRes?.skipped && agentRes?.reason === "max_calls_per_user_per_day") {
    return {
      ok: true,
      skipped: true,
      status: "max_calls_per_user_per_day",
      reason: "max_calls_per_user_per_day",
      tickType: "evening",
      userId: uid,
      chatId: uid,
      date: effectiveTodayYmd,
      actions: [],
    };
  }

  let executedActions = Array.isArray(agentRes?.actions) ? agentRes.actions : [];
  let usedFallback = false;

  // If Gemini failed (e.g. bad key / offline) or returned no tool actions, run deterministic evening logic
  if (!agentRes?.ok || agentRes?.fallback || executedActions.length === 0) {
    usedFallback = true;
    const fallbackOut = await runDeterministicEveningActions(uid, {
      api: resolvedApi,
      dryRun: dry,
      now: nowDate,
    });
    executedActions = fallbackOut.actions;
  }

  await markTickCompletedToday(uid, "evening", effectiveTodayYmd);

  return {
    ok: true,
    status: "sent",
    tickType: "evening",
    userId: uid,
    chatId: uid,
    date: effectiveTodayYmd,
    usedFallback,
    actions: executedActions,
    agentResult: agentRes,
  };
}

/**
 * Run either `'morning'` or `'evening'` tick for a single user.
 */
export async function runTickForUser(telegramUserId, tickType = "morning", options = {}) {
  if (String(tickType).toLowerCase() === "evening") {
    return await runEveningTickForUser(telegramUserId, options);
  }
  return await runMorningTickForUser(telegramUserId, options);
}

/**
 * Run a batch tick ('morning' | 'evening') across all active users (or a single `chatId`/`userId`)
 * with identical idempotency and per-user delay rules.
 */
export async function runTick(
  tickType = "morning",
  {
    todayYmd = undefined,
    force = false,
    chatId = null,
    userId = null,
    api = null,
    dryRun = undefined,
    delayMs = undefined,
    now = new Date(),
    generateFn = null,
    timeoutMs = undefined,
  } = {}
) {
  const normalizedType = String(tickType || "morning").toLowerCase() === "evening" ? "evening" : "morning";
  const nowDate = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date(now || Date.now());
  const effectiveTodayYmd = todayYmd || formatDateIstYmd(nowDate);
  const singleTarget = chatId ?? userId ?? null;
  const targetIds =
    singleTarget != null ? [Number(singleTarget)] : await getAllActiveStudyUserIds();
  const effectiveDelayMs = getTickDelayMs(delayMs);

  const results = [];
  let sentCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < targetIds.length; i++) {
    const id = Number(targetIds[i]);
    if (!Number.isFinite(id) || id <= 0) continue;

    if (i > 0 && effectiveDelayMs > 0) {
      await sleep(effectiveDelayMs);
    }

    try {
      const res =
        normalizedType === "evening"
          ? await runEveningTickForUser(id, {
              todayYmd: effectiveTodayYmd,
              force,
              api,
              dryRun,
              now: nowDate,
              generateFn,
              timeoutMs,
            })
          : await runMorningTickForUser(id, {
              todayYmd: effectiveTodayYmd,
              force,
              api,
              dryRun,
              now: nowDate,
              generateFn,
              timeoutMs,
            });

      if (res.skipped) {
        skippedCount++;
      } else if (res.ok) {
        sentCount++;
      }
      results.push(res);
    } catch (err) {
      results.push({
        ok: false,
        userId: id,
        chatId: id,
        tickType: normalizedType,
        status: "error",
        error: err.message,
      });
    }
  }

  return {
    ok: true,
    tickType: normalizedType,
    date: effectiveTodayYmd,
    sentCount,
    skippedCount,
    totalUsers: targetIds.length,
    delayMs: effectiveDelayMs,
    results,
  };
}

export async function runMorningTick(options = {}) {
  return await runTick("morning", options);
}

export async function runEveningTick(options = {}) {
  return await runTick("evening", options);
}

export const triggerMorningTick = runMorningTick;
export const triggerEveningTick = runEveningTick;

function isWithinScheduledWindow(nowHhMm, targetHhMm, windowMins = 5) {
  const [nh, nm] = String(nowHhMm || "00:00").split(":").map((n) => parseInt(n, 10));
  const [th, tm] = String(targetHhMm || "08:00").split(":").map((n) => parseInt(n, 10));
  if (!Number.isFinite(nh) || !Number.isFinite(nm) || !Number.isFinite(th) || !Number.isFinite(tm)) {
    return false;
  }
  const nowTotal = nh * 60 + nm;
  const targetTotal = th * 60 + tm;
  return nowTotal >= targetTotal && nowTotal <= targetTotal + windowMins;
}

let tickSchedulerInterval = null;

/**
 * Starts the IST periodic scheduler that runs:
 *  - Morning tick at `AGENT_TICK_TIME_MORNING` (default 08:00 IST)
 *  - Evening tick at `AGENT_TICK_TIME_EVENING` (default 20:00 IST)
 *  - Deferred quiet-hours nudge flush every minute
 */
export function startAgentTickScheduler({
  checkIntervalMs = 60_000,
  morningTimeIst = undefined,
  eveningTimeIst = undefined,
  api = null,
} = {}) {
  if (tickSchedulerInterval) return tickSchedulerInterval;

  tickSchedulerInterval = setInterval(async () => {
    try {
      const now = new Date();
      await flushAllPendingNudges({ now, api }).catch(() => {});

      const nowHhMm = getNowIstHhMm(now);
      const todayYmd = formatDateIstYmd(now);
      const morningTarget = morningTimeIst || getMorningTickTimeIst();
      const eveningTarget = eveningTimeIst || getEveningTickTimeIst();

      if (isWithinScheduledWindow(nowHhMm, morningTarget, 5)) {
        await runMorningTick({ todayYmd, force: false, api, now });
      }
      if (isWithinScheduledWindow(nowHhMm, eveningTarget, 5)) {
        await runEveningTick({ todayYmd, force: false, api, now });
      }
    } catch (err) {
      console.log(`Agent tick scheduler error: ${err.message}`);
    }
  }, checkIntervalMs);

  if (typeof tickSchedulerInterval.unref === "function") {
    tickSchedulerInterval.unref();
  }
  return tickSchedulerInterval;
}

export function stopAgentTickScheduler() {
  if (tickSchedulerInterval) {
    clearInterval(tickSchedulerInterval);
    tickSchedulerInterval = null;
  }
}