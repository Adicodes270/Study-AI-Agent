from ..config import DEFAULT_CLASS_LEVEL
from ..db import get_db
from .models import Syllabus


def save_syllabus(chat_id: int, syllabus: Syllabus) -> dict[str, str]:
    """Save each subject. Returns {label: added/updated/unchanged}."""
    exam = syllabus.exam or ""
    results = {}

    with get_db() as db:
        # Class priority: in the message > already saved > CLASS_LEVEL from .env
        row = db.execute(
            "SELECT class FROM chats WHERE chat_id = ?", (chat_id,)
        ).fetchone()
        saved_class = row["class"] if row else None
        class_value = syllabus.class_level or saved_class or DEFAULT_CLASS_LEVEL

        db.execute(
            "INSERT INTO chats (chat_id, class) VALUES (?, ?) "
            "ON CONFLICT(chat_id) DO UPDATE SET class = excluded.class",
            (chat_id, class_value),
        )

        for subject in syllabus.subjects:
            label = f"{subject.name} ({syllabus.exam})" if syllabus.exam else subject.name
            new = [(c.number, c.title) for c in subject.chapters]
            old = [
                (r["number"], r["title"])
                for r in db.execute(
                    "SELECT number, title FROM syllabus_chapters "
                    "WHERE chat_id = ? AND subject = ? AND exam = ? ORDER BY id",
                    (chat_id, subject.name, exam),
                )
            ]

            if old == new:
                results[label] = "unchanged"
                continue

            results[label] = "updated" if old else "added"
            db.execute(
                "DELETE FROM syllabus_chapters "
                "WHERE chat_id = ? AND subject = ? AND exam = ?",
                (chat_id, subject.name, exam),
            )
            db.executemany(
                "INSERT INTO syllabus_chapters "
                "(chat_id, class, subject, exam, number, title) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                [
                    (chat_id, class_value, subject.name, exam, num, title)
                    for num, title in new
                ],
            )
    return results