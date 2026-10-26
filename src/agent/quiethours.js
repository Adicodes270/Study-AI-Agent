// src/agent/quietHours.js
import "../tz.js";

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
  const mins = dateToIstMinutes(date instanceof Date ? date : new Date(date));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Determine whether `nowIst` falls within the quiet-hours window `[start, end)`.
 * Correctly handles windows that cross midnight (e.g. "22:00" to "07:00") as well as same-day windows.
 * Start boundary is inclusive; end boundary is exclusive (e.g. 07:00 is wake-up time, not quiet hours).
 */
export function isQuietHours(nowIst = new Date(), start = "22:00", end = "07:00") {
  const nowMins = parseTimeToMinutes(nowIst);
  const startMins = parseTimeToMinutes(start, 22 * 60);
  const endMins = parseTimeToMinutes(end, 7 * 60);

  if (startMins === endMins) {
    return false;
  }

  // Same-day window (e.g. 13:00 to 15:00)
  if (startMins < endMins) {
    return nowMins >= startMins && nowMins < endMins;
  }

  // Overnight window crossing midnight (e.g. 22:00 to 07:00)
  return nowMins >= startMins || nowMins < endMins;
}