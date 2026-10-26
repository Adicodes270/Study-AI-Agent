// src/agent/snapshot.js
import "../tz.js";
import {
  compactTaskId,
  countAgentMessagesToday,
  getAgentMemory,
  getChaptersWithResults,
  getDailyProgressStats,
  getDueReviews,
  getRecentAgentActions,
  getStudyPlanForUser,
  readLocalStore,
} from "../db.js";
import {
  DEFAULT_PLANNER_CONFIG,
  addDaysYmd,
  getTodayIstYmd,
  normalizePlannerConfig,
} from "../plannerEngine.js";
import { revisionFor } from "../quizEngine.js";
import { getNowIstHhMm, isQuietHours as checkQuietHours } from "./quietHours.js";

const MAX_SNAPSHOT_BYTES = 2048;
const SENSITIVE_KEY_RE = /key|token|secret|password|cookie|session|auth|credential/i;

/**
 * Determine exam preparation mode from days remaining until nearest exam:
 *  - > 14 days (or no upcoming exam): 'learning'
 *  - 4..14 days: 'revision'
 *  - <= 3 days: 'final_prep'
 */
export function computeExamMode(nearestExamDays) {
  if (nearestExamDays === null || nearestExamDays === undefined || !Number.isFinite(Number(nearestExamDays))) {
    return "learning";
  }
  const days = Number(nearestExamDays);
  if (days > 14) return "learning";
  if (days >= 4) return "revision";
  return "final_prep";
}

function normalizeBlockStatus(block) {
  if (!block) return "pending";
  if (block.completed || block.status === "done") return "done";
  if (block.status === "partial" || Number(block.completionPct) === 50) return "partial";
  if (block.status === "rescheduled") return "rescheduled";
  return "pending";
}

function truncateStr(val, maxLen = 48) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s.length <= maxLen ? s : `${s.slice(0, maxLen - 1)}…`;
}

function sanitizeMemory(rawMemory) {
  if (!rawMemory || typeof rawMemory !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(rawMemory)) {
    if (SENSITIVE_KEY_RE.test(k)) continue;
    if (typeof v === "string") {
      out[k] = truncateStr(v, 80);
    } else if (typeof v === "number" || typeof v === "boolean" || v === null) {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.slice(0, 5).map((item) => (typeof item === "string" ? truncateStr(item, 40) : item));
    } else if (typeof v === "object") {
      const nested = {};
      for (const [nk, nv] of Object.entries(v)) {
        if (SENSITIVE_KEY_RE.test(nk)) continue;
        if (typeof nv === "string" || typeof nv === "number" || typeof nv === "boolean" || nv === null) {
          nested[nk] = typeof nv === "string" ? truncateStr(nv, 40) : nv;
        }
      }
      out[k] = nested;
    }
  }
  return out;
}

function computeProgressMetrics(days = [], todayYmd, memory = {}) {
  const todayDay = days.find((d) => d.date === todayYmd) || null;
  const todayStats = getDailyProgressStats(todayDay);

  const windowStartYmd = addDaysYmd(todayYmd, -6);
  let last7CompletedUnits = 0;
  let last7TotalBlocks = 0;

  const activeDates = new Set();
  for (const d of days) {
    if (!d?.date) continue;
    const stats = getDailyProgressStats(d);
    if (stats.completed > 0 || stats.partial > 0) {
      activeDates.add(d.date);
    }
    if (d.date >= windowStartYmd && d.date <= todayYmd) {
      const effectiveTotal = Math.max(0, stats.total - stats.rescheduled);
      last7TotalBlocks += effectiveTotal;
      last7CompletedUnits += stats.completed + stats.partial * 0.5;
    }
  }

  const last7DaysCompletionPct =
    last7TotalBlocks > 0 ? Math.min(100, Math.round((last7CompletedUnits / last7TotalBlocks) * 100)) : 0;

  let streakDays = 0;
  let cursorYmd = activeDates.has(todayYmd) ? todayYmd : addDaysYmd(todayYmd, -1);
  while (activeDates.has(cursorYmd)) {
    streakDays++;
    cursorYmd = addDaysYmd(cursorYmd, -1);
  }
  if (streakDays === 0 && Number.isFinite(Number(memory?.streakDays))) {
    streakDays = Math.max(0, Number(memory.streakDays));
  }

  return {
    completedToday: todayStats.completed,
    totalToday: todayStats.total,
    last7DaysCompletionPct,
    streakDays,
  };
}

function enforceSnapshotSizeLimit(snapshot, maxBytes = MAX_SNAPSHOT_BYTES) {
  const byteSize = () => Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  if (byteSize() < maxBytes) return snapshot;

  const trimSteps = [
    () => {
      snapshot.overdueTasks = snapshot.overdueTasks.slice(0, 3);
      snapshot.weakSubtopics = snapshot.weakSubtopics.slice(0, 4);
      snapshot.dueReviews = snapshot.dueReviews.slice(0, 4);
    },
    () => {
      snapshot.todayTasks = snapshot.todayTasks.slice(0, 5);
      snapshot.exams = snapshot.exams.slice(0, 4);
      snapshot.lastAgentActions = snapshot.lastAgentActions.slice(0, 3);
    },
    () => {
      snapshot.overdueTasks = snapshot.overdueTasks.slice(0, 2);
      snapshot.weakSubtopics = snapshot.weakSubtopics.slice(0, 2);
      snapshot.dueReviews = snapshot.dueReviews.slice(0, 2);
    },
    () => {
      const keys = Object.keys(snapshot.memory || {});
      const trimmedMem = {};
      for (const k of keys.slice(0, 4)) {
        trimmedMem[k] = snapshot.memory[k];
      }
      snapshot.memory = trimmedMem;
    },
    () => {
      snapshot.todayTasks = snapshot.todayTasks.slice(0, 3);
      snapshot.overdueTasks = snapshot.overdueTasks.slice(0, 1);
      snapshot.weakSubtopics = snapshot.weakSubtopics.slice(0, 1);
      snapshot.dueReviews = snapshot.dueReviews.slice(0, 1);
      snapshot.lastAgentActions = snapshot.lastAgentActions.slice(0, 2);
      snapshot.memory = {};
    },
  ];

  for (const step of trimSteps) {
    step();
    if (byteSize() < maxBytes) break;
  }

  return snapshot;
}

/**
 * Build a single compact (<2KB, zero keys/tokens) student state snapshot for `telegramUserId`.
 */
export async function buildStudentSnapshot(telegramUserId, { now = new Date() } = {}) {
  const uid = Number(telegramUserId);
  const nowDate = now instanceof Date ? now : new Date(now);
  const today = getTodayIstYmd();
  const nowIst = getNowIstHhMm(nowDate);

  const [planRecord, chapters, dueReviewRows, recentActions, messagesSentToday, rawMemory] =
    await Promise.all([
      getStudyPlanForUser(uid),
      getChaptersWithResults(uid),
      getDueReviews(uid, nowDate.toISOString()),
      getRecentAgentActions(uid, 5),
      countAgentMessagesToday(uid),
      getAgentMemory(uid),
    ]);

  const config = normalizePlannerConfig(
    planRecord?.config || planRecord?.plan?.config || DEFAULT_PLANNER_CONFIG
  );
  const plan = planRecord?.plan || null;
  const days = Array.isArray(plan?.days) ? plan.days : [];
  const memory = sanitizeMemory(rawMemory);

  const quietStart = memory.quietHoursStart || config.quietHoursStart || "22:00";
  const quietEnd = memory.quietHoursEnd || config.quietHoursEnd || config.wakeUpTime || "07:00";
  const isQuietHours = checkQuietHours(nowIst, quietStart, quietEnd);

  // 1. Today's tasks
  const todayDay = days.find((d) => d.date === today) || null;
  const todayTasks = (todayDay?.studyBlocks || []).map((b) => ({
    id: compactTaskId(b.id),
    title: truncateStr(b.title || b.chapterTitle || "Study Session", 48),
    subject: truncateStr(b.subject || "General", 24),
    status: normalizeBlockStatus(b),
    startTime: b.startTime || null,
    durationMins: Number(b.durationMins) || 0,
  }));

  // 2. Overdue tasks (unfinished blocks from past days < today)
  const overdueTasks = [];
  for (const d of days) {
    if (!d?.date || d.date >= today) continue;
    for (const b of d.studyBlocks || []) {
      const status = normalizeBlockStatus(b);
      if (status !== "done" && status !== "rescheduled") {
        overdueTasks.push({
          id: compactTaskId(b.id),
          date: d.date,
          title: truncateStr(b.title || b.chapterTitle || "Study Session", 44),
          subject: truncateStr(b.subject || "General", 24),
          status,
          durationMins: Number(b.durationMins) || 0,
        });
      }
    }
  }

  // 3. Progress metrics
  const progress = computeProgressMetrics(days, today, memory);

  // 4. Upcoming exams, nearestExamDays, and examMode
  const todayMidnightMs = new Date(`${today}T00:00:00`).getTime();
  const exams = (config.examDates || [])
    .filter((e) => e?.date && e.date >= today)
    .map((e) => {
      const daysLeft = Math.max(
        0,
        Math.round((new Date(`${e.date}T00:00:00`).getTime() - todayMidnightMs) / 86_400_000)
      );
      return {
        subject: truncateStr(e.subject || "General", 24),
        examName: truncateStr(e.examName || e.subject || "Exam", 36),
        date: e.date,
        daysLeft,
      };
    })
    .sort((a, b) => a.daysLeft - b.daysLeft || a.date.localeCompare(b.date));

  const nearestExamDays = exams.length > 0 ? exams[0].daysLeft : null;
  const examMode = computeExamMode(nearestExamDays);

  // 5. Quiz results -> weakSubtopics & recentQuiz
  const weakSubtopics = [];
  let latestQuizEntry = null;
  let latestQuizMs = -Infinity;

  for (const ch of chapters || []) {
    const res = ch?.result;
    if (!res) continue;
    const pct = Number(res.percentage) || 0;
    const updatedAt = res.updated_at ? new Date(res.updated_at) : null;
    const updatedMs = updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt.getTime() : 0;
    const lastQuizAt = updatedMs > 0 ? updatedAt.toISOString().slice(0, 10) : null;

    if (updatedMs >= latestQuizMs) {
      latestQuizMs = updatedMs;
      const daysAgo =
        updatedMs > 0 ? Math.max(0, Math.floor((nowDate.getTime() - updatedMs) / 86_400_000)) : 0;
      const tier = res.revision_tier || revisionFor(pct).tier;
      latestQuizEntry = {
        chapter: truncateStr(ch.title, 48),
        percentage: pct,
        tier,
        daysAgo,
      };
    }

    const weaks = Array.isArray(res.weak_subtopics) ? res.weak_subtopics : [];
    for (const sub of weaks) {
      if (!sub) continue;
      weakSubtopics.push({
        subject: truncateStr(ch.subject || "General", 24),
        chapter: truncateStr(ch.title, 40),
        subtopic: truncateStr(sub, 40),
        lastScore: pct,
        lastQuizAt,
      });
    }
  }

  weakSubtopics.sort((a, b) => a.lastScore - b.lastScore);

  // 6. Due reviews
  const dueReviews = (dueReviewRows || []).slice(0, 6).map((r) => ({
    id: r.id,
    subject: truncateStr(r.subject, 24),
    chapter: truncateStr(r.chapter_title, 36),
    subtopic: truncateStr(r.subtopic, 36),
    intervalDays: r.interval_days,
    dueAt: typeof r.due_at === "string" ? r.due_at.slice(0, 10) : null,
  }));

  // 7. Days since last student activity (quizzes, task completions, focus logs)
  const activityTimestamps = [];
  if (latestQuizMs > 0) activityTimestamps.push(latestQuizMs);

  for (const d of days) {
    for (const b of d.studyBlocks || []) {
      for (const ts of [b.completedAt, b.partialLoggedAt, b.lastFocusedAt]) {
        if (ts) {
          const ms = new Date(ts).getTime();
          if (!Number.isNaN(ms)) activityTimestamps.push(ms);
        }
      }
      if ((b.completed || b.status === "done" || b.status === "partial") && d.date) {
        const ms = new Date(`${d.date}T12:00:00`).getTime();
        if (!Number.isNaN(ms)) activityTimestamps.push(ms);
      }
    }
  }

  const store = readLocalStore();
  for (const fl of store.focusLogs || []) {
    if (Number(fl?.telegramUserId) === uid && fl?.loggedAt) {
      const ms = new Date(fl.loggedAt).getTime();
      if (!Number.isNaN(ms)) activityTimestamps.push(ms);
    }
  }

  const maxActivityMs = activityTimestamps.length ? Math.max(...activityTimestamps) : null;
  const daysSinceLastActivity =
    maxActivityMs !== null
      ? Math.max(0, Math.floor((nowDate.getTime() - maxActivityMs) / 86_400_000))
      : null;

  // 8. Last 5 agent actions
  const lastAgentActions = (recentActions || []).slice(0, 5).map((a) => ({
    id: a.id,
    tickType: a.tick_type,
    toolName: a.tool_name,
    status: a.status,
    messageSent: truncateStr(a.message_sent, 60),
    createdAt: a.created_at,
  }));

  const snapshot = {
    today,
    nowIst,
    isQuietHours,
    todayTasks: todayTasks.slice(0, 6),
    overdueTasks: overdueTasks.slice(0, 5),
    progress,
    exams: exams.slice(0, 5),
    nearestExamDays,
    examMode,
    weakSubtopics: weakSubtopics.slice(0, 6),
    dueReviews,
    recentQuiz: latestQuizEntry,
    daysSinceLastActivity,
    lastAgentActions,
    messagesSentToday,
    memory,
  };

  return enforceSnapshotSizeLimit(snapshot, MAX_SNAPSHOT_BYTES);
}