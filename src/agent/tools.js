// src/agent/tools.js
import { Type } from "@google/genai";
import { Api } from "grammy";
import { z } from "zod";

import { TELEGRAM_BOT_TOKEN } from "../config.js";
import {
  compactTaskId,
  countAgentMessagesToday,
  findTaskInPlan,
  getAgentMemory,
  getAllActiveStudyUserIds,
  getDueReviews,
  getRecentAgentActions,
  getStudyPlanForUser,
  insertFollowup,
  insertReviews,
  logAgentAction,
  patchAgentMemory,
  readLocalStore,
  setMorningBriefSentDate,
  updateReviewStatus,
} from "../db.js";
import { buildSafeCallbackData, sendDailyMorningBrief } from "../intake/telegramBot.js";
import {
  carryOverPartialTask,
  ensureUserStudyPlan,
  getTodayIstYmd,
  rescheduleTasks,
} from "../plannerEngine.js";
import {
  getNextQuietHoursEndDate,
  getNowIstHhMm,
  isQuietHours,
  resolveQuietHoursFromMemory,
} from "./quiethours.js";
import { buildStudentSnapshot } from "./snapshot.js";

const DEFAULT_MAX_MESSAGES_PER_DAY = 3;
const BULK_RESCHEDULE_CONFIRM_THRESHOLD = 3;
// Max age for a queued quiet-hours nudge before it is considered stale (default: 12 hours)
const DEFAULT_STALE_NUDGE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
// Grace window after the quiet-hours end minute before an undelivered nudge is considered stale (default: 60 minutes)
const DEFAULT_STALE_DELIVERY_GRACE_MS = 60 * 60 * 1000;

// In-memory timers keyed by telegramUserId for firing deferred nudges at the first minute after quiet hours end
const pendingNudgeTimers = new Map();

export function isDryRun(ctx = {}) {
  if (typeof ctx?.dryRun === "boolean") return ctx.dryRun;
  const envVal = String(process.env.DRY_RUN ?? process.env.AGENT_DRY_RUN ?? "").trim();
  return /^(1|true|yes)$/i.test(envVal);
}

export function getMaxMessagesPerDay() {
  const raw = process.env.AGENT_MAX_MESSAGES_PER_DAY;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    const parsed = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_MAX_MESSAGES_PER_DAY;
}

function getStaleNudgeMaxAgeMs() {
  const raw = Number(process.env.AGENT_STALE_NUDGE_MAX_AGE_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_STALE_NUDGE_MAX_AGE_MS;
}

function getStaleDeliveryGraceMs() {
  const raw = Number(process.env.AGENT_STALE_DELIVERY_GRACE_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_STALE_DELIVERY_GRACE_MS;
}

function resolveTelegramApi(ctx = {}) {
  if (ctx?.api && typeof ctx.api.sendMessage === "function") {
    return ctx.api;
  }
  if (TELEGRAM_BOT_TOKEN) {
    return new Api(TELEGRAM_BOT_TOKEN);
  }
  return null;
}

function resolveNowDate(nowInput) {
  if (nowInput instanceof Date && !Number.isNaN(nowInput.getTime())) {
    return nowInput;
  }
  if (typeof nowInput === "string" && /^\d{1,2}:\d{2}(?::\d{2})?$/.test(nowInput.trim())) {
    const todayYmd = getTodayIstYmd();
    const hhmm = nowInput.trim().padStart(5, "0").slice(0, 5);
    const parsed = new Date(`${todayYmd}T${hhmm}:00+05:30`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (nowInput !== undefined && nowInput !== null) {
    const parsed = new Date(nowInput);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/**
 * Check whether the user has paused the study agent in `agent_memory`.
 */
export async function isUserPaused(telegramUserId) {
  const uid = Number(telegramUserId);
  if (!Number.isFinite(uid) || uid <= 0) return false;
  const memory = await getAgentMemory(uid).catch(() => ({}));
  return Boolean(memory?.paused);
}

/**
 * Preview which tasks `rescheduleTasks` would move without mutating or saving the study plan.
 */
export async function previewTasksToReschedule(
  telegramUserId,
  { taskId = null, todayYmd = getTodayIstYmd() } = {}
) {
  const uid = Number(telegramUserId);
  let plan = (await getStudyPlanForUser(uid).catch(() => null))?.plan || null;
  if (!plan || !Array.isArray(plan.days) || !plan.days.length) {
    const ensured = await ensureUserStudyPlan(uid, { todayYmd }).catch(() => null);
    plan = ensured?.plan || null;
  }
  if (!plan || !Array.isArray(plan.days)) {
    return { ok: true, tasksToMove: [] };
  }

  const tasksToMove = [];
  if (taskId) {
    const found = findTaskInPlan(plan, taskId);
    if (!found) {
      return { ok: false, error: `Task "${taskId}" not found in your study plan.`, tasksToMove: [] };
    }
    tasksToMove.push(found);

    for (let dIdx = 0; dIdx < plan.days.length; dIdx++) {
      const d = plan.days[dIdx];
      if (!d?.date || d.date >= todayYmd) continue;
      for (let bIdx = 0; bIdx < (d.studyBlocks || []).length; bIdx++) {
        const b = d.studyBlocks[bIdx];
        if (!b.completed && b.status !== "done" && b.status !== "rescheduled" && b.id !== found.block.id) {
          tasksToMove.push({ day: d, dayIndex: dIdx, block: b, blockIndex: bIdx });
        }
      }
    }
  } else {
    for (let dIdx = 0; dIdx < plan.days.length; dIdx++) {
      const d = plan.days[dIdx];
      if (!d?.date || d.date >= todayYmd) continue;
      for (let bIdx = 0; bIdx < (d.studyBlocks || []).length; bIdx++) {
        const b = d.studyBlocks[bIdx];
        if (!b.completed && b.status !== "done" && b.status !== "rescheduled") {
          tasksToMove.push({ day: d, dayIndex: dIdx, block: b, blockIndex: bIdx });
        }
      }
    }

    if (!tasksToMove.length) {
      const todayIdx = plan.days.findIndex((d) => d?.date === todayYmd);
      if (todayIdx >= 0) {
        const d = plan.days[todayIdx];
        for (let bIdx = 0; bIdx < (d.studyBlocks || []).length; bIdx++) {
          const b = d.studyBlocks[bIdx];
          if (!b.completed && b.status !== "done" && b.status !== "rescheduled") {
            tasksToMove.push({ day: d, dayIndex: todayIdx, block: b, blockIndex: bIdx });
          }
        }
      }
    }
  }

  return {
    ok: true,
    tasksToMove: tasksToMove.map((item) => ({
      id: item.block.id,
      subject: item.block.subject || "Study",
      title: item.block.title || item.block.chapterTitle || "Study Session",
      fromDate: item.day.date,
      durationMins: Number(item.block.durationMins) || 45,
    })),
  };
}

/**
 * Strip any model-supplied user/chat ID fields from tool arguments so the model
 * can never override `ctx.telegramUserId`.
 */
function stripUserIdFields(rawArgs) {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return {};
  }
  const copy = { ...rawArgs };
  delete copy.telegramUserId;
  delete copy.telegram_user_id;
  delete copy.userId;
  delete copy.user_id;
  delete copy.chatId;
  delete copy.chat_id;
  return copy;
}

// ---------------------------------------------------------------------------
// 1. Zod Argument Schemas for Every Tool
// ---------------------------------------------------------------------------
export const TOOL_SCHEMAS = {
  get_snapshot: z.object({}).strict(),

  reschedule_missed_tasks: z
    .object({
      taskId: z.string().trim().min(1).optional().nullable(),
      confirmed: z.boolean().optional(),
    })
    .passthrough(),

  carry_over_partial: z.object({
    taskId: z.string().trim().min(1),
  }),

  send_morning_brief: z.object({
    focusAdvice: z.string().trim().min(1),
    quickQuestion: z.string().trim().min(1),
  }),

  send_message: z
    .object({
      text: z.string().trim().min(1),
      kind: z.enum(["nudge", "reminder", "celebration", "exam_alert"]),
      taskId: z.string().trim().optional().nullable(),
      queuedAt: z.string().trim().optional().nullable(),
      expiresAt: z.string().trim().optional().nullable(),
      stale: z.boolean().optional(),
    })
    .passthrough(),

  update_memory: z.object({
    patch: z.record(z.string(), z.unknown()),
  }),

  do_nothing: z.object({
    reason: z.string().trim().min(1),
  }),

  send_quick_quiz: z
    .object({
      subject: z.string().trim().optional(),
      chapter: z.string().trim().optional(),
      subtopic: z.string().trim().optional(),
      question: z.string().trim().optional(),
    })
    .passthrough(),

  schedule_review: z
    .object({
      subject: z.string().trim().optional(),
      chapter: z.string().trim().optional(),
      subtopic: z.string().trim().optional(),
      intervalDays: z.number().int().optional(),
    })
    .passthrough(),

  send_followup_practice: z
    .object({
      question: z.string().trim().optional(),
      subtopic: z.string().trim().optional(),
      chapter: z.string().trim().optional(),
      expectedAnswer: z.string().trim().optional(),
    })
    .passthrough(),
};

// ---------------------------------------------------------------------------
// 2. Gemini Function Declarations (JSON Schemas)
// ---------------------------------------------------------------------------
export const TOOL_DECLARATIONS = [
  {
    name: "get_snapshot",
    description:
      "Fetch the student's current study snapshot (today's tasks, overdue tasks, exam countdowns, weak subtopics, due reviews, and recent activity).",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "reschedule_missed_tasks",
    description:
      "Redistribute a specific unfinished task (or all overdue/unfinished tasks if taskId is omitted) across upcoming days without overloading any day. If more than 3 tasks would be moved, asks the student for confirmation first.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        taskId: {
          type: Type.STRING,
          description: "Optional compact task ID (e.g. 'block_2026-10-26_1') to reschedule; omit to rebalance all overdue tasks.",
        },
      },
    },
  },
  {
    name: "carry_over_partial",
    description:
      "Mark a study task as 50% partially completed today and carry over the remaining 50% to the start of tomorrow's schedule.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        taskId: {
          type: Type.STRING,
          description: "The task ID to mark 50% complete and carry over to tomorrow.",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "send_morning_brief",
    description:
      "Send the interactive Daily Morning Study Brief to the student on Telegram, appending personalized focus advice and a quick active-recall question.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        focusAdvice: {
          type: Type.STRING,
          description: "Concise 1-sentence study focus advice for today (appended after '🎯 Focus today: ').",
        },
        quickQuestion: {
          type: Type.STRING,
          description: "A short active-recall question from a recent or weak topic (appended after '❓ Quick question: ').",
        },
      },
      required: ["focusAdvice", "quickQuestion"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a short proactive Telegram message to the student (automatically blocked during the user's quiet hours or when the daily message limit is reached).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: {
          type: Type.STRING,
          description: "The message text to send to the student.",
        },
        kind: {
          type: Type.STRING,
          enum: ["nudge", "reminder", "celebration", "exam_alert"],
          description: "Category of the proactive message.",
        },
      },
      required: ["text", "kind"],
    },
  },
  {
    name: "update_memory",
    description:
      "Merge new observations or preferences into the student's persistent agent memory object (shallow merge, does not overwrite unrelated keys).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        patch: {
          type: Type.OBJECT,
          description: "Key-value pairs to merge into the student's agent memory.",
        },
      },
      required: ["patch"],
    },
  },
  {
    name: "do_nothing",
    description:
      "Explicitly choose to take no action and send no message on this tick (for example when the student is on track or already received a check-in).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        reason: {
          type: Type.STRING,
          description: "Brief explanation of why silence / no action is the best choice right now.",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "send_quick_quiz",
    description: "Send a quick in-chat micro-quiz on a due review or weak subtopic (respecting quiet hours and daily message caps).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        subject: { type: Type.STRING, description: "Subject name." },
        chapter: { type: Type.STRING, description: "Chapter title." },
        subtopic: { type: Type.STRING, description: "Target subtopic." },
      },
    },
  },
  {
    name: "schedule_review",
    description: "Schedule a spaced-repetition review for a subtopic in review_schedule.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        subject: { type: Type.STRING, description: "Subject name." },
        chapter: { type: Type.STRING, description: "Chapter title." },
        subtopic: { type: Type.STRING, description: "Subtopic to review." },
        intervalDays: { type: Type.INTEGER, description: "Interval in days (1, 3, or 7)." },
      },
    },
  },
  {
    name: "send_followup_practice",
    description: "Send a follow-up practice question and track the open follow-up.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        question: { type: Type.STRING, description: "Follow-up question text." },
        subtopic: { type: Type.STRING, description: "Subtopic name." },
        chapter: { type: Type.STRING, description: "Chapter title." },
        expectedAnswer: { type: Type.STRING, description: "Expected answer summary." },
      },
    },
  },
];

export function getToolDeclarations() {
  return TOOL_DECLARATIONS.map((decl) => ({ ...decl }));
}

// ---------------------------------------------------------------------------
// 3. Quiet Hours & Deferred Nudge Queue Helpers
// ---------------------------------------------------------------------------
export async function getUserQuietHoursStatus(telegramUserId, now = new Date()) {
  const [planRecord, memory] = await Promise.all([
    getStudyPlanForUser(telegramUserId).catch(() => null),
    getAgentMemory(telegramUserId).catch(() => ({})),
  ]);
  const rawConfig = planRecord?.config || planRecord?.plan?.config || null;
  const { start, end, window, isCustom } = resolveQuietHoursFromMemory(memory, rawConfig);
  const nowDate = resolveNowDate(now);
  const nowIst = getNowIstHhMm(nowDate);
  const inQuietHours = isQuietHours(nowIst, start, end);
  const nextEndDate = getNextQuietHoursEndDate(nowDate, start, end);

  return {
    inQuietHours,
    start,
    end,
    window,
    isCustom,
    nowDate,
    nowIst,
    nextEndDate,
    planRecord,
    memory,
  };
}

async function checkUserQuietHours(telegramUserId, now = new Date()) {
  const status = await getUserQuietHoursStatus(telegramUserId, now);
  return status.inQuietHours;
}

/**
 * Determine whether a blocked/queued nudge is stale or still relevant at `now`.
 */
export async function evaluateQueuedNudgeStaleness(
  telegramUserId,
  nudge = {},
  {
    now = new Date(),
    planRecord = null,
    memory = null,
    recentActions = null,
    checkPostQueueActivity = true,
  } = {}
) {
  const uid = Number(telegramUserId);
  const nowDate = resolveNowDate(now);
  const nowMs = nowDate.getTime();

  if (!nudge || typeof nudge !== "object" || !String(nudge.text || "").trim()) {
    return { stale: true, reason: "empty_nudge" };
  }

  if (nudge.stale === true) {
    return { stale: true, reason: "marked_stale" };
  }

  if (nudge.expiresAt) {
    const expMs = new Date(nudge.expiresAt).getTime();
    if (Number.isFinite(expMs) && nowMs > expMs) {
      return { stale: true, reason: "expired" };
    }
  }

  const queuedAtRaw = nudge.queuedAt || nudge.createdAt;
  const queuedAtMs = queuedAtRaw ? new Date(queuedAtRaw).getTime() : nowMs;
  if (Number.isFinite(queuedAtMs) && nowMs - queuedAtMs > getStaleNudgeMaxAgeMs()) {
    return { stale: true, reason: "too_old" };
  }

  if (nudge.deliverAt) {
    const deliverAtMs = new Date(nudge.deliverAt).getTime();
    if (Number.isFinite(deliverAtMs) && nowMs > deliverAtMs + getStaleDeliveryGraceMs()) {
      return { stale: true, reason: "past_delivery_window" };
    }
  }

  const resolvedPlanRecord =
    planRecord !== null ? planRecord : await getStudyPlanForUser(uid).catch(() => null);
  const plan = resolvedPlanRecord?.plan || null;
  const days = Array.isArray(plan?.days) ? plan.days : [];

  // If the nudge references a specific taskId that is already completed or rescheduled, it is stale
  if (nudge.taskId && plan) {
    const found = findTaskInPlan(plan, nudge.taskId);
    if (found?.block) {
      if (found.block.completed || found.block.status === "done" || found.block.status === "rescheduled") {
        return { stale: true, reason: "task_already_completed" };
      }
    }
  }

  // If the nudge text mentions a specific task title that is already completed
  const lowerText = String(nudge.text || "").toLowerCase();
  for (const d of days) {
    for (const b of d?.studyBlocks || []) {
      const title = String(b?.title || b?.chapterTitle || "").trim();
      const isDone = Boolean(b?.completed || b?.status === "done" || b?.status === "rescheduled");
      if (title.length >= 4 && isDone && lowerText.includes(title.toLowerCase())) {
        return { stale: true, reason: "referenced_task_completed" };
      }
      if (checkPostQueueActivity && Number.isFinite(queuedAtMs)) {
        for (const ts of [b?.completedAt, b?.partialLoggedAt, b?.lastFocusedAt]) {
          if (ts) {
            const actMs = new Date(ts).getTime();
            if (Number.isFinite(actMs) && actMs > queuedAtMs && actMs <= nowMs) {
              return { stale: true, reason: "student_completed_task_since_nudge" };
            }
          }
        }
      }
    }
  }

  if (checkPostQueueActivity && Number.isFinite(queuedAtMs)) {
    const store = readLocalStore();
    for (const fl of store.focusLogs || []) {
      if (Number(fl?.telegramUserId) === uid && fl?.loggedAt) {
        const flMs = new Date(fl.loggedAt).getTime();
        if (Number.isFinite(flMs) && flMs > queuedAtMs && flMs <= nowMs) {
          return { stale: true, reason: "student_logged_focus_since_nudge" };
        }
      }
    }

    const actions =
      recentActions !== null ? recentActions : await getRecentAgentActions(uid, 10).catch(() => []);
    for (const act of actions || []) {
      if (
        act &&
        typeof act.message_sent === "string" &&
        act.message_sent.trim().length > 0 &&
        act.status === "ok"
      ) {
        const actMs = new Date(act.created_at).getTime();
        if (Number.isFinite(actMs) && actMs > queuedAtMs && actMs <= nowMs) {
          return { stale: true, reason: "superseded_by_newer_message" };
        }
      }
    }
  }

  return { stale: false, reason: "still_relevant" };
}

export function clearPendingNudgeTimer(telegramUserId) {
  const uid = Number(telegramUserId);
  const existing = pendingNudgeTimers.get(uid);
  if (existing) {
    clearTimeout(existing);
    pendingNudgeTimers.delete(uid);
  }
}

export function schedulePendingNudgeDelivery(
  telegramUserId,
  deliverAtDate,
  { now = new Date(), api = null, dryRun = undefined } = {}
) {
  const uid = Number(telegramUserId);
  if (!Number.isFinite(uid) || uid <= 0) return null;

  clearPendingNudgeTimer(uid);

  const targetDate = deliverAtDate instanceof Date ? deliverAtDate : new Date(deliverAtDate);
  const refNow = resolveNowDate(now);
  const delayMs = Math.max(50, targetDate.getTime() - refNow.getTime());
  // Cap setTimeout to max 24h in ms
  const safeDelayMs = Math.min(delayMs, 24 * 60 * 60 * 1000);

  const timer = setTimeout(() => {
    pendingNudgeTimers.delete(uid);
    flushPendingNudgesForUser(uid, { now: new Date(targetDate.getTime()), api, dryRun }).catch((err) =>
      console.log(`Deferred quiet-hours nudge flush error for user ${uid}: ${err.message}`)
    );
  }, safeDelayMs);

  if (typeof timer.unref === "function") {
    timer.unref();
  }
  pendingNudgeTimers.set(uid, timer);
  return timer;
}

/**
 * Flush any pending quiet-hours nudges for `telegramUserId`:
 *  - Drops stale nudges immediately.
 *  - If the user's quiet-hours window has ended (at or after the first minute after window end),
 *    sends still-relevant nudges and logs them to `agent_actions`.
 */
export async function flushPendingNudgesForUser(
  telegramUserId,
  { now = new Date(), api = null, dryRun = undefined } = {}
) {
  const uid = Number(telegramUserId);
  if (!Number.isFinite(uid) || uid <= 0) {
    return { ok: false, sent: [], dropped: [], remaining: [] };
  }

  const dry = isDryRun({ dryRun });
  const quietStatus = await getUserQuietHoursStatus(uid, now);
  const { memory, planRecord, inQuietHours, nowDate } = quietStatus;

  if (memory?.paused) {
    clearPendingNudgeTimer(uid);
    return { ok: true, paused: true, sent: [], dropped: [], remaining: memory?.pendingNudges || [] };
  }

  const rawQueue = Array.isArray(memory?.pendingNudges) ? memory.pendingNudges : [];
  if (!rawQueue.length) {
    clearPendingNudgeTimer(uid);
    return { ok: true, sent: [], dropped: [], remaining: [] };
  }

  const recentActions = await getRecentAgentActions(uid, 10).catch(() => []);
  const sorted = [...rawQueue].sort(
    (a, b) => new Date(b?.queuedAt || 0).getTime() - new Date(a?.queuedAt || 0).getTime()
  );

  const sent = [];
  const dropped = [];
  const remaining = [];
  let keptNewestRelevant = false;

  for (const nudge of sorted) {
    const evalRes = await evaluateQueuedNudgeStaleness(uid, nudge, {
      now: nowDate,
      planRecord,
      memory,
      recentActions,
      checkPostQueueActivity: true,
    });

    if (evalRes.stale) {
      dropped.push({ ...nudge, staleReason: evalRes.reason });
      continue;
    }

    // Only the latest relevant nudge should be kept/sent so the student isn't spammed with multiple queued nudges
    if (keptNewestRelevant) {
      dropped.push({ ...nudge, staleReason: "superseded_by_newer_nudge" });
      continue;
    }

    if (inQuietHours) {
      keptNewestRelevant = true;
      remaining.push(nudge);
      continue;
    }

    // Quiet hours have ended and this nudge is still relevant -> send at the first minute after the window ends
    const maxPerDay = getMaxMessagesPerDay();
    const sentToday = await countAgentMessagesToday(uid);
    if (sentToday >= maxPerDay) {
      dropped.push({ ...nudge, staleReason: "max_messages_per_day" });
      continue;
    }

    keptNewestRelevant = true;
    if (!dry) {
      const resolvedApi = resolveTelegramApi({ api });
      if (resolvedApi && typeof resolvedApi.sendMessage === "function") {
        await resolvedApi.sendMessage(uid, nudge.text);
      }
    }

    const actionRecord = await logAgentAction({
      telegram_user_id: uid,
      tick_type: "quiet_hours_flush",
      tool_name: "send_message",
      tool_args: { text: nudge.text, kind: nudge.kind || "nudge" },
      tool_result: {
        status: dry ? "skipped" : "ok",
        kind: nudge.kind || "nudge",
        flushedAfterQuietHours: true,
        queuedAt: nudge.queuedAt || null,
        deliveredAt: nowDate.toISOString(),
      },
      message_sent: dry ? null : nudge.text,
      reasoning: "Sent queued nudge after quiet hours ended",
      status: dry ? "skipped" : "ok",
      created_at: nowDate.toISOString(),
    });

    sent.push({ ...nudge, deliveredAt: nowDate.toISOString(), actionId: actionRecord?.id || null });
  }

  await patchAgentMemory(uid, { pendingNudges: remaining });
  if (!remaining.length) {
    clearPendingNudgeTimer(uid);
  }

  return {
    ok: true,
    inQuietHours,
    sent,
    dropped,
    remaining,
  };
}

/**
 * Re-evaluate and reschedule any pending quiet-hours nudges when a user updates `/quiet HH:MM-HH:MM`.
 */
export async function reschedulePendingNudgesForUser(telegramUserId, { now = new Date(), api = null } = {}) {
  const uid = Number(telegramUserId);
  const status = await getUserQuietHoursStatus(uid, now);
  const queue = Array.isArray(status.memory?.pendingNudges) ? status.memory.pendingNudges : [];
  if (!queue.length) return { ok: true, updated: 0 };

  if (!status.inQuietHours) {
    return await flushPendingNudgesForUser(uid, { now: status.nowDate, api });
  }

  const nextEndIso = status.nextEndDate.toISOString();
  const updatedQueue = queue.map((n) => ({
    ...n,
    deliverAt: nextEndIso,
    deliverAtHhMm: status.end,
    quietWindow: status.window,
  }));
  await patchAgentMemory(uid, { pendingNudges: updatedQueue });
  schedulePendingNudgeDelivery(uid, status.nextEndDate, { now: status.nowDate, api });
  return { ok: true, updated: updatedQueue.length, deliverAt: nextEndIso, deliverAtHhMm: status.end };
}

/**
 * Flush pending quiet-hours nudges across all active users (called by the periodic scheduler).
 */
export async function flushAllPendingNudges({ now = new Date(), api = null } = {}) {
  const store = readLocalStore();
  const memUserIds = Object.keys(store.agentMemory || {}).map((id) => Number(id));
  const activeIds = await getAllActiveStudyUserIds().catch(() => []);
  const allIds = [...new Set([...memUserIds, ...activeIds])].filter((id) => Number.isFinite(id) && id > 0);

  const results = [];
  for (const uid of allIds) {
    try {
      const res = await flushPendingNudgesForUser(uid, { now, api });
      if (res.sent?.length || res.dropped?.length) {
        results.push({ userId: uid, sent: res.sent.length, dropped: res.dropped.length });
      }
    } catch {}
  }
  return { ok: true, results };
}

// ---------------------------------------------------------------------------
// 4. Executor Map
// ---------------------------------------------------------------------------
export const TOOL_EXECUTORS = {
  async get_snapshot(validArgs, ctx) {
    const uid = Number(ctx.telegramUserId);
    if (await isUserPaused(uid)) {
      return {
        status: "skipped",
        reasoning: "paused",
        messageSent: null,
        result: { status: "skipped", reason: "paused" },
      };
    }
    const snapshot = await buildStudentSnapshot(uid, { now: ctx.now });
    if (isDryRun(ctx)) {
      return {
        status: "skipped",
        reasoning: "dry_run",
        messageSent: null,
        result: { status: "skipped", reason: "dry_run", snapshot },
      };
    }
    return {
      status: "ok",
      reasoning: null,
      messageSent: null,
      result: snapshot,
    };
  },

  async reschedule_missed_tasks(validArgs, ctx) {
    const uid = Number(ctx.telegramUserId);
    const taskId = validArgs.taskId || null;
    if (await isUserPaused(uid)) {
      return {
        status: "skipped",
        reasoning: "paused",
        messageSent: null,
        result: { status: "skipped", reason: "paused", taskId },
      };
    }
    if (isDryRun(ctx)) {
      return {
        status: "skipped",
        reasoning: "dry_run",
        messageSent: null,
        result: { status: "skipped", reason: "dry_run", taskId },
      };
    }

    // Check how many tasks would be moved before executing
    const preview = await previewTasksToReschedule(uid, { taskId });
    if (!preview.ok) {
      return {
        status: "error",
        reasoning: preview.error || "reschedule_failed",
        messageSent: null,
        result: { status: "error", error: preview.error || "Failed to reschedule tasks." },
      };
    }

    const wouldMoveCount = preview.tasksToMove.length;
    const isConfirmed = Boolean(validArgs.confirmed || ctx?.confirmed);

    // Confirmation for big changes: if reschedule_missed_tasks would move > 3 tasks, don't execute;
    // send an inline Yes/No message using buildSafeCallbackData and handle it in handleCallbackQuery.
    if (wouldMoveCount > BULK_RESCHEDULE_CONFIRM_THRESHOLD && !isConfirmed) {
      const targetArg = taskId ? compactTaskId(taskId) : "all";
      const yesCallbackData = buildSafeCallbackData("reschedule_confirm", "yes", targetArg);
      const noCallbackData = buildSafeCallbackData("reschedule_confirm", "no", targetArg);
      const reply_markup = {
        inline_keyboard: [
          [
            {
              text: "✅ Yes, Reschedule All",
              callback_data: yesCallbackData,
            },
            {
              text: "❌ No, Keep Schedule",
              callback_data: noCallbackData,
            },
          ],
        ],
      };

      const taskPreviewLines = preview.tasksToMove
        .slice(0, 5)
        .map((t, i) => `${i + 1}. [${t.subject}] ${t.title}`)
        .join("\n");
      const extraLine =
        wouldMoveCount > 5 ? `\n…and ${wouldMoveCount - 5} more task(s).` : "";

      const confirmText =
        `⚠️ *Confirm Bulk Reschedule (${wouldMoveCount} tasks)*\n` +
        `Rescheduling will move *${wouldMoveCount} unfinished tasks* across your upcoming days:\n\n` +
        `${taskPreviewLines}${extraLine}\n\n` +
        `Would you like me to rebalance these ${wouldMoveCount} tasks now?`;

      await patchAgentMemory(uid, {
        pendingBulkReschedule: {
          taskId: taskId || null,
          count: wouldMoveCount,
          tasks: preview.tasksToMove,
          createdAt: new Date().toISOString(),
        },
      });

      const api = resolveTelegramApi(ctx);
      if (api && typeof api.sendMessage === "function") {
        await api.sendMessage(uid, confirmText, { reply_markup });
      }

      return {
        status: "pending_confirmation",
        reasoning: `Asked confirmation before moving ${wouldMoveCount} tasks (> ${BULK_RESCHEDULE_CONFIRM_THRESHOLD})`,
        messageSent: confirmText,
        result: {
          status: "confirmation_required",
          requiresConfirmation: true,
          confirmationRequired: true,
          pendingCount: wouldMoveCount,
          movedCount: 0,
          movedTasks: [],
          tasksToMove: preview.tasksToMove,
          reply_markup,
        },
      };
    }

    const res = await rescheduleTasks(uid, { taskId });
    if (!res.ok) {
      return {
        status: "error",
        reasoning: res.error || "reschedule_failed",
        messageSent: null,
        result: { status: "error", error: res.error || "Failed to reschedule tasks." },
      };
    }
    return {
      status: "ok",
      reasoning: taskId ? `Rescheduled task ${taskId}` : "Rescheduled overdue tasks",
      messageSent: null,
      result: {
        status: "ok",
        movedCount: Array.isArray(res.movedTasks) ? res.movedTasks.length : 0,
        movedTasks: (res.movedTasks || []).slice(0, 5).map((m) => ({
          fromId: m.originalTaskId,
          toId: m.newTaskId,
          subject: m.subject,
          title: m.title,
          toDate: m.toDate,
          toDayLabel: m.toDayLabel,
          startTime: m.startTime,
        })),
      },
    };
  },

  async carry_over_partial(validArgs, ctx) {
    const uid = Number(ctx.telegramUserId);
    const { taskId } = validArgs;
    if (await isUserPaused(uid)) {
      return {
        status: "skipped",
        reasoning: "paused",
        messageSent: null,
        result: { status: "skipped", reason: "paused", taskId },
      };
    }
    if (isDryRun(ctx)) {
      return {
        status: "skipped",
        reasoning: "dry_run",
        messageSent: null,
        result: { status: "skipped", reason: "dry_run", taskId },
      };
    }
    const res = await carryOverPartialTask(uid, taskId);
    if (!res.ok) {
      return {
        status: "error",
        reasoning: res.error || "carry_over_failed",
        messageSent: null,
        result: { status: "error", taskId, error: res.error || "Failed to carry over partial task." },
      };
    }
    return {
      status: "ok",
      reasoning: `Carried over remaining 50% of ${taskId} to ${res.tomorrowDate}`,
      messageSent: null,
      result: {
        status: "ok",
        taskId,
        carryOverTaskId: res.carryOverBlock?.id || null,
        tomorrowDate: res.tomorrowDate || null,
      },
    };
  },

  async send_morning_brief(validArgs, ctx) {
    const uid = Number(ctx.telegramUserId);
    const { focusAdvice, quickQuestion } = validArgs;
    if (await isUserPaused(uid)) {
      return {
        status: "skipped",
        reasoning: "paused",
        messageSent: null,
        result: { status: "skipped", reason: "paused" },
      };
    }
    if (isDryRun(ctx)) {
      return {
        status: "skipped",
        reasoning: "dry_run",
        messageSent: null,
        result: { status: "skipped", reason: "dry_run" },
      };
    }

    const appendedBanner = [
      `🎯 Focus today: ${focusAdvice}`,
      `❓ Quick question: ${quickQuestion}`,
    ].join("\n");

    const api = resolveTelegramApi(ctx);
    const todayYmd = getTodayIstYmd();
    const briefRes = await sendDailyMorningBrief(uid, {
      todayYmd,
      statusBanner: appendedBanner,
      api,
    });
    await setMorningBriefSentDate(uid, briefRes.date || todayYmd);

    return {
      status: "ok",
      reasoning: "Sent daily morning study brief",
      messageSent: briefRes.text,
      result: {
        status: "ok",
        date: briefRes.date || todayYmd,
        tasksCount: briefRes.stats?.total || 0,
      },
    };
  },

  async send_message(validArgs, ctx) {
    const uid = Number(ctx.telegramUserId);
    const { text, kind } = validArgs;

    const quietStatus = await getUserQuietHoursStatus(uid, ctx?.now);
    if (quietStatus.memory?.paused) {
      return {
        status: "skipped",
        reasoning: "paused",
        messageSent: null,
        result: { status: "skipped", reason: "paused", kind },
      };
    }

    if (isDryRun(ctx)) {
      return {
        status: "skipped",
        reasoning: "dry_run",
        messageSent: null,
        result: { status: "skipped", reason: "dry_run", kind },
      };
    }

    if (quietStatus.inQuietHours) {
      const explicitQueuedAt = validArgs.queuedAt || ctx?.queuedAt || null;
      const candidateNudge = {
        id: `nudge_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        text,
        kind,
        taskId: validArgs.taskId || ctx?.taskId || null,
        forDate: getTodayIstYmd(),
        queuedAt: explicitQueuedAt || quietStatus.nowDate.toISOString(),
        expiresAt: validArgs.expiresAt || ctx?.expiresAt || null,
        stale: Boolean(validArgs.stale || ctx?.stale),
        deliverAt: quietStatus.nextEndDate.toISOString(),
        deliverAtHhMm: quietStatus.end,
        quietWindow: quietStatus.window,
      };

      const staleness = await evaluateQueuedNudgeStaleness(uid, candidateNudge, {
        now: quietStatus.nowDate,
        planRecord: quietStatus.planRecord,
        memory: quietStatus.memory,
        checkPostQueueActivity: Boolean(explicitQueuedAt),
      });

      if (staleness.stale) {
        return {
          status: "skipped",
          reasoning: "quiet_hours",
          messageSent: null,
          result: {
            status: "skipped",
            reason: "quiet_hours",
            kind,
            queued: false,
            dropped: true,
            nudgeStatus: "dropped_stale",
            staleReason: staleness.reason,
          },
        };
      }

      // Replace any older queued nudges with the newest relevant one for the first minute after quiet hours end
      const existingQueue = Array.isArray(quietStatus.memory?.pendingNudges)
        ? quietStatus.memory.pendingNudges
        : [];
      const keptQueue = existingQueue.filter((item) => item && item.text !== text).slice(-2);
      keptQueue.push(candidateNudge);

      await patchAgentMemory(uid, { pendingNudges: keptQueue });
      schedulePendingNudgeDelivery(uid, quietStatus.nextEndDate, {
        now: quietStatus.nowDate,
        api: resolveTelegramApi(ctx),
        dryRun: false,
      });

      return {
        status: "skipped",
        reasoning: "quiet_hours",
        messageSent: null,
        result: {
          status: "skipped",
          reason: "quiet_hours",
          kind,
          queued: true,
          dropped: false,
          nudgeStatus: "scheduled_after_quiet_hours",
          deliverAt: quietStatus.nextEndDate.toISOString(),
          deliverAtHhMm: quietStatus.end,
        },
      };
    }

    const maxPerDay = getMaxMessagesPerDay();
    const sentToday = await countAgentMessagesToday(uid);
    if (sentToday >= maxPerDay) {
      return {
        status: "skipped",
        reasoning: "max_messages_per_day",
        messageSent: null,
        result: {
          status: "skipped",
          reason: "max_messages_per_day",
          messagesSentToday: sentToday,
          limit: maxPerDay,
        },
      };
    }

    const api = resolveTelegramApi(ctx);
    if (api && typeof api.sendMessage === "function") {
      await api.sendMessage(uid, text);
    }

    return {
      status: "ok",
      reasoning: kind,
      messageSent: text,
      result: {
        status: "ok",
        kind,
        messagesSentToday: sentToday + 1,
      },
    };
  },

  async update_memory(validArgs, ctx) {
    const uid = Number(ctx.telegramUserId);
    const { patch } = validArgs;
    if (await isUserPaused(uid)) {
      return {
        status: "skipped",
        reasoning: "paused",
        messageSent: null,
        result: { status: "skipped", reason: "paused", keys: Object.keys(patch) },
      };
    }
    if (isDryRun(ctx)) {
      return {
        status: "skipped",
        reasoning: "dry_run",
        messageSent: null,
        result: { status: "skipped", reason: "dry_run", keys: Object.keys(patch) },
      };
    }
    const merged = await patchAgentMemory(uid, patch);
    return {
      status: "ok",
      reasoning: `Updated memory keys: ${Object.keys(patch).join(", ")}`,
      messageSent: null,
      result: {
        status: "ok",
        updatedKeys: Object.keys(patch),
        memory: merged,
      },
    };
  },

  async do_nothing(validArgs, ctx) {
    const uid = Number(ctx.telegramUserId);
    const { reason } = validArgs;
    if (await isUserPaused(uid)) {
      return {
        status: "skipped",
        reasoning: "paused",
        messageSent: null,
        result: { status: "skipped", reason: "paused", originalReason: reason },
      };
    }
    if (isDryRun(ctx)) {
      return {
        status: "skipped",
        reasoning: "dry_run",
        messageSent: null,
        result: { status: "skipped", reason: "dry_run", originalReason: reason },
      };
    }
    return {
      status: "ok",
      reasoning: reason,
      messageSent: null,
      result: { status: "ok", reason },
    };
  },

  async send_quick_quiz(validArgs, ctx) {
    const uid = Number(ctx.telegramUserId);
    if (await isUserPaused(uid)) {
      return {
        status: "skipped",
        reasoning: "paused",
        messageSent: null,
        result: { status: "skipped", reason: "paused" },
      };
    }
    const dry = isDryRun(ctx);
    if (dry) {
      return {
        status: "skipped",
        reasoning: "dry_run",
        messageSent: null,
        result: { status: "skipped", reason: "dry_run", ...validArgs },
      };
    }

    const quietStatus = await getUserQuietHoursStatus(uid, ctx?.now);
    if (quietStatus.inQuietHours) {
      return {
        status: "skipped",
        reasoning: "quiet_hours",
        messageSent: null,
        result: { status: "skipped", reason: "quiet_hours" },
      };
    }

    const maxPerDay = getMaxMessagesPerDay();
    const sentToday = await countAgentMessagesToday(uid);
    if (sentToday >= maxPerDay) {
      return {
        status: "skipped",
        reasoning: "max_messages_per_day",
        messageSent: null,
        result: {
          status: "skipped",
          reason: "max_messages_per_day",
          messagesSentToday: sentToday,
          limit: maxPerDay,
        },
      };
    }

    const dueList = await getDueReviews(uid, quietStatus.nowDate.toISOString()).catch(() => []);
    const matchedDue =
      dueList.find(
        (r) =>
          !validArgs.subtopic ||
          String(r.subtopic || "").toLowerCase() === String(validArgs.subtopic).toLowerCase()
      ) ||
      dueList[0] ||
      null;

    const subject = validArgs.subject || matchedDue?.subject || "Science";
    const chapter = validArgs.chapter || matchedDue?.chapter_title || "Revision";
    const subtopic = validArgs.subtopic || matchedDue?.subtopic || chapter;
    const questionText =
      validArgs.question ||
      `🧠 *Quick Recall Check (${subject} — ${chapter})*\nIn 1–2 sentences, explain the key idea or formula for *${subtopic}*.`;

    const api = resolveTelegramApi(ctx);
    if (api && typeof api.sendMessage === "function") {
      await api.sendMessage(uid, questionText);
    }

    if (matchedDue?.id) {
      await updateReviewStatus(matchedDue.id, "sent").catch(() => {});
    }

    return {
      status: "ok",
      reasoning: `Sent quick quiz for ${subtopic}`,
      messageSent: questionText,
      result: {
        status: "ok",
        subject,
        chapter,
        subtopic,
        reviewId: matchedDue?.id || null,
        messagesSentToday: sentToday + 1,
      },
    };
  },

  async schedule_review(validArgs, ctx) {
    const uid = Number(ctx.telegramUserId);
    if (await isUserPaused(uid)) {
      return {
        status: "skipped",
        reasoning: "paused",
        messageSent: null,
        result: { status: "skipped", reason: "paused" },
      };
    }
    const dry = isDryRun(ctx);
    const subject = validArgs.subject || "General";
    const chapter = validArgs.chapter || "";
    const subtopic = validArgs.subtopic || chapter || "Core Concept";
    const intervalDays = Math.max(1, Number(validArgs.intervalDays) || 1);

    if (dry) {
      return {
        status: "skipped",
        reasoning: "dry_run",
        messageSent: null,
        result: {
          status: "skipped",
          reason: "dry_run",
          subject,
          chapter,
          subtopic,
          intervalDays,
        },
      };
    }

    const nowDate = resolveNowDate(ctx?.now);
    const dueAt = new Date(nowDate.getTime() + intervalDays * 86_400_000).toISOString();
    const inserted = await insertReviews(uid, [
      {
        telegram_user_id: uid,
        subject,
        chapter_title: chapter,
        subtopic,
        interval_days: intervalDays,
        due_at: dueAt,
        status: "pending",
      },
    ]);

    return {
      status: "ok",
      reasoning: `Scheduled review for ${subtopic} in ${intervalDays} day(s)`,
      messageSent: null,
      result: {
        status: "ok",
        subject,
        chapter,
        subtopic,
        intervalDays,
        dueAt,
        review: inserted[0] || null,
      },
    };
  },

  async send_followup_practice(validArgs, ctx) {
    const uid = Number(ctx.telegramUserId);
    if (await isUserPaused(uid)) {
      return {
        status: "skipped",
        reasoning: "paused",
        messageSent: null,
        result: { status: "skipped", reason: "paused" },
      };
    }
    const dry = isDryRun(ctx);
    if (dry) {
      return {
        status: "skipped",
        reasoning: "dry_run",
        messageSent: null,
        result: { status: "skipped", reason: "dry_run", ...validArgs },
      };
    }

    const quietStatus = await getUserQuietHoursStatus(uid, ctx?.now);
    if (quietStatus.inQuietHours) {
      return {
        status: "skipped",
        reasoning: "quiet_hours",
        messageSent: null,
        result: { status: "skipped", reason: "quiet_hours" },
      };
    }

    const maxPerDay = getMaxMessagesPerDay();
    const sentToday = await countAgentMessagesToday(uid);
    if (sentToday >= maxPerDay) {
      return {
        status: "skipped",
        reasoning: "max_messages_per_day",
        messageSent: null,
        result: {
          status: "skipped",
          reason: "max_messages_per_day",
          messagesSentToday: sentToday,
          limit: maxPerDay,
        },
      };
    }

    const subtopic = validArgs.subtopic || "Key Concept";
    const chapter = validArgs.chapter || "";
    const question =
      validArgs.question || `Practice check: How would you apply ${subtopic}${chapter ? ` in ${chapter}` : ""}?`;

    const row = await insertFollowup({
      telegram_user_id: uid,
      question,
      subtopic,
      chapter_title: chapter,
      expected_answer: validArgs.expectedAnswer || null,
      status: "open",
    });

    const api = resolveTelegramApi(ctx);
    if (api && typeof api.sendMessage === "function") {
      await api.sendMessage(uid, question);
    }

    return {
      status: "ok",
      reasoning: `Sent follow-up practice on ${subtopic}`,
      messageSent: question,
      result: {
        status: "ok",
        followupId: row?.id || null,
        subtopic,
        chapter,
        messagesSentToday: sentToday + 1,
      },
    };
  },
};

/**
 * Validate `args` with Zod, execute the named agent tool for `ctx.telegramUserId`,
 * log the outcome to `agent_actions`, and return the compact JSON result.
 */
export async function executeTool(name, args = {}, ctx = {}) {
  const toolName = String(name || "").trim();
  const uid = Number(ctx?.telegramUserId);
  const tickType = String(ctx?.tickType || "event");

  if (!Number.isFinite(uid) || uid <= 0) {
    throw new Error("executeTool requires a valid numeric ctx.telegramUserId");
  }

  // Every tool becomes a no-op while the user has paused the agent
  if (await isUserPaused(uid)) {
    return {
      status: "skipped",
      reason: "paused",
    };
  }

  const sanitizedArgs = stripUserIdFields(args);
  const executor = TOOL_EXECUTORS[toolName];
  const schema = TOOL_SCHEMAS[toolName];

  if (!executor || !schema) {
    const unknownResult = { status: "error", error: `Unknown tool: ${toolName}` };
    await logAgentAction({
      telegram_user_id: uid,
      tick_type: tickType,
      tool_name: toolName || "unknown",
      tool_args: sanitizedArgs,
      tool_result: unknownResult,
      message_sent: null,
      reasoning: "unknown_tool",
      status: "error",
    });
    return unknownResult;
  }

  const parsed = schema.safeParse(sanitizedArgs);
  if (!parsed.success) {
    const errMsg =
      parsed.error?.issues?.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ") ||
      parsed.error?.message ||
      "Invalid tool arguments";
    const validationResult = { status: "error", error: "invalid_args", message: errMsg };
    await logAgentAction({
      telegram_user_id: uid,
      tick_type: tickType,
      tool_name: toolName,
      tool_args: sanitizedArgs,
      tool_result: validationResult,
      message_sent: null,
      reasoning: errMsg,
      status: "error",
    });
    return validationResult;
  }

  try {
    const outcome = await executor(parsed.data, { ...ctx, telegramUserId: uid, tickType });
    await logAgentAction({
      telegram_user_id: uid,
      tick_type: tickType,
      tool_name: toolName,
      tool_args: parsed.data,
      tool_result: outcome.result,
      message_sent: outcome.messageSent ?? null,
      reasoning: outcome.reasoning ?? null,
      status: outcome.status || "ok",
    });
    return outcome.result;
  } catch (err) {
    const errResult = { status: "error", error: err.message || "Tool execution error" };
    await logAgentAction({
      telegram_user_id: uid,
      tick_type: tickType,
      tool_name: toolName,
      tool_args: parsed.data,
      tool_result: errResult,
      message_sent: null,
      reasoning: err.message || "execution_error",
      status: "error",
    });
    return errResult;
  }
}