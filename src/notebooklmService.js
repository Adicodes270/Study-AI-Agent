// src/notebooklmService.js
// NotebookLM automation + NCERT fallback for one chapter, built to plug into src/generationQueue.js.
//
//   1. create a NotebookLM notebook for the chapter (user's saved Google session, via notebooklm-py)
//   2. try to add the chapter's source URL
//   3. if that throws / is rejected / ends in an error status: look the chapter up in the ncert_chapters table,
//      download the NCERT PDF to a temp file, upload it to the same notebook, delete the temp file
//   4. trigger the study resources (never infographics or reports)
//   5. return { notebookUrl, ... } -> the queue stores status 'Ready' + notebook_url, or 'Failed' if this throws
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NOTEBOOKLM_RESOURCE_TYPES, EXCLUDED_RESOURCE_TYPES } from "./api.js";
import { getChapterForUser, getNcertPdfUrls } from "./db.js";
import { registerChapterGenerator, setChapterStep } from "./generationQueue.js";

/** Python that has notebooklm-py: NOTEBOOKLM_PYTHON, else the project's own virtualenv, else system python. */
export function pickPython() {
  const env = process.env.NOTEBOOKLM_PYTHON;
  if (env && existsSync(env)) return env;
  const here = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  for (const c of [path.join(here, ".venv/bin/python"), "/app/.venv/bin/python", "/opt/venv/bin/python"]) if (existsSync(c)) return c;
  return process.platform === "win32" ? "python" : "python3";
}

const MAX_PDF_BYTES = 40 * 1024 * 1024;

// Test mode: add ONLY the chapter's saved link to NotebookLM. No download + file-upload fallback.
// On by default (no download): set NOTEBOOKLM_URL_ONLY=0 to bring the NCERT PDF fallback back.
const URL_ONLY = process.env.NOTEBOOKLM_URL_ONLY !== "0";

// Allowed resources = the app's list minus anything excluded (infographics, reports). Checked again in the Python script.
export const GENERATABLE_RESOURCE_TYPES = NOTEBOOKLM_RESOURCE_TYPES.map((t) => t.id).filter((id) => !EXCLUDED_RESOURCE_TYPES.has(id));

// ---------------------------------------------------------------------------
// Python bridge (notebooklm-py). One action per call; prints one JSON line.
// ---------------------------------------------------------------------------
const PY_SCRIPT = `
import asyncio, json, sys

EXCLUDED = {"infographic", "infographics", "report", "reports"}

def is_rate(exc):
    msg = str(exc).lower()
    if "sourceadd" in type(exc).__name__.lower(): return False  # "can't open this link" is not a rate limit
    return "ratelimit" in type(exc).__name__.lower() or "429" in msg or "quota" in msg or "rate limit" in msg

def bad_status(src):
    st = getattr(src, "status", None)
    if st is None:
        return False
    name = str(getattr(st, "name", "") or "").lower()
    try:
        val = int(getattr(st, "value", st))
    except Exception:
        val = None
    text = str(st).lower()
    return val == 3 or name == "error" or any(w in text for w in ("error", "fail", "unsupported", "rejected"))

async def trigger(client, nb_id, r_type, title, src_ids, ReportFormat):
    ids = src_ids or None
    a = client.artifacts
    if r_type == "audio_overview":
        st = await a.generate_audio(nb_id, source_ids=ids)
    elif r_type == "video_overview":
        st = await a.generate_video(nb_id, source_ids=ids)
    elif r_type == "quiz":
        st = await a.generate_quiz(nb_id, source_ids=ids)
    elif r_type == "data_table":
        st = await a.generate_data_table(nb_id, source_ids=ids)
    elif r_type == "flashcards":
        st = await a.generate_flashcards(nb_id, source_ids=ids)
    elif r_type == "mind_map":
        st = await a.generate_mind_map(nb_id, source_ids=ids)
        note_id = getattr(st, "note_id", None)
        if not note_id:
            raise RuntimeError("NotebookLM did not save the mind map")
        return note_id
    elif r_type == "slide_deck":
        st = await a.generate_slide_deck(nb_id, source_ids=ids)
    else:
        raise ValueError("unsupported resource type " + r_type)
    # Older versions return status="failed" instead of raising when NotebookLM refuses the request
    if getattr(st, "is_failed", False) or str(getattr(st, "status", "")).lower().endswith("failed"):
        err = RuntimeError(getattr(st, "error", None) or "NotebookLM refused to start this resource")
        if getattr(st, "error_code", None) == "USER_DISPLAYABLE_ERROR":
            err.retry_after = "15 minutes"
            err.args = ("rate limit: " + str(err),)
        raise err
    task_id = getattr(st, "task_id", None) or getattr(st, "id", None)
    if not task_id:
        raise RuntimeError("NotebookLM returned no task id, so the resource was not started")
    return task_id

def kind_of(art):
    """Map a notebook artifact to one of our resource ids (None if unknown)."""
    k = str(getattr(art, "kind", "") or "").lower().split(".")[-1]
    for needle, rid in (("audio", "audio_overview"), ("video", "video_overview"), ("flash", "flashcards"), ("quiz", "quiz"),
                        ("slide", "slide_deck"), ("data", "data_table"), ("mind", "mind_map")):
        if needle in k:
            return rid
    return None

async def existing_kinds(client, nb_id):
    """Resource types this notebook already has (finished or still being made), so a retry never makes a second copy."""
    have = set()
    try:
        for art in await client.artifacts.list(nb_id):
            if getattr(art, "is_failed", False):
                continue
            rid = kind_of(art)
            if rid:
                have.add(rid)
    except Exception:
        pass
    try:
        if hasattr(client.notes, "list_mind_maps") and await client.notes.list_mind_maps(nb_id):
            have.add("mind_map")
    except Exception:
        pass
    return have

async def verify(client, nb_id, task_id):
    """Ask NotebookLM whether the task really exists: pending / in_progress / completed => True."""
    for attempt in range(3):
        try:
            st = await client.artifacts.poll_status(nb_id, task_id)
        except Exception as exc:
            return False, f"{type(exc).__name__}: {exc}"
        state = str(getattr(st, "status", "")).lower().split(".")[-1]
        if state in ("pending", "in_progress", "completed"):
            return True, state
        if state == "failed":
            return False, getattr(st, "error", None) or "failed"
        await asyncio.sleep(2.5)  # not_found / unknown: listing may lag a moment
    return False, "not visible in the notebook"

def open_client(cls, path):
    """The library's default HTTP timeout is 30s, too short for ADD_SOURCE on a big PDF link: allow 5 minutes."""
    try:
        return cls.from_storage(path, timeout=300.0)
    except TypeError:
        return cls.from_storage(path)

async def run():
    p = json.loads(sys.argv[1])
    action = p["action"]
    try:
        from notebooklm import NotebookLMClient, ReportFormat
    except ImportError as e:
        print(json.dumps({"ok": False, "reason": "not_installed", "error": str(e)})); return
    try:
        async with open_client(NotebookLMClient, p["storage_path"]) as client:
            if action == "create_and_add_url":
                title = p["title"]
                nb = next((n for n in await client.notebooks.list() if getattr(n, "title", "") == title), None)
                if nb is not None:
                    existing = [s for s in await client.sources.list(nb.id) if getattr(s, "id", None) and not bad_status(s)]
                    right = [s for s in existing if (getattr(s, "url", None) or "").rstrip("/") == p["url"].rstrip("/")]
                    if right:  # a previous attempt already loaded this exact link: reuse it
                        print(json.dumps({"ok": True, "notebook_id": nb.id, "source_ok": True, "source_id": right[0].id, "reused": True})); return
                    for s in existing:  # a source from a wrong/old link would make the notebook open the wrong chapter
                        try: await client.sources.delete(nb.id, s.id)
                        except Exception: pass
                if nb is None:
                    nb = await client.notebooks.create(title)
                out = {"ok": True, "notebook_id": nb.id, "source_ok": False}
                # Just hand NotebookLM the link: no waiting, no checking that it loads.
                try:
                    src = await client.sources.add_url(nb.id, p["url"], wait=False)
                    out["source_id"] = getattr(src, "id", None)
                except Exception as exc:
                    if is_rate(exc): raise
                    out["note"] = f"{type(exc).__name__}: {exc}"  # ignored on purpose
                out["source_ok"] = True
                print(json.dumps(out))
            elif action == "add_file":
                src = await client.sources.add_file(p["notebook_id"], p["file_path"], wait=True, wait_timeout=150.0)
                if not getattr(src, "id", None) or bad_status(src):
                    raise RuntimeError("NotebookLM rejected the uploaded file: " + str(getattr(src, "status", "unknown")))
                print(json.dumps({"ok": True, "source_id": src.id}))
            elif action == "generate":
                nb_id = p["notebook_id"]
                def busy(x):
                    return str(getattr(getattr(x, "status", None), "name", "")).upper() in ("PROCESSING", "PREPARING", "PENDING")
                srcs = []
                for _ in range(24):  # the link may still be loading: wait up to ~2 minutes
                    srcs = [x for x in await client.sources.list(nb_id) if getattr(x, "id", None)]
                    if not any(busy(x) for x in srcs): break
                    await asyncio.sleep(5)
                src_ids = [x.id for x in srcs if not bad_status(x)]
                if not src_ids:
                    st = ", ".join(str(getattr(getattr(x, "status", None), "name", getattr(x, "status", "unknown"))) for x in srcs) or "no source"
                    raise RuntimeError("NotebookLM could not read the source link (" + st + "). It cannot open this link, so there is nothing to generate from.")
                results = {}
                have = await existing_kinds(client, nb_id)
                for r_type in p["resource_types"]:
                    if r_type.lower() in EXCLUDED:
                        continue
                    if r_type in have:  # already generated / generating in this notebook: do not make another one
                        results[r_type] = {"ok": True, "state": "already_exists"}
                        continue
                    try:
                        tid = await trigger(client, nb_id, r_type, p["title"], src_ids, ReportFormat)
                        if r_type == "mind_map":
                            results[r_type] = {"ok": True, "task_id": tid, "state": "completed"}
                        else:
                            good, state = await verify(client, nb_id, tid)
                            results[r_type] = {"ok": good, "task_id": tid, "state": state} if good else {"ok": False, "task_id": tid, "error": state}
                    except Exception as exc:
                        if is_rate(exc): results[r_type] = {"ok": False, "rate_limit": True, "error": str(exc), "retry_after": getattr(exc, "retry_after", None) or "15 minutes"}; break
                        results[r_type] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
                print(json.dumps({"ok": True, "resources": results}))
            else:
                raise ValueError("unknown action " + action)
    except Exception as exc:
        print(json.dumps({"ok": False, "reason": "rate_limit" if is_rate(exc) else "rpc_error", "error": f"{type(exc).__name__}: {exc}",
                          "retry_after": getattr(exc, "retry_after", None) or "15 minutes"}))

asyncio.run(run())
`;

function runPython(payload, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const bin = pickPython();
    const proc = spawn(bin, ["-c", PY_SCRIPT, JSON.stringify(payload)], { stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
    let out = "", err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", (e) => resolve({ ok: false, reason: "spawn_error", error: e.message }));
    proc.on("close", (code, signal) => {
      const last = out.trim().split("\n").filter(Boolean).pop() || "";
      try { resolve(JSON.parse(last)); }
      catch { resolve({ ok: false, reason: signal ? "timeout" : "parse_error", error: err.trim().slice(-500) || out.trim().slice(-500) || `notebooklm-py exited with ${code}` }); }
    });
  });
}

function pyError(res, what) {
  if (res.reason === "not_installed") return new Error("notebooklm-py is not installed on the server (pip install notebooklm-py)");
  if (res.reason === "spawn_error") return new Error(`Python could not be started on the server (${res.error}). Install Python 3 or set NOTEBOOKLM_PYTHON`);
  const e = new Error(`${what}: ${res.error || res.reason || "unknown error"}`);
  if (res.reason === "rate_limit") { e.status = 429; e.retryAfter = res.retry_after || "15 minutes"; }
  return e;
}

// ---------------------------------------------------------------------------
// NCERT fallback: resolve -> download -> temp file
// ---------------------------------------------------------------------------

/** Candidate NCERT PDF URLs for a chapter, best first (its own NCERT link, then links stored in ncert_chapters). */
export async function resolveNcertPdfUrls(chapter, { lookup = getNcertPdfUrls } = {}) {
  const urls = [];
  const own = String(chapter.pdf_url || "");
  if (/^https?:\/\/(www\.)?ncert\.nic\.in\//i.test(own)) urls.push(own);
  try {
    const stored = await lookup({ ncertId: chapter.ncert_id ?? null, classLevel: chapter.class ?? null, title: chapter.title });
    urls.push(...stored);
  } catch (e) {
    console.log(`⚠️  ncert_chapters lookup failed: ${e.message}`);
  }
  return [...new Set(urls)];
}

/** Download a PDF into a fresh temp dir. Returns { file, dir, url }. Caller must remove `dir`. */
export async function downloadNcertPdf(urls, { fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  const errors = [];
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 StudyAgent" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_PDF_BYTES) throw new Error("file too large");
      if (buf.subarray(0, 4).toString("latin1") !== "%PDF") throw new Error("not a PDF");
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ncert-"));
      const file = path.join(dir, path.basename(new URL(url).pathname) || "chapter.pdf");
      await fs.writeFile(file, buf, { mode: 0o600 });
      return { file, dir, url };
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }
  throw new Error(`NCERT download failed (${errors.join("; ") || "no NCERT link found in ncert_chapters"})`);
}

// ---------------------------------------------------------------------------
// Main routine
// ---------------------------------------------------------------------------

/**
 * Build the notebook for one chapter. Resolves with { notebookUrl, notebookId, sourceKind, resources } or throws
 * (the queue then marks the chapter 'Failed'; errors with `.retryAfter` also pause that user's queue).
 * `sourceUrl` defaults to the chapter's saved pdf_url. `deps` is for tests.
 */
export async function createChapterNotebook({ jobId, userId, chapter, sessionFile, sourceUrl }, deps = {}) {
  const step = deps.onStep || ((t) => setChapterStep(jobId, t));
  const py = deps.runPython || runPython;
  const download = deps.downloadNcertPdf || downloadNcertPdf;

  // The queue gives id/subject/title; load class, pdf_url, ... for the same chapter.
  let full = chapter;
  if (chapter.id != null && !deps.skipDb) {
    const row = await getChapterForUser(userId, chapter.id).catch(() => null);
    if (row) full = { ...row, ...chapter, pdf_url: row.pdf_url, class: row.class };
  }
  // The link Gemini saved on the syllabus chapter can point at the wrong NCERT chapter. ncert_chapters is the
  // source of truth: find this chapter there by title (class first) and use that row's pdf_url instead.
  if (!sourceUrl && !deps.skipDb) {
    try {
      const [best] = await (deps.lookupNcert || getNcertPdfUrls)({ ncertId: full.ncert_id ?? null, classLevel: full.class ?? null, title: full.title });
      if (best && best !== full.pdf_url) {
        console.log(`[notebooklm] "${full.title}": using ncert_chapters link ${best} (saved link was ${full.pdf_url || "none"})`);
        full = { ...full, pdf_url: best };
      }
    } catch (e) {
      console.log(`⚠️  ncert_chapters lookup failed for "${full.title}": ${e.message}`);
    }
  }
  const url = (sourceUrl || full.pdf_url || "").trim();
  const title = `Study Agent — ${full.subject}: ${full.title}`;

  // 1 + 2. Notebook, then the user's source URL
  await step(url ? "Creating notebook and adding your source link" : "Creating notebook");
  const first = await py({ action: "create_and_add_url", storage_path: sessionFile, title, url }, 480_000);
  if (!first?.ok || !first.notebook_id) throw pyError(first || {}, "Could not create the NotebookLM notebook");
  const notebookId = first.notebook_id;
  let sourceKind = first.reused ? "existing" : "url";
  let fallbackReason = null;

  // 3. NCERT fallback (skipped while URL_ONLY is on: the saved link is the only source we try)
  let urlError = first.source_error || null;
  if (!first.source_ok && URL_ONLY) {
    const why = urlError || (url ? "URL was not accepted" : "no source URL provided");
    throw new Error(`Could not add the source link for "${full.title}" (${url || "no link saved"}): ${why}`);
  }
  if (!first.source_ok) {
    fallbackReason = urlError || (url ? "URL was not accepted" : "no source URL provided");
    let tmp = null;
    try {
      await step("Source link failed, downloading the NCERT chapter instead");
      tmp = await download(await resolveNcertPdfUrls(full));
      await step("Uploading the NCERT chapter to NotebookLM");
      const up = await py({ action: "add_file", storage_path: sessionFile, notebook_id: notebookId, file_path: tmp.file }, 240_000);
      if (!up?.ok) throw pyError(up || {}, "NotebookLM rejected the NCERT file");
      sourceKind = "ncert_pdf";
    } catch (e) {
      if (e.retryAfter) throw e;
      throw new Error(`No usable source for "${full.title}". URL failed (${fallbackReason}); NCERT fallback failed (${e.message})`);
    } finally {
      if (tmp?.dir) await fs.rm(tmp.dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // 4. Study resources (infographics / reports are never requested)
  // Only what the user ticked for this chapter (never infographics/reports); no choice saved = every allowed type
  const wanted = Array.isArray(full.resourceTypes) ? full.resourceTypes : [];
  let types = GENERATABLE_RESOURCE_TYPES.filter((t) => wanted.includes(t));
  if (!types.length) types = GENERATABLE_RESOURCE_TYPES;
  await step("Starting study resources in NotebookLM");
  const gen = await py({ action: "generate", storage_path: sessionFile, notebook_id: notebookId, title: full.title, resource_types: types }, 420_000);
  if (!gen?.ok) throw pyError(gen || {}, "Resource generation failed");
  const resources = gen.resources || {};
  const started = Object.values(resources).filter((r) => r.ok).length;
  if (!started) {
    const rl = Object.values(resources).find((r) => r.rate_limit);
    if (rl) { const e = new Error(rl.error); e.status = 429; e.retryAfter = rl.retry_after; throw e; }
    throw new Error(`NotebookLM started none of the study resources (${Object.values(resources).map((r) => r.error).filter(Boolean).join("; ") || "no response"})`);
  }

  return {
    notebookId,
    notebookUrl: `https://notebooklm.google.com/notebook/${notebookId}`,
    sourceKind,
    fallbackReason,
    resources,
  };
}

/** Make the generation queue use this service (call once at startup). */
export function registerNotebookLmGenerator() {
  const bin = pickPython();
  const chk = spawn(bin, ["-c", "import notebooklm"], { stdio: "ignore" });
  chk.on("error", () => console.log(`⚠️  NotebookLM generation: "${bin}" was not found. Install Python 3 on the server.`));
  chk.on("close", (code) => { if (code) console.log("⚠️  NotebookLM generation: Python package notebooklm-py is missing. Run: pip install notebooklm-py"); });
  registerChapterGenerator((job) => createChapterNotebook(job));
}
