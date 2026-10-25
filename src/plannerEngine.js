// src/plannerEngine.js
// AI Study Planner & Todoist SDK Integration (@doist/todoist-sdk)
import { TodoistApi } from "@doist/todoist-sdk";
import { GoogleGenAI, Type } from "@google/genai";
import { GEMINI_API_KEY, GEMINI_MODEL } from "./config.js";
import { cleanTodoistKey, isValidTodoistKey } from "./intake/userKeys.js";
import { storedSubject } from "./db.js";
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
      error: "Please paste a valid Todoist API token (at least 16 characters, no spaces).",
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
      if (resV1.status === 401 || resV1.status === 403) {
        return {
          ok: false,
          valid: false,
          error: "Todoist rejected this API token (Unauthorized). Please copy your active API token from Todoist Settings → Integrations → Developer.",
        };
      }
    } catch {}

    if (status === 401 || status === 403 || /\b(401|403|unauthorized|forbidden)\b/i.test(msg)) {
      return {
        ok: false,
        valid: false,
        error: "Todoist rejected this API token. Please check that you copied the exact token from Todoist Developer Settings.",
      };
    }

    return {
      ok: true,
      valid: true,
      verified: true,
      mode: "format_verified",
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

  if (!normalizedChapters.length) {
    if (Array.isArray(config.examDates) && config.examDates.length) {
      config.examDates.forEach((ex, i) => {
        const subject = storedSubject(ex.subject, ex.examName, "", "", i + 1);
        const priority = config.subjectPriorities?.[subject] || "High";
        normalizedChapters.push({
          id: `exam-unit-${i + 1}`,
          subject,
          number: 1,
          title: `${ex.examName || ex.subject} — Core Syllabus & Past Paper Practice`,
          pdfUrl: null,
          exam: ex.examName,
          examDate: ex.date,
          daysUntilExam: Math.max(
            0,
            Math.round((new Date(`${ex.date}T00:00:00`) - new Date(`${todayYmd}T00:00:00`)) / 86400000)
          ),
          priority,
          quizPercentage: null,
          revisionTier: "untested",
          weakSubtopics: [],
          urgencyScore: 85 - i * 5,
        });
      });
    } else {
      const fallbackUnits = [
        { subject: "Physics", number: 1, title: "Light, Electricity & Laws of Motion — Concepts & Numericals", priority: "High" },
        { subject: "Chemistry", number: 1, title: "Chemical Reactions, Acids, Bases & Atomic Structure", priority: "High" },
        { subject: "Mathematics", number: 1, title: "Quadratic Equations, Polynomials & Triangles Practice", priority: "High" },
        { subject: "Biology", number: 1, title: "Life Processes, Cell Structure & Control and Coordination", priority: "Medium" },
        { subject: "History", number: 1, title: "The Rise of Nationalism in Europe & India", priority: "Medium" },
        { subject: "Geography", number: 1, title: "Resources, Water, Agriculture & Climate", priority: "Medium" },
        { subject: "Civics", number: 1, title: "Power-Sharing, Federalism & Constitutional Design", priority: "Low" },
        { subject: "Economics", number: 1, title: "Development & Sectors of the Indian Economy", priority: "Low" },
      ];
      fallbackUnits.forEach((u, i) => {
        normalizedChapters.push({
          id: `fallback-${i + 1}`,
          subject: u.subject,
          number: u.number,
          title: u.title,
          pdfUrl: null,
          exam: "CBSE Curriculum",
          examDate: null,
          daysUntilExam: null,
          priority: config.subjectPriorities?.[u.subject] || u.priority,
          quizPercentage: null,
          revisionTier: "untested",
          weakSubtopics: [],
          urgencyScore: 75 - i * 4,
        });
      });
    }
  }

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

  const prioritizedUnits = buildPrioritizedStudyQueue({
    chapters,
    config,
    todayYmd,
  });

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
  let unitCursor = 0;

  const rotationPool = [];
  for (const unit of prioritizedUnits) {
    const repeats = unit.priority === "High" ? 3 : unit.priority === "Medium" ? 2 : 1;
    for (let r = 0; r < repeats; r++) {
      rotationPool.push({ ...unit, occurrenceIndex: r + 1 });
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

    for (let sIdx = 0; sIdx < slots.length; sIdx++) {
      const slot = slots[sIdx];
      let chosenUnit = rotationPool[unitCursor % rotationPool.length];
      if (rotationPool.length > 1 && usedSubjectsToday.has(chosenUnit.subject)) {
        const altIdx = rotationPool.findIndex(
          (u, idx) => idx > unitCursor % rotationPool.length && !usedSubjectsToday.has(u.subject)
        );
        if (altIdx >= 0) chosenUnit = rotationPool[altIdx];
      }
      unitCursor++;
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
