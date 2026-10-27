// src/agent/agentLoop.js
import "./tz.js";
import { GoogleGenAI } from "@google/genai";

import { GEMINI_API_KEY, GEMINI_MODEL } from "../config.js";
import {
  getAgentMemory,
  getMorningBriefSentDate,
  getRecentAgentActions,
  logAgentAction,
} from "../db.js";
import { sendDailyMorningBrief } from "../intake/telegramBot.js";
import { getUserKeys } from "../intake/userKeys.js";
import { getTodayIstYmd } from "../plannerEngine.js";
import { buildStudentSnapshot } from "./snapshot.js";
import {
  executeTool,
  flushPendingNudgesForUser,
  getToolDeclarations,
  isDryRun,
} from "./tools.js";

const DEFAULT_MAX_STEPS = 4;
const DEFAULT_MAX_CALLS_PER_USER_PER_DAY = 20;
const DEFAULT_GEMINI_TIMEOUT_MS = 15_000;

export const AGENT_SYSTEM_PROMPT = `You are a caring, concise AI study coach for an Indian CBSE (NCERT) student.

Core Coaching Rules:
1. Choose the single most useful set of actions for right now based on the student's snapshot and tickType ('morning' | 'evening' | 'event'):
   - On 'morning' ticks: rebalance overdue tasks if needed and send the daily morning brief via send_morning_brief.
   - On 'evening' ticks: check what was completed today (progress.completedToday / progress.totalToday), send a gentle nudge or celebration via send_message (respecting quiet hours and daily caps), schedule spaced-repetition reviews via schedule_review for weak subtopics, and send a quick quiz via send_quick_quiz if a review is due (dueReviews).
2. Prefer fewer, higher-value messages. Never nag, guilt-trip, or spam the student.
3. Respect the student's quiet hours (snapshot.isQuietHours) and daily message limits. Never try to message during quiet hours.
4. Adapt your emphasis based on examMode (derived from nearestExamDays):
   - 'learning' (nearest exam > 14 days away, or no upcoming exam): Emphasize steady chapter completion, deep conceptual understanding, and consistent daily habits.
   - 'revision' (within 14 days of an exam, nearestExamDays 4-14): Emphasize revision and practice — prioritize weakSubtopics from recent quizzes, dueReviews, active recall, and targeted practice on low-scoring chapters rather than starting heavy new topics.
   - 'final_prep' (within 3 days of an exam, nearestExamDays <= 3): Emphasize light review plus sleep — focus on light, confidence-building review of key formulas, definitions, and summaries, avoid heavy cramming or overloading the schedule, and explicitly encourage getting full sleep and rest before the exam.
5. Never invent or guess task IDs. Only pass a taskId to reschedule_missed_tasks or carry_over_partial if that exact id appears in todayTasks or overdueTasks.
6. Only act through tools. Plain text responses are never sent to the student on Telegram.
7. Calling do_nothing({ reason }) is always a valid, respected choice whenever the student is on track, in quiet hours, or doesn't need an intervention right now.`;

const genClients = new Map();
function getGenClient(apiKey) {
  if (!genClients.has(apiKey)) {
    genClients.set(apiKey, new GoogleGenAI({ apiKey }));
  }
  return genClients.get(apiKey);
}

export function getAgentMaxSteps() {
  const raw = process.env.AGENT_MAX_STEPS;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    const parsed = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.min(10, parsed);
  }
  return DEFAULT_MAX_STEPS;
}

export function getAgentMaxCallsPerUserPerDay() {
  const raw = process.env.AGENT_MAX_CALLS_PER_USER_PER_DAY;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    const parsed = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_MAX_CALLS_PER_USER_PER_DAY;
}

/**
 * Build explicit exam-mode coaching guidance for the prompt based on `snapshot.examMode` and `snapshot.nearestExamDays`.
 */
export function buildExamModeGuidance(snapshot = {}) {
  const mode = snapshot?.examMode || "learning";
  const days = snapshot?.nearestExamDays;
  if (mode === "final_prep" || (Number.isFinite(days) && days <= 3)) {
    return "EXAM MODE: final_prep (exam within 3 days). Emphasize light review of high-yield formulas/summaries plus plenty of sleep and rest. Avoid heavy cramming.";
  }
  if (mode === "revision" || (Number.isFinite(days) && days <= 14)) {
    return "EXAM MODE: revision (exam within 14 days). Emphasize revision and practice on weakSubtopics and dueReviews.";
  }
  return "EXAM MODE: learning (>14 days to exam). Emphasize steady chapter progress and conceptual clarity.";
}

/**
 * Count how many `agent_actions` rows have been recorded for `telegramUserId` since 00:00:00 today (IST).
 */
export async function countAgentActionsToday(telegramUserId) {
  const uid = Number(telegramUserId);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startMs = startOfToday.getTime();

  const recent = await getRecentAgentActions(uid, 500);
  let count = 0;
  for (const row of recent) {
    const ts = new Date(row.created_at).getTime();
    if (Number.isFinite(ts) && ts >= startMs) {
      count++;
    }
  }
  return count;
}

function extractFunctionCalls(response) {
  if (Array.isArray(response?.functionCalls) && response.functionCalls.length > 0) {
    return response.functionCalls.map((fc) => ({
      name: fc.name,
      args: fc.args && typeof fc.args === "object" ? fc.args : {},
    }));
  }
  const parts = response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const calls = [];
    for (const part of parts) {
      if (part?.functionCall?.name) {
        calls.push({
          name: part.functionCall.name,
          args:
            part.functionCall.args && typeof part.functionCall.args === "object"
              ? part.functionCall.args
              : {},
        });
      }
    }
    return calls;
  }
  return [];
}

function extractModelReasoning(response, functionCalls = []) {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const textParts = parts
      .map((p) => (typeof p?.text === "string" ? p.text.trim() : ""))
      .filter(Boolean);
    if (textParts.length > 0) {
      return textParts.join(" ");
    }
  }
  if (typeof response?.text === "string" && response.text.trim()) {
    return response.text.trim();
  }
  for (const fc of functionCalls) {
    if (fc.args?.reason) return String(fc.args.reason);
    if (fc.args?.focusAdvice) return `Morning brief focus: ${fc.args.focusAdvice}`;
  }
  return null;
}

/**
 * Call Gemini with key rotation (user keys + GEMINI_API_KEY fallback) and a ~15s AbortController timeout.
 */
async function callGeminiWithKeyRotation({
  keys,
  contents,
  toolDeclarations,
  timeoutMs = DEFAULT_GEMINI_TIMEOUT_MS,
  generateFn = null,
}) {
  if (typeof generateFn === "function") {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error("Gemini request timed out")), timeoutMs);
    try {
      return await Promise.race([
        generateFn({
          model: GEMINI_MODEL,
          contents,
          config: {
            systemInstruction: AGENT_SYSTEM_PROMPT,
            tools: [{ functionDeclarations: toolDeclarations }],
            temperature: 0.2,
            abortSignal: ctl.signal,
          },
        }),
        new Promise((_, reject) => {
          ctl.signal.addEventListener(
            "abort",
            () => reject(ctl.signal.reason || new Error("Gemini request timed out")),
            { once: true }
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  if (!keys.length) {
    throw new Error("No Gemini API keys available for agent loop.");
  }

  let lastErr = null;
  for (const key of keys) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error("Gemini request timed out")), timeoutMs);
    try {
      const res = await Promise.race([
        getGenClient(key).models.generateContent({
          model: GEMINI_MODEL,
          contents,
          config: {
            systemInstruction: AGENT_SYSTEM_PROMPT,
            tools: [{ functionDeclarations: toolDeclarations }],
            temperature: 0.2,
            abortSignal: ctl.signal,
          },
        }),
        new Promise((_, reject) => {
          ctl.signal.addEventListener(
            "abort",
            () => reject(ctl.signal.reason || new Error("Gemini request timed out")),
            { once: true }
          );
        }),
      ]);
      return res;
    } catch (err) {
      lastErr = err;
      console.log(`Agent Gemini key ...${String(key).slice(-4)} failed (${err.message}); trying next`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr || new Error("All Gemini keys failed in agent loop.");
}

/**
 * Offline dry-run fallback planner used ONLY when DRY_RUN=true and no live Gemini key is reachable,
 * so `DRY_RUN=true node src/agent/devRun.js <userId> morning` works out-of-the-box in local/offline dev.
 */
function buildOfflineDryRunResponse(snapshot, tickType, stepIndex) {
  if (stepIndex > 0) {
    return {
      text: "Completed initial dry-run action; stopping.",
      functionCalls: [],
    };
  }

  if (snapshot.isQuietHours) {
    return {
      text: "Student is currently in quiet hours; choosing do_nothing.",
      functionCalls: [
        {
          name: "do_nothing",
          args: { reason: "Quiet hours active; avoiding notifications." },
        },
      ],
    };
  }

  if (tickType === "morning") {
    const topWeak = snapshot.weakSubtopics?.[0];
    const focusSubject =
      topWeak?.subject || snapshot.todayTasks?.[0]?.subject || snapshot.exams?.[0]?.subject || "Science";
    const focusTopic =
      topWeak?.subtopic || snapshot.todayTasks?.[0]?.title || "today's first NCERT study block";
    const calls = [];
    if (snapshot.overdueTasks?.length > 0) {
      calls.push({
        name: "reschedule_missed_tasks",
        args: { taskId: snapshot.overdueTasks.length === 1 ? snapshot.overdueTasks[0].id : null },
      });
    }
    const focusAdvice =
      snapshot.examMode === "final_prep"
        ? `Keep today to light review on ${focusSubject} (${focusTopic}) and prioritize full sleep tonight before your exam.`
        : snapshot.examMode === "revision"
        ? `Focus on revision and practice for ${focusSubject} (${focusTopic}) to strengthen weak areas.`
        : `Start with ${focusSubject} (${focusTopic}) during your peak focus block today.`;
    calls.push({
      name: "send_morning_brief",
      args: {
        focusAdvice,
        quickQuestion: topWeak
          ? `Can you state the core principle of ${topWeak.subtopic} in ${topWeak.chapter} in one sentence?`
          : `What is the main formula or takeaway from ${focusTopic}?`,
      },
    });
    return {
      text: `Morning tick (${snapshot.examMode} mode): rebalance any overdue task and send personalized morning study brief.`,
      functionCalls: calls,
    };
  }

  if (tickType === "evening") {
    const calls = [];
    const topWeak = snapshot.weakSubtopics?.[0];
    if (topWeak) {
      const alreadyDue = (snapshot.dueReviews || []).some(
        (r) => String(r.subtopic || "").toLowerCase() === String(topWeak.subtopic || "").toLowerCase()
      );
      if (!alreadyDue) {
        calls.push({
          name: "schedule_review",
          args: {
            subject: topWeak.subject,
            chapter: topWeak.chapter,
            subtopic: topWeak.subtopic,
            intervalDays: snapshot.examMode === "final_prep" ? 1 : 3,
          },
        });
      }
    }

    if (snapshot.dueReviews?.length > 0) {
      const due = snapshot.dueReviews[0];
      calls.push({
        name: "send_quick_quiz",
        args: {
          subject: due.subject,
          chapter: due.chapter,
          subtopic: due.subtopic,
        },
      });
    }

    const totalToday = snapshot.progress?.totalToday || 0;
    const completedToday = snapshot.progress?.completedToday || 0;

    if (totalToday > 0 && completedToday >= totalToday) {
      calls.push({
        name: "send_message",
        args: {
          kind: "celebration",
          text:
            snapshot.examMode === "final_prep"
              ? `Awesome job finishing all ${completedToday}/${totalToday} tasks today! Do a light 10-minute formula skim if you like, then get a full night's sleep.`
              : `Great work completing all ${completedToday}/${totalToday} study blocks today! Get good rest tonight.`,
        },
      });
    } else if (totalToday > 0 && completedToday < totalToday) {
      const pendingTask = snapshot.todayTasks?.find((t) => t.status === "pending");
      calls.push({
        name: "send_message",
        args: {
          kind: "nudge",
          text:
            snapshot.examMode === "final_prep"
              ? `Evening check-in: do a light 15-minute review of "${pendingTask?.title || "key formulas"}" and head to sleep early so you're well-rested for your exam!`
              : pendingTask
              ? `Evening check-in (${completedToday}/${totalToday} done): even 25 minutes on "${pendingTask.title}" (${pendingTask.subject}) will keep your momentum going!`
              : `Evening check-in (${completedToday}/${totalToday} done): wrap up one short revision block before winding down tonight!`,
        },
      });
    }

    if (calls.length > 0) {
      return {
        text: `Evening tick (${snapshot.examMode} mode): checked daily completion, scheduled reviews, and prepared evening coaching actions.`,
        functionCalls: calls,
      };
    }
  }

  return {
    text: "Student is on track; no intervention needed on this tick.",
    functionCalls: [
      {
        name: "do_nothing",
        args: { reason: "Student is on track; no proactive message required." },
      },
    ],
  };
}

/**
 * Run the tool-calling study agent loop for `telegramUserId`.
 * Returns `{ ok: false, fallback: true }` on total Gemini failure so the caller can fall back to deterministic logic
 * (and for `tickType === "morning"`, automatically ensures the deterministic morning brief still goes out).
 */
export async function runAgentForUser(
  telegramUserId,
  {
    tickType = "event",
    api = null,
    dryRun = undefined,
    timeoutMs = DEFAULT_GEMINI_TIMEOUT_MS,
    generateFn = null,
    now = undefined,
  } = {}
) {
  const uid = Number(telegramUserId);
  if (!Number.isFinite(uid) || uid <= 0) {
    return { ok: false, fallback: true, error: `Invalid telegramUserId: ${telegramUserId}` };
  }

  const dry = isDryRun({ dryRun });
  const maxSteps = getAgentMaxSteps();
  const maxCallsPerDay = getAgentMaxCallsPerUserPerDay();

  try {
    // 0. Check if user has paused the agent in agent_memory; every tick is a no-op while paused
    const memory = await getAgentMemory(uid);
    if (memory?.paused) {
      if (dry) {
        console.log(`[Agent DRY_RUN] Agent is paused for user ${uid}; skipping tick (${tickType}).`);
      }
      return {
        ok: true,
        skipped: true,
        paused: true,
        reason: "paused",
        fallback: false,
        dryRun: dry,
        telegramUserId: uid,
        tickType,
        steps: 0,
        stoppedBy: "paused",
        actions: [],
      };
    }

    // Flush any queued quiet-hours nudges that are ready (or drop them if stale)
    await flushPendingNudgesForUser(uid, { now: now || new Date(), api, dryRun: dry }).catch(() => {});

    // 1. Enforce AGENT_MAX_CALLS_PER_USER_PER_DAY via agent_actions
    const callsToday = await countAgentActionsToday(uid);
    if (callsToday >= maxCallsPerDay) {
      if (dry) {
        console.log(
          `[Agent DRY_RUN] Daily call cap reached for user ${uid} (${callsToday}/${maxCallsPerDay}).`
        );
      }
      return {
        ok: true,
        skipped: true,
        reason: "max_calls_per_user_per_day",
        callsToday,
        limit: maxCallsPerDay,
        steps: 0,
        actions: [],
      };
    }

    // 2. Build student snapshot (<2KB, no keys/tokens)
    const snapshot = await buildStudentSnapshot(uid, { now: now || new Date() });
    if (dry) {
      console.log(`\n[Agent DRY_RUN] === Student Snapshot (user=${uid}, tick=${tickType}) ===`);
      console.log(JSON.stringify(snapshot, null, 2));
    }

    // 3. Gather Gemini API keys (user keys + GEMINI_API_KEY fallback)
    const userKeys = await getUserKeys(uid).catch(() => []);
    const allGeminiKeys = [
      ...new Set(
        [...(userKeys || []), GEMINI_API_KEY, (process.env.GEMINI_API_KEY ?? "").trim()].filter(Boolean)
      ),
    ];

    const toolDeclarations = getToolDeclarations();
    const examGuidance = buildExamModeGuidance(snapshot);
    const contents = [
      {
        role: "user",
        parts: [
          {
            text: [
              `Tick type: ${tickType}`,
              examGuidance,
              `Current student snapshot (JSON):`,
              JSON.stringify(snapshot),
              `Choose the single most useful action (or small set of actions) for this student right now using the provided tools, or call do_nothing({ reason }) if no action is needed.`,
            ].join("\n"),
          },
        ],
      },
    ];

    const executedActions = [];
    let stepsRun = 0;
    let stoppedBy = "max_steps";

    for (let step = 0; step < maxSteps; step++) {
      // Re-check paused status before each step in case the user sent /pause mid-tick
      const latestMem = await getAgentMemory(uid);
      if (latestMem?.paused) {
        stoppedBy = "paused";
        break;
      }

      const currentCallsToday = callsToday + executedActions.length;
      if (currentCallsToday >= maxCallsPerDay) {
        stoppedBy = "max_calls_per_user_per_day";
        break;
      }

      let response;
      try {
        response = await callGeminiWithKeyRotation({
          keys: allGeminiKeys,
          contents,
          toolDeclarations,
          timeoutMs,
          generateFn,
        });
      } catch (err) {
        if (dry && !generateFn && process.env.AGENT_DISABLE_DRY_RUN_SIMULATION !== "true") {
          response = buildOfflineDryRunResponse(snapshot, tickType, step);
        } else {
          throw err;
        }
      }

      stepsRun++;
      const functionCalls = extractFunctionCalls(response);
      const reasoning = extractModelReasoning(response, functionCalls);

      if (dry && reasoning) {
        console.log(`[Agent DRY_RUN] Step ${stepsRun} Reasoning: ${reasoning}`);
      }

      // Stop if the model returned plain text with no function calls
      if (!functionCalls.length) {
        stoppedBy = "plain_text";
        if (dry) {
          console.log(`[Agent DRY_RUN] Step ${stepsRun}: No tool calls returned (stopping).`);
        }
        break;
      }

      const modelParts =
        response?.candidates?.[0]?.content?.parts ||
        functionCalls.map((fc) => ({ functionCall: { name: fc.name, args: fc.args } }));
      contents.push({ role: "model", parts: modelParts });

      const functionResponseParts = [];
      let calledDoNothing = false;

      for (const fc of functionCalls) {
        if (callsToday + executedActions.length >= maxCallsPerDay) {
          stoppedBy = "max_calls_per_user_per_day";
          break;
        }

        const callReasoning = fc.args?.reason || reasoning || null;
        if (dry) {
          console.log(
            `[Agent DRY_RUN] Tool Chosen: ${fc.name}(${JSON.stringify(fc.args)})${
              callReasoning ? ` | Reasoning: ${callReasoning}` : ""
            }`
          );
        }

        const toolResult = await executeTool(fc.name, fc.args, {
          telegramUserId: uid,
          tickType,
          api,
          dryRun: dry,
          now: now || new Date(),
        });

        executedActions.push({
          step: stepsRun,
          tool: fc.name,
          args: fc.args,
          reasoning: callReasoning,
          result: toolResult,
        });

        functionResponseParts.push({
          functionResponse: {
            name: fc.name,
            response: { result: toolResult },
          },
        });

        if (fc.name === "do_nothing") {
          calledDoNothing = true;
          stoppedBy = "do_nothing";
          break;
        }
      }

      if (calledDoNothing || stoppedBy === "max_calls_per_user_per_day") {
        break;
      }

      contents.push({
        role: "user",
        parts: functionResponseParts,
      });
    }

    return {
      ok: true,
      fallback: false,
      dryRun: dry,
      telegramUserId: uid,
      tickType,
      steps: stepsRun,
      stoppedBy,
      actions: executedActions,
      snapshot,
    };
  } catch (err) {
    console.log(`Agent loop failed for user ${uid} (${tickType}): ${err.message}`);

    // If Gemini fails during a morning tick (e.g. bad API key), still send the deterministic morning brief
    let fallbackBrief = null;
    if (tickType === "morning" && !dry) {
      try {
        const todayYmd = getTodayIstYmd();
        const alreadySent = (await getMorningBriefSentDate(uid)) === todayYmd;
        if (!alreadySent) {
          fallbackBrief = await sendDailyMorningBrief(uid, { todayYmd, api });
          await logAgentAction({
            telegram_user_id: uid,
            tick_type: "morning",
            tool_name: "send_morning_brief",
            tool_args: { fallback: true },
            tool_result: {
              status: "ok",
              fallback: true,
              date: fallbackBrief.date || todayYmd,
              tasksCount: fallbackBrief.stats?.total || 0,
            },
            message_sent: fallbackBrief.text,
            reasoning: `Deterministic morning brief fallback (${err.message || "Gemini error"})`,
            status: "ok",
          }).catch(() => {});
        }
      } catch (fbErr) {
        console.log(`Fallback morning brief failed for user ${uid}: ${fbErr.message}`);
      }
    }

    return {
      ok: false,
      fallback: true,
      fallbackBriefSent: Boolean(fallbackBrief?.ok),
      brief: fallbackBrief,
      error: err.message || "Agent loop failed",
    };
  }
}