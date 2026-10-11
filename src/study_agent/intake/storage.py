import json
import re

from ..config import DEFAULT_CLASS_LEVEL, ROOT
from .models import Syllabus

DATA_DIR = ROOT / "data"


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def find_known_class(chat_dir) -> int | None:
    """Look through already-saved subjects for a class."""
    for path in chat_dir.glob("syllabus_*.json"):
        data = json.loads(path.read_text(encoding="utf-8"))
        # "class_level" is the old key name from earlier files
        known = data.get("class") or data.get("class_level")
        if known is not None:
            return known
    return None


def save_syllabus(chat_id: int, syllabus: Syllabus) -> dict[str, str]:
    """Save each subject to its own file. Returns {label: added/updated/unchanged}."""
    chat_dir = DATA_DIR / str(chat_id)
    chat_dir.mkdir(parents=True, exist_ok=True)

    # Priority: class in the message > class already saved > CLASS_LEVEL from .env
    class_level = (
        syllabus.class_level
        or find_known_class(chat_dir)
        or DEFAULT_CLASS_LEVEL
    )
    exam_slug = slugify(syllabus.exam) if syllabus.exam else ""

    results = {}
    for subject in syllabus.subjects:
        parts = ["syllabus", slugify(subject.name), exam_slug]
        path = chat_dir / ("_".join(p for p in parts if p) + ".json")

        new_data = {
            "class": class_level,
            "exam": syllabus.exam,
            "name": subject.name,
            "chapters": [c.model_dump() for c in subject.chapters],
        }
        label = f"{subject.name} ({syllabus.exam})" if syllabus.exam else subject.name

        if path.exists():
            old_data = json.loads(path.read_text(encoding="utf-8"))
            if new_data == old_data:
                results[label] = "unchanged"
                continue
            results[label] = "updated"
        else:
            results[label] = "added"

        path.write_text(
            json.dumps(new_data, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    return results