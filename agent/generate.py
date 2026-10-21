# agent/generate.py - the ONLY file that talks to notebooklm-py's artifact API.
# I could not install or run notebooklm-py while writing this, so every call below follows its documented
# surface (client.artifacts.generate_* / poll_status / wait_for_completion / download_*). If a release renames
# something, the fix belongs in this file only. Optional keyword arguments are dropped on TypeError so a
# renamed option degrades to NotebookLM's defaults instead of failing the item.
from dataclasses import dataclass
from pathlib import Path

import quota


class QuotaExceeded(Exception):
    """NotebookLM refused to start this item because of a rate / daily limit."""


class GenerationFailed(Exception):
    pass


@dataclass(frozen=True)
class Asset:
    label: str           # shown to the student
    generate: str        # client.artifacts.<name>
    download: str        # client.artifacts.<name>
    ext: str
    immediate: bool = False        # no background task: the result exists as soon as generate returns
    dl_kwargs: tuple = ()          # extra download options, e.g. (("output_format", "markdown"),)


ASSETS: dict[str, Asset] = {
    "audio":       Asset("Audio overview", "generate_audio", "download_audio", "mp3"),
    "video":       Asset("Video overview", "generate_video", "download_video", "mp4"),
    "slide_deck":  Asset("Slide deck", "generate_slide_deck", "download_slide_deck", "pdf"),
    "report":      Asset("Study guide", "generate_report", "download_report", "md"),
    "flashcards":  Asset("Flashcards", "generate_flashcards", "download_flashcards", "md",
                         dl_kwargs=(("output_format", "markdown"),)),
    "quiz":        Asset("Quiz", "generate_quiz", "download_quiz", "md",
                         dl_kwargs=(("output_format", "markdown"),)),
    "mind_map":    Asset("Mind map", "generate_mind_map", "download_mind_map", "json", immediate=True),
    "infographic": Asset("Infographic", "generate_infographic", "download_infographic", "png"),
    "data_table":  Asset("Data table", "generate_data_table", "download_data_table", "csv"),
}


def label(asset_type: str) -> str:
    return ASSETS[asset_type].label if asset_type in ASSETS else asset_type


def _brief(ctx: dict) -> str:
    cls = f"Class {ctx['class']} " if ctx.get("class") else ""
    exam = f" preparing for the {ctx['exam']} exam" if ctx.get("exam") else ""
    return (f"Make this for a {cls}student{exam} revising the chapter '{ctx['chapter_title']}' ({ctx['subject']}). "
            "Stay close to the textbook. Cover key concepts, definitions, formulas and the questions most likely to be asked.")


def _kwargs(asset_type: str, ctx: dict) -> dict:
    if asset_type == "mind_map":
        return {}
    kw = {"instructions": _brief(ctx)}
    if asset_type == "report":
        kw = {}
        try:
            from notebooklm import ReportFormat
            kw["report_format"] = ReportFormat.STUDY_GUIDE
        except Exception:  # noqa: BLE001
            pass
    return kw


async def _call(fn, notebook_id: str, **kwargs):
    try:
        return await fn(notebook_id, **kwargs)
    except TypeError:
        if not kwargs:
            raise
        return await fn(notebook_id)  # option not supported by this version: use the defaults


def _message(obj) -> str:
    return str(getattr(obj, "error", None) or getattr(obj, "message", None) or obj)[:300]


async def start(client, asset_type: str, ctx: dict) -> str | None:
    """Ask NotebookLM to start generating. Returns the artifact/task id (None for instant items like mind maps)."""
    spec = ASSETS[asset_type]
    res = await _call(getattr(client.artifacts, spec.generate), ctx["notebook_id"], **_kwargs(asset_type, ctx))
    if getattr(res, "is_rate_limited", False):
        raise QuotaExceeded(_message(res))
    if getattr(res, "is_failed", False):
        msg = _message(res)
        raise (QuotaExceeded if quota.looks_like_quota(msg) else GenerationFailed)(msg)
    task_id = getattr(res, "task_id", None)
    if task_id is None and isinstance(res, dict):
        task_id = res.get("task_id") or res.get("artifact_id")
    return str(task_id) if task_id else None


@dataclass
class Progress:
    state: str            # "running" | "done" | "failed"
    error: str = ""


def _normalize(st) -> Progress:
    if st is None:
        return Progress("running")
    if getattr(st, "is_complete", False):
        return Progress("done")
    if getattr(st, "is_failed", False) or getattr(st, "is_rate_limited", False):
        return Progress("failed", _message(st))
    s = str(getattr(st, "status", "")).lower()
    if "complet" in s or s in ("done", "ready", "success"):
        return Progress("done")
    if "fail" in s or "error" in s:
        return Progress("failed", _message(st))
    return Progress("running")


async def poll(client, notebook_id: str, artifact_id: str) -> Progress:
    fn = getattr(client.artifacts, "poll_status", None)
    if fn is not None:
        return _normalize(await fn(notebook_id, artifact_id))
    try:  # fallback: wait a short while and treat a timeout as "still running"
        return _normalize(await client.artifacts.wait_for_completion(notebook_id, artifact_id, timeout=20))
    except TimeoutError:
        return Progress("running")


async def download(client, asset_type: str, ctx: dict, artifact_id: str | None, out_dir: Path) -> Path:
    spec = ASSETS[asset_type]
    safe = "".join(ch if ch.isalnum() or ch in " -_" else "" for ch in f"{ctx['subject']} - {ctx['chapter_title']} - {spec.label}")
    path = out_dir / f"{safe.strip()[:90]}.{spec.ext}"
    fn = getattr(client.artifacts, spec.download)
    extra = dict(spec.dl_kwargs)
    if artifact_id:
        extra["artifact_id"] = artifact_id
    try:
        await fn(ctx["notebook_id"], str(path), **extra)
    except TypeError:
        # an option this version doesn't accept: fall back to a plain download in the default format
        await fn(ctx["notebook_id"], str(path))
        if spec.dl_kwargs:
            path = path.rename(path.with_suffix(".json"))
    return path