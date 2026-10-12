from google import genai
from google.genai import types

from ..config import GEMINI_API_KEY, GEMINI_MODEL
from .models import Syllabus

client = genai.Client(api_key=GEMINI_API_KEY)

PROMPT = """Extract the school syllabus from the document.

Rules:
- Include EVERY subject that appears. Common ones are English, Hindi, Sanskrit,
  Mathematics, Physics, Chemistry, Biology, Social Science and Artificial
  Intelligence, but this list is only examples. Never skip a subject.
- For each subject, list the actual study units in order: textbook chapters,
  lessons, poems, units or topics.
- Headings like "Section A: Reading" or "Section B: Writing" are NOT chapters.
  List the lessons and topics under them. If a section only names skills
  (for example notice writing or letter writing), list those skills as topics.
- Use standard English subject names.
- Set exam to exactly one of: Term Test 1, Term Test 2, Half Yearly, Annual,
  Pre-Board. TT1 means Term Test 1 and TT2 means Term Test 2. Leave exam empty
  if the document does not say.
- Do not invent chapters that are not in the document.
- If the document is not a syllabus, return an empty subjects list.
"""


def _ask(contents) -> Syllabus:
    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=contents,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=Syllabus,
        ),
    )
    if response.parsed is None:
        raise ValueError("Could not read the syllabus.")
    return response.parsed


def parse_syllabus(raw_text: str) -> Syllabus:
    return _ask(f"{PROMPT}\nDOCUMENT:\n{raw_text}")


def parse_syllabus_pdf(pdf_bytes: bytes) -> Syllabus:
    pdf = types.Part.from_bytes(data=pdf_bytes, mime_type="application/pdf")
    return _ask([pdf, PROMPT])