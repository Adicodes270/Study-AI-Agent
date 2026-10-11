from pydantic import BaseModel


class Chapter(BaseModel):
    number: int
    title: str


class Subject(BaseModel):
    name: str
    chapters: list[Chapter]


class Syllabus(BaseModel):
    class_level: int | None = None
    exam: str | None = None
    subjects: list[Subject]