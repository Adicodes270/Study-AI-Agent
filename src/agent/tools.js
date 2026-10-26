// src/agent/tools.js
import { Type } from "@google/genai";
import { Api } from "grammy";
import { z } from "zod";

import { TELEGRAM_BOT_TOKEN } from "../config.js";
import {
  countAgentMessagesToday,
  getAgentMemory,
  getStudyPlanForUser,
  logAgentAction,
  patchAgentMemory,
  setMorningBriefSentDate,
} from "../db.js";
import { sendDailyMorningBrief } from "../intake/telegramBot.js";
import {
  DEFAULT_PLANNER_CONFIG,
  carryOverPartialTask,
  getTodayIstYmd,
  normalizePlannerConfig,
  rescheduleTasks,
} from "../plannerEngine.js";
import { getNowIstHhMm, isQuietHours } from "./quietHours.js";
import { buildStudentSnapshot } from "./snapshot.js";

const DEFAULT_MAX_MESSAGES_PER_DAY = 3;

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

function resolveTelegramApi(ctx = {}) {
  if (ctx?.api && typeof ctx.api.sendMessage === "function") {
    return ctx.api;
  }
  if (TELEGRAM_BOT_TOKEN) {
    return new Api(TELEGRAM_BOT_TOKEN);
  }
  return null;
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

  reschedule_missed_tasks: z.object({
    taskId: z.string().trim().min(1).optional().nullable(),
  }),

  carry_over_partial: z.object({
    taskId: z.string().trim().min(1),
  }),

  send_morning_brief: z.object({
    focusAdvice: z.string().trim().min(1),
    quickQuestion: z.string().trim().min(1),
  }),

  send_message: z.object({
    text: z.string().trim().min(1),
    kind: z.enum(["nudge", "reminder", "celebration", "exam_alert"]),
  }),

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
      "Redistribute a specific unfinished task (or all overdue/unfinished tasks if taskId is omitted) across upcoming days without overloading any day.",
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
      "Send a short proactive Telegram message to the student (automatically blocked during quiet hours 22:00-07:00 IST or when the daily message limit is reached).",
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
    description: "Send a quick in-chat micro-quiz on a weak subtopic (stub).",
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
    description: "Schedule a spaced-repetition review for a subtopic (stub).",
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
    description: "Send a follow-up practice question and track the open follow-up (stub).",
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
// 3. Executor Map
// ---------------------------------------------------------------------------
async function checkUserQuietHours(telegramUserId, now = new Date()) {
  const [planRecord, memory] = await Promise.all([
    getStudyPlanForUser(telegramUserId),
    getAgentMemory(telegramUserId),
  ]);
  const config = normalizePlannerConfig(
    planRecord?.config || planRecord?.plan?.config || DEFAULT_PLANNER_CONFIG
  );
  const quietStart = memory?.quietHoursStart || config?.quietHoursStart || "22:00";
  const quietEnd = memory?.quietHoursEnd || config?.quietHoursEnd || config?.wakeUpTime || "07:00";
  const nowIst = getNowIstHhMm(now);
  return isQuietHours(nowIst, quietStart, quietEnd);
}

export const TOOL_EXECUTORS = {
  async get_snapshot(validArgs, ctx) {
    const uid = Number(ctx.telegramUserId);
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
    if (isDryRun(ctx)) {
      return {
        status: "skipped",
        reasoning: "dry_run",
        messageSent: null,
        result: { status: "skipped", reason: "dry_run", taskId },
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
          startTime: m.startTime,
        })),
      },
    };
  },

  async carry_over_partial(validArgs, ctx) {
    const uid = Number(ctx.telegramUserId);
    const { taskId } = validArgs;
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

    if (isDryRun(ctx)) {
      return {
        status: "skipped",
        reasoning: "dry_run",
        messageSent: null,
        result: { status: "skipped", reason: "dry_run", kind },
      };
    }

    const inQuiet = await checkUserQuietHours(uid, ctx.now);
    if (inQuiet) {
      return {
        status: "skipped",
        reasoning: "quiet_hours",
        messageSent: null,
        result: { status: "skipped", reason: "quiet_hours", kind },
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
    const { reason } = validArgs;
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
    const dry = isDryRun(ctx);
    return {
      status: "skipped",
      reasoning: dry ? "dry_run" : "not_implemented",
      messageSent: null,
      result: dry ? { status: "not_implemented", reason: "dry_run" } : { status: "not_implemented" },
    };
  },

  async schedule_review(validArgs, ctx) {
    const dry = isDryRun(ctx);
    return {
      status: "skipped",
      reasoning: dry ? "dry_run" : "not_implemented",
      messageSent: null,
      result: dry ? { status: "not_implemented", reason: "dry_run" } : { status: "not_implemented" },
    };
  },

  async send_followup_practice(validArgs, ctx) {
    const dry = isDryRun(ctx);
    return {
      status: "skipped",
      reasoning: dry ? "dry_run" : "not_implemented",
      messageSent: null,
      result: dry ? { status: "not_implemented", reason: "dry_run" } : { status: "not_implemented" },
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