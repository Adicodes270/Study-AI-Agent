from google import genai
from google.genai import types

from ..config import GEMINI_API_KEY, GEMINI_MODEL
from .models import Syllabus

client = genai.Client(api_key=GEMINI_API_KEY)

PROMPT = """Extract the school syllabus from the text below.
List each subject with its chapters in order.
Use standard English subject names (Physics, Chemistry, Biology, Mathematics, English, Social Science, Hindi).
Also identify which exam this portion is for and set exam to exactly one of:
Term Test 1, Term Test 2, Half Yearly, Annual, Pre-Board.
TT1 means Term Test 1 and TT2 means Term Test 2.
If the text does not say which exam it is for, leave exam empty.
Do not invent chapters that are not in the text.
If the text is not a syllabus, return an empty subjects list.

TEXT:
{text}"""

def parse_syllabus(raw_text: str) -> Syllabus:
    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=PROMPT.format(text=raw_text),
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=Syllabus,
        ),
    )
    if response.parsed is None:
        raise ValueError("Could not read the syllabus from that text.")
    return response.parsed