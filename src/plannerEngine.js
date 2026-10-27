// src/plannerEngine.js
// AI Study Planner & Todoist SDK Integration (@doist/todoist-sdk)
import { TodoistApi } from "@doist/todoist-sdk";
import { GoogleGenAI, Type } from "@google/genai";
import { GEMINI_API_KEY, GEMINI_MODEL } from "./config.js";
import { cleanTodoistKey, getTodoistKey, getUserClass, getUserKeys, isValidTodoistKey } from "./intake/userKeys.js";
import {
  compactTaskId,
  findTaskInPlan,
  getChaptersWithResults,
  getDailyProgressStats,
  getStudyPlanForUser,
  markStudyTaskDone,
  markStudyTaskPartial,
  saveStudyPlanForUser,
  storedSubject,
} from "./db.js";
import { revisionFor } from "./quizEngine.js";

// ---------------------------------------------------------------------------
// 1. Default Planner Configuration
// ---------------------------------------------------------------------------
export const DEFAULT_PLANNER_CONFIG = {
  dailyStudyHours: 5,
  dailySleepHours: 8,
  dailyFreeHours: 2,
  planDays: 7,
  // Monday (1) to Saturday (6) are School Days by default; Sunday (0) is a non-school / full day
  schoolDays: [1, 2, 3, 4, 5, 6],
  schoolStartTime: "08:00",
  schoolEndTime: "14:30",
  // Daily time budget: study + sleep + free time can never add up to more than 24 hours.
  // Free time has its own start time; bedtime is worked out from wake-up time minus sleep hours.
  freeStartTime: "14:30",
  wakeUpTime: "07:00",
  sessionStyle: "pomodoro_25_5", // 'pomodoro_25_5' | 'deep_50_10' | 'block_90_15' | 'custom'
  customFocusMins: 45,
  customBreakMins: 10,
  examDates: [],      // [{ id, subject, examName, date }]
  vacationRanges: [], // [{ id, label, startDate, endDate }]
  startDate: "", // "" = Day 1 is the day the student opens the planner; otherwise a YYYY-MM-DD start date
  subjectPriorities: {}, // { [subject]: 'High' | 'Medium' | 'Low' }
  includeQuizRevision: true,
};

export const SESSION_STYLE_PRESETS = {
  pomodoro_25_5: {
    id: "pomodoro_25_5",
    label: "Pomodoro (25m Study / 5m Break)",
    focusMins: 25,
    breakMins: 5,
    longBreakMins: 15,
    cyclesBeforeLongBreak: 4,
  },
  deep_50_10: {
    id: "deep_50_10",
    label: "Deep Work (50m Study / 10m Break)",
    focusMins: 50,
    breakMins: 10,
    longBreakMins: 20,
    cyclesBeforeLongBreak: 2,
  },
  block_90_15: {
    id: "block_90_15",
    label: "Ultradian Block (90m Study / 15m Break)",
    focusMins: 90,
    breakMins: 15,
    longBreakMins: 25,
    cyclesBeforeLongBreak: 1,
  },
  custom: {
    id: "custom",
    label: "Custom Intervals",
    focusMins: 45,
    breakMins: 10,
    longBreakMins: 20,
    cyclesBeforeLongBreak: 2,
  },
};

export function normalizePlannerConfig(raw = {}) {
  const numOr = (v, d) => (v !== "" && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);
  let dailyStudyHours = Math.max(1, Math.min(14, numOr(raw.dailyStudyHours, DEFAULT_PLANNER_CONFIG.dailyStudyHours)));
  let dailySleepHours = Math.max(4, Math.min(12, numOr(raw.dailySleepHours, DEFAULT_PLANNER_CONFIG.dailySleepHours)));
  let dailyFreeHours = Math.max(0.5, Math.min(10, numOr(raw.dailyFreeHours, DEFAULT_PLANNER_CONFIG.dailyFreeHours)));
  // Study + sleep + free time must never exceed 24 hours: trim free time first, then study, then sleep.
  let overHours = dailyStudyHours + dailySleepHours + dailyFreeHours - 24;
  if (overHours > 0) {
    const trim = (v, min) => {
      const cut = Math.min(overHours, v - min);
      overHours -= cut;
      return v - cut;
    };
    dailyFreeHours = trim(dailyFreeHours, 0.5);
    dailyStudyHours = trim(dailyStudyHours, 1);
    dailySleepHours = trim(dailySleepHours, 4);
  }
  const planDays = Math.max(1, Math.min(30, parseInt(raw.planDays, 10) || DEFAULT_PLANNER_CONFIG.planDays));

  const schoolDays = Array.isArray(raw.schoolDays)
    ? [...new Set(raw.schoolDays.map((d) => parseInt(d, 10)).filter((d) => d >= 0 && d <= 6))]
    : [...DEFAULT_PLANNER_CONFIG.schoolDays];

  const schoolStartTime = /^\d{2}:\d{2}$/.test(String(raw.schoolStartTime || ""))
    ? String(raw.schoolStartTime)
    : DEFAULT_PLANNER_CONFIG.schoolStartTime;
  const schoolEndTime = /^\d{2}:\d{2}$/.test(String(raw.schoolEndTime || ""))
    ? String(raw.schoolEndTime)
    : DEFAULT_PLANNER_CONFIG.schoolEndTime;
  const validTime = (v) => /^\d{2}:\d{2}$/.test(String(v || ""));
  const freeStartTime = validTime(raw.freeStartTime) ? String(raw.freeStartTime) : DEFAULT_PLANNER_CONFIG.freeStartTime;
  const sleepMinsTotal = Math.round(dailySleepHours * 60);
  const wakeUpTime = validTime(raw.wakeUpTime) ? String(raw.wakeUpTime) : DEFAULT_PLANNER_CONFIG.wakeUpTime;
  // Bedtime is derived: wake-up time minus sleep hours.
  const sleepStartTime = minsToTimeStr(parseTimeToMins(wakeUpTime) - sleepMinsTotal);

  const sessionStyle = SESSION_STYLE_PRESETS[raw.sessionStyle]
    ? raw.sessionStyle
    : DEFAULT_PLANNER_CONFIG.sessionStyle;

  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.startDate || "")) ? String(raw.startDate) : "";
  const customFocusMins = Math.max(10, Math.min(180, parseInt(raw.customFocusMins, 10) || 45));
  const customBreakMins = Math.max(2, Math.min(60, parseInt(raw.customBreakMins, 10) || 10));

  const examDates = Array.isArray(raw.examDates)
    ? raw.examDates
        .filter((e) => e && (e.subject || e.examName) && e.date)
        .map((e, idx) => ({
          id: String(e.id || `exam_${idx + 1}`),
          subject: String(e.subject || "General").trim(),
          examName: String(e.examName || e.subject || "Upcoming Exam").trim(),
          date: String(e.date).slice(0, 10),
        }))
    : [];

  const vacationRanges = Array.isArray(raw.vacationRanges)
    ? raw.vacationRanges
        .filter((v) => v && (v.startDate || v.date))
        .map((v, idx) => {
          const start = String(v.startDate || v.date).slice(0, 10);
          const end = String(v.endDate || v.startDate || v.date).slice(0, 10);
          return {
            id: String(v.id || `vac_${idx + 1}`),
            label: String(v.label || "Holiday / Vacation").trim(),
            startDate: start <= end ? start : end,
            endDate: start <= end ? end : start,
          };
        })
    : [];

  const subjectPriorities = {};
  if (raw.subjectPriorities && typeof raw.subjectPriorities === "object") {
    for (const [subj, prio] of Object.entries(raw.subjectPriorities)) {
      const p = String(prio || "").trim();
      if (["High", "Medium", "Low"].includes(p)) {
        subjectPriorities[subj] = p;
      }
    }
  }

  return {
    dailyStudyHours,
    dailySleepHours,
    dailyFreeHours,
    planDays,
    schoolDays,
    schoolStartTime,
    schoolEndTime,
    freeStartTime,
    sleepStartTime,
    wakeUpTime,
    sessionStyle,
    customFocusMins,
    customBreakMins,
    startDate,
    examDates,
    vacationRanges,
    subjectPriorities,
    includeQuizRevision: raw.includeQuizRevision !== false,
  };
}

// ---------------------------------------------------------------------------
// 2. Todoist API Verification & Task Sync (@doist/todoist-sdk + REST fallback)
// ---------------------------------------------------------------------------
export async function verifyTodoistToken(rawToken) {
  const token = cleanTodoistKey(rawToken);
  if (!token || !isValidTodoistKey(token)) {
    return {
      ok: false,
      valid: false,
      error: "That is not a Todoist API token. It is 40 letters and numbers (0-9, a-f). Copy it from Todoist Settings → Integrations → Developer.",
    };
  }

  try {
    const api = new TodoistApi(token);
    const projectsRes = await api.getProjects();
    const list = Array.isArray(projectsRes)
      ? projectsRes
      : Array.isArray(projectsRes?.results)
        ? projectsRes.results
        : [];
    return {
      ok: true,
      valid: true,
      verified: true,
      mode: "todoist_sdk",
      projectCount: list.length,
    };
  } catch (sdkErr) {
    const status = Number(sdkErr?.httpStatusCode || sdkErr?.status || 0);
    const msg = String(sdkErr?.message || "");
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 7000);
      const resV1 = await fetch("https://api.todoist.com/api/v1/projects", {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctl.signal,
      }).finally(() => clearTimeout(timer));

      if (resV1.ok) {
        return {
          ok: true,
          valid: true,
          verified: true,
          mode: "todoist_api_v1",
        };
      }
      if (resV1.status < 500 && resV1.status !== 429) {
        // Todoist answered and said no (401/403/400/404...): this is not a working token
        return {
          ok: false,
          valid: false,
          error: "Todoist rejected this API token. Please copy your active API token from Todoist Settings → Integrations → Developer.",
        };
      }
    } catch {}

    if (status >= 400 && status < 500 && status !== 429) {
      return {
        ok: false,
        valid: false,
        error: "Todoist rejected this API token. Please check that you copied the exact token from Todoist Developer Settings.",
      };
    }
    if (/\b(400|401|403|404|unauthorized|forbidden|invalid)\b/i.test(msg)) {
      return {
        ok: false,
        valid: false,
        error: "Todoist rejected this API token. Please check that you copied the exact token from Todoist Developer Settings.",
      };
    }

    // Todoist could not be reached at all (network/5xx): the format is right, so allow it but say it was not verified
    return {
      ok: true,
      valid: true,
      verified: false,
      mode: "format_only",
    };
  }
}

/**
 * Helper that creates a task via @doist/todoist-sdk (`api.addTask`) exactly as shown in main.js,
 * and falls back to Todoist's REST API (/api/v1/tasks then /rest/v2/tasks) if the SDK call fails.
 */
async function addTaskWithFallback(api, token, taskArgs) {
  // 1. Primary path: @doist/todoist-sdk TodoistApi.addTask (matches main.js)
  try {
    const sdkPayload = {
      content: taskArgs.content,
    };
    if (taskArgs.description) sdkPayload.description = taskArgs.description;
    if (taskArgs.dueString) sdkPayload.dueString = taskArgs.dueString;
    if (taskArgs.parentId) sdkPayload.parentId = String(taskArgs.parentId);
    if (taskArgs.priority) sdkPayload.priority = taskArgs.priority;

    const created = await api.addTask(sdkPayload);
    if (created && created.id != null) {
      return created;
    }
  } catch (sdkErr) {
    // If SDK threw due to priority or optional fields, retry with core main.js fields only
    try {
      const minimalPayload = { content: taskArgs.content };
      if (taskArgs.description) minimalPayload.description = taskArgs.description;
      if (taskArgs.dueString) minimalPayload.dueString = taskArgs.dueString;
      if (taskArgs.parentId) minimalPayload.parentId = String(taskArgs.parentId);
      const retryCreated = await api.addTask(minimalPayload);
      if (retryCreated && retryCreated.id != null) {
        return retryCreated;
      }
    } catch {}

    // 2. Fallback path: Direct Todoist HTTP API (/api/v1/tasks and /rest/v2/tasks)
    const restBody = {
      content: taskArgs.content,
    };
    if (taskArgs.description) restBody.description = taskArgs.description;
    if (taskArgs.dueString) restBody.due_string = taskArgs.dueString;
    if (taskArgs.parentId) restBody.parent_id = String(taskArgs.parentId);
    if (taskArgs.priority) restBody.priority = taskArgs.priority;

    const endpoints = [
      "https://api.todoist.com/api/v1/tasks",
      "https://api.todoist.com/rest/v2/tasks",
    ];
    let lastStatus = sdkErr?.httpStatusCode || sdkErr?.status || 502;
    let lastMsg = sdkErr?.message || "Todoist API error";

    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(restBody),
        });
        if (res.ok) {
          const data = await res.json();
          const taskObj = data?.id != null ? data : data?.task?.id != null ? data.task : null;
          if (taskObj) return taskObj;
        } else if (res.status === 400 && restBody.due_string && taskArgs.dueDate) {
          const fallbackBody = { ...restBody, due_date: taskArgs.dueDate };
          delete fallbackBody.due_string;
          const retryRes = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(fallbackBody),
          });
          if (retryRes.ok) {
            const retryData = await retryRes.json();
            const taskObj = retryData?.id != null ? retryData : retryData?.task?.id != null ? retryData.task : null;
            if (taskObj) return taskObj;
          }
        } else {
          lastStatus = res.status;
          const errText = await res.text().catch(() => "");
          if (errText) lastMsg = errText.slice(0, 200);
        }
      } catch (fetchErr) {
        lastMsg = fetchErr.message || lastMsg;
      }
    }

    const finalErr = new Error(lastMsg);
    finalErr.status = lastStatus;
    throw finalErr;
  }
}

function format12hDueTime(hhmm = "18:00") {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return "6pm";
  let h = parseInt(m[1], 10);
  const mins = parseInt(m[2], 10);
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return mins === 0 ? `${h}${ampm}` : `${h}:${String(mins).padStart(2, "0")}${ampm}`;
}

/**
 * Push a generated Study Plan to Todoist using @doist/todoist-sdk (TodoistApi).
 * Follows the exact reference pattern in main.js:
 *  1) Parent task: api.addTask({ content, description, dueString })
 *  2) Sub-tasks:   api.addTask({ content, parentId: parentTask.id })
 *  3) Close task:  api.closeTask(taskId)
 */
export async function syncPlanToTodoist({
  token: rawToken,
  plan,
  onlyDate = null,
  maxDays = null,
  forceResync = false,
}) {
  const token = cleanTodoistKey(rawToken);
  if (!token || !isValidTodoistKey(token)) {
    const err = new Error("No valid Todoist API key found. Add your Todoist API key on the Setup or Planner page first.");
    err.status = 400;
    throw err;
  }
  if (!plan || !Array.isArray(plan.days) || !plan.days.length) {
    const err = new Error("Generate a study plan first before syncing to Todoist.");
    err.status = 400;
    throw err;
  }

  const api = new TodoistApi(token);
  const syncedTasks = [];
  let parentCount = 0;
  let subTaskCount = 0;

  const priorityToTodoist = (p) => {
    const v = String(p || "").toLowerCase();
    if (v === "high") return 4;
    if (v === "medium") return 3;
    return 2;
  };

  const targetDays = plan.days.filter((d, idx) => {
    if (onlyDate && d.date !== onlyDate) return false;
    if (maxDays != null && Number(maxDays) > 0 && idx >= Number(maxDays)) return false;
    return true;
  });

  for (let dayIdx = 0; dayIdx < targetDays.length; dayIdx++) {
    const day = targetDays[dayIdx];
    const blocks = Array.isArray(day.studyBlocks) ? day.studyBlocks : [];
    if (!blocks.length) continue;

    for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
      const block = blocks[bIdx];

      // Avoid creating duplicate tasks if already synced (unless forceResync is requested)
      if (!forceResync && block.synced && block.todoistTaskId) {
        syncedTasks.push({
          id: String(block.todoistTaskId),
          date: day.date,
          dayLabel: day.dayLabel,
          subject: block.subject,
          content: `[${block.subject}] ${block.title || block.chapterTitle}`,
          dueString: block.todoistDueString,
          priority: block.priority || "Medium",
          url: block.todoistUrl || `https://app.todoist.com/app/task/${block.todoistTaskId}`,
          completed: Boolean(block.completed),
          subtasks: (block.subtasks || []).map((s) => ({
            id: String(s.todoistTaskId || s.id),
            content: s.content,
            completed: Boolean(s.completed),
          })),
        });
        continue;
      }

      const dueString =
        block.todoistDueString ||
        day.todoistDueString ||
        `${day.date} at ${format12hDueTime(block.startTime || "18:00")}`;

      const ytQuery = encodeURIComponent(`${block.subject} ${block.chapterTitle} CBSE NCERT`);
      const tutorialUrl = block.youtubeUrl || `https://www.youtube.com/results?search_query=${ytQuery}`;

      const descLines = [
        `Tutorial link: ${tutorialUrl}`,
        `Schedule: ${day.dayLabel} (${day.dayTypeLabel}) · ${block.startTime}–${block.endTime} (${block.durationMins} mins)`,
        `Session Style: ${block.sessionPatternLabel || plan.sessionStyleLabel || "Pomodoro 25/5"} (${block.breakIntervalText || "5m break every 25m"})`,
        `Focus: ${block.strategyNote || block.focusType || "Concept Mastery & Practice"}`,
      ];
      if (block.pdfUrl) descLines.push(`NCERT Textbook PDF: ${block.pdfUrl}`);

      const parentPayload = {
        content: `[${block.subject}] ${block.title || block.chapterTitle} (${block.startTime}–${block.endTime})`,
        description: descLines.join("\n"),
        dueString,
        dueDate: day.date,
        priority: priorityToTodoist(block.priority),
      };

      let parentTask;
      try {
        parentTask = await addTaskWithFallback(api, token, parentPayload);
      } catch (err) {
        const e = new Error(`Todoist API error while creating task "${parentPayload.content}": ${err.message}`);
        e.status = err.httpStatusCode || err.status || 502;
        throw e;
      }

      parentCount++;
      block.todoistTaskId = String(parentTask.id);
      block.todoistUrl = parentTask.url || `https://app.todoist.com/app/task/${parentTask.id}`;
      block.synced = true;

      const createdSubtasks = [];
      const subItems = Array.isArray(block.subtasks) && block.subtasks.length
        ? block.subtasks.slice(0, 3)
        : [
            { content: `Study NCERT concepts & notes for ${block.chapterTitle}`, completed: false },
            { content: `Solve practice questions & take Study Agent Quiz on ${block.chapterTitle}`, completed: false },
          ];

      for (const sub of subItems) {
        const subText = typeof sub === "string" ? sub : String(sub.content || sub.title || "");
        if (!subText.trim()) continue;
        try {
          const subTask = await addTaskWithFallback(api, token, {
            content: subText,
            parentId: parentTask.id,
          });
          subTaskCount++;
          if (typeof sub === "object" && sub.completed) {
            await closeOrReopenTaskWithFallback(api, token, subTask.id, true).catch(() => {});
          }
          if (typeof sub === "object") {
            sub.todoistTaskId = String(subTask.id);
            sub.synced = true;
          }
          createdSubtasks.push({
            id: String(subTask.id),
            content: subTask.content,
            completed: Boolean(typeof sub === "object" && sub.completed),
          });
        } catch (subErr) {
          console.log(`Could not create subtask "${subText}": ${subErr.message}`);
        }
      }

      if (block.completed) {
        await closeOrReopenTaskWithFallback(api, token, parentTask.id, true).catch(() => {});
      }

      syncedTasks.push({
        id: String(parentTask.id),
        date: day.date,
        dayLabel: day.dayLabel,
        subject: block.subject,
        content: parentTask.content,
        dueString,
        priority: block.priority || "Medium",
        url: block.todoistUrl,
        completed: Boolean(block.completed),
        subtasks: createdSubtasks,
      });
    }
  }

  const syncedAt = new Date().toISOString();
  const prevParent = Number(plan.todoistSync?.parentTasksCreated) || 0;
  const prevSub = Number(plan.todoistSync?.subTasksCreated) || 0;
  const totalParentsNow = forceResync ? parentCount : prevParent + parentCount;
  const totalSubsNow = forceResync ? subTaskCount : prevSub + subTaskCount;

  plan.todoistSync = {
    synced: true,
    syncedAt,
    parentTasksCreated: totalParentsNow,
    subTasksCreated: totalSubsNow,
    totalTasksCreated: totalParentsNow + totalSubsNow,
    upcomingUrl: "https://app.todoist.com/app/upcoming",
  };

  return {
    ok: true,
    syncedAt,
    parentTasksCreated: parentCount || totalParentsNow,
    subTasksCreated: subTaskCount || totalSubsNow,
    totalTasksCreated: (parentCount + subTaskCount) || (totalParentsNow + totalSubsNow),
    upcomingUrl: "https://app.todoist.com/app/upcoming",
    syncedTasks,
    plan,
  };
}

async function closeOrReopenTaskWithFallback(api, token, taskId, completed = true) {
  const idStr = String(taskId);
  try {
    if (completed) {
      await api.closeTask(idStr);
    } else {
      await api.reopenTask(idStr);
    }
    return true;
  } catch {
    const action = completed ? "close" : "reopen";
    const urls = [
      `https://api.todoist.com/api/v1/tasks/${encodeURIComponent(idStr)}/${action}`,
      `https://api.todoist.com/rest/v2/tasks/${encodeURIComponent(idStr)}/${action}`,
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) return true;
      } catch {}
    }
    return false;
  }
}

export async function setTodoistTaskCompleted({ token: rawToken, taskId, completed = true }) {
  const token = cleanTodoistKey(rawToken);
  if (!token || !isValidTodoistKey(token)) {
    const err = new Error("No valid Todoist API key configured.");
    err.status = 400;
    throw err;
  }
  const api = new TodoistApi(token);
  await closeOrReopenTaskWithFallback(api, token, taskId, completed);
  return { ok: true, taskId: String(taskId), completed: Boolean(completed) };
}

// ---------------------------------------------------------------------------
// 3. Time & Schedule Calculation Helpers
// ---------------------------------------------------------------------------
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseTimeToMins(hhmm, fallback = 8 * 60) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return fallback;
  return Math.min(23 * 60 + 59, Math.max(0, parseInt(m[1], 10) * 60 + parseInt(m[2], 10)));
}

function minsToTimeStr(totalMins) {
  const wrapped = ((Math.round(totalMins) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function subtractRange(ranges, a, b) {
  const out = [];
  for (const [s0, e0] of ranges) {
    if (b <= s0 || a >= e0) {
      out.push([s0, e0]);
      continue;
    }
    if (a > s0) out.push([s0, a]);
    if (b < e0) out.push([b, e0]);
  }
  return out;
}

/**
 * Lays out one day from the student's own three blocks - Sleep, Free time and Study. Sleep is
 * anchored to the wake-up time, free time has its own start time, and study fills the rest: only
 * while awake, after school (or mid-morning on non-school days), and outside the free-time block.
 */
function buildDayLayout(config, isSchoolDay) {
  const sleepMins = Math.round(config.dailySleepHours * 60);
  const freeMins = Math.round(config.dailyFreeHours * 60);
  const wake = parseTimeToMins(config.wakeUpTime, 7 * 60);
  const sleepStart = (((wake - sleepMins) % 1440) + 1440) % 1440;
  const studyStart = isSchoolDay
    ? parseTimeToMins(config.schoolEndTime, 14 * 60 + 30) + 75 // rest/commute after school
    : Math.max(wake + 60, 9 * 60 + 30);
  const freeStart = parseTimeToMins(config.freeStartTime, 14 * 60 + 30);
  const awakeEnd = sleepStart > wake ? sleepStart : 1440;

  let ranges = [[Math.max(studyStart, wake), awakeEnd]];
  ranges = subtractRange(ranges, freeStart, Math.min(freeStart + freeMins, 1440));
  if (isSchoolDay) {
    ranges = subtractRange(
      ranges,
      parseTimeToMins(config.schoolStartTime, 8 * 60),
      parseTimeToMins(config.schoolEndTime, 14 * 60 + 30)
    );
  }
  const windows = ranges
    .filter(([s, e]) => e - s >= 30)
    .map(([s, e]) => ({
      start: s,
      end: e,
      period: s < 12 * 60 ? "Morning Study Window" : s < 17 * 60 ? "Afternoon Study Window" : "Evening Study Window",
    }));

  return {
    windows,
    sleepBlock: { startTime: minsToTimeStr(sleepStart), endTime: minsToTimeStr(wake), hours: config.dailySleepHours },
    freeBlock: { startTime: minsToTimeStr(freeStart), endTime: minsToTimeStr(freeStart + freeMins), hours: config.dailyFreeHours },
    wakeTime: minsToTimeStr(wake),
  };
}

function formatDateYMD(d) {
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${yr}-${mo}-${da}`;
}

function isDateInVacation(dateYmd, vacationRanges = []) {
  for (const v of vacationRanges) {
    if (dateYmd >= v.startDate && dateYmd <= v.endDate) {
      return v;
    }
  }
  return null;
}

function getSessionPreset(config) {
  if (config.sessionStyle === "custom") {
    const f = Math.max(15, Math.min(180, Number(config.customFocusMins) || 45));
    const b = Math.max(3, Math.min(60, Number(config.customBreakMins) || 10));
    return {
      id: "custom",
      label: `Custom (${f}m Study / ${b}m Break)`,
      focusMins: f,
      breakMins: b,
      longBreakMins: Math.min(45, b * 2),
      cyclesBeforeLongBreak: 2,
    };
  }
  return SESSION_STYLE_PRESETS[config.sessionStyle] || SESSION_STYLE_PRESETS.pomodoro_25_5;
}

/**
 * Generates clean, well-spaced Study Sessions for a single day:
 * - Groups short intervals (e.g. Pomodoro 25m) into 90–100m focused Subject Blocks (2–4 blocks/day for 5h)
 *   so the user's schedule and Todoist Upcoming list are structured, realistic, and never cluttered.
 * - On School Days (Mon–Sat): schedules blocks after school (and optional pre-school morning block if >5.5h).
 * - On Full Days (Sunday & Vacation/Holidays): spreads blocks across Morning, Afternoon, and Evening windows.
 */
function buildDailyTimeSlots(dayType, config, preset) {
  const totalStudyMins = Math.round(config.dailyStudyHours * 60);
  const windows = buildDayLayout(config, dayType === "school_day").windows;

  // Group Pomodoro/Deep Work cycles into substantial 90–100m subject study sessions (3 blocks for 5h/day)
  const targetBlockFocus =
    preset.focusMins <= 30
      ? preset.focusMins * 4 // 4 × 25m = 100m subject block
      : preset.focusMins <= 55
        ? preset.focusMins * 2 // 2 × 50m = 100m subject block
        : preset.focusMins; // 90m ultradian block

  const interBlockBreak = Math.max(15, preset.longBreakMins || 15);
  const spanFor = (f) => f + Math.max(0, Math.round(f / preset.focusMins) - 1) * preset.breakMins;

  const slots = [];
  let remainingFocus = totalStudyMins;
  let wIdx = 0;
  let cursor = windows[0]?.start ?? 16 * 60;

  while (remainingFocus > 0 && slots.length < 8) {
    const win = windows[wIdx];
    if (!win) break;
    if (cursor < win.start) cursor = win.start;

    let focusForThisBlock = Math.min(remainingFocus, targetBlockFocus);
    // Shrink the block to fit what is left of this window, or move on to the next window.
    if (cursor + spanFor(focusForThisBlock) > win.end) {
      const avail = win.end - cursor;
      let f = focusForThisBlock;
      while (f > 15 && spanFor(f) > avail) f -= 5;
      if (f < 20 || spanFor(f) > avail) {
        wIdx++;
        if (windows[wIdx]) cursor = windows[wIdx].start;
        continue;
      }
      focusForThisBlock = f;
    }
    const cyclesCount = Math.max(1, Math.round(focusForThisBlock / preset.focusMins));
    const actualSpan = spanFor(focusForThisBlock);

    const startTime = minsToTimeStr(cursor);
    const endTime = minsToTimeStr(cursor + actualSpan);
    const breakEnd = minsToTimeStr(cursor + actualSpan + interBlockBreak);

    const breakText =
      cyclesCount > 1
        ? `${cyclesCount} × ${preset.focusMins}m focus (${preset.breakMins}m short break between cycles) + ${interBlockBreak}m recharge until ${breakEnd}`
        : `${focusForThisBlock}m deep focus + ${interBlockBreak}m recharge break until ${breakEnd}`;

    slots.push({
      startTime,
      endTime,
      durationMins: focusForThisBlock,
      spanMins: actualSpan,
      breakMinsAfter: interBlockBreak,
      period: win.period,
      sessionPatternLabel: preset.label,
      breakIntervalText: breakText,
    });

    remainingFocus -= focusForThisBlock;
    cursor += actualSpan + interBlockBreak;
  }

  return slots;
}

export function buildPrioritizedStudyQueue({ chapters = [], config = {}, todayYmd }) {
  const normalizedChapters = [];

  for (const ch of chapters) {
    const subject = storedSubject(ch.subject, ch.title, ch.pdf_url, "", ch.number);
    const res = ch.result || null;
    const pct = res?.percentage != null ? Number(res.percentage) : null;
    const tierInfo = pct != null ? revisionFor(pct) : null;
    const tier = res?.revision_tier || tierInfo?.tier || "untested";
    const weakSubtopics = Array.isArray(res?.weak_subtopics) ? res.weak_subtopics : [];

    const matchingExam = (config.examDates || [])
      .filter((e) => e.date >= todayYmd)
      .find(
        (e) =>
          e.subject.toLowerCase() === subject.toLowerCase() ||
          e.examName.toLowerCase().includes(subject.toLowerCase()) ||
          subject.toLowerCase().includes(e.subject.toLowerCase())
      );

    let daysUntilExam = null;
    if (matchingExam?.date) {
      const diffMs = new Date(`${matchingExam.date}T00:00:00`) - new Date(`${todayYmd}T00:00:00`);
      daysUntilExam = Math.max(0, Math.round(diffMs / 86400000));
    }

    let priority = config.subjectPriorities?.[subject] || null;
    if (!priority) {
      if (tier === "heavy_restudy" || (daysUntilExam !== null && daysUntilExam <= 10)) {
        priority = "High";
      } else if (tier === "moderate_revision" || (daysUntilExam !== null && daysUntilExam <= 21)) {
        priority = "High";
      } else if (tier === "mastered") {
        priority = "Low";
      } else {
        priority = "Medium";
      }
    }

    let urgencyScore = 50;
    if (priority === "High") urgencyScore += 35;
    else if (priority === "Low") urgencyScore -= 15;

    if (tier === "heavy_restudy") urgencyScore += 40;
    else if (tier === "moderate_revision") urgencyScore += 25;
    else if (tier === "untested") urgencyScore += 15;
    else if (tier === "mastered") urgencyScore -= 20;

    if (weakSubtopics.length > 0) urgencyScore += Math.min(20, weakSubtopics.length * 6);
    if (daysUntilExam !== null) {
      if (daysUntilExam <= 3) urgencyScore += 50;
      else if (daysUntilExam <= 7) urgencyScore += 35;
      else if (daysUntilExam <= 14) urgencyScore += 20;
      else urgencyScore += 10;
    }

    normalizedChapters.push({
      id: ch.id,
      subject,
      number: ch.number,
      title: ch.title,
      pdfUrl: ch.pdf_url || null,
      exam: matchingExam?.examName || ch.exam || null,
      examDate: matchingExam?.date || null,
      daysUntilExam,
      priority,
      quizPercentage: pct,
      revisionTier: tier,
      weakSubtopics,
      urgencyScore,
    });
  }

  // Do not inject fake fallback units when no syllabus has been uploaded.

  normalizedChapters.sort((a, b) => b.urgencyScore - a.urgencyScore);
  return normalizedChapters;
}

const AI_PLAN_ENRICHMENT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    coachHeadline: { type: Type.STRING },
    coachSummary: { type: Type.STRING },
    keyRecommendations: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    chapterStrategies: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          chapterTitle: { type: Type.STRING },
          strategyNote: { type: Type.STRING },
          subtasks: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ["chapterTitle", "strategyNote", "subtasks"],
      },
    },
  },
  required: ["coachHeadline", "coachSummary", "keyRecommendations", "chapterStrategies"],
};

const genClients = new Map();
function getGenClient(key) {
  if (!genClients.has(key)) genClients.set(key, new GoogleGenAI({ apiKey: key }));
  return genClients.get(key);
}

export async function generateAiStudyPlan({
  chapters = [],
  config: rawConfig = {},
  geminiKeys = [],
  startDate = null,
  classLevel = null, // the student's class from the setup page
}) {
  const studentClass = classLevel ?? chapters.find((c) => c?.class)?.class ?? null;
  const classLabel = studentClass ? `Class ${studentClass}` : "school";
  const config = normalizePlannerConfig(rawConfig);
  const preset = getSessionPreset(config);
  // Day 1 is the day the student opened the planner (today, in India), unless they picked a later start date.
  const istNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const realTodayYmd = formatDateYMD(istNow);
  const realTomorrowYmd = formatDateYMD(new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate() + 1));
  const requestedStart = String(startDate || config.startDate || "");
  const planStartYmd = /^\d{4}-\d{2}-\d{2}$/.test(requestedStart) && requestedStart >= realTodayYmd ? requestedStart : realTodayYmd;
  const baseDate = new Date(`${planStartYmd}T00:00:00`);
  const todayYmd = planStartYmd;

  const syllabusChaptersOnly = Array.isArray(chapters) ? chapters.filter((c) => !c?.is_custom) : [];
  const prioritizedUnits = buildPrioritizedStudyQueue({
    chapters: syllabusChaptersOnly,
    config,
    todayYmd,
  });
  if (!prioritizedUnits.length) {
    return null;
  }

  let aiEnrichment = null;
  const allGeminiKeys = [...new Set([...(geminiKeys || []), GEMINI_API_KEY].filter(Boolean))];
  if (allGeminiKeys.length > 0) {
    const unitSummary = prioritizedUnits.slice(0, 14).map((u) => ({
      subject: u.subject,
      chapterTitle: u.title,
      priority: u.priority,
      quizScore: u.quizPercentage != null ? `${u.quizPercentage}% (${u.revisionTier})` : "Not quizzed yet",
      weakSubtopics: u.weakSubtopics,
      examDate: u.examDate,
    }));

    const prompt = `You are an expert CBSE & NCERT AI Study Coach designing a ${config.planDays}-day Todoist study schedule for a ${classLabel} student.

Student Configuration:
- Daily Study Goal: ${config.dailyStudyHours} hours/day
- Daily Sleep Target: ${config.dailySleepHours} hours/day (bedtime ${config.sleepStartTime}, wake-up ${config.wakeUpTime})
- Daily Free Time: ${config.dailyFreeHours} hours/day, starting ${config.freeStartTime} (never schedule study during it)
- Study + sleep + free time = ${(config.dailyStudyHours + config.dailySleepHours + config.dailyFreeHours).toFixed(1)}h of the 24h day.
- Session Style: ${preset.label}
- School Days: ${config.schoolDays.map((d) => SHORT_DAY_NAMES[d]).join(", ")} (${config.schoolStartTime} to ${config.schoolEndTime}); Sunday & Vacation dates are full non-school days.
- Upcoming Exams: ${config.examDates.length ? JSON.stringify(config.examDates) : "None specified yet"}
- Vacation / Holidays: ${config.vacationRanges.length ? JSON.stringify(config.vacationRanges) : "None specified"}

Prioritized Syllabus & Quiz Performance Queue:
${JSON.stringify(unitSummary, null, 2)}

Provide:
1. "coachHeadline": An encouraging, specific 1-line headline summarizing the study strategy.
2. "coachSummary": A 2-3 sentence executive summary explaining how their ${config.dailyStudyHours}h/day study blocks, school vs full-day schedule, exam countdowns, and quiz weak-spots are balanced.
3. "keyRecommendations": 3 actionable bullet points for exam & revision success.
4. "chapterStrategies": For each chapter in the queue, provide a concise "strategyNote" (1 sentence) and 2 concrete Todoist "subtasks".`;

    for (const key of allGeminiKeys) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 8000);
        const res = await getGenClient(key)
          .models.generateContent({
            model: GEMINI_MODEL,
            contents: prompt,
            config: {
              responseMimeType: "application/json",
              responseSchema: AI_PLAN_ENRICHMENT_SCHEMA,
              temperature: 0.35,
            },
          })
          .finally(() => clearTimeout(timer));
        const parsed = JSON.parse(res.text);
        if (parsed && parsed.coachHeadline) {
          aiEnrichment = parsed;
          break;
        }
      } catch (e) {
        console.log(`Planner Gemini enrichment fallback: ${e.message}`);
      }
    }
  }

  const strategyByTitle = new Map();
  if (Array.isArray(aiEnrichment?.chapterStrategies)) {
    for (const item of aiEnrichment.chapterStrategies) {
      if (item?.chapterTitle) {
        strategyByTitle.set(String(item.chapterTitle).toLowerCase().trim(), item);
      }
    }
  }

  const days = [];
  let rotationQueue = [];

  // Round-robin passes: pass 1 holds every chapter once, later passes repeat only the Medium/High
  // priority ones, so every chapter is reached before any chapter repeats.
  const rotationPool = [];
  for (let r = 0; r < 3; r++) {
    for (const unit of prioritizedUnits) {
      const repeats = unit.priority === "High" ? 3 : unit.priority === "Medium" ? 2 : 1;
      if (r < repeats) rotationPool.push({ ...unit, occurrenceIndex: r + 1 });
    }
  }

  for (let dOffset = 0; dOffset < config.planDays; dOffset++) {
    const dateObj = new Date(baseDate);
    dateObj.setDate(baseDate.getDate() + dOffset);
    const dateYmd = formatDateYMD(dateObj);
    const dow = dateObj.getDay();
    const vacationMatch = isDateInVacation(dateYmd, config.vacationRanges);
    const isSchoolDay = !vacationMatch && config.schoolDays.includes(dow);

    const dayType = vacationMatch
      ? "vacation_day"
      : isSchoolDay
        ? "school_day"
        : "full_day";

    const dayTypeLabel = vacationMatch
      ? `Vacation / Holiday (${vacationMatch.label})`
      : isSchoolDay
        ? `School Day (${config.schoolStartTime}–${config.schoolEndTime})`
        : dow === 0
          ? "Sunday · Full Study & Recharge Day"
          : "Non-School Full Day";

    const slots = buildDailyTimeSlots(isSchoolDay ? "school_day" : "full_day", config, preset);
    const studyBlocks = [];
    const usedSubjectsToday = new Set();
    const usedUnitsToday = new Set();

    for (let sIdx = 0; sIdx < slots.length; sIdx++) {
      const slot = slots[sIdx];
      // Next chapter in the rotation, preferring a subject not used yet today and never the same chapter twice in a day.
      if (!rotationQueue.length) rotationQueue = [...rotationPool];
      // Always scan from the front: chapters skipped earlier (same subject already used today) come first next time.
      let pickIdx = rotationQueue.findIndex((u) => !usedSubjectsToday.has(u.subject) && !usedUnitsToday.has(u.id));
      if (pickIdx < 0) pickIdx = rotationQueue.findIndex((u) => !usedUnitsToday.has(u.id));
      if (pickIdx < 0) pickIdx = 0;
      const chosenUnit = rotationQueue.splice(pickIdx, 1)[0];
      usedUnitsToday.add(chosenUnit.id);
      usedSubjectsToday.add(chosenUnit.subject);

      const aiStrat = strategyByTitle.get(String(chosenUnit.title).toLowerCase().trim());

      let focusType = "Concept Deep-Dive & NCERT Notes";
      if (chosenUnit.revisionTier === "heavy_restudy") {
        focusType = "Heavy Re-Study & Weak Subtopic Recovery";
      } else if (chosenUnit.revisionTier === "moderate_revision") {
        focusType = "Targeted Weak-Concept Practice & Requiz";
      } else if (chosenUnit.revisionTier === "mastered") {
        focusType = "Rapid Spaced-Repetition & Exam Questions";
      } else if (sIdx === slots.length - 1) {
        focusType = "Active Recall & Study Agent Quiz Checkpoint";
      }

      const defaultSubtasks = [];
      if (chosenUnit.weakSubtopics?.length) {
        defaultSubtasks.push(
          `Target weak subtopics from past quiz: ${chosenUnit.weakSubtopics.slice(0, 3).join(", ")}`
        );
      } else {
        defaultSubtasks.push(
          `Read NCERT chapter & summarize key concepts for "${chosenUnit.title}"`
        );
      }
      defaultSubtasks.push(
        `Solve textbook exercises & take Study Agent Quiz on "${chosenUnit.title}"`
      );

      const rawSubtasks =
        Array.isArray(aiStrat?.subtasks) && aiStrat.subtasks.length >= 2
          ? aiStrat.subtasks.slice(0, 3)
          : defaultSubtasks;

      const strategyNote =
        aiStrat?.strategyNote ||
        (chosenUnit.weakSubtopics?.length
          ? `Focus on fixing weak areas (${chosenUnit.weakSubtopics.slice(0, 2).join(", ")}) identified in your last quiz (${chosenUnit.quizPercentage}%).`
          : chosenUnit.daysUntilExam != null
            ? `Exam in ${chosenUnit.daysUntilExam} day(s) — prioritize high-yield NCERT questions and timed practice.`
            : `Complete ${slot.breakIntervalText} and test recall immediately after.`);

      const relativeDuePrefix =
        dateYmd === realTodayYmd ? "today" : dateYmd === realTomorrowYmd ? "tomorrow" : dateYmd;
      const todoistDueString = `${relativeDuePrefix} at ${format12hDueTime(slot.startTime)}`;

      const ytQuery = encodeURIComponent(`${chosenUnit.subject} ${chosenUnit.title}${studentClass ? ` Class ${studentClass}` : ""} NCERT`);

      studyBlocks.push({
        id: `block_${dateYmd}_${sIdx + 1}`,
        slotIndex: sIdx + 1,
        startTime: slot.startTime,
        endTime: slot.endTime,
        durationMins: slot.durationMins,
        breakMinsAfter: slot.breakMinsAfter,
        period: slot.period,
        sessionPatternLabel: slot.sessionPatternLabel,
        breakIntervalText: slot.breakIntervalText,
        subject: chosenUnit.subject,
        chapterId: chosenUnit.id,
        chapterNumber: chosenUnit.number,
        chapterTitle: chosenUnit.title,
        title: `${chosenUnit.number ? `Ch ${chosenUnit.number}: ` : ""}${chosenUnit.title}`,
        priority: chosenUnit.priority,
        focusType,
        quizPercentage: chosenUnit.quizPercentage,
        revisionTier: chosenUnit.revisionTier,
        weakSubtopics: chosenUnit.weakSubtopics || [],
        examName: chosenUnit.exam,
        examDate: chosenUnit.examDate,
        daysUntilExam: chosenUnit.daysUntilExam,
        pdfUrl: chosenUnit.pdfUrl,
        youtubeUrl: `https://www.youtube.com/results?search_query=${ytQuery}`,
        strategyNote,
        todoistDueString,
        synced: false,
        todoistTaskId: null,
        todoistUrl: null,
        completed: false,
        subtasks: rawSubtasks.map((st, idx) => ({
          id: `sub_${dateYmd}_${sIdx + 1}_${idx + 1}`,
          content: String(st),
          completed: false,
          todoistTaskId: null,
        })),
      });
    }

    const totalScheduledMins = studyBlocks.reduce((acc, b) => acc + b.durationMins, 0);
    const totalBreakMins = studyBlocks.reduce((acc, b) => acc + b.breakMinsAfter, 0);
    const layout = buildDayLayout(config, isSchoolDay);
    const studyShortfallMins = Math.max(0, Math.round(config.dailyStudyHours * 60) - totalScheduledMins);

    days.push({
      dayIndex: dOffset + 1,
      date: dateYmd,
      dayOfWeek: DAY_NAMES[dow],
      shortDay: SHORT_DAY_NAMES[dow],
      displayDate: `${SHORT_DAY_NAMES[dow]}, ${SHORT_MONTHS[dateObj.getMonth()]} ${dateObj.getDate()}`,
      dayLabel:
        dateYmd === realTodayYmd
          ? `Today (${SHORT_DAY_NAMES[dow]}, ${SHORT_MONTHS[dateObj.getMonth()]} ${dateObj.getDate()})`
          : dateYmd === realTomorrowYmd
            ? `Tomorrow (${SHORT_DAY_NAMES[dow]}, ${SHORT_MONTHS[dateObj.getMonth()]} ${dateObj.getDate()})`
            : `${DAY_NAMES[dow]}, ${SHORT_MONTHS[dateObj.getMonth()]} ${dateObj.getDate()}`,
      dayType,
      dayTypeLabel,
      isSchoolDay,
      isVacation: Boolean(vacationMatch),
      vacationLabel: vacationMatch?.label || null,
      sleepHours: config.dailySleepHours,
      studyHours: +(totalScheduledMins / 60).toFixed(1),
      freeHours: config.dailyFreeHours,
      freePlayHours: config.dailyFreeHours,
      sleepBlock: layout.sleepBlock,
      freeBlock: layout.freeBlock,
      wakeTime: layout.wakeTime,
      studyShortfallMins,
      totalBreakMins,
      todoistDueString: `${dateYmd === realTodayYmd ? "today" : dateYmd === realTomorrowYmd ? "tomorrow" : dateYmd} at 6pm`,
      studyBlocks,
    });
  }

  const subjectBreakdownMap = new Map();
  for (const d of days) {
    for (const b of d.studyBlocks) {
      if (!subjectBreakdownMap.has(b.subject)) {
        subjectBreakdownMap.set(b.subject, {
          subject: b.subject,
          priority: b.priority,
          sessionsCount: 0,
          totalMinutes: 0,
          chaptersCovered: new Set(),
          weakSubtopicsTargeted: new Set(),
          examDate: b.examDate || null,
        });
      }
      const entry = subjectBreakdownMap.get(b.subject);
      entry.sessionsCount++;
      entry.totalMinutes += b.durationMins;
      entry.chaptersCovered.add(b.chapterTitle);
      for (const w of b.weakSubtopics || []) entry.weakSubtopicsTargeted.add(w);
    }
  }

  const prioritizedSubjects = [...subjectBreakdownMap.values()].map((s) => ({
    subject: s.subject,
    priority: s.priority,
    sessionsCount: s.sessionsCount,
    totalHours: +(s.totalMinutes / 60).toFixed(1),
    chaptersCount: s.chaptersCovered.size,
    chapters: [...s.chaptersCovered],
    weakSubtopics: [...s.weakSubtopicsTargeted],
    examDate: s.examDate,
  }));

  const weakChaptersCount = prioritizedUnits.filter(
    (u) => u.revisionTier === "heavy_restudy" || u.revisionTier === "moderate_revision"
  ).length;

  const defaultHeadline =
    weakChaptersCount > 0
      ? `Smart ${config.planDays}-Day Plan · Prioritizing ${weakChaptersCount} Revision Chapter(s) & Upcoming Exams`
      : `Balanced ${config.planDays}-Day Study & Todoist Schedule (${config.dailyStudyHours}h/day · ${preset.label})`;

  const defaultSummary = `Scheduled ${config.dailyStudyHours} hours of focused study, ${config.dailyFreeHours} hours of free time from ${config.freeStartTime} and ${config.dailySleepHours} hours of sleep (${config.sleepStartTime}–${config.wakeUpTime}) daily across ${config.planDays} days. Monday–Saturday school timings (${config.schoolStartTime}–${config.schoolEndTime}) place study blocks in afternoon/evening focus windows, while Sundays and holidays unlock full-day deep-work and play/recharge schedules.`;

  const defaultRecs = [
    `Follow ${preset.label} strictly—step away from your desk during every ${preset.breakMins}-minute break to keep retention high.`,
    weakChaptersCount > 0
      ? `Chapters with quiz scores below 80% are front-loaded in peak focus slots for rapid score recovery.`
      : `Take a Study Agent chapter quiz after finishing each chapter's study block to lock in active recall.`,
    `Protect your ${config.dailySleepHours}-hour sleep window (${config.sleepStartTime}–${config.wakeUpTime}) each night so memory consolidation stays optimal before exams.`,
  ];

  return {
    generatedAt: new Date().toISOString(),
    startDate: planStartYmd,
    hasSyllabus: chapters.length > 0,
    usedQuizHistoryFallback: chapters.some((c) => Boolean(c.result)),
    sessionStyleId: preset.id,
    sessionStyleLabel: preset.label,
    config,
    coachHeadline: aiEnrichment?.coachHeadline || defaultHeadline,
    coachSummary: aiEnrichment?.coachSummary || defaultSummary,
    keyRecommendations:
      Array.isArray(aiEnrichment?.keyRecommendations) && aiEnrichment.keyRecommendations.length
        ? aiEnrichment.keyRecommendations
        : defaultRecs,
    metrics: {
      totalDays: days.length,
      schoolDaysCount: days.filter((d) => d.dayType === "school_day").length,
      fullDaysCount: days.filter((d) => d.dayType !== "school_day").length,
      totalStudyHours: +days.reduce((acc, d) => acc + d.studyHours, 0).toFixed(1),
      dailyStudyHours: config.dailyStudyHours,
      dailySleepHours: config.dailySleepHours,
      dailyFreeHours: config.dailyFreeHours,
      totalBlocks: days.reduce((acc, d) => acc + d.studyBlocks.length, 0),
      weakChaptersTargeted: weakChaptersCount,
    },
    prioritizedSubjects,
    days,
    todoistSync: {
      synced: false,
      syncedAt: null,
      parentTasksCreated: 0,
      subTasksCreated: 0,
      totalTasksCreated: 0,
      upcomingUrl: "https://app.todoist.com/app/upcoming",
    },
  };
}


// ---------------------------------------------------------------------------
// 4. Telegram Bot Daily Study Brief, Partial Carry-Over & Dynamic Rescheduling
// ---------------------------------------------------------------------------

/**
 * Rescheduling pads the plan with empty look-ahead days so it has somewhere to move tasks.
 * Drop the empty ones past the chosen horizon so the plan never shows more days than the student asked for.
 */
export function trimEmptyDaysPastHorizon(plan, planDays) {
  if (!plan || !Array.isArray(plan.days)) return plan;
  const limit = Math.max(1, Number(planDays) || 7);
  while (
    plan.days.length > limit &&
    !(plan.days[plan.days.length - 1].studyBlocks || []).length
  ) {
    plan.days.pop();
  }
  return plan;
}

export function getTodayIstYmd() {
  const istNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return formatDateYMD(istNow);
}

export function addDaysYmd(baseYmd, daysToAdd) {
  const d = new Date(`${baseYmd}T00:00:00`);
  d.setDate(d.getDate() + Number(daysToAdd || 0));
  return formatDateYMD(d);
}

export function formatFriendlyDate(dateYmd, todayYmd = getTodayIstYmd()) {
  const tomorrowYmd = addDaysYmd(todayYmd, 1);
  const d = new Date(`${dateYmd}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(dateYmd);
  const shortStr = `${SHORT_DAY_NAMES[d.getDay()]}, ${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (dateYmd === todayYmd) return `Today (${shortStr})`;
  if (dateYmd === tomorrowYmd) return `Tomorrow (${shortStr})`;
  return shortStr;
}

function buildEmptyPlanDay(dateYmd, dayIndex, configInput = {}, todayYmd = getTodayIstYmd()) {
  const config = normalizePlannerConfig(configInput);
  const preset = getSessionPreset(config);
  const dateObj = new Date(`${dateYmd}T00:00:00`);
  const dow = dateObj.getDay();
  const vacationMatch = isDateInVacation(dateYmd, config.vacationRanges);
  const isSchoolDay = !vacationMatch && config.schoolDays.includes(dow);
  const dayType = vacationMatch ? "vacation_day" : isSchoolDay ? "school_day" : "full_day";
  const dayTypeLabel = vacationMatch
    ? `Vacation / Holiday (${vacationMatch.label})`
    : isSchoolDay
      ? `School Day (${config.schoolStartTime}–${config.schoolEndTime})`
      : dow === 0
        ? "Sunday · Full Study & Recharge Day"
        : "Non-School Full Day";
  const layout = buildDayLayout(config, isSchoolDay);
  const tomorrowYmd = addDaysYmd(todayYmd, 1);

  return {
    dayIndex,
    date: dateYmd,
    dayOfWeek: DAY_NAMES[dow],
    shortDay: SHORT_DAY_NAMES[dow],
    displayDate: `${SHORT_DAY_NAMES[dow]}, ${SHORT_MONTHS[dateObj.getMonth()]} ${dateObj.getDate()}`,
    dayLabel:
      dateYmd === todayYmd
        ? `Today (${SHORT_DAY_NAMES[dow]}, ${SHORT_MONTHS[dateObj.getMonth()]} ${dateObj.getDate()})`
        : dateYmd === tomorrowYmd
          ? `Tomorrow (${SHORT_DAY_NAMES[dow]}, ${SHORT_MONTHS[dateObj.getMonth()]} ${dateObj.getDate()})`
          : `${DAY_NAMES[dow]}, ${SHORT_MONTHS[dateObj.getMonth()]} ${dateObj.getDate()}`,
    dayType,
    dayTypeLabel,
    isSchoolDay,
    isVacation: Boolean(vacationMatch),
    vacationLabel: vacationMatch?.label || null,
    sleepHours: config.dailySleepHours,
    studyHours: 0,
    freeHours: config.dailyFreeHours,
    freePlayHours: config.dailyFreeHours,
    sleepBlock: layout.sleepBlock,
    freeBlock: layout.freeBlock,
    wakeTime: layout.wakeTime,
    studyShortfallMins: 0,
    totalBreakMins: 0,
    todoistDueString: `${dateYmd === todayYmd ? "today" : dateYmd === tomorrowYmd ? "tomorrow" : dateYmd} at 6pm`,
    studyBlocks: [],
    _presetLabel: preset.label,
  };
}

function recalculateDayTimings(day, configInput = {}, todayYmd = getTodayIstYmd()) {
  const config = normalizePlannerConfig(configInput);
  const preset = getSessionPreset(config);
  const slots = buildDailyTimeSlots(day.isSchoolDay ? "school_day" : "full_day", config, preset);
  const blocks = Array.isArray(day.studyBlocks) ? day.studyBlocks : [];
  const tomorrowYmd = addDaysYmd(todayYmd, 1);

  let lastEndMins = slots[0] ? parseTimeToMins(slots[0].startTime, 16 * 60) : 16 * 60;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    b.slotIndex = i + 1;
    const dur = Math.max(15, Number(b.durationMins) || 45);
    if (slots[i]) {
      b.startTime = slots[i].startTime;
      b.endTime = minsToTimeStr(parseTimeToMins(slots[i].startTime) + dur);
      b.period = slots[i].period;
      b.sessionPatternLabel = b.sessionPatternLabel || slots[i].sessionPatternLabel;
      b.breakIntervalText = b.breakIntervalText || slots[i].breakIntervalText;
      lastEndMins = parseTimeToMins(b.endTime) + (slots[i].breakMinsAfter || 15);
    } else {
      b.startTime = minsToTimeStr(lastEndMins);
      b.endTime = minsToTimeStr(lastEndMins + dur);
      b.period = lastEndMins < 17 * 60 ? "Afternoon Study Window" : "Evening Study Window";
      b.sessionPatternLabel = b.sessionPatternLabel || preset.label;
      b.breakIntervalText = b.breakIntervalText || `${dur}m focused study session`;
      lastEndMins = lastEndMins + dur + 15;
    }
    const relPrefix = day.date === todayYmd ? "today" : day.date === tomorrowYmd ? "tomorrow" : day.date;
    b.todoistDueString = `${relPrefix} at ${format12hDueTime(b.startTime)}`;
  }

  const activeMins = blocks
    .filter((b) => b.status !== "rescheduled")
    .reduce((acc, b) => acc + (Number(b.durationMins) || 0), 0);
  day.studyHours = +(activeMins / 60).toFixed(1);
}

/**
 * Ensures the user has an active, up-to-date study plan in src/db.js.
 * If none exists (or all scheduled days are in the past), generates and saves one automatically.
 */
export async function ensureUserStudyPlan(
  telegramUserId,
  { todayYmd = getTodayIstYmd(), forceRegenerate = false } = {}
) {
  const [chapters, existing] = await Promise.all([
    getChaptersWithResults(telegramUserId),
    getStudyPlanForUser(telegramUserId),
  ]);
  const syllabusChapters = (chapters || []).filter((c) => !c?.is_custom);
  const hasSyllabus = syllabusChapters.length > 0;
  const config = normalizePlannerConfig(existing?.config || DEFAULT_PLANNER_CONFIG);

  let plan = existing?.plan || null;
  const hasFallbackBlocks =
    plan &&
    Array.isArray(plan.days) &&
    plan.days.some((d) =>
      (d.studyBlocks || []).some((b) => String(b.chapterId || "").startsWith("fallback-"))
    );

  const hasSavedPlan = Boolean(
    plan && !hasFallbackBlocks && Array.isArray(plan.days) && plan.days.length > 0
  );

  // If no syllabus is uploaded and no valid study plan is saved, do not generate a plan
  if (!hasSyllabus && !hasSavedPlan) {
    return {
      hasSyllabus: false,
      hasPlan: false,
      noPlan: true,
      chapters: [],
      plan: null,
      config,
      todayYmd,
    };
  }

  // If the user has not saved any study plan yet (and forceRegenerate was not requested),
  // do not auto-generate a plan in Telegram — return hasPlan: false / noPlan: true.
  if (!hasSavedPlan && !forceRegenerate) {
    return {
      hasSyllabus,
      hasPlan: false,
      noPlan: true,
      chapters: syllabusChapters,
      plan: null,
      config,
      todayYmd,
    };
  }

  if (forceRegenerate && hasSyllabus) {
    const [geminiKeys, classLevel] = await Promise.all([
      getUserKeys(telegramUserId),
      getUserClass(telegramUserId),
    ]);
    plan = await generateAiStudyPlan({
      chapters: syllabusChapters,
      config,
      geminiKeys,
      startDate: todayYmd,
      classLevel,
    });
    if (plan) {
      await saveStudyPlanForUser(telegramUserId, { config, plan });
    }
  }

  return {
    hasSyllabus: hasSyllabus || hasSavedPlan,
    hasPlan: Boolean(plan && Array.isArray(plan.days) && plan.days.length > 0),
    noPlan: !(plan && Array.isArray(plan.days) && plan.days.length > 0),
    chapters: syllabusChapters,
    plan: hasFallbackBlocks ? null : plan,
    config,
    todayYmd,
  };
}

/**
 * Fetches today's scheduled tasks/chapters and completion statistics for the given user.
 */
export async function getTodayScheduleForUser(
  telegramUserId,
  { todayYmd = getTodayIstYmd(), forceRegenerate = false } = {}
) {
  const { hasSyllabus, hasPlan, chapters, plan, config } = await ensureUserStudyPlan(telegramUserId, {
    todayYmd,
    forceRegenerate,
  });

  if (!hasPlan || !plan) {
    return {
      hasSyllabus,
      hasPlan: false,
      noPlan: true,
      chapters,
      plan: null,
      config,
      day: null,
      todayYmd,
      stats: { total: 0, completed: 0, partial: 0, rescheduled: 0, remaining: 0, pct: 0 },
    };
  }

  const days = Array.isArray(plan?.days) ? plan.days : [];
  let day = days.find((d) => d.date === todayYmd) || days.find((d) => d.date >= todayYmd) || days[0] || null;

  if (!day) {
    return {
      hasSyllabus,
      hasPlan: false,
      noPlan: true,
      chapters,
      plan: null,
      config,
      day: null,
      todayYmd,
      stats: { total: 0, completed: 0, partial: 0, rescheduled: 0, remaining: 0, pct: 0 },
    };
  }

  const stats = getDailyProgressStats(day);
  return {
    hasSyllabus,
    hasPlan: true,
    noPlan: false,
    chapters,
    plan,
    config,
    day,
    todayYmd,
    stats,
  };
}

/**
 * Marks a task as 100% completed in src/db.js (and syncs to Todoist if linked),
 * returning updated daily progress stats.
 */
export async function completeStudyTask(telegramUserId, taskId, { todayYmd = getTodayIstYmd() } = {}) {
  const { hasSyllabus, hasPlan, plan } = await ensureUserStudyPlan(telegramUserId, { todayYmd });
  if (!hasPlan || !plan) {
    return {
      ok: false,
      noSyllabus: !hasSyllabus,
      noPlan: true,
      error: !hasSyllabus
        ? "No syllabus has been processed yet. Upload your syllabus to get started."
        : "You don't have any study plans saved yet. Generate your study plan on the Web Planner first.",
    };
  }
  const res = await markStudyTaskDone(telegramUserId, taskId);
  if (!res.ok) return res;

  if (res.task?.todoistTaskId) {
    const token = await getTodoistKey(telegramUserId).catch(() => "");
    if (token) {
      await setTodoistTaskCompleted({
        token,
        taskId: res.task.todoistTaskId,
        completed: true,
      }).catch(() => {});
    }
  }

  return res;
}

/**
 * Marks a task as 50% complete in src/db.js and automatically carries over the remaining half
 * of the topic into tomorrow's schedule.
 */
export async function carryOverPartialTask(telegramUserId, taskId, { todayYmd = getTodayIstYmd() } = {}) {
  const { hasSyllabus, hasPlan, plan, config } = await ensureUserStudyPlan(telegramUserId, { todayYmd });
  if (!hasPlan || !plan) {
    return {
      ok: false,
      noSyllabus: !hasSyllabus,
      noPlan: true,
      error: !hasSyllabus
        ? "No syllabus has been processed yet. Upload your syllabus to get started."
        : "You don't have any study plans saved yet. Generate your study plan on the Web Planner first.",
    };
  }
  const found = findTaskInPlan(plan, taskId);
  if (!found) {
    return { ok: false, error: `Task "${taskId}" not found in your study plan.` };
  }

  const { day, block } = found;
  const tomorrowYmd = addDaysYmd(day.date || todayYmd, 1);

  // 1. Mark current task as 50% complete in db
  block.completed = false;
  block.status = "partial";
  block.completionPct = 50;
  block.partialLoggedAt = new Date().toISOString();
  block.carriedToDate = tomorrowYmd;

  if (Array.isArray(block.subtasks) && block.subtasks.length > 0) {
    const half = Math.max(1, Math.ceil(block.subtasks.length / 2));
    block.subtasks.forEach((sub, idx) => {
      if (sub && typeof sub === "object" && idx < half) {
        sub.completed = true;
      }
    });
  }

  // 2. Find or create tomorrow's schedule day
  let tomorrowDay = plan.days.find((d) => d.date === tomorrowYmd);
  if (!tomorrowDay) {
    tomorrowDay = buildEmptyPlanDay(tomorrowYmd, plan.days.length + 1, config, todayYmd);
    plan.days.push(tomorrowDay);
    plan.days.sort((a, b) => a.date.localeCompare(b.date));
    plan.days.forEach((d, idx) => {
      d.dayIndex = idx + 1;
    });
  }

  tomorrowDay.studyBlocks = Array.isArray(tomorrowDay.studyBlocks) ? tomorrowDay.studyBlocks : [];

  // 3. Avoid duplicate carry-over if user tapped Half Done twice on the same task
  let carryOverBlock = tomorrowDay.studyBlocks.find((b) => b.carriedFromTaskId === block.id);
  if (!carryOverBlock) {
    const remainingDuration = Math.max(25, Math.round((Number(block.durationMins) || 60) / 2));
    const baseTitle = String(block.title || block.chapterTitle || "Study Topic")
      .replace(/\s*\(Remaining 50%\)\s*$/i, "")
      .trim();
    const nextSlotNum = tomorrowDay.studyBlocks.length + 1;
    const carryId = `block_${tomorrowYmd}_${nextSlotNum}`;

    const remainingSubtasks = Array.isArray(block.subtasks)
      ? block.subtasks.filter((s) => !s.completed).map((s, idx) => ({
          id: `sub_${tomorrowYmd}_${nextSlotNum}_${idx + 1}`,
          content: typeof s === "string" ? s : String(s.content || ""),
          completed: false,
          todoistTaskId: null,
        }))
      : [];

    if (!remainingSubtasks.length) {
      remainingSubtasks.push({
        id: `sub_${tomorrowYmd}_${nextSlotNum}_1`,
        content: `Complete remaining 50% of ${baseTitle} & take Study Agent Quiz`,
        completed: false,
        todoistTaskId: null,
      });
    }

    carryOverBlock = {
      ...block,
      id: carryId,
      slotIndex: nextSlotNum,
      durationMins: remainingDuration,
      title: `${baseTitle} (Remaining 50%)`,
      priority: "High",
      focusType: "Carry-Over Completion (Remaining 50%)",
      strategyNote: `Finish the remaining half of "${baseTitle}" carried over from ${day.date}.`,
      carriedFromTaskId: block.id,
      carriedFromDate: day.date,
      carriedToDate: null,
      completed: false,
      status: "pending",
      completionPct: 0,
      synced: false,
      todoistTaskId: null,
      todoistUrl: null,
      subtasks: remainingSubtasks,
    };

    // Front-load carried-over partial task at the start of tomorrow's schedule
    tomorrowDay.studyBlocks.unshift(carryOverBlock);
    recalculateDayTimings(tomorrowDay, config, todayYmd);
  }

  block.carriedToTaskId = carryOverBlock.id;

  if (plan.metrics) {
    plan.metrics.totalBlocks = plan.days.reduce((acc, d) => acc + (d.studyBlocks?.length || 0), 0);
    plan.metrics.totalStudyHours = +plan.days.reduce((acc, d) => acc + (d.studyHours || 0), 0).toFixed(1);
  }

  await saveStudyPlanForUser(telegramUserId, { plan });
  const stats = getDailyProgressStats(day);

  return {
    ok: true,
    task: block,
    carryOverBlock,
    day,
    tomorrowDay,
    tomorrowDate: tomorrowYmd,
    tomorrowLabel: formatFriendlyDate(tomorrowYmd, todayYmd),
    stats,
    plan,
  };
}

/**
 * Dynamically redistributes a specific unfinished task (`taskId`) OR all overdue/unfinished tasks
 * across upcoming days in the user's schedule without overloading a single day.
 */
export async function rescheduleTasks(
  telegramUserId,
  { taskId = null, todayYmd = getTodayIstYmd() } = {}
) {
  const { hasSyllabus, hasPlan, plan, config } = await ensureUserStudyPlan(telegramUserId, { todayYmd });
  if (!hasPlan || !plan) {
    return {
      ok: false,
      noSyllabus: !hasSyllabus,
      noPlan: true,
      error: !hasSyllabus
        ? "No syllabus has been processed yet. Upload your syllabus to get started."
        : "You don't have any study plans saved yet. Generate your study plan on the Web Planner first.",
    };
  }
  const maxDailyMins = Math.round((Number(config.dailyStudyHours) || 5) * 60);
  const maxBlocksPerDay = Math.max(3, Math.ceil(maxDailyMins / 75) + 1);

  const tasksToMove = [];

  if (taskId) {
    const found = findTaskInPlan(plan, taskId);
    if (!found) {
      return { ok: false, error: `Task "${taskId}" not found in your study plan.` };
    }
    tasksToMove.push(found);

    // Also include any strictly overdue unfinished tasks from earlier days (< todayYmd)
    for (let dIdx = 0; dIdx < plan.days.length; dIdx++) {
      const d = plan.days[dIdx];
      if (d.date >= todayYmd) continue;
      for (let bIdx = 0; bIdx < (d.studyBlocks || []).length; bIdx++) {
        const b = d.studyBlocks[bIdx];
        if (!b.completed && b.status !== "rescheduled" && b.id !== found.block.id) {
          tasksToMove.push({ day: d, dayIndex: dIdx, block: b, blockIndex: bIdx });
        }
      }
    }
  } else {
    // 1. Collect all overdue unfinished tasks from past days (date < todayYmd)
    for (let dIdx = 0; dIdx < plan.days.length; dIdx++) {
      const d = plan.days[dIdx];
      if (d.date >= todayYmd) continue;
      for (let bIdx = 0; bIdx < (d.studyBlocks || []).length; bIdx++) {
        const b = d.studyBlocks[bIdx];
        if (!b.completed && b.status !== "rescheduled") {
          tasksToMove.push({ day: d, dayIndex: dIdx, block: b, blockIndex: bIdx });
        }
      }
    }

    // 2. If no past overdue tasks, redistribute unfinished tasks from today
    if (!tasksToMove.length) {
      const todayIdx = plan.days.findIndex((d) => d.date === todayYmd);
      if (todayIdx >= 0) {
        const d = plan.days[todayIdx];
        for (let bIdx = 0; bIdx < (d.studyBlocks || []).length; bIdx++) {
          const b = d.studyBlocks[bIdx];
          if (!b.completed && b.status !== "rescheduled") {
            tasksToMove.push({ day: d, dayIndex: todayIdx, block: b, blockIndex: bIdx });
          }
        }
      }
    }
  }

  if (!tasksToMove.length) {
    const todayDay = plan.days.find((d) => d.date === todayYmd) || plan.days[0] || null;
    return {
      ok: true,
      movedTasks: [],
      day: todayDay,
      stats: todayDay ? getDailyProgressStats(todayDay) : null,
      plan,
    };
  }

  // Helper to get active minutes & block count for a candidate day
  const getDayLoad = (d) => {
    const active = (d.studyBlocks || []).filter((b) => b.status !== "rescheduled");
    const mins = active.reduce((acc, b) => acc + (Number(b.durationMins) || 0), 0);
    return { count: active.length, mins };
  };

  // Helper to ensure there is at least one upcoming day after `afterDateYmd` with capacity
  const pickTargetUpcomingDay = (afterDateYmd, neededMins) => {
    const minTargetDate = afterDateYmd > todayYmd ? addDaysYmd(afterDateYmd, 1) : addDaysYmd(todayYmd, 1);

    // Ensure at least 3 upcoming days exist in plan.days
    let lastDate = plan.days[plan.days.length - 1]?.date || todayYmd;
    while (lastDate < addDaysYmd(minTargetDate, 2)) {
      const nextDate = addDaysYmd(lastDate, 1);
      plan.days.push(buildEmptyPlanDay(nextDate, plan.days.length + 1, config, todayYmd));
      lastDate = nextDate;
    }

    const candidates = plan.days.filter((d) => d.date >= minTargetDate);

    // First pass: find the earliest upcoming day that fits neededMins without exceeding maxDailyMins + 30m buffer
    let bestDay = null;
    let bestScore = Infinity;

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const load = getDayLoad(cand);
      const fitsCleanly = load.mins + neededMins <= maxDailyMins + 30 && load.count < maxBlocksPerDay;
      // Score balances current load and proximity so tasks spread evenly across upcoming days
      const score = load.mins + i * 20 + (fitsCleanly ? 0 : 500);
      if (score < bestScore) {
        bestScore = score;
        bestDay = cand;
      }
    }

    // If even the best candidate is overloaded, append a new day at the end of the plan
    if (!bestDay || getDayLoad(bestDay).mins + neededMins > maxDailyMins + 60) {
      const newDate = addDaysYmd(plan.days[plan.days.length - 1].date, 1);
      const newDay = buildEmptyPlanDay(newDate, plan.days.length + 1, config, todayYmd);
      plan.days.push(newDay);
      return newDay;
    }

    return bestDay;
  };

  const movedTasks = [];

  for (const item of tasksToMove) {
    const { day: srcDay, block } = item;
    const dur = Math.max(25, Number(block.durationMins) || 60);
    const targetDay = pickTargetUpcomingDay(srcDay.date, dur);

    // Mark original block as rescheduled so today's view reflects it cleanly
    block.completed = false;
    block.status = "rescheduled";
    block.rescheduledTo = targetDay.date;
    block.rescheduledAt = new Date().toISOString();

    const nextSlotNum = (targetDay.studyBlocks?.length || 0) + 1;
    const newBlockId = `block_${targetDay.date}_${nextSlotNum}`;

    const clonedSubtasks = Array.isArray(block.subtasks)
      ? block.subtasks.map((s, idx) => ({
          id: `sub_${targetDay.date}_${nextSlotNum}_${idx + 1}`,
          content: typeof s === "string" ? s : String(s.content || ""),
          completed: Boolean(s.completed),
          todoistTaskId: null,
        }))
      : [];

    const newBlock = {
      ...block,
      id: newBlockId,
      slotIndex: nextSlotNum,
      rescheduledFrom: srcDay.date,
      rescheduledFromTaskId: block.id,
      rescheduledTo: null,
      completed: false,
      status: "pending",
      synced: false,
      todoistTaskId: null,
      todoistUrl: null,
      subtasks: clonedSubtasks,
    };

    targetDay.studyBlocks = Array.isArray(targetDay.studyBlocks) ? targetDay.studyBlocks : [];
    targetDay.studyBlocks.push(newBlock);
    recalculateDayTimings(targetDay, config, todayYmd);
    recalculateDayTimings(srcDay, config, todayYmd);

    block.rescheduledToTaskId = newBlock.id;

    movedTasks.push({
      originalTaskId: block.id,
      newTaskId: newBlock.id,
      subject: block.subject,
      title: block.title || block.chapterTitle,
      durationMins: dur,
      fromDate: srcDay.date,
      fromDayLabel: formatFriendlyDate(srcDay.date, todayYmd),
      toDate: targetDay.date,
      toDayLabel: formatFriendlyDate(targetDay.date, todayYmd),
      startTime: newBlock.startTime,
      endTime: newBlock.endTime,
    });
  }

  plan.days.sort((a, b) => a.date.localeCompare(b.date));
  trimEmptyDaysPastHorizon(plan, config.planDays);
  plan.days.forEach((d, idx) => {
    d.dayIndex = idx + 1;
  });

  if (plan.metrics) {
    plan.metrics.totalDays = plan.days.length;
    plan.metrics.totalBlocks = plan.days.reduce((acc, d) => acc + (d.studyBlocks?.length || 0), 0);
    plan.metrics.totalStudyHours = +plan.days.reduce((acc, d) => acc + (d.studyHours || 0), 0).toFixed(1);
  }

  await saveStudyPlanForUser(telegramUserId, { plan });
  const primaryDay =
    (taskId ? tasksToMove[0]?.day : plan.days.find((d) => d.date === todayYmd)) ||
    plan.days.find((d) => d.date === todayYmd) ||
    plan.days[0] ||
    null;

  return {
    ok: true,
    movedTasks,
    day: primaryDay,
    stats: primaryDay ? getDailyProgressStats(primaryDay) : null,
    plan,
  };
}