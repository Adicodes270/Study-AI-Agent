// src/notebooklmService.js
// NotebookLM automation + NCERT fallback for one chapter, built to plug into src/generationQueue.js.
//
//   1. create a NotebookLM notebook for the chapter (user's saved Google session, via notebooklm-py)
//   2. try to add the chapter's source URL
//   3. if that throws / is rejected / ends in an error status: look the chapter up in ncertCatalog.js,
//      download the NCERT PDF to a temp file, upload it to the same notebook, delete the temp file
//   4. trigger the study resources (never infographics or reports)
//   5. return { notebookUrl, ... } -> the queue stores status 'Ready' + notebook_url, or 'Failed' if this throws
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NOTEBOOKLM_RESOURCE_TYPES, EXCLUDED_RESOURCE_TYPES } from "./api.js";
import { DEFAULT_CLASS_LEVEL } from "./config.js";
import { getChapterForUser } from "./db.js";
import { buildNcertPdfUrl, findNcertChapter } from "./intake/ncertCatalog.js";
import { registerChapterGenerator, setChapterStep } from "./generationQueue.js";

const MAX_PDF_BYTES = 40 * 1024 * 1024;

// Test mode: add ONLY the chapter's saved link to NotebookLM. No download + file-upload fallback.
// On by default; set NOTEBOOKLM_URL_ONLY=0 to bring the NCERT PDF fallback back.
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
    elif r_type == "study_guide":
        if hasattr(a, "generate_study_guide"):
            st = await a.generate_study_guide(nb_id, source_ids=ids)
        else:
            st = await a.generate_report(nb_id, report_format=ReportFormat.STUDY_GUIDE, source_ids=ids)
    elif r_type == "briefing_doc":
        st = await a.generate_report(nb_id, report_format=ReportFormat.BRIEFING_DOC, source_ids=ids)
    elif r_type == "faq":
        st = await a.generate_report(nb_id, report_format=ReportFormat.CUSTOM, source_ids=ids,
            custom_prompt=f"Create a comprehensive exam FAQ with questions and model answers for {title}.")
    elif r_type == "timeline":
        st = await a.generate_report(nb_id, report_format=ReportFormat.CUSTOM, source_ids=ids,
            custom_prompt=f"Create a detailed chronological timeline and sequential process breakdown for {title}.")
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

async def run():
    p = json.loads(sys.argv[1])
    action = p["action"]
    try:
        from notebooklm import NotebookLMClient, ReportFormat
    except ImportError as e:
        print(json.dumps({"ok": False, "reason": "not_installed", "error": str(e)})); return
    try:
        async with NotebookLMClient.from_storage(p["storage_path"]) as client:
            if action == "create_and_add_url":
                title = p["title"]
                nb = next((n for n in await client.notebooks.list() if getattr(n, "title", "") == title), None)
                if nb is not None:
                    existing = [s for s in await client.sources.list(nb.id) if getattr(s, "id", None) and not bad_status(s)]
                    if existing:  # a previous attempt already loaded a good source: reuse it
                        print(json.dumps({"ok": True, "notebook_id": nb.id, "source_ok": True, "source_id": existing[0].id, "reused": True})); return
                if nb is None:
                    nb = await client.notebooks.create(title)
                out = {"ok": True, "notebook_id": nb.id, "source_ok": False}
                try:
                    src = await client.sources.add_url(nb.id, p["url"], wait=True, wait_timeout=90.0)
                    if not getattr(src, "id", None) or bad_status(src):
                        out["source_error"] = "source ended with status " + str(getattr(src, "status", "unknown"))
                        if getattr(src, "id", None):
                            try: await client.sources.delete(nb.id, src.id)
                            except Exception: pass
                    else:
                        out.update(source_ok=True, source_id=src.id)
                except Exception as exc:
                    if is_rate(exc): raise
                    out["source_error"] = f"{type(exc).__name__}: {exc}"
                print(json.dumps(out))
            elif action == "add_file":
                src = await client.sources.add_file(p["notebook_id"], p["file_path"], wait=True, wait_timeout=150.0)
                if not getattr(src, "id", None) or bad_status(src):
                    raise RuntimeError("NotebookLM rejected the uploaded file: " + str(getattr(src, "status", "unknown")))
                print(json.dumps({"ok": True, "source_id": src.id}))
            elif action == "generate":
                nb_id = p["notebook_id"]
                src_ids = [s.id for s in await client.sources.list(nb_id) if getattr(s, "id", None) and not bad_status(s)]
                if not src_ids:
                    raise RuntimeError("the notebook has no usable source")
                results = {}
                for r_type in p["resource_types"]:
                    if r_type.lower() in EXCLUDED:
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
    const bin = process.env.NOTEBOOKLM_PYTHON || (process.platform === "win32" ? "python" : "python3");
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

/** Candidate NCERT PDF URLs for a chapter, best first (its own NCERT link, then the catalog match). */
export function resolveNcertPdfUrls(chapter) {
  const urls = [];
  const own = String(chapter.pdf_url || "");
  if (/^https?:\/\/(www\.)?ncert\.nic\.in\//i.test(own)) urls.push(own);
  const hit = findNcertChapter({ classLevel: chapter.class ?? DEFAULT_CLASS_LEVEL, subject: chapter.subject, title: chapter.title });
  if (hit) urls.push(hit.pdf_url);
  // single-book subjects keep the same code, so an explicit book code + number in the saved URL also works
  const m = /\/([a-z]{4}\d)(\d{2})\.pdf$/i.exec(own);
  if (m) urls.push(buildNcertPdfUrl(m[1], parseInt(m[2], 10)));
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
  throw new Error(`NCERT download failed (${errors.join("; ") || "no matching NCERT chapter found"})`);
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
  const url = (sourceUrl || full.pdf_url || "").trim();
  const title = `Study Agent — ${full.subject}: ${full.title}`;

  // 1 + 2. Notebook, then the user's source URL
  await step(url ? "Creating notebook and adding your source link" : "Creating notebook");
  const first = await py({ action: "create_and_add_url", storage_path: sessionFile, title, url }, 240_000);
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
      tmp = await download(resolveNcertPdfUrls(full));
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
  const types = GENERATABLE_RESOURCE_TYPES;
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
  const bin = process.env.NOTEBOOKLM_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const chk = spawn(bin, ["-c", "import notebooklm"], { stdio: "ignore" });
  chk.on("error", () => console.log(`⚠️  NotebookLM generation: "${bin}" was not found. Install Python 3 on the server.`));
  chk.on("close", (code) => { if (code) console.log("⚠️  NotebookLM generation: Python package notebooklm-py is missing. Run: pip install notebooklm-py"); });
  registerChapterGenerator((job) => createChapterNotebook(job));
}
