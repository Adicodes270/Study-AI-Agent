import pymupdf


def extract_pdf_text(pdf_bytes: bytes) -> str:
    """Pull all the text out of a PDF given as raw bytes."""
    with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
        return "\n".join(page.get_text() for page in doc).strip()