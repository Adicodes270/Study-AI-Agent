// src/agent/quietHours.js
import "./tz.js";
import { QUIET_HOURS_END, QUIET_HOURS_START } from "../config.js";
import { getAgentMemory, getStudyPlanForUser, patchAgentMemory } from "../db.js";

export { QUIET_HOURS_END, QUIET_HOURS_START };

/**
 * Returns the fallback quiet-hours start and end from environment/config (`QUIET_HOURS_START` / `QUIET_HOURS_END`).
 */
export function getDefaultQuietHours() {
  const rawStart = String(process.env.QUIET_HOURS_START ?? QUIET_HOURS_START ?? "22:00").trim();
  const rawEnd = String(process.env.QUIET_HOURS_END ?? QUIET_HOURS_END ?? "07:00").trim();
  const start = normalizeHhMm(rawStart) || "22:00";
  const end = normalizeHhMm(rawEnd) || "07:00";
  return {
    start,
    end,
    window: `${start}-${end}`,
  };
}

/**
 * Strictly validates and normalizes a single "HH:MM" 24-hour time string (00:00..23:59).
 * Returns normalized "HH:MM" or null if invalid.
 */
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

/**
 * Validate a quiet-hours window string in `HH:MM-HH:MM` format (e.g. "23:00-06:00").
 * Returns `{ ok: true, start, end, window }` or `{ ok: false, error }`.
 */
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

/**
 * Resolve a user's quiet-hours window from an `agent_memory` object (falling back to optional planner config,
 * then `QUIET_HOURS_START` and `QUIET_HOURS_END`).
 */
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

/**
 * Read a user's quiet-hours window from `agent_memory`, falling back to `QUIET_HOURS_START` / `QUIET_HOURS_END`.
 */
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

/**
 * Validate and persist a user's quiet-hours window in `agent_memory`.
 */
export async function setUserQuietHours(telegramUserId, windowInput) {
  const uid = Number(telegramUserId);
  if (!Number.isFinite(uid) || uid <= 0) {
    return { ok: false, error: "Invalid user ID." };
  }
  const validated = validateQuietHoursWindow(windowInput);
  if (!validated.ok) {
    return validated;
  }
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

/**
 * Parse a time input into minutes since midnight (0..1439) in IST (Asia/Kolkata).
 * Accepts:
 *  - "HH:MM" or "H:MM" or "HH:MM:SS" strings (e.g. "23:00", "03:00", "07:00", "12:00")
 *  - ISO strings or Date objects (converted to Asia/Kolkata local time)
 *  - Numbers representing minutes since midnight (0..1439)
 */
export function parseTimeToMinutes(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return ((Math.floor(value) % 1440) + 1440) % 1440;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    const hhmmMatch = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(trimmed);
    if (hhmmMatch) {
      const h = parseInt(hhmmMatch[1], 10);
      const m = parseInt(hhmmMatch[2], 10);
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        return h * 60 + m;
      }
    }

    const parsedDate = new Date(trimmed);
    if (!Number.isNaN(parsedDate.getTime())) {
      return dateToIstMinutes(parsedDate);
    }
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return dateToIstMinutes(value);
  }

  if (value === undefined || value === null) {
    return fallback !== null ? fallback : dateToIstMinutes(new Date());
  }

  return fallback !== null ? fallback : 0;
}

function dateToIstMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10) % 24;
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
  return hour * 60 + minute;
}

/**
 * Format a Date (defaults to now) as "HH:MM" in IST (Asia/Kolkata).
 */
export function getNowIstHhMm(date = new Date()) {
  if (typeof date === "string" && /^\d{1,2}:\d{2}$/.test(date.trim())) {
    return normalizeHhMm(date.trim()) || "00:00";
  }
  const d = date instanceof Date ? date : new Date(date);
  const mins = dateToIstMinutes(Number.isNaN(d.getTime()) ? new Date() : d);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Determine whether `nowIst` falls within the quiet-hours window `[start, end)`.
 * Correctly handles:
 *  - explicit `(nowIst, start, end)` strings
 *  - a combined window string `(nowIst, "23:00-06:00")`
 *  - a per-user `agent_memory` object `(nowIst, memory)`
 *  - fallback to `QUIET_HOURS_START` / `QUIET_HOURS_END` when `start`/`end` are omitted.
 * Start boundary is inclusive; end boundary is exclusive (e.g. 06:00 is wake-up time, not quiet hours).
 */
export function isQuietHours(nowIst = new Date(), start = undefined, end = undefined) {
  const defaults = getDefaultQuietHours();
  let resolvedStart = start;
  let resolvedEnd = end;

  if (start && typeof start === "object" && !(start instanceof Date)) {
    const fromMem = resolveQuietHoursFromMemory(start, end && typeof end === "object" ? end : null);
    resolvedStart = fromMem.start;
    resolvedEnd = fromMem.end;
  } else if (typeof start === "string" && start.includes("-") && end === undefined) {
    const parsed = validateQuietHoursWindow(start);
    if (parsed.ok) {
      resolvedStart = parsed.start;
      resolvedEnd = parsed.end;
    }
  }

  const defaultStartMins = parseTimeToMinutes(defaults.start, 22 * 60);
  const defaultEndMins = parseTimeToMinutes(defaults.end, 7 * 60);

  const nowMins = parseTimeToMinutes(nowIst);
  const startMins =
    resolvedStart !== undefined && resolvedStart !== null && String(resolvedStart).trim() !== ""
      ? parseTimeToMinutes(resolvedStart, defaultStartMins)
      : defaultStartMins;
  const endMins =
    resolvedEnd !== undefined && resolvedEnd !== null && String(resolvedEnd).trim() !== ""
      ? parseTimeToMinutes(resolvedEnd, defaultEndMins)
      : defaultEndMins;

  if (startMins === endMins) {
    return false;
  }

  // Same-day window (e.g. 13:00 to 15:00)
  if (startMins < endMins) {
    return nowMins >= startMins && nowMins < endMins;
  }

  // Overnight window crossing midnight (e.g. 22:00 to 07:00 or 23:00 to 06:00)
  return nowMins >= startMins || nowMins < endMins;
}

/**
 * Async helper that checks whether `telegramUserId` is currently in their quiet-hours window
 * (reading from `agent_memory` and falling back to `QUIET_HOURS_START` / `QUIET_HOURS_END`).
 */
export async function isUserInQuietHours(telegramUserId, now = new Date()) {
  const { start, end } = await getUserQuietHours(telegramUserId);
  return isQuietHours(now, start, end);
}

/**
 * Compute the Date representing the exact first minute after the quiet-hours window ends
 * (i.e. `end` HH:MM in IST, which is the first minute outside `[start, end)`).
 */
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
    const nowRef = new Date();
    const currentMins = dateToIstMinutes(nowRef);
    const targetNowMins = parseTimeToMinutes(now.trim(), currentMins);
    baseDate = new Date(nowRef.getTime() + (targetNowMins - currentMins) * 60_000);
  } else {
    const parsed = new Date(now);
    baseDate = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  // Floor baseDate to the start of its minute
  baseDate.setUTCSeconds(0, 0);
  const nowMins = dateToIstMinutes(baseDate);
  let diffMins = endMins - nowMins;
  if (diffMins <= 0) {
    diffMins += 1440;
  }

  return new Date(baseDate.getTime() + diffMins * 60_000);
}