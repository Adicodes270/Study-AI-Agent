# agent/sources.py - creating a notebook for a chapter and loading its NCERT PDF into it
import tempfile
from pathlib import Path

import httpx

MAX_PDF_BYTES = 100 * 1024 * 1024
# ncert.nic.in answers plain scripts with errors; a normal browser User-Agent works
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0 Safari/537.36",
    "Accept": "application/pdf,*/*",
}


class SourceError(Exception):
    pass


def notebook_title(subject: str, chapter: str, exam: str) -> str:
    title = f"{subject} - {chapter}"
    if exam:
        title += f" ({exam})"
    return title[:100]


async def create_notebook(client, title: str) -> str:
    nb = await client.notebooks.create(title)
    return nb.id


async def _download_pdf(url: str, dest: Path) -> None:
    async with httpx.AsyncClient(follow_redirects=True, timeout=120, headers=_HEADERS) as http:
        async with http.stream("GET", url) as res:
            if res.status_code != 200:
                raise SourceError(f"HTTP {res.status_code} from {url}")
            size = 0
            with dest.open("wb") as f:
                async for chunk in res.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_PDF_BYTES:
                        raise SourceError("PDF is larger than 100 MB")
                    f.write(chunk)
    with dest.open("rb") as f:
        if f.read(4) != b"%PDF":
            raise SourceError("that link did not return a PDF")


async def add_chapter_source(client, notebook_id: str, pdf_url: str) -> None:
    """Download the chapter PDF and upload it; if that fails, let NotebookLM fetch the link itself."""
    errors = []
    with tempfile.TemporaryDirectory(prefix="nlm-src-") as tmp:
        path = Path(tmp) / "chapter.pdf"
        try:
            await _download_pdf(pdf_url, path)
            try:
                await client.sources.add_file(notebook_id, str(path), wait=True)
            except TypeError:  # older/newer client without the wait argument
                await client.sources.add_file(notebook_id, str(path))
            return
        except Exception as e:  # noqa: BLE001 - try the URL route before giving up
            errors.append(f"upload: {e}")
    try:
        try:
            await client.sources.add_url(notebook_id, pdf_url, wait=True)
        except TypeError:
            await client.sources.add_url(notebook_id, pdf_url)
    except Exception as e:  # noqa: BLE001
        errors.append(f"url: {e}")
        raise SourceError("; ".join(errors)) from e