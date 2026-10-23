// src/generationQueue.js
// Syllabus ingestion -> sequential, chapter-by-chapter background generation.
//
//  0. NEW: after an upload, api.js `syllabusUpload` (and the Telegram bot) call `scheduleAutoStart()`, which only
//     opens a 5-minute window. In that window the user picks chapters + resource types on resources.html
//     (POST /api/resources/start -> enqueueExisting). If the window runs out, runDuePlans() generates everything.
//  1. (older, still exported) `enqueueSyllabus(userId, syllabus)` queues a parsed syllabus immediately.
//  2. The syllabus is flattened into an ordered chapter list (subject order, then chapter number).
//  3. Every chapter is stored as 'Generating' in `chapter_generation`.
//  4. ONE worker per user walks the list strictly one chapter at a time, using that user's saved
//     Google/NotebookLM session (exportStorageStateFile, the session written by notebooklmLogin.js).
//     A chapter only finishes when the NotebookLM integration reports back, so two chapters can
//     never hit the same Google session at once.
//  5. The integration reports back with `completeChapter()` / `failChapter()` (or the events
//     `generationEvents.emit("chapter:completed" | "chapter:failed", ...)`).
//
// Integration contract (see registerChapterGenerator):
//   registerChapterGenerator(async ({ jobId, userId, chapter, sessionFile }) => { ... })
//   - Either call completeChapter({ jobId }) / failChapter({ jobId, error }) from inside, or just
//     return / throw: a resolved promise counts as completed, a rejected one as failed.
//
// In-memory queue state lives in this process. On boot `resumePendingGenerations()` re-queues any rows
// still 'Generating' (they were interrupted by a restart). This needs a long-running Node server
// (src/main.js); it is not suitable for short-lived serverless functions.
import { EventEmitter } from "node:events";
import { initDb, withDb } from "./db.js";
import { exportStorageStateFile } from "./intake/userKeys.js";

export const GENERATION_STATUS = Object.freeze({
  GENERATING: "Generating",
  READY: "Ready",
  FAILED: "Failed",
});

const DELAY_BETWEEN_CHAPTERS_MS = intEnv("GENERATION_DELAY_MS", 5_000);
const CHAPTER_TIMEOUT_MS = intEnv("GENERATION_CHAPTER_TIMEOUT_MS", 15 * 60_000);
const MAX_RATE_LIMIT_COOLDOWN_MS = intEnv("GENERATION_MAX_COOLDOWN_MS", 60 * 60_000);
// After a syllabus upload the user has this long to choose chapters / resource types on the Resources page;
// when it ends, everything that was uploaded is generated automatically.
const AUTO_START_DELAY_MS = intEnv("GENERATION_AUTO_START_MS", 5 * 60_000);
const AUTO_START_POLL_MS = intEnv("GENERATION_AUTO_START_POLL_MS", 15_000);

function intEnv(name, dflt) {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Events: "chapter:started" | "chapter:completed" | "chapter:failed" | "queue:idle" (userId). */
export const generationEvents = new EventEmitter();

// ---------------------------------------------------------------------------
// 1. Parse syllabus -> ordered chapter list
// ---------------------------------------------------------------------------

/** Flatten a parsed syllabus ({ exam, subjects:[{ name, chapters:[...] }] }) into an ordered, de-duplicated list. */
export function orderedChaptersFromSyllabus(syllabus) {
  const exam = syllabus?.exam || "";
  const out = [];
  const seen = new Set();
  for (const subject of syllabus?.subjects || []) {
    const chapters = [...(subject.chapters || [])]
      .map((c, i) => ({ c, i }))
      .sort((a, b) => (a.c.number ?? Infinity) - (b.c.number ?? Infinity) || a.i - b.i)
      .map(({ c }) => c);
    for (const c of chapters) {
      const title = String(c?.title || "").trim();
      if (!title) continue;
      const key = `${subject.name}\u0000${title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ subject: subject.name, exam, number: c.number ?? null, title });
    }
  }
  return out.map((c, position) => ({ ...c, position }));
}

// ---------------------------------------------------------------------------
// 2. Storage layer
// ---------------------------------------------------------------------------

const ROW_COLS = `id, telegram_user_id, chapter_id, subject, exam, chapter_title, chapter_number,
                  position, status, error, notebook_url, step, attempts, resource_types, created_at, updated_at`;

/** chapter_generation.resource_types is a JSON array string (or NULL = every allowed type). */
function parseTypes(s) {
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) && a.length ? a.map(String) : null;
  } catch {
    return null;
  }
}

/**
 * Save every chapter as 'Generating'. Chapters already 'Ready' are left alone (generated content is
 * never regenerated); 'Failed' or stale 'Generating' rows are reset so they are retried.
 * Returns the rows that need work, in syllabus order.
 */
async function saveInitialStatuses(userId, chapters) {
  return withDb(async (db) => {
    const todo = [];
    for (const ch of chapters) {
      const { rows: found } = await db.query(
        `SELECT id FROM syllabus_chapters
          WHERE chat_id = $1 AND subject = $2 AND exam = $3 AND lower(title) = lower($4)
          ORDER BY id DESC LIMIT 1`,
        [userId, ch.subject, ch.exam, ch.title]
      );
      const types = Array.isArray(ch.resourceTypes) && ch.resourceTypes.length ? JSON.stringify(ch.resourceTypes) : null;
      const { rows } = await db.query(
        `INSERT INTO chapter_generation
           (telegram_user_id, chapter_id, subject, exam, chapter_title, chapter_number, position, status, resource_types)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'Generating', $8)
         ON CONFLICT (telegram_user_id, subject, exam, chapter_title) DO UPDATE
           SET chapter_id = EXCLUDED.chapter_id,
               chapter_number = EXCLUDED.chapter_number,
               position = EXCLUDED.position,
               resource_types = CASE WHEN chapter_generation.status = 'Ready'
                                     THEN chapter_generation.resource_types ELSE EXCLUDED.resource_types END,
               status = CASE WHEN chapter_generation.status = 'Ready'
                             THEN chapter_generation.status ELSE 'Generating' END,
               step = CASE WHEN chapter_generation.status = 'Ready' THEN chapter_generation.step ELSE 'Waiting in queue' END,
               error = CASE WHEN chapter_generation.status = 'Ready'
                            THEN chapter_generation.error ELSE NULL END,
               updated_at = now()
         RETURNING ${ROW_COLS}`,
        [userId, found[0]?.id ?? null, ch.subject, ch.exam, ch.title, ch.number, ch.position, types]
      );
      if (rows[0].status === GENERATION_STATUS.GENERATING) todo.push(rows[0]);
    }
    return todo;
  });
}

async function getJobRow(id) {
  const { rows } = await withDb((db) => db.query(`SELECT ${ROW_COLS} FROM chapter_generation WHERE id = $1`, [id]));
  return rows[0] || null;
}

async function writeResult(id, status, { error = null, result = null } = {}) {
  const { rows } = await withDb((db) =>
    db.query(
      `UPDATE chapter_generation
          SET status = $2, error = $3, result_json = $4, notebook_url = COALESCE($5, notebook_url), step = NULL, updated_at = now()
        WHERE id = $1 AND status = 'Generating'
        RETURNING ${ROW_COLS}`,
      [id, status, error, result == null ? null : JSON.stringify(result), status === GENERATION_STATUS.READY ? result?.notebookUrl || null : null]
    )
  );
  return rows[0] || null; // null => already finished (duplicate report), ignore
}

/** Record what a running chapter is doing right now (shown on the Resources page, logged on the server). Never throws. */
export async function setChapterStep(jobId, step) {
  if (jobId == null) return;
  console.log("[generation] job " + jobId + ": " + step);
  await withDb((db) => db.query("UPDATE chapter_generation SET step = $2, updated_at = now() WHERE id = $1 AND status = 'Generating'", [jobId, step])).catch(() => {});
}

/** Statuses for the UI: [{ chapter_id, subject, title, status, error, ... }] in syllabus order. */
export async function getGenerationStatus(userId) {
  await initDb();
  const { rows } = await withDb((db) =>
    db.query(
      `SELECT ${ROW_COLS} FROM chapter_generation WHERE telegram_user_id = $1 ORDER BY position, id`,
      [userId]
    )
  );
  return rows;
}

// ---------------------------------------------------------------------------
// 3. Sequential queue
// ---------------------------------------------------------------------------

let generator = null; // registered by the NotebookLM integration
const queues = new Map(); // userId -> { jobs: row[], running: boolean }
const waiting = new Map(); // jobId -> { resolve }
const cooldownUntil = new Map(); // userId -> epoch ms (after a rate limit)

/** The NotebookLM integration registers the function that does the work for one chapter. */
export function registerChapterGenerator(fn) {
  generator = typeof fn === "function" ? fn : null;
  if (generator) for (const userId of queues.keys()) void drain(userId); // start anything that was waiting
}

/** Add rows to a user's queue (never twice) and make sure a worker is running. */
function schedule(userId, rows) {
  let q = queues.get(userId);
  if (!q) queues.set(userId, (q = { jobs: [], running: false }));
  for (const r of rows) if (!q.jobs.some((j) => j.id === r.id)) q.jobs.push(r);
  q.jobs.sort((a, b) => a.position - b.position || a.id - b.id);
  void drain(userId);
}

/**
 * Entry point called after a syllabus is parsed and saved. Stores 'Generating' for each chapter and starts
 * the background queue; returns as soon as the statuses are saved (it does not wait for generation).
 */
export async function enqueueSyllabus(userId, syllabus) {
  const chapters = orderedChaptersFromSyllabus(syllabus);
  if (!chapters.length) return { queued: 0, chapters: [] };
  const rows = await saveInitialStatuses(userId, chapters);
  schedule(userId, rows);
  return {
    queued: rows.length,
    skipped_completed: chapters.length - rows.length,
    chapters: rows.map((r) => ({ id: r.id, chapter_id: r.chapter_id, subject: r.subject, title: r.chapter_title, status: r.status })),
  };
}

/**
 * Queue chapters that are already saved in the syllabus but not generated yet (never queued, or Failed).
 * `chapterIds` (syllabus_chapters ids) limits it to those chapters; omit for all of the user's chapters.
 * `typesById` ({ [syllabusChapterId]: ["study_guide", ...] }) is the user's per-chapter choice of what to
 * generate; a chapter without an entry gets every allowed resource type.
 */
export async function enqueueExisting(userId, chapterIds = null, typesById = null) {
  await initDb();
  const { rows } = await withDb((db) =>
    db.query(
      `SELECT sc.id, sc.subject, sc.exam, sc.number, sc.title
         FROM syllabus_chapters sc
         LEFT JOIN chapter_generation g
           ON g.telegram_user_id = sc.chat_id AND g.subject = sc.subject AND g.exam = sc.exam
          AND lower(g.chapter_title) = lower(sc.title)
        WHERE sc.chat_id = $1 AND COALESCE(g.status, '') <> 'Ready'
          AND ($2::int[] IS NULL OR sc.id = ANY($2::int[]))
        ORDER BY sc.id`,
      [userId, Array.isArray(chapterIds) && chapterIds.length ? chapterIds : null]
    )
  );
  if (!rows.length) return { queued: 0, chapters: [] };
  const chapters = rows.map((r, position) => ({
    subject: r.subject, exam: r.exam, number: r.number, title: r.title, position,
    resourceTypes: typesById?.[r.id] ?? null,
  }));
  const todo = await saveInitialStatuses(userId, chapters);
  schedule(userId, todo);
  return { queued: todo.length, chapters: todo.map((r) => ({ id: r.id, chapter_id: r.chapter_id, subject: r.subject, title: r.chapter_title, status: r.status })) };
}

/** On server boot: pick up rows left as 'Generating' by a previous process. */
export async function resumePendingGenerations() {
  await initDb();
  const { rows } = await withDb((db) =>
    db.query(`SELECT ${ROW_COLS} FROM chapter_generation WHERE status = 'Generating' ORDER BY telegram_user_id, position, id`)
  );
  const byUser = new Map();
  for (const r of rows) (byUser.get(r.telegram_user_id) || byUser.set(r.telegram_user_id, []).get(r.telegram_user_id)).push(r);
  for (const [userId, list] of byUser) schedule(userId, list);
  return rows.length;
}

// ---------------------------------------------------------------------------
// 2b. Auto-start window: upload -> N minutes to choose -> generate everything that is left
// ---------------------------------------------------------------------------

const chapterKey = (c) => `${c.subject}\u0000${String(c.title || "").toLowerCase()}`;

/**
 * Called after a syllabus upload instead of enqueueSyllabus(): does NOT start generating. It opens (or restarts)
 * the user's choose-what-to-generate window. Chapters from several uploads inside one window are merged.
 * Returns { scheduled, startAt }.
 */
export async function scheduleAutoStart(userId, syllabus) {
  const fresh = orderedChaptersFromSyllabus(syllabus);
  if (!fresh.length) return { scheduled: 0, startAt: null };
  return withDb(async (db) => {
    const { rows } = await db.query("SELECT chapters_json FROM generation_plan WHERE telegram_user_id = $1", [userId]);
    let merged = [];
    try { merged = rows[0] ? JSON.parse(rows[0].chapters_json) : []; } catch { merged = []; }
    const seen = new Set(merged.map(chapterKey));
    for (const c of fresh) if (!seen.has(chapterKey(c))) { merged.push(c); seen.add(chapterKey(c)); }
    merged = merged.map((c, position) => ({ ...c, position }));
    const { rows: out } = await db.query(
      `INSERT INTO generation_plan (telegram_user_id, start_at, chapters_json)
       VALUES ($1, now() + $2::int * interval '1 millisecond', $3)
       ON CONFLICT (telegram_user_id) DO UPDATE
         SET start_at = EXCLUDED.start_at, chapters_json = EXCLUDED.chapters_json
       RETURNING start_at`,
      [userId, AUTO_START_DELAY_MS, JSON.stringify(merged)]
    );
    return { scheduled: merged.length, startAt: out[0].start_at };
  });
}

/** The user's open window as { startAt, now } (both server time, so the page can count down without clock skew), or null. */
export async function getAutoStart(userId) {
  const { rows } = await withDb((db) =>
    db.query("SELECT start_at, now() AS now FROM generation_plan WHERE telegram_user_id = $1", [userId])
  );
  return rows[0] ? { startAt: rows[0].start_at, now: rows[0].now } : null;
}

/** Close the window without generating (the user chose chapters themselves, or cancelled). True if one was open. */
export async function cancelAutoStart(userId) {
  const { rows } = await withDb((db) =>
    db.query("DELETE FROM generation_plan WHERE telegram_user_id = $1 RETURNING telegram_user_id", [userId])
  );
  return rows.length > 0;
}

let checkingPlans = false;
/** Start every window that has run out. DELETE ... RETURNING claims a plan atomically, so it can never start twice. */
export async function runDuePlans() {
  if (checkingPlans) return 0;
  checkingPlans = true;
  let started = 0;
  try {
    await initDb();
    const { rows } = await withDb((db) =>
      db.query("DELETE FROM generation_plan WHERE start_at <= now() RETURNING telegram_user_id, chapters_json")
    );
    for (const r of rows) {
      const userId = Number(r.telegram_user_id);
      try {
        const chapters = JSON.parse(r.chapters_json);
        const todo = await saveInitialStatuses(userId, chapters);
        schedule(userId, todo);
        started += todo.length;
        console.log(`[generation] auto-start for user ${userId}: ${todo.length} chapter(s) queued`);
      } catch (e) {
        console.log(`[generation] auto-start for user ${userId} failed (${e.message}); retrying in a minute`);
        await withDb((db) =>
          db.query(
            `INSERT INTO generation_plan (telegram_user_id, start_at, chapters_json)
             VALUES ($1, now() + interval '1 minute', $2) ON CONFLICT (telegram_user_id) DO NOTHING`,
            [userId, r.chapters_json]
          )
        ).catch(() => {});
      }
    }
  } catch (e) {
    console.log(`generationQueue: auto-start check failed: ${e.message}`);
  } finally {
    checkingPlans = false;
  }
  return started;
}

let autoTimer = null;
/** Call once at server start. Also picks up windows that ended while the server was down. */
export function startAutoStartScheduler() {
  if (autoTimer) return;
  autoTimer = setInterval(() => void runDuePlans(), AUTO_START_POLL_MS);
  autoTimer.unref?.();
  void runDuePlans();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function drain(userId) {
  const q = queues.get(userId);
  if (!q || q.running || !generator) return;
  q.running = true;
  try {
    while (q.jobs.length && generator) {
      const wait = (cooldownUntil.get(userId) || 0) - Date.now();
      if (wait > 0) {
        // After a Google rate limit the whole queue pauses. Say so on the Resources page instead of
        // leaving every waiting chapter on a silent "Waiting in queue".
        const msg = `Paused after a Google rate limit, resuming in about ${Math.ceil(wait / 60_000)} min`;
        console.log(`[generation] user ${userId}: ${msg}`);
        await Promise.all(q.jobs.map((j) => setChapterStep(j.id, msg)));
        await sleep(wait);
      }

      const row = q.jobs[0];
      const outcome = await runOne(userId, row);
      // Remove THIS job by id. schedule() re-sorts q.jobs while a chapter is running, so the head may
      // now be a different, not-yet-run chapter; a bare shift() used to drop that one without running it.
      const done = q.jobs.findIndex((j) => j.id === row.id);
      if (done >= 0) q.jobs.splice(done, 1);
      if (outcome.rateLimited) {
        cooldownUntil.set(userId, Date.now() + Math.min(outcome.retryAfterMs || 15 * 60_000, MAX_RATE_LIMIT_COOLDOWN_MS));
      }
      if (q.jobs.length) await sleep(DELAY_BETWEEN_CHAPTERS_MS);
    }
  } finally {
    q.running = false;
    if (!q.jobs.length) {
      queues.delete(userId);
      generationEvents.emit("queue:idle", userId);
    }
  }
}

/** Run one chapter and resolve only after it has been completed or failed. Never throws. */
async function runOne(userId, row) {
  const fresh = await getJobRow(row.id).catch(() => row);
  if (!fresh || fresh.status !== GENERATION_STATUS.GENERATING) return {}; // finished/removed meanwhile

  await withDb((db) => db.query("UPDATE chapter_generation SET attempts = attempts + 1, updated_at = now() WHERE id = $1", [row.id])).catch(() => {});

  const settled = new Promise((resolve) => waiting.set(row.id, { resolve }));
  const finish = (outcome) => waiting.get(row.id)?.resolve(outcome);
  const timer = setTimeout(
    () => finish({ status: GENERATION_STATUS.FAILED, error: "Timed out waiting for NotebookLM", timedOut: true }),
    CHAPTER_TIMEOUT_MS
  );

  try {
    const sessionFile = await exportStorageStateFile(userId); // the user's Google session (notebooklmLogin.js)
    if (!sessionFile) {
      finish({ status: GENERATION_STATUS.FAILED, error: "No NotebookLM/Google session saved. Sign in on the setup page.", noSession: true });
    } else {
      const chapter = {
        id: fresh.chapter_id,
        subject: fresh.subject,
        exam: fresh.exam,
        number: fresh.chapter_number,
        title: fresh.chapter_title,
        resourceTypes: parseTypes(fresh.resource_types), // what the user ticked (null = everything allowed)
      };
      generationEvents.emit("chapter:started", { jobId: row.id, userId, chapter });
      Promise.resolve()
        .then(() => generator({ jobId: row.id, userId, chapter, sessionFile }))
        .then((res) => finish({ status: GENERATION_STATUS.READY, result: res ?? null }))
        .catch((e) => finish({ status: GENERATION_STATUS.FAILED, error: e?.message || String(e), rateLimited: Boolean(e?.retryAfter || e?.status === 429), retryAfterMs: parseRetryAfterMs(e?.retryAfter) }));
    }
    const outcome = await settled;
    return await commit(row, outcome);
  } catch (e) {
    return await commit(row, { status: GENERATION_STATUS.FAILED, error: e.message });
  } finally {
    clearTimeout(timer);
    waiting.delete(row.id);
  }
}

async function commit(row, outcome) {
  // If the integration already reported through completeChapter()/failChapter() the row is final and this is a no-op.
  const saved = await writeResult(row.id, outcome.status, { error: outcome.error || null, result: outcome.result }).catch((e) => {
    console.log(`generationQueue: could not save status for job ${row.id}: ${e.message}`);
    return null;
  });
  if (saved) emitFor(saved, outcome);
  return outcome;
}

function emitFor(saved, outcome) {
  console.log("[generation] job " + saved.id + " '" + saved.chapter_title + "': " + saved.status + (saved.error ? " (" + saved.error + ")" : ""));
  const payload = { jobId: saved.id, userId: saved.telegram_user_id, chapterId: saved.chapter_id, subject: saved.subject, title: saved.chapter_title, error: saved.error };
  generationEvents.emit(saved.status === GENERATION_STATUS.READY ? "chapter:completed" : "chapter:failed", payload);
}

// ---------------------------------------------------------------------------
// 4. Callbacks for the NotebookLM integration module
// ---------------------------------------------------------------------------

async function report(ref, status, { error, result, retryAfter } = {}) {
  let jobId = ref?.jobId ?? null;
  if (jobId == null && ref?.userId != null && ref?.chapterId != null) {
    const { rows } = await withDb((db) =>
      db.query(
        "SELECT id FROM chapter_generation WHERE telegram_user_id = $1 AND chapter_id = $2 AND status = 'Generating' ORDER BY updated_at DESC LIMIT 1",
        [ref.userId, ref.chapterId]
      )
    );
    jobId = rows[0]?.id ?? null;
  }
  if (jobId == null) return { ok: false, reason: "unknown_job" };

  const saved = await writeResult(jobId, status, { error: error || null, result });
  if (!saved) return { ok: false, reason: "already_finished" };
  emitFor(saved, { status });

  const retryAfterMs = parseRetryAfterMs(retryAfter);
  waiting.get(jobId)?.resolve({
    status,
    error,
    result,
    rateLimited: status === GENERATION_STATUS.FAILED && Boolean(retryAfter),
    retryAfterMs,
  });
  return { ok: true, status };
}

/** Called by the NotebookLM integration when a chapter finished. ref = { jobId } or { userId, chapterId }. */
export const completeChapter = (ref, result) => report(ref, GENERATION_STATUS.READY, { result });

/** Called on failure. `retryAfter` ("15 minutes", "90s", ms) marks it as a rate limit and pauses this user's queue. */
export const failChapter = (ref, error, { retryAfter } = {}) =>
  report(ref, GENERATION_STATUS.FAILED, { error: String(error?.message || error || "Generation failed"), retryAfter });

// Event-style triggers: generationEvents.emit("report:completed", { jobId, result }) / ("report:failed", { jobId, error, retryAfter })
generationEvents.on("report:completed", ({ result, ...ref } = {}) => void completeChapter(ref, result).catch(() => {}));
generationEvents.on("report:failed", ({ error, retryAfter, ...ref } = {}) => void failChapter(ref, error, { retryAfter }).catch(() => {}));

export function parseRetryAfterMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const m = /([0-9]+(?:\.[0-9]+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)?/i.exec(String(v));
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = (m[2] || "s")[0].toLowerCase();
  return Math.round(n * (u === "h" ? 3_600_000 : u === "m" ? 60_000 : 1_000));
}
